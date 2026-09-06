/**
 * Turso / libSQL SQL-over-HTTP client (POST /v2/pipeline).
 *
 * No native libsql/.so — safe on Vercel serverless. Uses fetch (Node 18+).
 * Transactions keep a Hrana baton so BEGIN/COMMIT share one connection.
 */

export class TursoHttpError extends Error {
  constructor(message, { statusCode = 500 } = {}) {
    super(message);
    this.name = 'TursoHttpError';
    this.statusCode = statusCode;
  }
}

export function pipelineUrl(databaseUrl) {
  let raw = String(databaseUrl || '').trim();
  if (raw.startsWith('libsql://')) {
    raw = `https://${raw.slice('libsql://'.length)}`;
  } else if (raw.startsWith('turso://')) {
    raw = `https://${raw.slice('turso://'.length)}`;
  }
  const parsed = new URL(raw);
  let pathname = parsed.pathname.replace(/\/$/, '');
  if (!pathname.endsWith('/v2/pipeline')) {
    pathname = `${pathname}/v2/pipeline`;
  }
  parsed.pathname = pathname;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export function encodeArg(value) {
  if (value === undefined || value === null) {
    return { type: 'null' };
  }
  if (typeof value === 'boolean') {
    return { type: 'integer', value: String(Number(value)) };
  }
  if (typeof value === 'bigint') {
    return { type: 'integer', value: value.toString() };
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return { type: 'integer', value: String(value) };
    }
    return { type: 'float', value };
  }
  if (typeof value === 'string') {
    return { type: 'text', value };
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return { type: 'blob', base64: Buffer.from(value).toString('base64') };
  }
  return { type: 'text', value: String(value) };
}

export function decodeCell(cell) {
  if (cell == null || typeof cell !== 'object') return cell;
  const kind = cell.type;
  if (kind === 'null') return null;
  if (kind === 'integer') return Number(cell.value);
  if (kind === 'float') return Number(cell.value);
  if (kind === 'text') return cell.value;
  if (kind === 'blob') return Buffer.from(cell.base64 || '', 'base64');
  return cell.value;
}

export function isInsertSql(sql) {
  return /^\s*insert\b/i.test(String(sql || ''));
}

/**
 * Turso / Hrana may omit last_insert_rowid, return camelCase, or send "0"
 * after INSERT on a baton stream. Treat missing/empty as 0 so callers can
 * fall back to SELECT last_insert_rowid() on the same connection.
 */
export function mapLastInsertRowid(result) {
  if (!result || typeof result !== 'object') return 0;
  const raw = result.last_insert_rowid ?? result.lastInsertRowid ?? result.last_insert_row_id;
  if (raw == null || raw === '') return 0;
  const n = typeof raw === 'bigint' ? Number(raw) : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function pipelineError(item) {
  const err = item.error || item.response?.error || {};
  const message = err.message || String(item);
  const sqlError = new TursoHttpError(message);
  if (/UNIQUE constraint failed/i.test(message)) {
    sqlError.code = 'SQLITE_CONSTRAINT_UNIQUE';
  }
  return sqlError;
}

/** Collect execute results from a /v2/pipeline payload (ok-wrapped or flat). */
export function extractExecuteResults(payload) {
  const executes = [];
  for (const item of payload?.results || []) {
    if (item.type === 'error') {
      throw pipelineError(item);
    }
    const resp = item.response || item;
    if (resp.type === 'error') {
      throw pipelineError({ error: resp.error || item.error, type: 'error' });
    }
    if (resp.type === 'execute' || resp.result) {
      executes.push(resp.result || {});
    }
  }
  return executes;
}

/** Drop leading `--` comment lines and blank lines so DDL after a file header is kept. */
function stripLeadingSqlComments(chunk) {
  const lines = String(chunk).split(/\r?\n/);
  let start = 0;
  while (start < lines.length) {
    const trimmed = lines[start].trim();
    if (trimmed === '' || trimmed.startsWith('--')) {
      start += 1;
      continue;
    }
    break;
  }
  return lines.slice(start).join('\n').trim();
}

export function splitSqlScript(sql) {
  return String(sql)
    .split(';')
    .map((part) => stripLeadingSqlComments(part))
    .filter(Boolean);
}

function rowObjects(cols, rows) {
  const names = (cols || []).map((col) => col.name || '');
  return (rows || []).map((row) => {
    const obj = {};
    names.forEach((name, i) => {
      obj[name] = decodeCell(row[i]);
    });
    return obj;
  });
}

export class TursoHttpClient {
  constructor(databaseUrl, authToken, { timeout = 20000, fetchImpl = fetch } = {}) {
    this.pipelineUrl = pipelineUrl(databaseUrl);
    this._token = authToken;
    this._timeout = timeout;
    this._fetch = fetchImpl;
    this._baton = null;
    this._baseUrl = null;
    this._inTransaction = 0;
  }

  get mode() {
    return 'turso-http';
  }

  get useTurso() {
    return true;
  }

  _headers() {
    return {
      Authorization: `Bearer ${this._token}`,
      'Content-Type': 'application/json'
    };
  }

  async _pipeline(requests, { keepOpen = false } = {}) {
    const body = { requests };
    if (this._baton) body.baton = this._baton;

    let response;
    try {
      response = await this._fetch(this._baseUrl || this.pipelineUrl, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this._timeout)
      });
    } catch (error) {
      throw new TursoHttpError(`Turso HTTP request failed: ${error.message}`);
    }

    if (response.status === 401) {
      throw new TursoHttpError(
        'Turso HTTP 401 Unauthorized — token rejected. '
        + 'Use a database token from `turso db tokens create` '
        + '(not an org/platform JWT).',
        { statusCode: 503 }
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new TursoHttpError(
        `Turso HTTP ${response.status}: ${text.slice(0, 500)}`,
        { statusCode: response.status === 404 ? 503 : 500 }
      );
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new TursoHttpError(`Turso HTTP returned non-JSON: ${text.slice(0, 300)}`);
    }

    this._baton = payload.baton || null;
    if (payload.base_url) this._baseUrl = payload.base_url;

    const executes = extractExecuteResults(payload);
    const lastExecute = executes.length
      ? executes[executes.length - 1]
      : { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null };

    if (!keepOpen && !this._inTransaction) {
      this._baton = null;
      this._baseUrl = null;
    }

    return { ...lastExecute, executes };
  }

  async _execute(sql, params = [], { keepOpen = false } = {}) {
    const args = [...params].map(encodeArg);
    const stmt = { sql };
    if (args.length) stmt.args = args;
    const requests = [{ type: 'execute', stmt }];
    if (!keepOpen && !this._inTransaction) {
      requests.push({ type: 'close' });
    }
    return this._pipeline(requests, { keepOpen: keepOpen || this._inTransaction > 0 });
  }

  prepare(sql) {
    const client = this;
    return {
      async get(...params) {
        const result = await client._execute(sql, params);
        const rows = rowObjects(result.cols, result.rows);
        return rows[0] || undefined;
      },
      async all(...params) {
        const result = await client._execute(sql, params);
        return rowObjects(result.cols, result.rows);
      },
      async run(...params) {
        // Hrana /v2/pipeline often omits last_insert_rowid on INSERT (especially
        // after BEGIN on a baton). Pair INSERT with SELECT last_insert_rowid()
        // on the same pipeline/connection so child FKs get a real id.
        const insertLike = isInsertSql(sql);
        const args = [...params].map(encodeArg);
        const stmt = { sql };
        if (args.length) stmt.args = args;
        const requests = [{ type: 'execute', stmt }];
        if (insertLike) {
          requests.push({ type: 'execute', stmt: { sql: 'SELECT last_insert_rowid() AS id' } });
        }
        const keepOpen = client._inTransaction > 0;
        if (!keepOpen) requests.push({ type: 'close' });

        const result = await client._pipeline(requests, { keepOpen });
        const executes = result.executes?.length ? result.executes : [result];
        const writeResult = executes[0] || result;
        const idResult = insertLike && executes.length > 1 ? executes[executes.length - 1] : null;
        const idRows = idResult ? rowObjects(idResult.cols, idResult.rows) : [];

        let lastInsertRowid = mapLastInsertRowid(writeResult);
        if (!lastInsertRowid && idRows.length) {
          lastInsertRowid = Number(idRows[0]?.id || 0);
        }
        if (!lastInsertRowid) {
          lastInsertRowid = mapLastInsertRowid(result);
        }

        return {
          lastInsertRowid,
          changes: Number(writeResult.affected_row_count ?? writeResult.affectedRowCount ?? 0)
        };
      }
    };
  }

  async exec(sql) {
    const stmts = splitSqlScript(sql);
    if (stmts.length === 0) return;
    const requests = stmts.map((stmt) => ({ type: 'execute', stmt: { sql: stmt } }));
    if (!this._inTransaction) requests.push({ type: 'close' });
    await this._pipeline(requests, { keepOpen: this._inTransaction > 0 });
  }

  async pragma(source) {
    const sql = String(source).trim().toLowerCase().startsWith('pragma')
      ? source
      : `PRAGMA ${source}`;
    if (/=/.test(sql)) {
      await this.exec(sql);
      return [];
    }
    return this.prepare(sql).all();
  }

  transaction(fn) {
    const client = this;
    const run = async (...args) => {
      const nested = client._inTransaction > 0;
      if (!nested) {
        client._inTransaction += 1;
        await client._execute('BEGIN', [], { keepOpen: true });
      } else {
        client._inTransaction += 1;
        await client._execute('SAVEPOINT pf_tx', [], { keepOpen: true });
      }
      try {
        const result = await fn(...args);
        if (!nested) {
          await client._execute('COMMIT', [], { keepOpen: true });
          await client._pipeline([{ type: 'close' }]);
          client._baton = null;
          client._baseUrl = null;
        } else {
          await client._execute('RELEASE pf_tx', [], { keepOpen: true });
        }
        client._inTransaction -= 1;
        return result;
      } catch (error) {
        try {
          if (!nested) {
            await client._execute('ROLLBACK', [], { keepOpen: true });
            await client._pipeline([{ type: 'close' }]);
          } else {
            await client._execute('ROLLBACK TO pf_tx', [], { keepOpen: true });
            await client._execute('RELEASE pf_tx', [], { keepOpen: true });
          }
        } catch {
          // ignore rollback failures
        }
        client._inTransaction = Math.max(0, client._inTransaction - 1);
        if (client._inTransaction === 0) {
          client._baton = null;
          client._baseUrl = null;
        }
        throw error;
      }
    };
    run.then = (onFulfilled, onRejected) => run().then(onFulfilled, onRejected);
    return run;
  }

  close() {
    this._baton = null;
    this._baseUrl = null;
    this._inTransaction = 0;
  }
}
