/**
 * Turso / libSQL SQL-over-HTTP client (POST /v2/pipeline).
 *
 * No native libsql/.so — safe on Vercel serverless. Uses fetch (Node 18+).
 * An interactive transaction is a Hrana stream identified by a baton. The
 * baton and the nesting count live in AsyncLocalStorage, one store per
 * transaction() call, so concurrent requests on one warm instance cannot
 * share a stream. Statements outside a store send no baton and close.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const txLocal = new AsyncLocalStorage();

function currentTx(client) {
  const store = txLocal.getStore();
  if (!store || store.client !== client) return null;
  return store;
}

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

/**
 * Split a SQL script on statement-ending `;` only.
 * Naive `String.split(';')` breaks CREATE TABLE when a `--` comment
 * (or a string literal) contains a semicolon — Turso then reports
 * `SQL string could not be parsed: unexpected end of input`.
 */
export function splitSqlScript(sql) {
  const source = String(sql);
  const statements = [];
  let current = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let word = '';
  // Trigger bodies contain semicolons. Transaction BEGIN; does not, and it
  // does not follow the word TRIGGER, so it still splits as its own statement.
  let beginDepth = 0;

  const flushWord = () => {
    if (!word) return;
    const upper = word.toUpperCase();
    word = '';
    if (upper === 'END') {
      if (beginDepth > 0) beginDepth -= 1;
      return;
    }
    if (upper !== 'BEGIN') return;
    let j = i;
    while (j < source.length && /\s/.test(source[j])) j += 1;
    if (source[j] === ';') return;
    if (/\bTRIGGER\b/i.test(current)) beginDepth += 1;
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      i += 1;
      continue;
    }

    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        i += 2;
        inBlockComment = false;
        continue;
      }
      i += 1;
      continue;
    }

    if (inSingle) {
      current += ch;
      if (ch === "'" && next === "'") {
        current += next;
        i += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }

    if (inDouble) {
      current += ch;
      if (ch === '"' && next === '"') {
        current += next;
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }

    if (/[A-Za-z0-9_]/.test(ch)) {
      word += ch;
      current += ch;
      i += 1;
      continue;
    }

    flushWord();

    if (ch === '-' && next === '-') {
      current += ch + next;
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      current += ch + next;
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      current += ch;
      inSingle = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      current += ch;
      inDouble = true;
      i += 1;
      continue;
    }
    if (ch === ';') {
      if (beginDepth === 0) {
        const stmt = stripLeadingSqlComments(current);
        if (stmt) statements.push(stmt);
        current = '';
      } else {
        current += ch;
      }
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  flushWord();

  const tail = stripLeadingSqlComments(current);
  if (tail) statements.push(tail);
  return statements;
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
  }

  get mode() {
    return 'turso-http';
  }

  get useTurso() {
    return true;
  }

  inTransaction() {
    return (currentTx(this)?.depth || 0) > 0;
  }

  /**
   * Run `fn` outside this client's transaction store. Async work created
   * inside `fn` (including setImmediate) does not inherit the open baton.
   */
  runOutsideTransaction(fn) {
    return txLocal.exit(fn);
  }

  /**
   * One non-interactive pipeline: BEGIN, the statements, COMMIT, close.
   * Turso's interactive-transaction cap does not apply. Refuses to join
   * an open interactive transaction.
   */
  async batch(statements) {
    if ((currentTx(this)?.depth || 0) > 0) {
      throw new TursoHttpError('batch() cannot run inside an interactive transaction');
    }
    const requests = [{ type: 'execute', stmt: { sql: 'BEGIN' } }];
    for (const item of statements || []) {
      if (item?.exec) {
        for (const sql of splitSqlScript(item.sql)) {
          requests.push({ type: 'execute', stmt: { sql } });
        }
      } else if (item?.sql) {
        const args = [...(item.args || [])].map(encodeArg);
        const stmt = { sql: item.sql };
        if (args.length) stmt.args = args;
        requests.push({ type: 'execute', stmt });
      }
    }
    if (requests.length === 1) return;
    requests.push({ type: 'execute', stmt: { sql: 'COMMIT' } });
    requests.push({ type: 'close' });
    await this._pipeline(requests, { keepOpen: false });
  }

  _headers() {
    return {
      Authorization: `Bearer ${this._token}`,
      'Content-Type': 'application/json'
    };
  }

  async _pipeline(requests, { keepOpen = false } = {}) {
    const tx = currentTx(this);
    const body = { requests };
    if (tx?.baton) body.baton = tx.baton;

    let response;
    try {
      response = await this._fetch(tx?.baseUrl || this.pipelineUrl, {
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

    if (tx && keepOpen) {
      tx.baton = payload.baton || null;
      if (payload.base_url) tx.baseUrl = payload.base_url;
    }

    const executes = extractExecuteResults(payload);
    const lastExecute = executes.length
      ? executes[executes.length - 1]
      : { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null };

    return { ...lastExecute, executes };
  }

  async _execute(sql, params = [], { keepOpen = false } = {}) {
    const args = [...params].map(encodeArg);
    const stmt = { sql };
    if (args.length) stmt.args = args;
    const requests = [{ type: 'execute', stmt }];
    const inTx = (currentTx(this)?.depth || 0) > 0;
    const hold = keepOpen || inTx;
    if (!hold) requests.push({ type: 'close' });
    return this._pipeline(requests, { keepOpen: hold });
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
        const keepOpen = (currentTx(client)?.depth || 0) > 0;
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
    const inTx = (currentTx(this)?.depth || 0) > 0;
    if (!inTx) requests.push({ type: 'close' });
    await this._pipeline(requests, { keepOpen: inTx });
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
    return this._transaction(fn, 'BEGIN');
  }

  /** Reserve the write lock before the callback reads, so a second writer waits. */
  immediateTransaction(fn) {
    return this._transaction(fn, 'BEGIN IMMEDIATE');
  }

  _transaction(fn, beginSql) {
    const client = this;
    const run = async (...args) => {
      const existing = currentTx(client);
      if (existing && existing.depth > 0) {
        existing.depth += 1;
        await client._execute('SAVEPOINT pf_tx', [], { keepOpen: true });
        try {
          const result = await fn(...args);
          await client._execute('RELEASE pf_tx', [], { keepOpen: true });
          existing.depth -= 1;
          return result;
        } catch (error) {
          try {
            await client._execute('ROLLBACK TO pf_tx', [], { keepOpen: true });
            await client._execute('RELEASE pf_tx', [], { keepOpen: true });
          } catch {
            // ignore rollback failures
          }
          existing.depth = Math.max(0, existing.depth - 1);
          throw error;
        }
      }

      const ctx = { client, baton: null, baseUrl: null, depth: 0 };
      return txLocal.run(ctx, async () => {
        ctx.depth = 1;
        try {
          await client._execute(beginSql, [], { keepOpen: true });
          try {
            const result = await fn(...args);
            await client._execute('COMMIT', [], { keepOpen: true });
            await client._pipeline([{ type: 'close' }], { keepOpen: true });
            return result;
          } catch (error) {
            try {
              await client._execute('ROLLBACK', [], { keepOpen: true });
              await client._pipeline([{ type: 'close' }], { keepOpen: true });
            } catch {
              // ignore rollback failures
            }
            throw error;
          }
        } finally {
          ctx.depth = 0;
          ctx.baton = null;
          ctx.baseUrl = null;
        }
      });
    };
    run.then = (onFulfilled, onRejected) => run().then(onFulfilled, onRejected);
    return run;
  }

  close() {
    // Baton state is per transaction, not on this shared client.
  }
}
