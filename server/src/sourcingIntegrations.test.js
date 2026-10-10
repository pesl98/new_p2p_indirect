import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from './app.js';
import { createMemoryDatabase } from './db.js';
import { loadDbConfig } from './dbConfig.js';
import { withCookie } from './testSession.js';
import { watchPipeline } from './sourcingAwardFixtures.js';

const SECRET = '0123456789abcdef0123456789abcdef';

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', async () => {
      try {
        await fn(`http://127.0.0.1:${server.address().port}`);
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
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  return { status: response.status, body, headers: response.headers };
}

async function world() {
  const db = await createMemoryDatabase();
  await db.prepare(`INSERT INTO departments (id, code, name) VALUES (1, 'MKT', 'Marketing')`).run();
  await db.prepare(`
    INSERT INTO users (id, name, email, role, department_id, title, status) VALUES
      (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Buyer', 'active'),
      (5, 'Elena Rostova', 'elena@example.com', 'admin', 1, 'Admin', 'active')
  `).run();
  await db.prepare(`
    INSERT INTO suppliers (id, name, code, contact_person, email, status) VALUES
      (2, 'Active Supply', 'ACT', 'Ann', 'ann@active.test', 'active')
  `).run();
  await db.prepare(`
    INSERT INTO integration_entity_links (entity_type, external_id, entity_id, created_at, updated_at)
    VALUES ('supplier', 'ERP-ACT', 2, '2026-01-01', '2026-01-01')
  `).run();
  return db;
}

async function withEnv(fn) {
  const prev = { s: process.env.SOURCING_ENABLED, p: process.env.PORTAL_TOKEN_SECRET };
  process.env.SOURCING_ENABLED = '1';
  process.env.PORTAL_TOKEN_SECRET = SECRET;
  try { return await fn(); } finally {
    if (prev.s == null) delete process.env.SOURCING_ENABLED; else process.env.SOURCING_ENABLED = prev.s;
    if (prev.p == null) delete process.env.PORTAL_TOKEN_SECRET; else process.env.PORTAL_TOKEN_SECRET = prev.p;
  }
}

async function issueKey(base, scopes, userId = 5) {
  const response = await json(await fetch(`${base}/api/integrations/keys`, withCookie(userId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ERP RFQ', scopes })
  })));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.token || response.body.key;
}

const auth = (token, extra = {}) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra });
const DRAFT = {
  external_id: 'ERP-RFQ-1',
  title: 'Stoelen',
  deadline_at: '2026-10-30T14:00:00.000Z',
  lines: [{ description: 'Stoel', category: 'Office Supplies', quantity: 2 }],
  invitations: [{ supplier_external_id: 'ERP-ACT' }]
};

describe('sourcing machine API', () => {
  test('scopes are enforced and a key cannot publish or award', async () => {
    const db = await world();
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date('2026-10-08T12:00:00Z') });
    await withEnv(() => withServer(app, async (base) => {
      const readKey = await issueKey(base, ['sourcing:read']);
      const writeKey = await issueKey(base, ['sourcing:write']);
      const noKey = await json(await fetch(`${base}/api/integrations/sourcing/events`));
      assert.equal(noKey.status, 401);
      const wrongScope = await json(await fetch(`${base}/api/integrations/sourcing/events`, { headers: auth(writeKey) }));
      assert.equal(wrongScope.status, 403);
      const readCannotWrite = await json(await fetch(`${base}/api/integrations/sourcing/events`, {
        method: 'POST', headers: auth(readKey), body: JSON.stringify(DRAFT)
      }));
      assert.equal(readCannotWrite.status, 403);
      const created = await json(await fetch(`${base}/api/integrations/sourcing/events`, {
        method: 'POST', headers: auth(writeKey), body: JSON.stringify(DRAFT)
      }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const number = created.body.event_number;
      for (const action of ['publish', 'award', 'cancel']) {
        const response = await fetch(`${base}/api/integrations/sourcing/events/${number}/${action}`, {
          method: 'POST', headers: auth(writeKey), body: '{}'
        });
        assert.ok([404, 405].includes(response.status), `${action} => ${response.status}`);
      }
      const spoof = await json(await fetch(`${base}/api/integrations/sourcing/events`, {
        method: 'POST', headers: auth(writeKey), body: JSON.stringify({ ...DRAFT, external_id: 'X2', status: 'published' })
      }));
      assert.equal(spoof.status, 400);
      const ev = await db.prepare(`SELECT status FROM sourcing_events WHERE event_number = ?`).get(number);
      assert.equal(ev.status, 'draft');
    }));
  });

  test('create is idempotent on external_id and Idempotency-Key; invitees can be added to a draft', async () => {
    const db = await world();
    await db.prepare(`
      INSERT INTO suppliers (id, name, code, contact_person, email, status) VALUES (4, 'Other', 'OTH', 'Otto', 'otto@o.test', 'active')
    `).run();
    await db.prepare(`
      INSERT INTO integration_entity_links (entity_type, external_id, entity_id, created_at, updated_at)
      VALUES ('supplier', 'ERP-OTH', 4, '2026-01-01', '2026-01-01')
    `).run();
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date('2026-10-08T12:00:00Z') });
    await withEnv(() => withServer(app, async (base) => {
      const key = await issueKey(base, ['sourcing:write', 'sourcing:read']);
      const first = await json(await fetch(`${base}/api/integrations/sourcing/events`, {
        method: 'POST', headers: auth(key, { 'Idempotency-Key': 'k1' }), body: JSON.stringify(DRAFT)
      }));
      assert.equal(first.status, 201);
      const keyReplay = await json(await fetch(`${base}/api/integrations/sourcing/events`, {
        method: 'POST', headers: auth(key, { 'Idempotency-Key': 'k1' }), body: JSON.stringify(DRAFT)
      }));
      assert.equal(keyReplay.headers.get('idempotent-replayed'), 'true');
      const extReplay = await json(await fetch(`${base}/api/integrations/sourcing/events`, {
        method: 'POST', headers: auth(key, { 'Idempotency-Key': 'k2' }), body: JSON.stringify(DRAFT)
      }));
      assert.equal(extReplay.status, 200);
      assert.equal(extReplay.body.event_number, first.body.event_number);
      const count = await db.prepare(`SELECT COUNT(*) AS n FROM sourcing_events`).get();
      assert.equal(Number(count.n), 1);

      const added = await json(await fetch(`${base}/api/integrations/sourcing/events/${first.body.event_number}/invitations`, {
        method: 'POST', headers: auth(key), body: JSON.stringify({ invitations: [{ supplier_external_id: 'ERP-OTH' }] })
      }));
      assert.equal(added.status, 200, JSON.stringify(added.body));
      assert.deepEqual(added.body.invitations.map((row) => row.supplier_code), ['ACT', 'OTH']);
      const unknown = await json(await fetch(`${base}/api/integrations/sourcing/events/${first.body.event_number}/invitations`, {
        method: 'POST', headers: auth(key), body: JSON.stringify({ invitations: [{ supplier_external_id: 'NOPE' }] })
      }));
      assert.equal(unknown.status, 400);
    }));
  });

  test('read views are sealed before the deadline and expose no contacts, links or tokens', async () => {
    const db = await world();
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date('2026-10-08T12:00:00Z') });
    await withEnv(() => withServer(app, async (base) => {
      const key = await issueKey(base, ['sourcing:write', 'sourcing:read']);
      const created = await json(await fetch(`${base}/api/integrations/sourcing/events`, {
        method: 'POST', headers: auth(key), body: JSON.stringify(DRAFT)
      }));
      const number = created.body.event_number;
      const row = await db.prepare(`SELECT id, row_version FROM sourcing_events WHERE event_number = ?`).get(number);
      const published = await json(await fetch(`${base}/api/sourcing/events/${row.id}/publish`, {
        method: 'POST',
        headers: { ...withCookie(5).headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_version: row.row_version })
      }));
      assert.equal(published.status, 200, JSON.stringify(published.body));
      const detail = await json(await fetch(`${base}/api/integrations/sourcing/events/${number}`, { headers: auth(key) }));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.bids_sealed, true);
      assert.deepEqual(detail.body.bids, []);
      assert.equal(detail.body.external_id, 'ERP-RFQ-1');
      const text = JSON.stringify(detail.body);
      assert.doesNotMatch(text, /pfi_|portal|ann@active\.test|contact_email/);
      const list = await json(await fetch(`${base}/api/integrations/sourcing/events?status=published&updated_since=2020-01-01T00:00:00Z`, { headers: auth(key) }));
      assert.equal(list.body.events.length, 1);
      const award = await json(await fetch(`${base}/api/integrations/sourcing/events/${number}/award`, { headers: auth(key) }));
      assert.deepEqual(award.body, { award: null });
      const bad = await json(await fetch(`${base}/api/integrations/sourcing/events?status=nope`, { headers: auth(key) }));
      assert.equal(bad.status, 400);
    }));
  });

  async function manySuppliers(db, count) {
    for (let n = 1; n <= count; n += 1) {
      const id = 100 + n;
      await db.prepare(`INSERT INTO suppliers (id, name, code, contact_person, email, status) VALUES (?, ?, ?, 'X', ?, 'active')`)
        .run(id, `Sup ${id}`, `S${id}`, `s${id}@sup.test`);
      await db.prepare(`
        INSERT INTO integration_entity_links (entity_type, external_id, entity_id, created_at, updated_at)
        VALUES ('supplier', ?, ?, '2026-01-01', '2026-01-01')
      `).run(`ERP-S${id}`, id);
    }
  }
  const bigDraft = (externalId, lines, suppliers, offset = 0) => ({
    external_id: externalId,
    title: 'Groot',
    deadline_at: '2026-10-30T14:00:00.000Z',
    lines: Array.from({ length: lines }, (_, i) => ({ description: `Regel ${i + 1}`, category: 'Office Supplies', quantity: 1 })),
    invitations: Array.from({ length: suppliers }, (_, i) => ({ supplier_external_id: `ERP-S${101 + offset + i}` }))
  });

  test('create and add-invitees stay within the Turso statement budget at the caps', async () => {
    const db = await world();
    await manySuppliers(db, 40);
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date('2026-10-08T12:00:00Z') });
    await withEnv(() => withServer(app, async (base) => {
      const key = await issueKey(base, ['sourcing:write', 'sourcing:read']);
      const watch = watchPipeline(db);
      try {
        const small = await json(await fetch(`${base}/api/integrations/sourcing/events`, {
          method: 'POST', headers: auth(key, { 'Idempotency-Key': 'a' }),
          body: JSON.stringify(bigDraft('SMALL', 2, 2))
        }));
        assert.equal(small.status, 201, JSON.stringify(small.body));
        const big = await json(await fetch(`${base}/api/integrations/sourcing/events`, {
          method: 'POST', headers: auth(key, { 'Idempotency-Key': 'b' }),
          body: JSON.stringify(bigDraft('BIG', 50, 20))
        }));
        assert.equal(big.status, 201, JSON.stringify(big.body));
        assert.equal(big.body.lines.length, 50);
        assert.equal(big.body.invitations.length, 20);
        const empty = await json(await fetch(`${base}/api/integrations/sourcing/events`, {
          method: 'POST', headers: auth(key), body: JSON.stringify({ ...bigDraft('EMPTY', 1, 0) })
        }));
        assert.equal(empty.status, 201);
        const added = await json(await fetch(`${base}/api/integrations/sourcing/events/${empty.body.event_number}/invitations`, {
          method: 'POST', headers: auth(key, { 'Idempotency-Key': 'c' }),
          body: JSON.stringify({ invitations: Array.from({ length: 20 }, (_, i) => ({ supplier_external_id: `ERP-S${121 + i}` })) })
        }));
        assert.equal(added.status, 200, JSON.stringify(added.body));
        assert.equal(added.body.invitations.length, 20);
        const pipelines = watch.results.map((row) => row.pipeline);
        assert.ok(pipelines.length >= 3);
        assert.ok(Math.max(...pipelines) <= 25, `pipelines: ${pipelines.join(',')}`);
      } finally {
        watch.restore();
      }
      // Replays return the stored full response.
      const replay = await json(await fetch(`${base}/api/integrations/sourcing/events`, {
        method: 'POST', headers: auth(key, { 'Idempotency-Key': 'b' }), body: JSON.stringify(bigDraft('BIG', 50, 20))
      }));
      assert.equal(replay.headers.get('idempotent-replayed'), 'true');
      assert.equal(replay.body.lines.length, 50);
      const reused = await json(await fetch(`${base}/api/integrations/sourcing/events`, {
        method: 'POST', headers: auth(key, { 'Idempotency-Key': 'b' }), body: JSON.stringify(bigDraft('OTHER', 1, 1))
      }));
      assert.equal(reused.status, 409);
    }));
  });

  test('parallel creates all succeed with distinct RFQ numbers; the same external id creates one', async () => {
    const db = await world();
    await manySuppliers(db, 5);
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date('2026-10-08T12:00:00Z') });
    await withEnv(() => withServer(app, async (base) => {
      const key = await issueKey(base, ['sourcing:write']);
      const post = (externalId) => fetch(`${base}/api/integrations/sourcing/events`, {
        method: 'POST', headers: auth(key), body: JSON.stringify(bigDraft(externalId, 2, 2))
      }).then(json);
      const results = await Promise.all(['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map(post));
      assert.deepEqual(results.map((r) => r.status), [201, 201, 201, 201, 201, 201], JSON.stringify(results.map((r) => r.body)));
      assert.equal(new Set(results.map((r) => r.body.event_number)).size, 6);
      const same = await Promise.all([1, 2, 3, 4].map(() => post('SAME')));
      assert.ok(same.every((r) => r.status === 201 || r.status === 200), JSON.stringify(same.map((r) => r.status)));
      assert.equal(new Set(same.map((r) => r.body.event_number)).size, 1);
      const count = await db.prepare(`SELECT COUNT(*) AS n FROM sourcing_events`).get();
      assert.equal(Number(count.n), 7);
    }));
  });

  test('external ids are scoped per key; the audit records the key; award reads show approved awards only', async () => {
    const db = await world();
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date('2026-10-08T12:00:00Z') });
    await withEnv(() => withServer(app, async (base) => {
      const one = await issueKey(base, ['sourcing:write', 'sourcing:read']);
      const two = await issueKey(base, ['sourcing:write']);
      const a = await json(await fetch(`${base}/api/integrations/sourcing/events`, { method: 'POST', headers: auth(one), body: JSON.stringify(DRAFT) }));
      const b = await json(await fetch(`${base}/api/integrations/sourcing/events`, { method: 'POST', headers: auth(two), body: JSON.stringify(DRAFT) }));
      assert.equal(a.status, 201);
      assert.equal(b.status, 201);
      assert.notEqual(a.body.event_number, b.body.event_number);
      const audit = await db.prepare(`SELECT details FROM compliance_audit_events WHERE action = 'SOURCING_EVENT_CREATED' ORDER BY id`).all();
      assert.ok(audit.every((row) => /"api_key_id":\d+/.test(row.details)));
      // A pending award (with prices) is not shown to a key.
      const ev = await db.prepare(`SELECT id FROM sourcing_events WHERE event_number = ?`).get(a.body.event_number);
      await db.prepare(`
        INSERT INTO sourcing_awards (event_id, award_type, status, total_cents, is_lowest, comparison_snapshot_json, proposed_by_user_id, proposed_at)
        VALUES (?, 'full', 'pending_approval', 1000, 1, '{}', 3, '2026-10-08')
      `).run(ev.id);
      const award = await json(await fetch(`${base}/api/integrations/sourcing/events/${a.body.event_number}/award`, { headers: auth(one) }));
      assert.deepEqual(award.body, { award: null });
    }));
  });

  test('a read key stops working when its creator is demoted or deactivated', async () => {
    const db = await world();
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date('2026-10-08T12:00:00Z') });
    await withEnv(() => withServer(app, async (base) => {
      const readKey = await issueKey(base, ['sourcing:read']);
      const ok = await fetch(`${base}/api/integrations/sourcing/events`, { headers: auth(readKey) });
      assert.equal(ok.status, 200);
      await db.prepare(`UPDATE users SET role = 'requester' WHERE id = 5`).run();
      const demoted = await fetch(`${base}/api/integrations/sourcing/events`, { headers: auth(readKey) });
      assert.equal(demoted.status, 403);
      await db.prepare(`UPDATE users SET role = 'admin', status = 'inactive' WHERE id = 5`).run();
      const inactive = await fetch(`${base}/api/integrations/sourcing/events`, { headers: auth(readKey) });
      assert.equal(inactive.status, 403);
    }));
  });
});
