import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  TursoHttpClient,
  TursoHttpError,
  decodeCell,
  encodeArg,
  extractExecuteResults,
  isInsertSql,
  mapLastInsertRowid,
  pipelineUrl,
  splitSqlScript
} from './tursoHttp.js';
import { preferTursoHttp, schemaPath } from './dbConfig.js';
import { kickWebhookDispatch } from './webhookOutbox.js';

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

  test('splitSqlScript does not split on semicolon inside -- comments', () => {
    // Exact invoices shape that produced:
    // "SQL string could not be parsed: unexpected end of input at (11, 54)"
    const sql = `CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT NOT NULL,
  po_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  invoice_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  tax_amount INTEGER DEFAULT 0,
  total_amount INTEGER NOT NULL,
  -- NULL = pay billed total_amount. Set by short_pay; billed total is never rewritten.
  payable_total_cents INTEGER,
  status TEXT DEFAULT 'pending_match'
);`;
    const stmts = splitSqlScript(sql);
    assert.equal(stmts.length, 1, 'comment semicolon must not start a second statement');
    assert.match(stmts[0], /payable_total_cents INTEGER/);
    assert.match(stmts[0], /Set by short_pay; billed total is never rewritten/);
    assert.ok(
      !stmts.some((stmt) => /^\s*billed total is never rewritten/i.test(stmt)),
      'must not emit a leftover fragment after the comment semicolon'
    );
  });

  test('splitSqlScript keeps a trigger body intact and still splits BEGIN', () => {
    const stmts = splitSqlScript(`
      CREATE TABLE t (id INT);
      CREATE TRIGGER t_no_update BEFORE UPDATE ON t
      BEGIN
        SELECT RAISE(ABORT, 'no');
      END;
      BEGIN IMMEDIATE;
      COMMIT;
    `);
    assert.equal(stmts.length, 4);
    assert.match(stmts[0], /^CREATE TABLE t/);
    assert.match(stmts[1], /CREATE TRIGGER t_no_update/);
    assert.match(stmts[1], /SELECT RAISE\(ABORT, 'no'\);/);
    assert.match(stmts[1], /END$/);
    assert.equal(stmts[2], 'BEGIN IMMEDIATE');
    assert.equal(stmts[3], 'COMMIT');
  });

  test('splitSqlScript does not split on semicolon inside string literals', () => {
    const stmts = splitSqlScript(
      `INSERT INTO t (msg) VALUES ('hello; world');\nINSERT INTO t (msg) VALUES ('ok');`
    );
    assert.equal(stmts.length, 2);
    assert.equal(stmts[0], `INSERT INTO t (msg) VALUES ('hello; world')`);
    assert.equal(stmts[1], `INSERT INTO t (msg) VALUES ('ok')`);
  });

  test('splitSqlScript does not split on semicolon inside block comments', () => {
    const stmts = splitSqlScript(
      `/* note; still a comment */\nCREATE TABLE a (id INT);\nCREATE TABLE b (id INT);`
    );
    assert.equal(stmts.length, 2);
    assert.match(stmts[0], /CREATE TABLE a \(id INT\)/);
    assert.match(stmts[1], /CREATE TABLE b \(id INT\)/);
  });

  test('splitSqlScript(schema.sql) keeps invoices CREATE including payable_total_cents', () => {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const stmts = splitSqlScript(schema);
    const invoices = stmts.find((stmt) => /CREATE TABLE IF NOT EXISTS invoices\b/i.test(stmt));
    assert.ok(invoices, 'invoices CREATE must be present');
    assert.match(invoices, /payable_total_cents INTEGER/);
    assert.match(invoices, /duplicate_status TEXT NOT NULL DEFAULT 'clear'/);
    assert.match(invoices, /UNIQUE\(supplier_id, invoice_number\)/);
    assert.ok(
      !stmts.some((stmt) => /^\s*billed total is never rewritten/i.test(stmt)),
      'schema comment semicolon must not leak a truncated fragment'
    );
  });

  test('splitSqlScript(schema.sql) keeps each CREATE TABLE as one complete statement', () => {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const stmts = splitSqlScript(schema);
    const creates = stmts.filter((stmt) => /^\s*CREATE TABLE/i.test(stmt));
    assert.ok(creates.length >= 19, `expected all schema tables, got ${creates.length}`);
    for (const stmt of creates) {
      assert.match(stmt, /\)\s*$/, `truncated CREATE TABLE: ${stmt.slice(0, 80)}`);
    }
    const dispositions = creates.find((stmt) =>
      /CREATE TABLE IF NOT EXISTS invoice_exception_dispositions\b/i.test(stmt)
    );
    assert.ok(dispositions);
    assert.match(dispositions, /'short_pay'/);
    assert.match(dispositions, /billed_total_cents INTEGER/);
    const dupFlags = creates.find((stmt) =>
      /CREATE TABLE IF NOT EXISTS invoice_duplicate_flags\b/i.test(stmt)
    );
    assert.ok(dupFlags);
    assert.match(dupFlags, /same_amount_near_date/);
  });

  test('exec(schema.sql) sends invoices CREATE as a single pipeline statement', async () => {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const executed = [];
    const fetchImpl = mockPipelineBySql((sql) => {
      executed.push(sql);
      return { cols: [], rows: [], affected_row_count: 0 };
    });
    const client = new TursoHttpClient('libsql://ex.turso.io', 'tok', { fetchImpl });
    await client.exec(schema);
    const invoices = executed.find((sql) => /CREATE TABLE IF NOT EXISTS invoices\b/i.test(sql));
    assert.ok(invoices);
    assert.match(invoices, /payable_total_cents INTEGER/);
    assert.match(invoices, /duplicate_status TEXT NOT NULL DEFAULT 'clear'/);
    assert.ok(!executed.some((sql) => /^\s*billed total is never rewritten/i.test(sql)));
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

  test('mapLastInsertRowid accepts snake_case, camelCase, and missing', () => {
    assert.equal(mapLastInsertRowid({ last_insert_rowid: '7' }), 7);
    assert.equal(mapLastInsertRowid({ lastInsertRowid: 9 }), 9);
    assert.equal(mapLastInsertRowid({}), 0);
    assert.equal(mapLastInsertRowid({ last_insert_rowid: '0' }), 0);
    assert.equal(mapLastInsertRowid(null), 0);
    assert.equal(isInsertSql('INSERT INTO t (a) VALUES (1)'), true);
    assert.equal(isInsertSql('SELECT 1'), false);
  });

  test('extractExecuteResults reads ok-wrapped and flat execute items', () => {
    const executes = extractExecuteResults({
      results: [
        {
          type: 'ok',
          response: {
            type: 'execute',
            result: { cols: [], rows: [], affected_row_count: 1 }
          }
        },
        {
          type: 'execute',
          result: {
            cols: [{ name: 'id' }],
            rows: [[{ type: 'integer', value: '12' }]]
          }
        }
      ]
    });
    assert.equal(executes.length, 2);
    assert.equal(executes[0].affected_row_count, 1);
    assert.equal(executes[1].rows.length, 1);
  });

  test('run recovers lastInsertRowid via SELECT last_insert_rowid when pipeline omits it', async () => {
    const fetchImpl = mockPipelineBySql((sql) => {
      if (/^insert\b/i.test(sql)) {
        return { cols: [], rows: [], affected_row_count: 1 };
      }
      if (/last_insert_rowid/i.test(sql)) {
        return {
          cols: [{ name: 'id' }],
          rows: [[{ type: 'integer', value: '42' }]],
          affected_row_count: 0
        };
      }
      return { cols: [], rows: [], affected_row_count: 0 };
    });
    const client = new TursoHttpClient('libsql://ex.turso.io', 'tok', { fetchImpl });
    const run = await client.prepare(
      'INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount) VALUES (?, ?, ?, ?, ?)'
    ).run('PR-2026-100', 1, 1, 'draft', 12500);
    assert.equal(run.lastInsertRowid, 42);
    assert.equal(run.changes, 1);
  });

  test('transaction INSERT still maps lastInsertRowid when execute result has 0', async () => {
    const calls = [];
    const fetchImpl = mockPipelineBySql((sql) => {
      if (/^begin\b|^commit\b|^rollback\b/i.test(sql)) {
        return { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: '0' };
      }
      if (/^insert\b/i.test(sql)) {
        return { cols: [], rows: [], affected_row_count: 1, last_insert_rowid: '0' };
      }
      if (/last_insert_rowid/i.test(sql)) {
        return {
          cols: [{ name: 'id' }],
          rows: [[{ type: 'integer', value: '8' }]],
          affected_row_count: 0
        };
      }
      return { cols: [], rows: [], affected_row_count: 0 };
    }, calls);

    const client = new TursoHttpClient('libsql://ex.turso.io', 'tok', { fetchImpl });
    const prId = await client.transaction(async () => {
      const pr = await client.prepare(
        'INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount) VALUES (?, ?, ?, ?, ?)'
      ).run('PR-2026-101', 1, 1, 'draft', 5000);
      await client.prepare(
        'INSERT INTO requisition_items (requisition_id, item_description, category, quantity, unit_price, total_price) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(pr.lastInsertRowid, 'Notebooks', 'Office Supplies', 2, 2500, 5000);
      return pr.lastInsertRowid;
    });

    assert.equal(prId, 8);
    assert.equal(calls[0].requests[0].stmt.sql, 'BEGIN');
    const insertCall = calls.find((c) =>
      (c.requests || []).some((req) => req.type === 'execute' && /^insert\b/i.test(req.stmt?.sql || ''))
    );
    assert.ok(insertCall);
    assert.ok(
      insertCall.requests.some((req) => /last_insert_rowid/i.test(req.stmt?.sql || '')),
      'INSERT pipeline request must also SELECT last_insert_rowid()'
    );
    assert.ok(calls.some((c) => c.baton === 'baton-1'));
  });

  test('concurrent transactions keep separate batons and rollback isolation', async () => {
    const fake = createIsolatingFetch();
    const client = new TursoHttpClient('libsql://ex.turso.io', 'tok', { fetchImpl: fake.fetchImpl });
    let releaseA;
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    let markA;
    const aStarted = new Promise((resolve) => { markA = resolve; });

    const pendingA = client.transaction(async () => {
      await client.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('a', '1');
      markA();
      await gateA;
      throw new Error('rollback-a');
    })();

    await aStarted;
    const outside = await client.prepare('SELECT v FROM t WHERE k = ?').get('a');
    const pendingB = client.transaction(async () => {
      await client.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('b', '2');
    })();
    await pendingB;
    releaseA();
    await assert.rejects(pendingA, /rollback-a/);

    const insertA = fake.calls.find((body) => bodyHasArg(body, 'a') && sqlIncludes(body, 'INSERT'));
    const insertB = fake.calls.find((body) => bodyHasArg(body, 'b') && sqlIncludes(body, 'INSERT'));
    const outsideCall = fake.calls.find((body) => sqlIncludes(body, 'SELECT v FROM t'));
    assert.ok(insertA?.baton, 'transaction A must pin a baton');
    assert.ok(insertB?.baton, 'transaction B must pin a baton');
    assert.notEqual(insertA.baton, insertB.baton);
    assert.equal(outsideCall.baton, undefined);
    assert.ok(outsideCall.requests.some((request) => request.type === 'close'));
    assert.equal(outside, undefined);
    assert.deepEqual(await client.prepare('SELECT v FROM t WHERE k = ?').get('b'), { v: '2' });
    assert.equal(await client.prepare('SELECT v FROM t WHERE k = ?').get('a'), undefined);
  });

  test('a nested transaction keeps its parent stream while another transaction runs', async () => {
    const fake = createIsolatingFetch();
    const client = new TursoHttpClient('libsql://ex.turso.io', 'tok', { fetchImpl: fake.fetchImpl });
    let releaseA;
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    let markA;
    const aStarted = new Promise((resolve) => { markA = resolve; });

    const pendingA = client.transaction(async () => {
      await client.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('a', '1');
      markA();
      await gateA;
      await client.transaction(async () => {
        await client.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('n', '9');
      })();
    })();

    await aStarted;
    const outside = client.prepare('SELECT v FROM t WHERE k = ?').get('a');
    const pendingB = client.transaction(async () => {
      await client.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('b', '2');
    })();
    await pendingB;
    releaseA();
    await pendingA;
    assert.equal(await outside, undefined);

    const nested = fake.calls.find((body) => bodyHasArg(body, 'n') && sqlIncludes(body, 'INSERT'));
    const insertB = fake.calls.find((body) => bodyHasArg(body, 'b') && sqlIncludes(body, 'INSERT'));
    const outsideCall = fake.calls.find((body) => sqlIncludes(body, 'SELECT v FROM t'));
    assert.ok(nested?.baton);
    assert.ok(insertB?.baton);
    assert.notEqual(nested.baton, insertB.baton);
    assert.equal(outsideCall.baton, undefined);
    const savepoint = fake.calls.find((body) => sqlIncludes(body, 'SAVEPOINT'));
    assert.ok(savepoint?.streamId);
    assert.equal(savepoint.streamId, nested.streamId);
    assert.notEqual(savepoint.streamId, insertB.streamId);
  });

  test('webhook delivery started inside a transaction does not send that baton', async () => {
    const fake = createIsolatingFetch();
    const client = new TursoHttpClient('libsql://ex.turso.io', 'tok', { fetchImpl: fake.fetchImpl });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let mark;
    const started = new Promise((resolve) => { mark = resolve; });

    const pending = client.transaction(async () => {
      await client.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('a', '1');
      kickWebhookDispatch(client, {
        ready: true,
        webhookTargetUrl: 'https://hooks.example.test/procureflow',
        webhookSigningSecret: 'secret'
      });
      mark();
      await gate;
    })();

    await started;
    await new Promise((resolve) => setImmediate(resolve));
    const outbox = fake.calls.find((body) => sqlIncludes(body, 'webhook_outbox'));
    assert.ok(outbox, 'dispatch should query the outbox');
    assert.equal(outbox.baton, undefined);
    assert.ok(outbox.requests.some((request) => request.type === 'close'));
    release();
    await pending;
  });

  test('a failed BEGIN leaves the client outside any transaction', async () => {
    const fake = createIsolatingFetch({ failOn: /^begin\b/i });
    const client = new TursoHttpClient('libsql://ex.turso.io', 'tok', { fetchImpl: fake.fetchImpl });
    await assert.rejects(
      () => client.transaction(async () => {
        await client.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('a', '1');
      })(),
      /forced failure/
    );
    assert.equal(client.inTransaction(), false);
    fake.calls.length = 0;
    await client.prepare('SELECT v FROM t WHERE k = ?').get('a');
    assert.equal(fake.calls[0].baton, undefined);
    assert.ok(fake.calls[0].requests.some((request) => request.type === 'close'));
  });

  test('a failed COMMIT leaves the client outside any transaction', async () => {
    const fake = createIsolatingFetch({ failOn: /^commit\b/i });
    const client = new TursoHttpClient('libsql://ex.turso.io', 'tok', { fetchImpl: fake.fetchImpl });
    await assert.rejects(
      () => client.transaction(async () => {
        await client.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('a', '1');
      })(),
      /forced failure/
    );
    assert.equal(client.inTransaction(), false);
    fake.calls.length = 0;
    fake.failOn = null;
    await client.prepare('SELECT v FROM t WHERE k = ?').get('a');
    assert.equal(fake.calls[0].baton, undefined);
    assert.equal(await client.prepare('SELECT v FROM t WHERE k = ?').get('a'), undefined);
  });

  test('a rotated baton is rejected when presented again', async () => {
    const fake = createIsolatingFetch();
    const client = new TursoHttpClient('libsql://ex.turso.io', 'tok', { fetchImpl: fake.fetchImpl });
    await client.transaction(async () => {
      await client.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('a', '1');
      await client.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('c', '3');
    })();
    const used = fake.calls.map((body) => body.baton).filter(Boolean);
    assert.ok(used.length >= 2);
    assert.notEqual(used[0], used[1]);
    const stale = await fake.fetchImpl('https://ex.turso.io/v2/pipeline', {
      body: JSON.stringify({
        baton: used[0],
        requests: [{ type: 'execute', stmt: { sql: 'SELECT 1' } }]
      })
    });
    assert.equal(stale.status, 400);
    const text = await stale.text();
    assert.match(text, /stale or unknown baton/);
  });

  test('batch sends BEGIN and COMMIT in one pipeline and does not keep a baton', async () => {
    const calls = [];
    const fetchImpl = mockPipelineBySql(() => ({ cols: [], rows: [], affected_row_count: 1 }), calls);
    const client = new TursoHttpClient('libsql://ex.turso.io', 'tok', { fetchImpl });
    await client.batch([
      { sql: 'INSERT INTO t (k) VALUES (?)', args: ['a'] },
      { sql: 'INSERT INTO t (k) VALUES (?)', args: ['b'] }
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].baton, undefined);
    assert.equal(calls[0].requests[0].stmt.sql, 'BEGIN');
    assert.equal(calls[0].requests.at(-2).stmt.sql, 'COMMIT');
    assert.equal(calls[0].requests.at(-1).type, 'close');
  });
});

function sqlIncludes(body, fragment) {
  return (body?.requests || []).some((request) => String(request.stmt?.sql || '').includes(fragment));
}

function bodyHasArg(body, value) {
  return (body?.requests || []).some((request) => (request.stmt?.args || []).some((arg) => arg?.value === value));
}

/**
 * One committed map, plus a stream per baton. Each response rotates the
 * baton. A reused or unknown baton is rejected. A statement with no baton
 * reads only committed rows.
 */
function createIsolatingFetch({ failOn = null } = {}) {
  const calls = [];
  let seq = 0;
  const committed = new Map();
  const streams = new Map();
  const stale = new Set();
  const state = { failOn };
  let streamSeq = 0;

  function readMap(map, key) {
    if (!map.has(key)) return undefined;
    return { v: map.get(key) };
  }

  function resultFor(sql, args, map) {
    if (/^select\s+v\s+from\s+t\b/i.test(sql)) {
      const key = args[0]?.value;
      const row = readMap(map, key);
      return {
        cols: [{ name: 'v' }],
        rows: row ? [[{ type: 'text', value: row.v }]] : [],
        affected_row_count: 0
      };
    }
    if (/^insert\b/i.test(sql)) {
      const key = args[0]?.value;
      const value = args[1]?.value;
      if (key != null) map.set(key, value);
      return { cols: [], rows: [], affected_row_count: 1, last_insert_rowid: '1' };
    }
    if (/last_insert_rowid/i.test(sql)) {
      return {
        cols: [{ name: 'id' }],
        rows: [[{ type: 'integer', value: '1' }]],
        affected_row_count: 0
      };
    }
    return { cols: [], rows: [], affected_row_count: 0 };
  }

  function rotate(baton) {
    const stream = streams.get(baton);
    streams.delete(baton);
    stale.add(baton);
    const next = `baton-${++seq}`;
    streams.set(next, stream);
    return next;
  }

  function rejected(message) {
    return {
      status: 400,
      ok: false,
      async text() {
        return message;
      }
    };
  }

  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const requests = body.requests || [];
    if (state.failOn && requests.some((request) => state.failOn.test(String(request.stmt?.sql || '')))) {
      return {
        status: 500,
        ok: false,
        async text() {
          return 'forced failure';
        }
      };
    }

    const closing = requests.some((request) => request.type === 'close');
    let baton = body.baton || null;
    let map;
    let stream = null;
    if (baton) {
      if (stale.has(baton) || !streams.has(baton)) {
        return rejected('stale or unknown baton');
      }
      stream = streams.get(baton);
      map = stream.map;
    } else if (!closing) {
      baton = `baton-${++seq}`;
      stream = { id: `stream-${++streamSeq}`, map: new Map(committed) };
      streams.set(baton, stream);
      map = stream.map;
    } else {
      map = committed;
    }
    body.streamId = stream?.id;

    const results = [];
    for (const request of requests) {
      if (request.type === 'close') {
        results.push({ type: 'ok', response: { type: 'close' } });
        continue;
      }
      const sql = String(request.stmt?.sql || '');
      const args = request.stmt?.args || [];
      if (/^commit\b/i.test(sql) && baton && streams.has(baton)) {
        const current = streams.get(baton);
        committed.clear();
        for (const [key, value] of current.map) committed.set(key, value);
        streams.delete(baton);
        stale.add(baton);
        baton = null;
      } else if (/^rollback\b/i.test(sql) && !/^rollback\s+to\b/i.test(sql) && baton && streams.has(baton)) {
        streams.delete(baton);
        stale.add(baton);
        baton = null;
      }
      const live = baton && streams.has(baton) ? streams.get(baton).map : map;
      results.push({
        type: 'ok',
        response: {
          type: 'execute',
          result: resultFor(sql, args, live)
        }
      });
    }

    const responseBaton = baton && streams.has(baton) ? rotate(baton) : null;
    return {
      status: 200,
      ok: true,
      async text() {
        return JSON.stringify({ baton: responseBaton, results });
      }
    };
  };

  return {
    fetchImpl,
    calls,
    get failOn() {
      return state.failOn;
    },
    set failOn(value) {
      state.failOn = value;
    }
  };
}

function mockPipelineBySql(handler, calls = []) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const results = [];
    for (const request of body.requests) {
      if (request.type === 'close') {
        results.push({ type: 'ok', response: { type: 'close' } });
        continue;
      }
      if (request.type === 'execute') {
        results.push({
          type: 'ok',
          response: {
            type: 'execute',
            result: handler(request.stmt.sql, request.stmt.args || [])
          }
        });
      }
    }
    const last = body.requests[body.requests.length - 1];
    return {
      status: 200,
      ok: true,
      async text() {
        return JSON.stringify({
          baton: last?.type !== 'close' ? 'baton-1' : null,
          results
        });
      }
    };
  };
}
