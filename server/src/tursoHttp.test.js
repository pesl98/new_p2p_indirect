import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  TursoHttpClient,
  TursoHttpError,
  decodeCell,
  encodeArg,
  pipelineUrl,
  splitSqlScript
} from './tursoHttp.js';
import { preferTursoHttp, schemaPath } from './dbConfig.js';

function mockFetch(payload, { status = 200 } = {}) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return typeof payload === 'string' ? payload : JSON.stringify(payload);
    }
  });
}

describe('Turso HTTP pipeline client', () => {
  test('pipeline_url maps libsql:// to https /v2/pipeline', () => {
    assert.equal(
      pipelineUrl('libsql://ex-org.turso.io'),
      'https://ex-org.turso.io/v2/pipeline'
    );
  });

  test('pipeline_url keeps an existing /v2/pipeline path', () => {
    assert.equal(
      pipelineUrl('https://ex.turso.io/v2/pipeline'),
      'https://ex.turso.io/v2/pipeline'
    );
  });

  test('HTTP is preferred whenever Turso is used (no native wheel)', () => {
    assert.equal(preferTursoHttp({}), true);
    assert.equal(preferTursoHttp({ VERCEL: '1' }), true);
    assert.equal(preferTursoHttp({ PROCUREFLOW_LIBSQL_HTTP: '0' }), false);
  });

  test('encode/decode round-trip', () => {
    assert.deepEqual(encodeArg(null), { type: 'null' });
    assert.deepEqual(encodeArg(12), { type: 'integer', value: '12' });
    assert.equal(decodeCell({ type: 'integer', value: '12' }), 12);
    assert.equal(decodeCell({ type: 'text', value: 'hi' }), 'hi');
    assert.equal(decodeCell({ type: 'null' }), null);
  });

  test('splitSqlScript drops empties', () => {
    assert.deepEqual(
      splitSqlScript('CREATE TABLE a (id INT); CREATE INDEX i ON a(id);'),
      ['CREATE TABLE a (id INT)', 'CREATE INDEX i ON a(id)']
    );
  });

  test('splitSqlScript keeps CREATE after leading -- comments', () => {
    const fixture = `-- Schema header
-- Money columns are INTEGER cents.

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

-- next table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT
);
`;
    const stmts = splitSqlScript(fixture);
    assert.ok(
      stmts.some((stmt) => /CREATE TABLE IF NOT EXISTS departments/i.test(stmt)),
      'first CREATE after file-header comments must be kept'
    );
    assert.match(stmts[0], /CREATE TABLE IF NOT EXISTS departments/);
    assert.match(stmts[1], /CREATE TABLE IF NOT EXISTS users/);
  });

  test('splitSqlScript(schema.sql) includes departments CREATE', () => {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const stmts = splitSqlScript(schema);
    assert.ok(
      stmts.some((stmt) => /CREATE TABLE IF NOT EXISTS departments/i.test(stmt)),
      'schema.sql departments CREATE must survive header -- comments'
    );
  });

  test('execute maps named rows and lastInsertRowid', async () => {
    const payload = {
      results: [
        {
          type: 'ok',
          response: {
            type: 'execute',
            result: {
              cols: [{ name: 'n' }],
              rows: [[{ type: 'integer', value: '42' }]],
              last_insert_rowid: '7',
              affected_row_count: 1
            }
          }
        },
        { type: 'ok', response: { type: 'close' } }
      ]
    };
    const client = new TursoHttpClient('libsql://ex.turso.io', 'tok', {
      fetchImpl: mockFetch(payload)
    });
    const row = await client.prepare('SELECT COUNT(*) AS n FROM departments').get();
    assert.deepEqual(row, { n: 42 });
    const run = await client.prepare('INSERT INTO departments (code, name) VALUES (?, ?)').run('MKT', 'Marketing');
    assert.equal(run.lastInsertRowid, 7);
    assert.equal(run.changes, 1);
  });

  test('401 mentions database token', async () => {
    const client = new TursoHttpClient('libsql://ex.turso.io', 'org-jwt', {
      fetchImpl: mockFetch('unauthorized', { status: 401 })
    });
    await assert.rejects(
      () => client.prepare('SELECT 1').get(),
      (err) => err instanceof TursoHttpError && /database token/.test(err.message)
    );
  });

  test('transaction keeps a baton across statements', async () => {
    const calls = [];
    const fetchImpl = async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      const last = body.requests[body.requests.length - 1];
      const keepOpen = last?.type !== 'close';
      return {
        status: 200,
        ok: true,
        async text() {
          return JSON.stringify({
            baton: keepOpen ? 'baton-1' : null,
            results: [
              {
                type: 'ok',
                response: {
                  type: 'execute',
                  result: { cols: [], rows: [], last_insert_rowid: '1', affected_row_count: 1 }
                }
              }
            ]
          });
        }
      };
    };
    const client = new TursoHttpClient('libsql://ex.turso.io', 'tok', { fetchImpl });
    await client.transaction(async () => {
      await client.prepare('INSERT INTO departments (id, code, name) VALUES (?, ?, ?)').run(1, 'MKT', 'Marketing');
      await client.prepare('INSERT INTO departments (id, code, name) VALUES (?, ?, ?)').run(2, 'ITE', 'IT');
    });
    assert.ok(calls.length >= 3);
    assert.equal(calls[0].requests[0].stmt.sql, 'BEGIN');
    assert.ok(calls.some((c) => c.baton === 'baton-1'));
    assert.equal(calls[calls.length - 1].requests[0].type, 'close');
  });
});
