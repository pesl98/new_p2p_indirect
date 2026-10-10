import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from './app.js';
import { createMemoryDatabase } from './db.js';
import { loadDbConfig } from './dbConfig.js';
import { withCookie } from './testSession.js';

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
});
