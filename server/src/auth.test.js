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
import { authenticateUser } from './usersService.js';

const TEST_AUTH = loadAuthConfig({}, {
  sessionSecret: 'test-session-secret',
  bcryptRounds: 4,
  cookieSecure: false,
  demoPersonaSwitcher: false
});

const BOOTSTRAP_TOKEN = 'a'.repeat(32);

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
    assert.equal(session.sessionVersion, 1);

    const legacy = signSessionToken(5, 'secret', 1_000_000, 60, null);
    const legacySession = verifySessionToken(legacy, 'secret', 1_000_000);
    assert.equal(legacySession.userId, 5);
    assert.equal(legacySession.sessionVersion, null);
    assert.equal(JSON.parse(Buffer.from(legacy.split('.')[0], 'base64url').toString('utf8')).sv, undefined);

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
      assert.equal(body.identityProvider, 'local');
      assert.equal(body.ssoReady, false);
      assert.equal(body.localLogin, true);
      assert.equal(body.bootstrapNeeded, true);
      assert.equal(body.demoPersonaSwitcher, false);
      assert.equal(body.currency, 'EUR');
    });
  });

  test('bootstrap creates first admin, sets cookie, and refuses a second call', async () => {
    const db = await createMemoryDatabase();
    const app = createApp({
      db,
      config: loadDbConfig({}),
      authConfig: TEST_AUTH,
      env: { BOOTSTRAP_TOKEN }
    });

    await withServer(app, async (base) => {
      const first = await json(await fetch(`${base}/api/auth/bootstrap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bootstrap-Token': BOOTSTRAP_TOKEN
        },
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
        headers: {
          'Content-Type': 'application/json',
          'X-Bootstrap-Token': BOOTSTRAP_TOKEN
        },
        body: JSON.stringify({
          name: 'Other',
          email: 'other@acme.com',
          password: 'a-secure-pass'
        })
      }));
      assert.equal(second.status, 409);
    });
  });

  test('login / me / logout cookie session; bad password and inactive are both 401', async () => {
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
      assert.equal(inactive.status, bad.status);
      assert.deepEqual(inactive.body, bad.body);
      assert.equal(inactive.body.error, 'Invalid email or password');
      assert.equal(inactive.body.code, undefined);
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

  test('inactive login matches a wrong password, including a bcrypt compare', async () => {
    const db = await createMemoryDatabase();
    await seedUsers(db);
    db.exec(`UPDATE users SET status = 'inactive' WHERE id = 5`);
    const app = createApp({ db, config: loadDbConfig({}), authConfig: TEST_AUTH });

    const time = async (fn) => {
      const start = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - start);
    };
    await authenticateUser(db, 'elena@example.com', 'wrong-password', {}).catch(() => {});
    const wrongTimes = [];
    const inactiveTimes = [];
    for (let i = 0; i < 3; i += 1) {
      wrongTimes.push(await time(() => authenticateUser(db, 'elena@example.com', 'wrong-password', {})
        .catch((error) => error)));
      inactiveTimes.push(await time(() => authenticateUser(db, 'elena@example.com', DEMO_SEED_PASSWORD, {})
        .catch((error) => error)));
    }
    const median = (values) => values.slice().sort((a, b) => a - b)[1];
    assert.ok(median(inactiveTimes) >= median(wrongTimes) * 0.4);

    await withServer(app, async (base) => {
      const wrong = await json(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'elena@example.com', password: 'wrong-password' })
      }));
      const inactive = await json(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'elena@example.com', password: DEMO_SEED_PASSWORD })
      }));
      assert.equal(wrong.status, 401);
      assert.equal(inactive.status, wrong.status);
      assert.deepEqual(inactive.body, wrong.body);
      assert.equal(JSON.stringify(inactive.body), JSON.stringify(wrong.body));
      assert.equal(inactive.body.error, 'Invalid email or password');
      assert.equal(inactive.cookie.includes('pf_session='), false);

      const events = db.prepare(`
        SELECT action FROM compliance_audit_events ORDER BY id
      `).all().map((row) => row.action);
      assert.ok(events.includes('LOCAL_LOGIN_FAILURE'));
      assert.ok(events.includes('LOCAL_LOGIN_INACTIVE'));
    });
  });
});

function sessionFromCookie(cookie) {
  const token = parseCookies(cookie).pf_session;
  return verifySessionToken(token, TEST_AUTH.sessionSecret);
}

async function login(base, email, password = DEMO_SEED_PASSWORD) {
  return json(await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  }));
}

function cleared(response) {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie().join('\n')
    : (response.headers.get('set-cookie') || '');
  return /pf_session=/.test(raw) && /Max-Age=0/i.test(raw);
}

describe('session revocation', () => {
  test('old cookies die after self change, admin reset, deactivation, and role change', async () => {
    const db = await createMemoryDatabase();
    await seedUsers(db);
    const app = createApp({ db, config: loadDbConfig({}), authConfig: TEST_AUTH });

    await withServer(app, async (base) => {
      const legacyToken = signSessionToken(1, TEST_AUTH.sessionSecret, Date.now(), 3600, null);
      const legacyCookie = `pf_session=${encodeURIComponent(legacyToken)}`;
      const legacyMe = await json(await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: legacyCookie }
      }));
      assert.equal(legacyMe.status, 200, legacyMe.body.error);
      assert.equal(legacyMe.body.user.email, 'alice@example.com');

      const alice1 = await login(base, 'alice@example.com');
      const alice2 = await login(base, 'alice@example.com');
      const elena = await login(base, 'elena@example.com');
      assert.equal(alice1.status, 200, alice1.body.error);
      assert.equal(sessionFromCookie(alice1.cookie).sessionVersion, 1);
      assert.equal('session_version' in alice1.body.user, false);

      const changed = await json(await fetch(`${base}/api/auth/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: alice1.cookie },
        body: JSON.stringify({
          current_password: DEMO_SEED_PASSWORD,
          new_password: 'alice-new-pass'
        })
      }));
      assert.equal(changed.status, 200, changed.body.error);
      assert.match(changed.cookie, /pf_session=/);
      assert.equal(sessionFromCookie(changed.cookie).sessionVersion, 2);
      assert.equal(changed.body.user.email, 'alice@example.com');

      const still = await json(await fetch(`${base}/api/users`, {
        headers: { Cookie: changed.cookie }
      }));
      assert.equal(still.status, 200, still.body.error);
      const me = await json(await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: changed.cookie }
      }));
      assert.equal(me.status, 200);
      assert.equal(me.body.user.id, 1);

      const oldTab = await fetch(`${base}/api/users`, { headers: { Cookie: alice1.cookie } });
      assert.equal(oldTab.status, 401);
      assert.equal(cleared(oldTab), true);
      const otherDevice = await fetch(`${base}/api/auth/me`, { headers: { Cookie: alice2.cookie } });
      assert.equal(otherDevice.status, 401);
      assert.equal(cleared(otherDevice), true);
      const legacyAfter = await fetch(`${base}/api/users`, { headers: { Cookie: legacyCookie } });
      assert.equal(legacyAfter.status, 401);
      assert.equal(cleared(legacyAfter), true);

      const wrongCurrent = await json(await fetch(`${base}/api/auth/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: changed.cookie },
        body: JSON.stringify({ current_password: 'not-the-password', new_password: 'another-pass-1' })
      }));
      assert.equal(wrongCurrent.status, 400);
      const unchanged = await json(await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: changed.cookie }
      }));
      assert.equal(unchanged.status, 200);

      const adminStill = await json(await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: elena.cookie }
      }));
      assert.equal(adminStill.status, 200);

      const back = await login(base, 'alice@example.com', 'alice-new-pass');
      const back2 = await login(base, 'alice@example.com', 'alice-new-pass');
      assert.equal(sessionFromCookie(back.cookie).sessionVersion, 2);
      const reset = await json(await fetch(`${base}/api/users/1/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: elena.cookie },
        body: JSON.stringify({ password: 'admin-reset-pass' })
      }));
      assert.equal(reset.status, 200, reset.body.error);
      const afterReset = await fetch(`${base}/api/users`, { headers: { Cookie: back.cookie } });
      assert.equal(afterReset.status, 401);
      assert.equal(cleared(afterReset), true);
      const afterReset2 = await fetch(`${base}/api/auth/me`, { headers: { Cookie: back2.cookie } });
      assert.equal(afterReset2.status, 401);
      const elenaStill = await json(await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: elena.cookie }
      }));
      assert.equal(elenaStill.status, 200);

      const roleLogin = await login(base, 'alice@example.com', 'admin-reset-pass');
      assert.equal(sessionFromCookie(roleLogin.cookie).sessionVersion, 3);
      const role = await json(await fetch(`${base}/api/users/1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: elena.cookie },
        body: JSON.stringify({ role: 'approver' })
      }));
      assert.equal(role.status, 200, role.body.error);
      assert.equal(role.body.role, 'approver');
      const afterRole = await fetch(`${base}/api/users`, { headers: { Cookie: roleLogin.cookie } });
      assert.equal(afterRole.status, 401);
      assert.equal(cleared(afterRole), true);

      const activeAgain = await login(base, 'alice@example.com', 'admin-reset-pass');
      assert.equal(sessionFromCookie(activeAgain.cookie).sessionVersion, 4);
      const off = await json(await fetch(`${base}/api/users/1/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: elena.cookie },
        body: JSON.stringify({ status: 'inactive' })
      }));
      assert.equal(off.status, 200, off.body.error);
      const afterOff = await fetch(`${base}/api/auth/me`, { headers: { Cookie: activeAgain.cookie } });
      assert.equal(afterOff.status, 401);
      assert.equal(cleared(afterOff), true);

      const wrong = await json(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', password: 'wrong-password' })
      }));
      const inactive = await json(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', password: 'admin-reset-pass' })
      }));
      assert.equal(inactive.status, wrong.status);
      assert.deepEqual(inactive.body, wrong.body);

      const elenaOld = elena.cookie;
      const elenaReset = await json(await fetch(`${base}/api/users/5/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: elena.cookie },
        body: JSON.stringify({ password: 'elena-new-pass' })
      }));
      assert.equal(elenaReset.status, 200, elenaReset.body.error);
      assert.equal(sessionFromCookie(elenaReset.cookie).sessionVersion, 2);
      const elenaNow = await json(await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: elenaReset.cookie }
      }));
      assert.equal(elenaNow.status, 200);
      assert.equal(elenaNow.body.user.id, 5);
      const elenaDead = await fetch(`${base}/api/users`, { headers: { Cookie: elenaOld } });
      assert.equal(elenaDead.status, 401);
      assert.equal(cleared(elenaDead), true);
    });
  });
});
