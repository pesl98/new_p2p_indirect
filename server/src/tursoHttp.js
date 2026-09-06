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

export function splitSqlScript(sql) {
  return String(sql)
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !/^--/.test(part));
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

    let lastExecute = { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: '0' };
    for (const item of payload.results || []) {
      if (item.type === 'error') {
        const err = item.error || {};
        const message = err.message || String(item);
        const sqlError = new TursoHttpError(message);
        if (/UNIQUE constraint failed/i.test(message)) {
          sqlError.code = 'SQLITE_CONSTRAINT_UNIQUE';
        }
        throw sqlError;
      }
      const resp = item.response || {};
      if (resp.type === 'execute') {
        lastExecute = resp.result || lastExecute;
      }
    }

    if (!keepOpen && !this._inTransaction) {
      this._baton = null;
      this._baseUrl = null;
    }

    return lastExecute;
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
        const result = await client._execute(sql, params);
        return {
          lastInsertRowid: Number(result.last_insert_rowid || 0),
          changes: Number(result.affected_row_count || 0)
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
