import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { toCents } from '../../client/src/money.js';
import { createApp } from './app.js';
import { applySchema, createMemoryDatabase, schemaPath } from './db.js';
import { loadDbConfig } from './dbConfig.js';
import { convertRequisitionToPurchaseOrders } from './purchaseOrdersService.js';
import { sourcingEnabled, parseDeadline } from './sourcingConfig.js';
import { assertTransition, canTransition, publishBlockers, SourcingStatusError } from './sourcingStatus.js';
import { SqliteAdapter } from './sqliteAdapter.js';
import { withCookie } from './testSession.js';
import { TursoHttpClient } from './tursoHttp.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address();
        await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve());
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

async function json(response) {
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, headers: response.headers };
}

async function withFlag(value, fn) {
  const prev = process.env.SOURCING_ENABLED;
  if (value == null) delete process.env.SOURCING_ENABLED;
  else process.env.SOURCING_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (prev == null) delete process.env.SOURCING_ENABLED;
    else process.env.SOURCING_ENABLED = prev;
  }
}

function authHeaders(userId, extra = {}) {
  return withCookie(userId, { headers: extra }).headers;
}

async function seedWorld(db) {
  await db.prepare(`
    INSERT INTO departments (id, code, name) VALUES
      (1, 'MKT', 'Marketing'),
      (2, 'FIN', 'Finance')
  `).run();
  await db.prepare(`
    INSERT INTO users (id, name, email, role, department_id, title, status) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Specialist', 'active'),
      (2, 'Bob Approver', 'bob@example.com', 'approver', 1, 'Head', 'active'),
      (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Buyer', 'active'),
      (4, 'David Miller', 'david@example.com', 'finance', 2, 'Controller', 'active'),
      (5, 'Elena Rostova', 'elena@example.com', 'admin', 2, 'CFO', 'active'),
      (6, 'Frank Buyer', 'frank@example.com', 'procurement', 1, 'Buyer', 'active')
  `).run();
  await db.prepare(`
    INSERT INTO suppliers (id, name, code, contact_person, email, status) VALUES
      (1, 'Default Vendor', 'DEF', 'Pat', 'pat@default.test', 'active'),
      (2, 'Active Supply', 'ACT', 'Ann', 'ann@active.test', 'active'),
      (3, 'Paused Supply', 'PAU', 'Paul', 'paul@paused.test', 'inactive')
  `).run();
}

async function insertApprovedPr(db, { supplierId = 1, unitPrice = 129550, quantity = 2 } = {}) {
  const result = await db.prepare(`
    INSERT INTO purchase_requisitions (
      pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date, priority
    ) VALUES ('PR-2026-041', 1, 1, 'approved', ?, 'Ergonomic chairs', '2026-12-01', 'Medium')
  `).run(unitPrice * quantity);
  const prId = Number(result.lastInsertRowid);
  await db.prepare(`
    INSERT INTO requisition_items (
      requisition_id, item_description, category, quantity, unit_price, total_price, estimated_supplier_id, line_type
    ) VALUES (?, 'Task chair', 'Office Supplies', ?, ?, ?, ?, 'goods')
  `).run(prId, quantity, unitPrice, unitPrice * quantity, supplierId);
  return prId;
}

function appFor(db) {
  return createApp({ db, config: loadDbConfig({}) });
}

describe('sourcing status machine', () => {
  const legal = [
    ['draft', 'published'],
    ['draft', 'cancelled'],
    ['published', 'closed'],
    ['published', 'cancelled'],
    ['closed', 'evaluated'],
    ['closed', 'cancelled'],
    ['evaluated', 'awarded'],
    ['evaluated', 'cancelled']
  ];

  test('allows only the documented edges and fails closed otherwise', () => {
    for (const [from, to] of legal) {
      assert.equal(canTransition(from, to), true);
      assert.doesNotThrow(() => assertTransition(from, to));
    }
    const illegal = [
      ['draft', 'closed'],
      ['draft', 'draft'],
      ['published', 'awarded'],
      ['published', 'evaluated'],
      ['closed', 'published'],
      ['evaluated', 'published'],
      ['awarded', 'cancelled'],
      ['awarded', 'closed'],
      ['cancelled', 'draft'],
      ['mystery', 'draft'],
      ['draft', 'mystery']
    ];
    for (const [from, to] of illegal) {
      assert.equal(canTransition(from, to), false);
      assert.throws(() => assertTransition(from, to), SourcingStatusError);
    }
  });

  test('publish blockers require a line, an invitation, weights, and one hour of lead time', () => {
    const now = new Date('2026-10-08T12:00:00.000Z');
    const event = {
      status: 'draft',
      weight_price: 70,
      weight_lead_time: 15,
      weight_quality: 15,
      deadline_at: '2026-10-08T13:00:00.000Z'
    };
    assert.deepEqual(publishBlockers(event, { now, lineCount: 1, invitationCount: 1 }), []);
    assert.ok(publishBlockers(event, { now, lineCount: 0, invitationCount: 1 }).includes('publish_needs_line'));
    assert.ok(publishBlockers({ ...event, deadline_at: '2026-10-08T12:30:00.000Z' }, {
      now, lineCount: 1, invitationCount: 1
    }).includes('deadline_too_soon'));
  });
});

describe('sourcing deadlines and flag', () => {
  test('naive datetimes are Europe/Amsterdam and absolute instants stay UTC', () => {
    assert.equal(parseDeadline('2026-01-15T12:00'), '2026-01-15T11:00:00.000Z');
    assert.equal(parseDeadline('2026-07-15T12:00'), '2026-07-15T10:00:00.000Z');
    assert.equal(parseDeadline('2026-10-08T12:00:00.000Z'), '2026-10-08T12:00:00.000Z');
    assert.equal(parseDeadline(''), null);
    assert.equal(parseDeadline('tomorrow'), undefined);
  });

  test('SOURCING_ENABLED defaults off and accepts only the usual truthy words', () => {
    assert.equal(sourcingEnabled({}), false);
    assert.equal(sourcingEnabled({ SOURCING_ENABLED: '' }), false);
    assert.equal(sourcingEnabled({ SOURCING_ENABLED: '0' }), false);
    assert.equal(sourcingEnabled({ SOURCING_ENABLED: 'false' }), false);
    assert.equal(sourcingEnabled({ SOURCING_ENABLED: 'maybe' }), false);
    assert.equal(sourcingEnabled({ SOURCING_ENABLED: '1' }), true);
    assert.equal(sourcingEnabled({ SOURCING_ENABLED: 'true' }), true);
    assert.equal(sourcingEnabled({ SOURCING_ENABLED: 'YES' }), true);
  });

  test('comma major units become integer cents before they are stored', () => {
    assert.equal(toCents('1.295,50'), 129550);
  });
});

describe('sourcing schema', () => {
  test('applying the schema twice drops nothing and keeps a pre-sourcing database', async () => {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const marker = schema.indexOf('-- Sourcing (RFQ)');
    assert.ok(marker > 0);
    const block = schema.slice(marker).replace(/--[^\n]*/g, '');
    assert.doesNotMatch(block, /\bDROP\b/i);
    assert.doesNotMatch(block, /\bALTER\s+TABLE\b/i);
    assert.match(block, /CREATE TABLE IF NOT EXISTS sourcing_events/);
    assert.match(block, /CREATE TABLE IF NOT EXISTS sourcing_file_blobs/);

    const db = await createMemoryDatabase();
    await db.prepare(`INSERT INTO departments (code, name) VALUES ('IT', 'IT')`).run();
    const before = await db.prepare(`SELECT COUNT(*) AS n FROM departments`).get();
    const sqlBefore = await db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'sourcing_events'`).get();
    await applySchema(db);
    const after = await db.prepare(`SELECT COUNT(*) AS n FROM departments`).get();
    const sqlAfter = await db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'sourcing_events'`).get();
    assert.equal(Number(after.n), Number(before.n));
    assert.equal(sqlAfter.sql, sqlBefore.sql);
    const blob = await db.prepare(`SELECT name FROM sqlite_master WHERE name = 'sourcing_file_blobs'`).get();
    assert.equal(blob.name, 'sourcing_file_blobs');

    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    raw.exec(schema.slice(0, marker));
    raw.prepare(`INSERT INTO departments (id, code, name) VALUES (1, 'FIN', 'Finance')`).run();
    raw.prepare(`
      INSERT INTO users (id, name, email, role, department_id, status)
      VALUES (1, 'Keep Me', 'keep@example.com', 'admin', 1, 'active')
    `).run();
    const adapter = new SqliteAdapter(raw);
    await applySchema(adapter);
    const user = await adapter.prepare(`SELECT name FROM users WHERE id = 1`).get();
    assert.equal(user.name, 'Keep Me');
    const dept = await adapter.prepare(`SELECT COUNT(*) AS n FROM departments`).get();
    assert.equal(Number(dept.n), 1);
    const table = await adapter.prepare(`SELECT name FROM sqlite_master WHERE name = 'sourcing_events'`).get();
    assert.equal(table.name, 'sourcing_events');
    const kept = await adapter.prepare(`SELECT COUNT(*) AS n FROM users`).get();
    assert.equal(Number(kept.n), 1);
  });

  test('database checks reject bad weights, a late bid, and an updated revision', async () => {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const now = '2026-10-08T12:00:00.000Z';
    assert.throws(() => db.prepare(`
      INSERT INTO sourcing_events (
        event_number, title, department_id, owner_user_id, status, currency,
        weight_price, weight_lead_time, weight_quality, created_at, updated_at
      ) VALUES ('RFQ-2026-900', 'Bad weights', 1, 3, 'draft', 'EUR', 70, 15, 20, ?, ?)
    `).run(now, now), /weight_price/);

    await db.prepare(`
      INSERT INTO sourcing_events (
        event_number, title, department_id, owner_user_id, status, currency, deadline_at,
        created_at, updated_at
      ) VALUES ('RFQ-2026-901', 'Published', 1, 3, 'published', 'EUR', '2026-01-01T00:00:00.000Z', ?, ?)
    `).run(now, now);
    const event = await db.prepare(`SELECT id FROM sourcing_events WHERE event_number = 'RFQ-2026-901'`).get();
    await db.prepare(`
      INSERT INTO sourcing_event_lines (event_id, line_no, description, category, quantity)
      VALUES (?, 1, 'Chair', 'Office Supplies', 1)
    `).run(event.id);
    const line = await db.prepare(`SELECT id FROM sourcing_event_lines WHERE event_id = ?`).get(event.id);
    await db.prepare(`
      INSERT INTO sourcing_invitations (
        event_id, supplier_id, contact_email, invited_by_user_id, created_at
      ) VALUES (?, 2, 'ann@active.test', 3, ?)
    `).run(event.id, now);
    const invitation = await db.prepare(`SELECT id FROM sourcing_invitations WHERE event_id = ?`).get(event.id);
    await db.prepare(`
      INSERT INTO sourcing_bids (
        event_id, invitation_id, supplier_id, first_submitted_at, last_submitted_at
      ) VALUES (?, ?, 2, ?, ?)
    `).run(event.id, invitation.id, '2025-12-31T23:00:00.000Z', '2025-12-31T23:00:00.000Z');
    const bid = await db.prepare(`SELECT id FROM sourcing_bids WHERE event_id = ?`).get(event.id);
    await db.prepare(`
      INSERT INTO sourcing_bid_revisions (
        bid_id, revision, submission_id, total_cents, quoted_line_count, content_sha256, submitted_at
      ) VALUES (?, 1, 'sub-1', 100, 1, 'abc', '2025-12-31T23:59:59.000Z')
    `).run(bid.id);
    await db.prepare(`
      INSERT INTO sourcing_bid_lines (
        bid_id, revision, event_line_id, quoted, unit_price_cents, line_total_cents
      ) VALUES (?, 1, ?, 1, 100, 100)
    `).run(bid.id, line.id);
    assert.throws(() => db.prepare(`
      INSERT INTO sourcing_bid_revisions (
        bid_id, revision, submission_id, total_cents, quoted_line_count, content_sha256, submitted_at
      ) VALUES (?, 2, 'sub-2', 100, 1, 'def', '2026-01-01T00:00:00.000Z')
    `).run(bid.id), /deadline/);
    assert.throws(() => db.prepare(`
      UPDATE sourcing_bid_revisions SET total_cents = 1 WHERE bid_id = ?
    `).run(bid.id), /append-only/);
  });
});

function bindPipelineArgs(args) {
  return (args || []).map((arg) => {
    if (!arg || arg.type === 'null') return null;
    if (arg.type === 'integer') return Number(arg.value);
    if (arg.type === 'float') return Number(arg.value);
    if (arg.type === 'blob') return Buffer.from(arg.base64 || '', 'base64');
    return arg.value ?? null;
  });
}

function pipelineCell(value) {
  if (value == null) return { type: 'null' };
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { type: 'integer', value: String(value) }
      : { type: 'float', value };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: 'blob', base64: Buffer.from(value).toString('base64') };
  }
  return { type: 'text', value: String(value) };
}

function runPipelineSql(db, sql, args) {
  const text = String(sql || '').trim();
  if (/^(begin|commit|rollback|savepoint|release)\b/i.test(text)) {
    db.exec(text);
    return { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: '0' };
  }
  const stmt = db.prepare(text);
  const bound = bindPipelineArgs(args);
  if (stmt.reader) {
    const rows = stmt.all(...bound);
    const cols = stmt.columns().map((col) => ({ name: col.name }));
    return {
      cols,
      rows: rows.map((row) => cols.map((col) => pipelineCell(row[col.name]))),
      affected_row_count: 0,
      last_insert_rowid: '0'
    };
  }
  const result = stmt.run(...bound);
  return {
    cols: [],
    rows: [],
    affected_row_count: Number(result.changes || 0),
    last_insert_rowid: String(result.lastInsertRowid ?? 0)
  };
}

function startFilePipeline(file) {
    const autocommit = new Database(file);
    autocommit.pragma('journal_mode = WAL');
    autocommit.pragma('foreign_keys = ON');
    autocommit.pragma('busy_timeout = 0');
  const streams = new Map();
  const calls = [];
  let seq = 0;
  let writer = null;
  const waiters = [];

  function openStream() {
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 0');
    const id = `baton-${++seq}`;
    const stream = { id, db, writing: false };
    streams.set(id, stream);
    return stream;
  }

  function acquire(stream) {
    if (writer == null) {
      writer = stream;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiters.push(() => {
        writer = stream;
        resolve();
      });
    });
  }

  function release(stream) {
    if (writer !== stream) return;
    const next = waiters.shift();
    if (next) next();
    else writer = null;
  }

  async function handle(body) {
    let stream = null;
    if (body.baton) {
      stream = streams.get(body.baton);
      if (!stream) {
        return {
          status: 400,
          payload: { message: 'stale or unknown baton' }
        };
      }
    }
    const results = [];
    for (const request of body.requests || []) {
      if (request.type === 'close') {
        if (stream) {
          if (stream.db.inTransaction) {
            try { stream.db.exec('ROLLBACK'); } catch { /* already closed */ }
          }
          if (stream.writing) release(stream);
          streams.delete(stream.id);
          stream.db.close();
          stream = null;
        }
        results.push({ type: 'ok', response: { type: 'close' } });
        continue;
      }
      const sql = String(request.stmt?.sql || '');
      const args = request.stmt?.args || [];
      if (/^begin\b/i.test(sql) && !stream) stream = openStream();
      const immediate = /^begin\s+immediate\b/i.test(sql);
      if (immediate) {
        await acquire(stream);
        stream.writing = true;
      }
      try {
        const result = runPipelineSql(stream ? stream.db : autocommit, sql, args);
        if (stream) calls.push({ sql, argc: args.length });
        results.push({ type: 'ok', response: { type: 'execute', result } });
      } catch (error) {
        if (immediate && stream?.writing) {
          stream.writing = false;
          release(stream);
        }
        results.push({
          type: 'error',
          error: { message: `${error.code || 'SQLITE_ERROR'}: ${error.message}` }
        });
        break;
      }
      if (/^(commit|rollback)\b/i.test(sql.trim()) && !/^rollback\s+to\b/i.test(sql)) {
        if (stream?.writing) {
          stream.writing = false;
          release(stream);
        }
      }
    }
    return { status: 200, payload: { baton: stream?.id || null, results } };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const outcome = await handle(body);
      res.writeHead(outcome.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(outcome.payload));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error?.message || error));
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close() {
          return new Promise((done) => {
            server.close(() => {
              for (const stream of streams.values()) {
                try { stream.db.close(); } catch { /* already closed */ }
              }
              try { autocommit.close(); } catch { /* already closed */ }
              done();
            });
          });
        }
      });
    });
    server.on('error', reject);
  });
}

describe('sourcing HTTP', () => {
  async function boot() {
    const db = await createMemoryDatabase();
    await seedWorld(db);
    const app = appFor(db);
    return { db, app };
  }

  test('hides the API when the flag is unset and leaves the rest of the API alone', async () => {
    const { db, app } = await boot();
    await withFlag(null, () => withServer(app, async (base) => {
      const health = await json(await fetch(`${base}/api/health`));
      assert.equal(health.status, 200);
      assert.equal(health.body.status, 'ok');

      const anon = await json(await fetch(`${base}/api/sourcing/events`));
      assert.equal(anon.status, 401);

      const admin = await json(await fetch(`${base}/api/sourcing/events`, { headers: authHeaders(5) }));
      assert.equal(admin.status, 503);
      assert.equal(admin.body.code, 'sourcing_disabled');

      const requisitions = await json(await fetch(`${base}/api/requisitions`, { headers: authHeaders(3) }));
      assert.equal(requisitions.status, 200);
      assert.ok(Array.isArray(requisitions.body));

      const prId = await insertApprovedPr(db);
      const detail = await json(await fetch(`${base}/api/requisitions/${prId}`, { headers: authHeaders(1) }));
      assert.equal(detail.status, 200);
      assert.equal(Object.hasOwn(detail.body, 'sourcing_event'), false);
    }));
    await db.close?.();
  });

  test('enforces the role matrix, owner edits, and draft cancel', async () => {
    const { app } = await boot();
    await withFlag('1', () => withServer(app, async (base) => {
      const anon = await json(await fetch(`${base}/api/sourcing/events`));
      assert.equal(anon.status, 401);

      for (const userId of [1, 2]) {
        const denied = await json(await fetch(`${base}/api/sourcing/events`, { headers: authHeaders(userId) }));
        assert.equal(denied.status, 403);
      }

      const financeGet = await json(await fetch(`${base}/api/sourcing/me`, { headers: authHeaders(4) }));
      assert.equal(financeGet.status, 200);
      assert.equal(financeGet.body.canSee, true);
      assert.equal(financeGet.body.canWrite, false);
      const financePost = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(4), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Nope' })
      }));
      assert.equal(financePost.status, 403);

      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Stoelen',
          description: 'Specificatie',
          category: 'Office Supplies',
          deadline_at: '2026-11-02T15:00',
          lines: [{
            description: 'Bureaustoel',
            category: 'Office Supplies',
            quantity: 4,
            target_unit_price_cents: 129550
          }],
          invitations: [{ supplier_id: 2 }]
        })
      }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.match(created.body.event_number, /^RFQ-\d{4}-001$/);
      assert.equal(created.body.status, 'draft');
      assert.equal(created.body.deadline_at, '2026-11-02T14:00:00.000Z');
      assert.equal(created.body.lines[0].target_unit_price_cents, 129550);
      assert.equal(created.body.invitations[0].contact_email, 'ann@active.test');
      assert.equal(created.body.invitations[0].supplier_code, 'ACT');
      assert.equal('token_hash' in created.body.invitations[0], false);

      const second = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Tweede', spec_only: true, category: 'Facilities & MRO' })
      }));
      assert.equal(second.status, 201);
      assert.match(second.body.event_number, /^RFQ-\d{4}-002$/);
      assert.equal(second.body.lines.length, 1);
      assert.equal(second.body.lines[0].description, 'Totaalprijs volgens specificatie');
      assert.equal(second.body.lines[0].service_basis, 'lump_sum');
      assert.equal(second.body.lines[0].quantity, 1);

      const stranger = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(6), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Kapen', row_version: created.body.row_version })
      }));
      assert.equal(stranger.status, 403);
      assert.equal(stranger.body.code, 'not_owner');

      const admin = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(5), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Stoelen Q4',
          row_version: created.body.row_version,
          weight_price: 60,
          weight_lead_time: 20,
          weight_quality: 20
        })
      }));
      assert.equal(admin.status, 200, JSON.stringify(admin.body));
      assert.equal(admin.body.title, 'Stoelen Q4');
      assert.equal(admin.body.weight_price, 60);

      const badWeights = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(5), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          row_version: admin.body.row_version,
          weight_price: 70,
          weight_lead_time: 20,
          weight_quality: 20
        })
      }));
      assert.equal(badWeights.status, 400);
      assert.equal(badWeights.body.code, 'weights_invalid');

      const removed = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}`, {
        method: 'DELETE',
        headers: authHeaders(5)
      }));
      assert.equal(removed.status, 405);

      const cancelled = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/cancel`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Niet meer nodig' })
      }));
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      assert.equal(cancelled.body.status, 'cancelled');
      const again = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/cancel`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Nog een keer' })
      }));
      assert.equal(again.status, 409);
      assert.equal(again.body.code, 'event_state_changed');
    }));
  });

  test('copies an approved requisition without the default supplier and locks convert', async () => {
    const { db, app } = await boot();
    const prId = await insertApprovedPr(db, { supplierId: 1, unitPrice: 129550, quantity: 3 });
    await withFlag('1', () => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events/from-requisition`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requisition_id: prId,
          estimated_supplier_id: 1,
          deadline_at: '2026-12-01T09:00'
        })
      }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.source_requisition_id, prId);
      assert.equal(created.body.lines.length, 1);
      assert.equal(created.body.lines[0].requisition_item_id > 0, true);
      assert.equal(created.body.lines[0].target_unit_price_cents, 129550);
      assert.equal(created.body.lines[0].quantity, 3);
      assert.equal(created.body.invitations.length, 0);
      assert.equal(JSON.stringify(created.body.lines).includes('estimated_supplier'), false);
      assert.equal(created.body.target_total_cents, 129550 * 3);

      const detail = await json(await fetch(`${base}/api/requisitions/${prId}`, { headers: authHeaders(1) }));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.sourcing_event.event_number, created.body.event_number);
      assert.equal(detail.body.sourcing_event.status, 'draft');

      const ledger = await db.prepare(`
        SELECT action, entity_type FROM compliance_audit_events WHERE action = 'SOURCING_EVENT_CREATED'
      `).get();
      assert.equal(ledger.entity_type, 'sourcing_event');
      const trail = await db.prepare(`
        SELECT action, details FROM audit_logs WHERE entity_type = 'sourcing_event' AND action = 'CREATED'
      `).get();
      assert.match(trail.details, /requisition/);

      const blocked = await json(await fetch(`${base}/api/purchase-orders/from-requisition`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ requisition_id: prId })
      }));
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.code, 'requisition_in_sourcing');

      const duplicate = await json(await fetch(`${base}/api/sourcing/events/from-requisition`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ requisition_id: prId })
      }));
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.body.code, 'requisition_in_sourcing');

      const cancelled = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/cancel`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Toch een bestelling' })
      }));
      assert.equal(cancelled.status, 200);
      const cleared = await json(await fetch(`${base}/api/requisitions/${prId}`, { headers: authHeaders(1) }));
      assert.equal(Object.hasOwn(cleared.body, 'sourcing_event'), false);

      const issued = await json(await fetch(`${base}/api/purchase-orders/from-requisition`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ requisition_id: prId })
      }));
      assert.equal(issued.status, 201, JSON.stringify(issued.body));
      assert.equal(issued.body.purchase_orders.length, 1);
      assert.equal(issued.body.purchase_orders[0].supplier_id, 1);
    }));
  });

  test('rejects too many lines, invitations, inactive suppliers, and non-integer money', async () => {
    const { db, app } = await boot();
    for (let n = 4; n <= 24; n += 1) {
      await db.prepare(`
        INSERT INTO suppliers (id, name, code, email, status) VALUES (?, ?, ?, ?, 'active')
      `).run(n, `Vendor ${n}`, `V${n}`, `v${n}@example.test`);
    }
    await withFlag('1', () => withServer(app, async (base) => {
      const lines = Array.from({ length: 51 }, (_, index) => ({
        description: `Line ${index + 1}`,
        category: 'Office Supplies',
        quantity: 1
      }));
      const tooManyLines = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Te veel regels', lines })
      }));
      assert.equal(tooManyLines.status, 400);
      assert.equal(tooManyLines.body.code, 'too_many_lines');

      const invitations = Array.from({ length: 21 }, (_, index) => ({ supplier_id: index + 4 }));
      const tooManyInvites = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Te veel leveranciers', invitations })
      }));
      assert.equal(tooManyInvites.status, 400);
      assert.equal(tooManyInvites.body.code, 'too_many_invitations');

      const inactive = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Inactief', invitations: [{ supplier_id: 3 }] })
      }));
      assert.equal(inactive.status, 400);
      assert.equal(inactive.body.code, 'supplier_not_active');

      const money = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Komma blijft buiten de API',
          lines: [{
            description: 'Stoel',
            category: 'Office Supplies',
            quantity: 1,
            target_unit_price_cents: '1.295,50'
          }]
        })
      }));
      assert.equal(money.status, 400);
      assert.equal(money.body.code, 'invalid_amount');

      const draftOnly = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Niet publiceren', status: 'published' })
      }));
      assert.equal(draftOnly.status, 409);
      assert.equal(draftOnly.body.code, 'invalid_transition');

      const tender = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Aanbesteding', kind: 'tender' })
      }));
      assert.equal(tender.status, 400);
      assert.equal(tender.body.code, 'kind_not_supported');
    }));
  });

  test('checks PDF magic, size, and the file cap, and list queries never read blobs', async () => {
    const { db, app } = await boot();
    await withFlag('1', () => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Met bijlagen' })
      }));
      assert.equal(created.status, 201);
      const eventId = created.body.id;
      const upload = (body, headers = {}) => fetch(`${base}/api/sourcing/events/${eventId}/files`, {
        method: 'POST',
        headers: {
          ...authHeaders(3),
          'Content-Type': 'application/pdf',
          'X-Filename': 'specificatie.pdf',
          ...headers
        },
        body
      });

      const fake = await json(await upload(Buffer.from('hello world')));
      assert.equal(fake.status, 400);
      assert.equal(fake.body.code, 'not_a_pdf');

      const wrongType = await json(await fetch(`${base}/api/sourcing/events/${eventId}/files`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'text/plain' },
        body: PDF
      }));
      assert.equal(wrongType.status, 400);
      assert.equal(wrongType.body.code, 'not_a_pdf');

      const prevCap = process.env.SOURCING_PDF_MAX_BYTES;
      process.env.SOURCING_PDF_MAX_BYTES = '16';
      try {
        const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(20, 1)]);
        const tooBig = await json(await upload(big));
        assert.equal(tooBig.status, 413);
        assert.equal(tooBig.body.code, 'file_too_large');
      } finally {
        if (prevCap == null) delete process.env.SOURCING_PDF_MAX_BYTES;
        else process.env.SOURCING_PDF_MAX_BYTES = prevCap;
      }

      let firstId = null;
      for (let n = 0; n < 10; n += 1) {
        const saved = await json(await upload(PDF, { 'X-Filename': `file-${n}.pdf` }));
        assert.equal(saved.status, 201, JSON.stringify(saved.body));
        assert.equal(saved.body.content_type, 'application/pdf');
        assert.equal('bytes' in saved.body, false);
        firstId = firstId || saved.body.id;
      }
      const eleventh = await json(await upload(PDF));
      assert.equal(eleventh.status, 400);
      assert.equal(eleventh.body.code, 'too_many_files');

      const original = db.prepare.bind(db);
      const blobReads = [];
      db.prepare = (sql) => {
        if (/sourcing_file_blobs/i.test(String(sql))) blobReads.push(String(sql));
        return original(sql);
      };
      try {
        const detail = await json(await fetch(`${base}/api/sourcing/events/${eventId}`, { headers: authHeaders(4) }));
        assert.equal(detail.status, 200);
        assert.equal(detail.body.files.length, 10);
        assert.equal(JSON.stringify(detail.body).includes('pdf_bytes'), false);
        const list = await json(await fetch(`${base}/api/sourcing/events`, { headers: authHeaders(4) }));
        assert.equal(list.status, 200);
        assert.equal(blobReads.length, 0);

        const download = await fetch(`${base}/api/sourcing/events/${eventId}/files/${firstId}`, {
          headers: authHeaders(4)
        });
        assert.equal(download.status, 200);
        assert.match(download.headers.get('content-type'), /application\/pdf/);
        assert.match(download.headers.get('content-disposition'), /attachment/);
        assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
        assert.match(download.headers.get('content-security-policy'), /frame-ancestors 'none'/);
        const bytes = Buffer.from(await download.arrayBuffer());
        assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
        assert.ok(blobReads.some((sql) => /sourcing_file_blobs/i.test(sql)));
      } finally {
        db.prepare = original;
      }
    }));
  });

  test('removing a draft file deletes the blob and download returns 404', async () => {
    const { db, app } = await boot();
    await withFlag('1', () => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Met een bijlage' })
      }));
      assert.equal(created.status, 201);
      const eventId = created.body.id;
      const upload = (name) => fetch(`${base}/api/sourcing/events/${eventId}/files`, {
        method: 'POST',
        headers: {
          ...authHeaders(3),
          'Content-Type': 'application/pdf',
          'X-Filename': name
        },
        body: PDF
      });
      const saved = await json(await upload('specificatie.pdf'));
      assert.equal(saved.status, 201, JSON.stringify(saved.body));
      const fileId = saved.body.id;

      const before = await fetch(`${base}/api/sourcing/events/${eventId}/files/${fileId}`, {
        headers: authHeaders(3)
      });
      assert.equal(before.status, 200);

      const removed = await json(await fetch(`${base}/api/sourcing/events/${eventId}/files/${fileId}/remove`, {
        method: 'POST',
        headers: authHeaders(3)
      }));
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      assert.ok(removed.body.removed_at);

      const download = await json(await fetch(`${base}/api/sourcing/events/${eventId}/files/${fileId}`, {
        headers: authHeaders(3)
      }));
      assert.equal(download.status, 404);
      assert.equal(download.body.code, 'file_not_found');

      const meta = await db.prepare(`
        SELECT id, filename, sha256, removed_at FROM sourcing_files WHERE id = ?
      `).get(fileId);
      assert.equal(meta.filename, 'specificatie.pdf');
      assert.equal(typeof meta.sha256, 'string');
      assert.ok(meta.removed_at);
      const blob = await db.prepare(`SELECT file_id FROM sourcing_file_blobs WHERE file_id = ?`).get(fileId);
      assert.equal(blob, undefined);
      const audit = await db.prepare(`
        SELECT action FROM audit_logs
        WHERE entity_type = 'sourcing_event' AND entity_id = ? AND action = 'FILE_REMOVED'
      `).get(eventId);
      assert.equal(audit.action, 'FILE_REMOVED');
      const ledger = await db.prepare(`
        SELECT action FROM compliance_audit_events
        WHERE entity_type = 'sourcing_event' AND entity_id = ? AND action = 'SOURCING_FILE_REMOVED'
      `).get(eventId);
      assert.equal(ledger.action, 'SOURCING_FILE_REMOVED');

      const again = await json(await upload('vervanging.pdf'));
      assert.equal(again.status, 201, JSON.stringify(again.body));
      const active = await db.prepare(`
        SELECT COUNT(*) AS n FROM sourcing_files
        WHERE event_id = ? AND owner_kind = 'event' AND removed_at IS NULL
      `).get(eventId);
      const stored = await db.prepare(`
        SELECT COUNT(*) AS n FROM sourcing_file_blobs b
        JOIN sourcing_files f ON f.id = b.file_id
        WHERE f.event_id = ?
      `).get(eventId);
      assert.equal(Number(active.n), 1);
      assert.equal(Number(stored.n), 1);
    }));
  });

  test('a published event cannot be cancelled through the draft transition', async () => {
    const { db, app } = await boot();
    const now = '2026-10-08T12:00:00.000Z';
    await db.prepare(`
      INSERT INTO sourcing_events (
        event_number, title, department_id, owner_user_id, status, currency, deadline_at, created_at, updated_at
      ) VALUES ('RFQ-2026-050', 'Live', 1, 3, 'published', 'EUR', '2099-01-01T00:00:00.000Z', ?, ?)
    `).run(now, now);
    const event = await db.prepare(`SELECT id FROM sourcing_events WHERE event_number = 'RFQ-2026-050'`).get();
    await withFlag('1', () => withServer(app, async (base) => {
      const cancelled = await json(await fetch(`${base}/api/sourcing/events/${event.id}/cancel`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Te vroeg' })
      }));
      assert.equal(cancelled.status, 409);
      assert.equal(cancelled.body.code, 'event_state_changed');
      const row = await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(event.id);
      assert.equal(row.status, 'published');
    }));
  });

  function capPayload(supplierIds) {
    const lines = Array.from({ length: 50 }, (_, index) => ({
      description: `Regel ${index + 1}`,
      category: 'Office Supplies',
      quantity: 1,
      line_type: 'goods',
      target_unit_price_cents: 100
    }));
    const invitations = supplierIds.map((id) => ({
      supplier_id: id,
      contact_email: `buyer-${id}@cap.test`
    }));
    return { lines, invitations };
  }

  async function seedCapSuppliers(db) {
    for (let n = 4; n <= 23; n += 1) {
      await db.prepare(`
        INSERT INTO suppliers (id, name, code, email, status) VALUES (?, ?, ?, ?, 'active')
      `).run(n, `Cap ${n}`, `CAP${n}`, `cap${n}@supply.test`);
    }
  }

  function watchTransactions(db) {
    const counts = [];
    let inTx = false;
    let current = 0;
    const origPrepare = db.prepare.bind(db);
    const origTransaction = db.transaction.bind(db);
    const origImmediate = db.immediateTransaction.bind(db);
    db.prepare = (sql) => {
      const stmt = origPrepare(sql);
      const count = (method) => (...args) => {
        if (inTx) current += 1;
        return stmt[method](...args);
      };
      return { run: count('run'), get: count('get'), all: count('all') };
    };
    const wrap = (factory) => (fn) => factory(async (...args) => {
      const outer = inTx;
      if (!outer) current = 0;
      inTx = true;
      try {
        return await fn(...args);
      } finally {
        inTx = outer;
        if (!outer) counts.push(current);
      }
    });
    db.transaction = wrap(origTransaction);
    db.immediateTransaction = wrap(origImmediate);
    return {
      counts,
      restore() {
        db.prepare = origPrepare;
        db.transaction = origTransaction;
        db.immediateTransaction = origImmediate;
      }
    };
  }

  test('a draft save at the caps stays within 25 statements', async () => {
    const { db, app } = await boot();
    await seedCapSuppliers(db);
    const supplierIds = [2, ...Array.from({ length: 19 }, (_, index) => index + 4)];
    const body = capPayload(supplierIds);
    const watch = watchTransactions(db);
    try {
      await withFlag('1', () => withServer(app, async (base) => {
        const created = await json(await fetch(`${base}/api/sourcing/events`, {
          method: 'POST',
          headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Vol tot de rand', ...body })
        }));
        assert.equal(created.status, 201, JSON.stringify(created.body));
        assert.equal(created.body.lines.length, 50);
        assert.equal(created.body.invitations.length, 20);
        const ledger = await db.prepare(`
          SELECT COUNT(*) AS n FROM compliance_audit_events
          WHERE entity_type = 'sourcing_event' AND entity_id = ? AND action = 'SOURCING_EVENT_CREATED'
        `).get(created.body.id);
        assert.equal(Number(ledger.n), 1);
        const perInvite = await db.prepare(`
          SELECT COUNT(*) AS n FROM compliance_audit_events WHERE action = 'SOURCING_INVITATION_CREATED'
        `).get();
        assert.equal(Number(perInvite.n), 0);

        const updated = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}`, {
          method: 'PATCH',
          headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Vol tot de rand, herzien',
            row_version: created.body.row_version,
            ...body
          })
        }));
        assert.equal(updated.status, 200, JSON.stringify(updated.body));
        assert.equal(updated.body.lines.length, 50);
        assert.equal(updated.body.invitations.length, 20);
        assert.deepEqual(
          updated.body.invitations.map((row) => row.id),
          created.body.invitations.map((row) => row.id)
        );
        const edited = await db.prepare(`
          SELECT action FROM compliance_audit_events
          WHERE entity_type = 'sourcing_event' AND entity_id = ? AND action = 'SOURCING_EVENT_UPDATED'
        `).get(created.body.id);
        assert.equal(edited.action, 'SOURCING_EVENT_UPDATED');
      }));
    } finally {
      watch.restore();
    }
    assert.equal(watch.counts.length, 2, JSON.stringify(watch.counts));
    for (const count of watch.counts) {
      assert.ok(count <= 25, `transaction used ${count} statements`);
      assert.ok(count > 0);
    }
  });

  test('parallel creates get distinct RFQ numbers and a UNIQUE collision retries', async () => {
    const { db, app } = await boot();
    await withFlag('1', () => withServer(app, async (base) => {
      const post = () => fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Gelijktijdig' })
      });
      const [first, second] = await Promise.all([json(await post()), json(await post())]);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.match(first.body.event_number, /^RFQ-\d{4}-\d{3}$/);
      assert.match(second.body.event_number, /^RFQ-\d{4}-\d{3}$/);
      assert.notEqual(first.body.event_number, second.body.event_number);

      const origPrepare = db.prepare.bind(db);
      let collisions = 0;
      db.prepare = (sql) => {
        const stmt = origPrepare(sql);
        if (!/INSERT INTO sourcing_events/i.test(String(sql))) return stmt;
        const run = stmt.run.bind(stmt);
        return {
          get: stmt.get.bind(stmt),
          all: stmt.all.bind(stmt),
          run: (...args) => {
            collisions += 1;
            if (collisions <= 2) {
              const error = new Error('UNIQUE constraint failed: sourcing_events.event_number');
              error.code = 'SQLITE_CONSTRAINT_UNIQUE';
              throw error;
            }
            return run(...args);
          }
        };
      };
      try {
        const retried = await json(await post());
        assert.equal(retried.status, 201, JSON.stringify(retried.body));
        assert.match(retried.body.event_number, /^RFQ-\d{4}-\d{3}$/);
        assert.ok(collisions >= 3);

        collisions = 0;
        db.prepare = (sql) => {
          const stmt = origPrepare(sql);
          if (!/INSERT INTO sourcing_events/i.test(String(sql))) return stmt;
          return {
            get: stmt.get.bind(stmt),
            all: stmt.all.bind(stmt),
            run: () => {
              collisions += 1;
              const error = new Error('UNIQUE constraint failed: sourcing_events.event_number');
              error.code = 'SQLITE_CONSTRAINT_UNIQUE';
              throw error;
            }
          };
        };
        const blocked = await json(await post());
        assert.equal(blocked.status, 409);
        assert.equal(blocked.body.code, 'event_number_conflict');
        assert.equal(collisions, 3);
        assert.equal(String(blocked.body.error).includes('UNIQUE constraint'), false);

        collisions = 0;
        db.prepare = (sql) => {
          const stmt = origPrepare(sql);
          if (!/INSERT INTO sourcing_events/i.test(String(sql))) return stmt;
          const run = stmt.run.bind(stmt);
          return {
            get: stmt.get.bind(stmt),
            all: stmt.all.bind(stmt),
            run: (...args) => {
              collisions += 1;
              if (collisions <= 2) {
                const error = new Error('database is locked');
                error.code = 'SQLITE_BUSY_SNAPSHOT';
                throw error;
              }
              return run(...args);
            }
          };
        };
        const retriedBusy = await json(await post());
        assert.equal(retriedBusy.status, 201, JSON.stringify(retriedBusy.body));
        assert.equal(JSON.stringify(retriedBusy.body).includes('database is locked'), false);
        assert.ok(collisions >= 3);

        collisions = 0;
        db.prepare = (sql) => {
          const stmt = origPrepare(sql);
          if (!/INSERT INTO sourcing_events/i.test(String(sql))) return stmt;
          return {
            get: stmt.get.bind(stmt),
            all: stmt.all.bind(stmt),
            run: () => {
              collisions += 1;
              const error = new Error('SQLITE_BUSY: database is locked');
              error.code = 'SQLITE_BUSY';
              throw error;
            }
          };
        };
        const locked = await json(await post());
        assert.equal(locked.status, 409);
        assert.equal(locked.body.code, 'event_number_conflict');
        assert.equal(collisions, 3);
        assert.equal(JSON.stringify(locked.body).includes('database is locked'), false);
        assert.equal(JSON.stringify(locked.body).includes('SQLITE_BUSY'), false);
      } finally {
        db.prepare = origPrepare;
      }
    }));
  });

  test('a stale row_version, another department, and a past deadline are reported', async () => {
    const { app } = await boot();
    await withFlag('1', () => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Versie', deadline_at: '2020-01-15T12:00' })
      }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.deepEqual(created.body.warnings, ['deadline_in_the_past']);

      const saved = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Versie 2', row_version: created.body.row_version })
      }));
      assert.equal(saved.status, 200, JSON.stringify(saved.body));

      const stale = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Versie 1', row_version: created.body.row_version })
      }));
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, 'event_state_changed');

      const otherDept = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Andere kostenplaats', department_id: 2 })
      }));
      assert.equal(otherDept.status, 403);
      assert.equal(otherDept.body.code, 'department_not_allowed');

      const admin = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(5), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Beheerder', department_id: 2 })
      }));
      assert.equal(admin.status, 201, JSON.stringify(admin.body));
      assert.equal(admin.body.department_id, 2);
    }));
  });

  test('active attachment bytes cannot pass 40 MiB, and a removed file does not count', async () => {
    const { db, app } = await boot();
    await withFlag('1', () => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Bijlagenplafond' })
      }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const ceiling = 40 * 1024 * 1024;
      await db.prepare(`
        INSERT INTO sourcing_files (
          event_id, owner_kind, filename, content_type, size_bytes, sha256, uploaded_by_user_id, created_at
        ) VALUES (?, 'event', 'al-vol.pdf', 'application/pdf', ?, ?, 3, '2026-10-08T12:00:00.000Z')
      `).run(created.body.id, ceiling - PDF.length + 1, 'a'.repeat(64));
      const upload = () => fetch(`${base}/api/sourcing/events/${created.body.id}/files`, {
        method: 'POST',
        headers: {
          ...authHeaders(3),
          'Content-Type': 'application/pdf',
          'X-Filename': 'extra.pdf'
        },
        body: PDF
      });
      const over = await json(await upload());
      assert.equal(over.status, 400);
      assert.equal(over.body.code, 'event_files_too_large');

      await db.prepare(`UPDATE sourcing_files SET removed_at = ? WHERE event_id = ?`).run(
        '2026-10-08T12:01:00.000Z',
        created.body.id
      );
      const after = await json(await upload());
      assert.equal(after.status, 201, JSON.stringify(after.body));
    }));
  });

  test('an unexpected failure returns a generic 500 and hides the detail', async () => {
    const { db, app } = await boot();
    const origPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const stmt = origPrepare(sql);
      if (!/FROM sourcing_events e/i.test(String(sql)) || !/owner_name/i.test(String(sql))) return stmt;
      return {
        get: stmt.get.bind(stmt),
        all: () => {
          throw new Error('secret turso pipeline detail');
        },
        run: stmt.run.bind(stmt)
      };
    };
    try {
      await withFlag('1', () => withServer(app, async (base) => {
        const listed = await json(await fetch(`${base}/api/sourcing/events`, { headers: authHeaders(3) }));
        assert.equal(listed.status, 500);
        assert.equal(listed.body.error, 'Sourcing request failed');
        assert.equal(listed.body.code, 'sourcing_error');
        assert.equal(JSON.stringify(listed.body).includes('secret'), false);
        assert.equal(JSON.stringify(listed.body).includes('pipeline'), false);
      }));
    } finally {
      db.prepare = origPrepare;
    }
  });

  test('a buyer can resave a requisition department and cannot move it', async () => {
    const { db, app } = await boot();
    const pr = await db.prepare(`
      INSERT INTO purchase_requisitions (
        pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date, priority
      ) VALUES ('PR-2026-077', 1, 2, 'approved', 1000, 'Andere kostenplaats', '2026-12-01', 'Medium')
    `).run();
    const prId = Number(pr.lastInsertRowid);
    await db.prepare(`
      INSERT INTO requisition_items (
        requisition_id, item_description, category, quantity, unit_price, total_price, estimated_supplier_id, line_type
      ) VALUES (?, 'Papier', 'Office Supplies', 1, 1000, 1000, 1, 'goods')
    `).run(prId);
    await withFlag('1', () => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events/from-requisition`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ requisition_id: prId, title: 'Van financiën' })
      }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.department_id, 2);

      const same = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Van financiën, herzien',
          department_id: 2,
          row_version: created.body.row_version
        })
      }));
      assert.equal(same.status, 200, JSON.stringify(same.body));
      assert.equal(same.body.department_id, 2);

      const moved = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          department_id: 1,
          row_version: same.body.row_version
        })
      }));
      assert.equal(moved.status, 409);
      assert.equal(moved.body.code, 'department_locked');

      const scratch = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Eigen kostenplaats' })
      }));
      assert.equal(scratch.status, 201, JSON.stringify(scratch.body));
      assert.equal(scratch.body.department_id, 1);
      const other = await json(await fetch(`${base}/api/sourcing/events/${scratch.body.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          department_id: 2,
          row_version: scratch.body.row_version
        })
      }));
      assert.equal(other.status, 403);
      assert.equal(other.body.code, 'department_not_allowed');
    }));
  });

  test('invitation ids stay put when a draft is saved again', async () => {
    const { db, app } = await boot();
    await db.prepare(`
      INSERT INTO suppliers (id, name, code, email, status) VALUES (4, 'Extra', 'EXT', 'extra@supply.test', 'active')
    `).run();
    await withFlag('1', () => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Uitnodigingen',
          invitations: [{ supplier_id: 2, contact_email: 'ann@active.test' }]
        })
      }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const keptId = created.body.invitations[0].id;

      const edited = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          row_version: created.body.row_version,
          invitations: [
            { supplier_id: 2, contact_email: 'buyer@active.test' },
            { supplier_id: 4, contact_email: 'extra@supply.test' }
          ]
        })
      }));
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      const still = edited.body.invitations.find((row) => row.supplier_id === 2);
      const added = edited.body.invitations.find((row) => row.supplier_id === 4);
      assert.equal(still.id, keptId);
      assert.equal(still.contact_email, 'buyer@active.test');
      assert.ok(added.id);
      assert.notEqual(added.id, keptId);

      const trimmed = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          row_version: edited.body.row_version,
          invitations: [{ supplier_id: 4, contact_email: 'extra@supply.test' }]
        })
      }));
      assert.equal(trimmed.status, 200, JSON.stringify(trimmed.body));
      assert.equal(trimmed.body.invitations.length, 1);
      assert.equal(trimmed.body.invitations[0].id, added.id);
    }));
  });

  test('removing a file re-checks draft status inside the write', async () => {
    const { db, app } = await boot();
    await withFlag('1', () => withServer(app, async (base) => {
      const created = await json(await fetch(`${base}/api/sourcing/events`, {
        method: 'POST',
        headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Bijlage race' })
      }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const upload = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}/files`, {
        method: 'POST',
        headers: {
          ...authHeaders(3),
          'Content-Type': 'application/pdf',
          'X-Filename': 'specificatie.pdf'
        },
        body: PDF
      }));
      assert.equal(upload.status, 201, JSON.stringify(upload.body));
      await db.prepare(`
        UPDATE sourcing_events SET status = 'published', deadline_at = ? WHERE id = ?
      `).run('2026-12-01T12:00:00.000Z', created.body.id);

      const origPrepare = db.prepare.bind(db);
      let lied = false;
      db.prepare = (sql) => {
        const stmt = origPrepare(sql);
        if (!lied && /SELECT \* FROM sourcing_events WHERE id/i.test(String(sql))) {
          return {
            get: async (...args) => {
              lied = true;
              const row = await stmt.get(...args);
              return row ? { ...row, status: 'draft' } : row;
            },
            all: stmt.all.bind(stmt),
            run: stmt.run.bind(stmt)
          };
        }
        return stmt;
      };
      try {
        const removed = await json(await fetch(
          `${base}/api/sourcing/events/${created.body.id}/files/${upload.body.id}/remove`,
          { method: 'POST', headers: authHeaders(3) }
        ));
        assert.equal(removed.status, 409);
        assert.equal(removed.body.code, 'event_state_changed');
        assert.equal(JSON.stringify(removed.body).includes('UNIQUE'), false);
      } finally {
        db.prepare = origPrepare;
      }
      const meta = await db.prepare(`SELECT removed_at FROM sourcing_files WHERE id = ?`).get(upload.body.id);
      const blob = await db.prepare(`SELECT file_id FROM sourcing_file_blobs WHERE file_id = ?`).get(upload.body.id);
      assert.equal(meta.removed_at, null);
      assert.equal(blob.file_id, upload.body.id);
    }));
  });

  async function openSeededTurso(extra) {
    const file = path.join(os.tmpdir(), `pf-rfq-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    const setup = new SqliteAdapter(new Database(file));
    setup.raw.pragma('journal_mode = WAL');
    setup.raw.pragma('foreign_keys = ON');
    await applySchema(setup);
    await seedWorld(setup);
    if (extra) await extra(setup);
    setup.raw.pragma('wal_checkpoint(TRUNCATE)');
    setup.close();
    const pipeline = await startFilePipeline(file);
    const client = new TursoHttpClient(pipeline.url, 'tok');
    return {
      app: appFor(client),
      client,
      pipeline,
      async close() {
        await pipeline.close();
        fs.rmSync(file, { force: true });
        for (const suffix of ['-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
      }
    };
  }

  test('five parallel creates on the Turso client get distinct RFQ numbers', async () => {
    const opened = await openSeededTurso();
    try {
      await withFlag('1', () => withServer(opened.app, async (base) => {
        const post = () => fetch(`${base}/api/sourcing/events`, {
          method: 'POST',
          headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Gelijktijdig' })
        }).then(json);
        const created = await Promise.all(Array.from({ length: 5 }, () => post()));
        const numbers = created.map((row) => {
          assert.equal(row.status, 201, JSON.stringify(row.body));
          assert.match(row.body.event_number, /^RFQ-\d{4}-\d{3}$/);
          return row.body.event_number;
        });
        assert.equal(new Set(numbers).size, 5);
      }));
    } finally {
      await opened.close();
    }
  });

  test('a capped draft save stays within 25 statements on the Turso client', async () => {
    const opened = await openSeededTurso((db) => seedCapSuppliers(db));
    const supplierIds = [2, ...Array.from({ length: 19 }, (_, index) => index + 4)];
    const body = capPayload(supplierIds);
    const watch = watchTransactions(opened.client);
    try {
      await withFlag('1', () => withServer(opened.app, async (base) => {
        const created = await json(await fetch(`${base}/api/sourcing/events`, {
          method: 'POST',
          headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Vol tot de rand', ...body })
        }));
        assert.equal(created.status, 201, JSON.stringify(created.body));
        assert.equal(created.body.lines.length, 50);
        assert.equal(created.body.invitations.length, 20);
        const updated = await json(await fetch(`${base}/api/sourcing/events/${created.body.id}`, {
          method: 'PATCH',
          headers: { ...authHeaders(3), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Vol tot de rand, herzien',
            row_version: created.body.row_version,
            ...body
          })
        }));
        assert.equal(updated.status, 200, JSON.stringify(updated.body));
        assert.deepEqual(
          updated.body.invitations.map((row) => row.id),
          created.body.invitations.map((row) => row.id)
        );
      }));
    } finally {
      watch.restore();
      await opened.close();
    }
    assert.equal(watch.counts.length, 2, JSON.stringify(watch.counts));
    for (const count of watch.counts) {
      assert.ok(count <= 25, `transaction used ${count} statements`);
      assert.ok(count > 0);
    }
    assert.ok(opened.pipeline.calls.some((call) => /^BEGIN IMMEDIATE\b/i.test(call.sql.trim())));
    const lineInserts = opened.pipeline.calls.filter((call) => /INSERT INTO sourcing_event_lines/i.test(call.sql));
    assert.ok(lineInserts.length >= 1);
    assert.equal(Math.max(...lineInserts.map((call) => call.argc)), 600);
  });

  test('convert still issues a PO when no RFQ points at the requisition', async () => {
    const { db } = await boot();
    const prId = await insertApprovedPr(db);
    await withFlag(null, async () => {
      const issued = await convertRequisitionToPurchaseOrders(db, { requisition_id: prId, created_by: 3 });
      assert.equal(issued.length, 1);
      assert.match(issued[0].poNumber, /^PO-/);
    });
  });
});
