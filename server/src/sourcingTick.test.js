import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from './app.js';
import { createMemoryDatabase } from './db.js';
import { loadDbConfig } from './dbConfig.js';
import { corsOptions } from './security.js';
import { withCookie } from './testSession.js';

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

async function withEnv(vars, fn) {
  const keys = Object.keys(vars);
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) { if (vars[key] == null) delete process.env[key]; else process.env[key] = vars[key]; }
  try { return await fn(); } finally {
    for (const key of keys) { if (prev[key] == null) delete process.env[key]; else process.env[key] = prev[key]; }
  }
}

/** fetch drops the Origin header, so use raw http. */
function rawGet(base, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${path}`, { headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.headers));
    });
    req.on('error', reject);
  });
}

const ENV = { SOURCING_ENABLED: '1', PORTAL_TOKEN_SECRET: '0123456789abcdef0123456789abcdef' };

async function dueWorld() {
  const db = await createMemoryDatabase();
  await db.prepare(`INSERT INTO departments (id, code, name) VALUES (1, 'MKT', 'Marketing')`).run();
  await db.prepare(`
    INSERT INTO users (id, name, email, role, department_id, title, status)
    VALUES (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Buyer', 'active')
  `).run();
  await db.prepare(`
    INSERT INTO sourcing_events (event_number, kind, title, department_id, owner_user_id, status, currency,
      deadline_at, weight_price, weight_lead_time, weight_quality, row_version, created_at, updated_at)
    VALUES ('RFQ-2026-001', 'rfq', 'Due', 1, 3, 'published', 'EUR', '2026-10-01T10:00:00.000Z', 70, 15, 15, 0, '2026-09-01', '2026-09-01')
  `).run();
  return db;
}

describe('sourcing tick', () => {
  test('needs CRON_SECRET, closes due events, and is idempotent', async () => {
    const db = await dueWorld();
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date('2026-10-08T12:00:00Z') });
    await withEnv({ ...ENV, CRON_SECRET: 'cron-secret-value-123' }, () => withServer(app, async (base) => {
      assert.equal((await fetch(`${base}/api/sourcing/tick`)).status, 401);
      assert.equal((await fetch(`${base}/api/sourcing/tick`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
      // A signed-in buyer without the secret is not enough.
      assert.equal((await fetch(`${base}/api/sourcing/tick`, withCookie(3, { method: 'POST' }))).status, 401);
      const headers = { Authorization: 'Bearer cron-secret-value-123' };
      const first = await fetch(`${base}/api/sourcing/tick`, { headers });
      assert.equal(first.status, 200);
      assert.equal((await first.json()).closed, 1);
      const again = await fetch(`${base}/api/sourcing/tick`, { method: 'POST', headers });
      assert.equal((await again.json()).closed, 0);
      const row = await db.prepare(`SELECT status FROM sourcing_events`).get();
      assert.equal(row.status, 'closed');
    }));
  });

  test('is off when CRON_SECRET is unset', async () => {
    const db = await dueWorld();
    const app = createApp({ db, config: loadDbConfig({}) });
    await withEnv({ ...ENV, CRON_SECRET: null }, () => withServer(app, async (base) => {
      const response = await fetch(`${base}/api/sourcing/tick`, { headers: { Authorization: 'Bearer ' } });
      assert.equal(response.status, 401);
    }));
  });
});

function receiver(delayMs) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers['x-procureflow-event-id']);
    req.resume();
    setTimeout(() => { res.statusCode = 200; res.end('ok'); }, delayMs);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    seen,
    url: `http://127.0.0.1:${server.address().port}/hook`,
    close: () => new Promise((r) => server.close(r))
  })));
}

async function addDueEvent(db, number) {
  await db.prepare(`
    INSERT INTO sourcing_events (event_number, kind, title, department_id, owner_user_id, status, currency,
      deadline_at, weight_price, weight_lead_time, weight_quality, row_version, created_at, updated_at)
    VALUES (?, 'rfq', 'Due', 1, 3, 'published', 'EUR', '2026-10-01T10:00:00.000Z', 70, 15, 15, 0, '2026-09-01', '2026-09-01')
  `).run(number);
}

describe('tick webhooks', () => {
  test('parallel ticks deliver each closed webhook exactly once (lease claim)', async () => {
    const db = await dueWorld();
    await addDueEvent(db, 'RFQ-2026-002');
    const hook = await receiver(400);
    const app = createApp({
      db, config: loadDbConfig({}), now: () => new Date('2026-10-08T12:00:00Z'),
      integrationConfig: { webhookTargetUrl: hook.url, webhookSigningSecret: 'secret', ready: true }
    });
    try {
      await withEnv({ ...ENV, CRON_SECRET: 'cron-secret-value-123' }, () => withServer(app, async (base) => {
        const headers = { Authorization: 'Bearer cron-secret-value-123' };
        const results = await Promise.all([1, 2, 3].map(() => fetch(`${base}/api/sourcing/tick`, { headers }).then((r) => r.json())));
        assert.equal(results.reduce((sum, r) => sum + r.closed, 0), 2, 'each RFQ is closed once');
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(hook.seen.length, 2, `deliveries: ${hook.seen.join(',')}`);
        assert.equal(new Set(hook.seen).size, 2);
        const rows = await db.prepare(`SELECT status, attempt_count FROM webhook_outbox`).all();
        assert.ok(rows.every((row) => row.status === 'delivered' && Number(row.attempt_count) === 1));
        // A later tick finds nothing to send.
        await fetch(`${base}/api/sourcing/tick`, { headers });
        assert.equal(hook.seen.length, 2);
      }));
    } finally {
      await hook.close();
    }
  });

  test('a close that fails does not stop the others, and a spent budget stops sending', async () => {
    const db = await dueWorld();
    await addDueEvent(db, 'RFQ-2026-002');
    await addDueEvent(db, 'RFQ-2026-003');
    // The first RFQ cannot close: make its audit write fail.
    await db.exec(`
      CREATE TRIGGER fail_first_close BEFORE UPDATE ON sourcing_events
      WHEN NEW.event_number = 'RFQ-2026-001' AND NEW.status = 'closed'
      BEGIN SELECT RAISE(ABORT, 'boom'); END
    `);
    const app = createApp({ db, config: loadDbConfig({}), now: () => new Date('2026-10-08T12:00:00Z') });
    await withEnv({ ...ENV, CRON_SECRET: 'cron-secret-value-123' }, () => withServer(app, async (base) => {
      const response = await fetch(`${base}/api/sourcing/tick`, { headers: { Authorization: 'Bearer cron-secret-value-123' } });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.closed, 2);
      assert.deepEqual(body.close_errors.map((e) => e.event_number), ['RFQ-2026-001']);
    }));
  });
});

describe('CORS allowlist', () => {
  function decide(env, origin) {
    return new Promise((resolve) => corsOptions(env, { warn() {} }).origin(origin, (_e, ok) => resolve(ok)));
  }

  test('production allows only APP_BASE_URL and CORS_ORIGINS', async () => {
    const env = { NODE_ENV: 'production', APP_BASE_URL: 'https://procure.example/', CORS_ORIGINS: 'https://admin.example' };
    assert.equal(await decide(env, 'https://procure.example'), true);
    assert.equal(await decide(env, 'https://admin.example'), true);
    assert.equal(await decide(env, 'https://evil.example'), false);
    assert.equal(await decide({ NODE_ENV: 'production' }, 'https://evil.example'), false);
  });

  test('a foreign Origin gets no credentialed CORS headers on the buyer API', async () => {
    const db = await dueWorld();
    const app = createApp({ db, config: loadDbConfig({}), env: { ...process.env, NODE_ENV: 'test', APP_BASE_URL: 'https://procure.example' } });
    await withEnv(ENV, () => withServer(app, async (base) => {
      const cookie = withCookie(3).headers;
      const foreign = await rawGet(base, '/api/sourcing/events', { ...cookie, Origin: 'https://evil.example' });
      assert.equal(foreign['access-control-allow-origin'], undefined);
      assert.equal(foreign['access-control-allow-credentials'], undefined);
      const own = await rawGet(base, '/api/sourcing/events', { ...cookie, Origin: 'https://procure.example' });
      assert.equal(own['access-control-allow-origin'], 'https://procure.example');
    }));
  });
});

describe('seed guard, APP_BASE_URL and same-origin logging', () => {
  test('the seed refuses production unless --force', async () => {
    const { seedRefusal } = await import('./seed.js');
    assert.match(seedRefusal({ NODE_ENV: 'production' }, ['node', 'seed.js']), /Refusing/);
    assert.match(seedRefusal({ VERCEL_ENV: 'production' }, ['node', 'seed.js']), /Refusing/);
    assert.equal(seedRefusal({ NODE_ENV: 'production' }, ['node', 'seed.js', '--force']), null);
    assert.equal(seedRefusal({ NODE_ENV: 'development' }, ['node', 'seed.js']), null);
    assert.equal(seedRefusal({ VERCEL_ENV: 'preview' }, ['node', 'seed.js']), null);
  });

  test('a schemeless APP_BASE_URL is warned about', async () => {
    const { warnIfBadAppBaseUrl } = await import('./sourcingConfig.js');
    const lines = [];
    const log = { warn: (line) => lines.push(line) };
    assert.equal(warnIfBadAppBaseUrl({ APP_BASE_URL: 'procure.example' }, log), true);
    assert.equal(lines.length, 1);
    assert.equal(warnIfBadAppBaseUrl({ APP_BASE_URL: 'https://procure.example' }, log), false);
    assert.equal(warnIfBadAppBaseUrl({}, log), false);
  });

  test('same-origin requests are not logged as denied; foreign ones are, once', async () => {
    const { corsDelegate } = await import('./security.js');
    const lines = [];
    const delegate = corsDelegate({ NODE_ENV: 'test', APP_BASE_URL: 'https://procure.example' }, { warn: (l) => lines.push(l) });
    const ask = (origin, host) => new Promise((resolve) => delegate({ headers: { origin, host } }, (_e, options) => {
      if (options.origin === false) return resolve(false);
      options.origin(origin, (_e2, ok) => resolve(ok));
    }));
    assert.equal(await ask('https://other.example', 'other.example'), false);
    assert.equal(lines.length, 0, 'same-origin is silent');
    assert.equal(await ask('https://evil.example', 'procure.example'), false);
    assert.equal(await ask('https://evil.example', 'procure.example'), false);
    assert.equal(lines.length, 1, 'a foreign origin is logged once');
  });
});
