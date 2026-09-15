import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import {
  DEMO_SEED_PASSWORD,
  hashPassword,
  loadAuthConfig,
  parseCookies,
  signSessionToken,
  verifySessionToken
} from './auth.js';

const TEST_AUTH = loadAuthConfig({}, {
  sessionSecret: 'test-session-secret',
  bcryptRounds: 4,
  cookieSecure: false,
  demoPersonaSwitcher: false
});

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
  return { status: response.status, body: await response.json(), cookie: cookieHeader(response) };
}

function cookieHeader(response) {
  const headers = response.headers;
  if (!headers) return '';
  const raw = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get?.('set-cookie') ? [headers.get('set-cookie')] : []);
  return raw.map((c) => String(c).split(';')[0]).join('; ');
}

async function seedUsers(db, { withPassword = true, adminOnly = false } = {}) {
  db.exec(`
    INSERT INTO departments (id, code, name) VALUES (1, 'MKT', 'Marketing'), (5, 'ADM', 'Finance');
    INSERT INTO users (id, name, email, role, department_id, title, approval_limit, status) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Specialist', 0, 'active'),
      (5, 'Elena Rostova', 'elena@example.com', 'admin', 5, 'CFO', 50000000, 'active');
  `);
  if (adminOnly) {
    db.exec(`DELETE FROM users WHERE id = 1`);
  }
  if (withPassword) {
    const hash = await hashPassword(DEMO_SEED_PASSWORD, 4);
    const insert = db.prepare(`INSERT INTO user_credentials (user_id, password_hash) VALUES (?, ?)`);
    const ids = db.prepare(`SELECT id FROM users`).all();
    for (const row of ids) {
      insert.run(row.id, hash);
    }
  }
}

describe('session tokens', () => {
  test('sign and verify round-trip; tamper and expiry fail', () => {
    const token = signSessionToken(5, 'secret', 1_000_000, 60);
    const session = verifySessionToken(token, 'secret', 1_000_000);
    assert.equal(session.userId, 5);

    assert.equal(verifySessionToken(token, 'other', 1_000_000), null);
    assert.equal(verifySessionToken(`${token}x`, 'secret', 1_000_000), null);
    assert.equal(verifySessionToken(token, 'secret', 1_000_000 + 61_000), null);
  });

  test('parseCookies decodes values', () => {
    const cookies = parseCookies('pf_session=abc%2Edef; other=1');
    assert.equal(cookies.pf_session, 'abc.def');
    assert.equal(cookies.other, '1');
  });
});

describe('auth HTTP', () => {
  test('GET /api/auth/config reports bootstrapNeeded on empty tenant', async () => {
    const db = await createMemoryDatabase();
    const app = createApp({ db, config: loadDbConfig({}), authConfig: TEST_AUTH });
    await withServer(app, async (base) => {
      const { status, body } = await json(await fetch(`${base}/api/auth/config`));
      assert.equal(status, 200);
      assert.equal(body.auth, 'session');
      assert.equal(body.bootstrapNeeded, true);
      assert.equal(body.demoPersonaSwitcher, false);
    });
  });

  test('bootstrap creates first admin, sets cookie, and refuses a second call', async () => {
    const db = await createMemoryDatabase();
    const app = createApp({ db, config: loadDbConfig({}), authConfig: TEST_AUTH });

    await withServer(app, async (base) => {
      const first = await json(await fetch(`${base}/api/auth/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Ada Admin',
          email: 'ada@acme.com',
          password: 'a-secure-pass'
        })
      }));
      assert.equal(first.status, 201, first.body.error);
      assert.equal(first.body.user.email, 'ada@acme.com');
      assert.equal(first.body.user.role, 'admin');
      assert.equal(first.body.user.has_password, 1);
      assert.equal('password_hash' in first.body.user, false);
      const cookie = first.cookie;
      assert.match(cookie, /pf_session=/);

      const me = await json(await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: cookie }
      }));
      assert.equal(me.status, 200);
      assert.equal(me.body.user.email, 'ada@acme.com');

      const second = await json(await fetch(`${base}/api/auth/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Other',
          email: 'other@acme.com',
          password: 'a-secure-pass'
        })
      }));
      assert.equal(second.status, 409);
    });
  });

  test('login / me / logout cookie session; bad password 401; inactive 403', async () => {
    const db = await createMemoryDatabase();
    await seedUsers(db);
    const app = createApp({ db, config: loadDbConfig({}), authConfig: TEST_AUTH });

    await withServer(app, async (base) => {
      const bad = await json(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'elena@example.com', password: 'wrong-password' })
      }));
      assert.equal(bad.status, 401);

      const login = await json(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'Elena@example.com', password: DEMO_SEED_PASSWORD })
      }));
      assert.equal(login.status, 200, login.body.error);
      assert.equal(login.body.user.name, 'Elena Rostova');
      const cookie = login.cookie;
      assert.match(cookie, /pf_session=/);

      const loginRes = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'elena@example.com', password: DEMO_SEED_PASSWORD })
      });
      const setCookie = loginRes.headers.get('set-cookie') || '';
      assert.match(String(setCookie), /HttpOnly/i);
      assert.match(String(setCookie), /SameSite=Lax/i);
      await loginRes.json();

      const me = await json(await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } }));
      assert.equal(me.status, 200);
      assert.equal(me.body.user.role, 'admin');

      const unauth = await json(await fetch(`${base}/api/auth/me`));
      assert.equal(unauth.status, 401);

      const logout = await json(await fetch(`${base}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: cookie }
      }));
      assert.equal(logout.status, 200);
      assert.match(logout.cookie, /pf_session=/);

      db.exec(`UPDATE users SET status = 'inactive' WHERE id = 5`);
      const inactive = await json(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'elena@example.com', password: DEMO_SEED_PASSWORD })
      }));
      assert.equal(inactive.status, 403);
    });
  });

  test('login does not leak whether the email exists', async () => {
    const db = await createMemoryDatabase();
    await seedUsers(db);
    const app = createApp({ db, config: loadDbConfig({}), authConfig: TEST_AUTH });
    await withServer(app, async (base) => {
      const missing = await json(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com', password: DEMO_SEED_PASSWORD })
      }));
      assert.equal(missing.status, 401);
      assert.equal(missing.body.error, 'Invalid email or password');
    });
  });
});
