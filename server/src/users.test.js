import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { DEMO_SEED_PASSWORD, hashPassword, loadAuthConfig } from './auth.js';

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
  return { status: response.status, body: await response.json() };
}

function cookieHeader(response) {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
  return raw.map((c) => c.split(';')[0]).join('; ');
}

async function seedUsers(db) {
  db.exec(`
    INSERT INTO departments (id, code, name) VALUES
      (1, 'MKT', 'Marketing'),
      (5, 'ADM', 'Finance');
    INSERT INTO users (id, name, email, role, department_id, title, approval_limit, status) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Specialist', 0, 'active'),
      (5, 'Elena Rostova', 'elena@example.com', 'admin', 5, 'CFO', 50000000, 'active');
  `);
  const hash = await hashPassword(DEMO_SEED_PASSWORD, 4);
  const insert = db.prepare(`INSERT INTO user_credentials (user_id, password_hash) VALUES (?, ?)`);
  insert.run(1, hash);
  insert.run(5, hash);
}

async function loginAs(base, email = 'elena@example.com') {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: DEMO_SEED_PASSWORD })
  });
  const body = await res.json();
  assert.equal(res.status, 200, body.error);
  return { cookie: cookieHeader(res), user: body.user };
}

describe('admin user CRUD', () => {
  test('GET /api/users lists public fields and never password_hash', async () => {
    const db = await createMemoryDatabase();
    await seedUsers(db);
    const app = createApp({ db, config: loadDbConfig({}), authConfig: TEST_AUTH });
    await withServer(app, async (base) => {
      const { status, body } = await json(await fetch(`${base}/api/users`));
      assert.equal(status, 200);
      assert.equal(body.length, 2);
      const elena = body.find((u) => u.email === 'elena@example.com');
      assert.equal(elena.role, 'admin');
      assert.equal(elena.status, 'active');
      assert.equal(elena.has_password, 1);
      assert.equal(elena.department_code, 'ADM');
      assert.equal('password_hash' in elena, false);
      for (const user of body) {
        assert.equal('password_hash' in user, false);
      }
    });
  });

  test('mutating user routes require a logged-in admin', async () => {
    const db = await createMemoryDatabase();
    await seedUsers(db);
    const app = createApp({ db, config: loadDbConfig({}), authConfig: TEST_AUTH });
    await withServer(app, async (base) => {
      const payload = {
        name: 'New Requester',
        email: 'new@example.com',
        role: 'requester',
        department_id: 1
      };
      const anon = await json(await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }));
      assert.equal(anon.status, 401);

      const alice = await loginAs(base, 'alice@example.com');
      const asAlice = await json(await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: alice.cookie },
        body: JSON.stringify(payload)
      }));
      assert.equal(asAlice.status, 403);
    });
  });

  test('admin can create, edit, set password, and soft-deactivate; DELETE is 405', async () => {
    const db = await createMemoryDatabase();
    await seedUsers(db);
    const app = createApp({ db, config: loadDbConfig({}), authConfig: TEST_AUTH });

    await withServer(app, async (base) => {
      const { cookie } = await loginAs(base);

      const created = await json(await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'New Buyer',
          email: 'New.Buyer@example.com',
          role: 'requester',
          department_id: 1,
          title: 'Coordinator',
          approval_limit: 25000,
          password: 'welcome-new-user'
        })
      }));
      assert.equal(created.status, 201, created.body.error);
      assert.equal(created.body.email, 'new.buyer@example.com');
      assert.equal(created.body.role, 'requester');
      assert.equal(created.body.approval_limit, 25000);
      assert.equal(created.body.has_password, 1);
      assert.equal(created.body.status, 'active');
      const newId = created.body.id;

      const dup = await json(await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'Copy',
          email: 'new.buyer@example.com',
          role: 'requester',
          department_id: 1
        })
      }));
      assert.equal(dup.status, 409);

      const patched = await json(await fetch(`${base}/api/users/${newId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Senior Coordinator',
          approval_limit: 40000,
          role: 'approver'
        })
      }));
      assert.equal(patched.status, 200, patched.body.error);
      assert.equal(patched.body.title, 'Senior Coordinator');
      assert.equal(patched.body.approval_limit, 40000);
      assert.equal(patched.body.role, 'approver');

      const pw = await json(await fetch(`${base}/api/users/${newId}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ password: 'reset-pass-99' })
      }));
      assert.equal(pw.status, 200, pw.body.error);

      const loginNew = await json(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'new.buyer@example.com', password: 'reset-pass-99' })
      }));
      assert.equal(loginNew.status, 200, loginNew.body.error);

      const deactivated = await json(await fetch(`${base}/api/users/${newId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ status: 'inactive' })
      }));
      assert.equal(deactivated.status, 200, deactivated.body.error);
      assert.equal(deactivated.body.status, 'inactive');
      const stillThere = db.prepare(`SELECT id, status FROM users WHERE id = ?`).get(newId);
      assert.equal(stillThere.status, 'inactive');

      const inactiveLogin = await json(await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'new.buyer@example.com', password: 'reset-pass-99' })
      }));
      assert.equal(inactiveLogin.status, 403);

      const listed = await json(await fetch(`${base}/api/users?status=active`));
      assert.equal(listed.body.some((u) => u.id === newId), false);

      const del = await json(await fetch(`${base}/api/users/${newId}`, {
        method: 'DELETE',
        headers: { Cookie: cookie }
      }));
      assert.equal(del.status, 405);
    });
  });

  test('cannot deactivate the last active admin or your own account', async () => {
    const db = await createMemoryDatabase();
    await seedUsers(db);
    const app = createApp({ db, config: loadDbConfig({}), authConfig: TEST_AUTH });
    await withServer(app, async (base) => {
      const { cookie } = await loginAs(base);

      const self = await json(await fetch(`${base}/api/users/5/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ status: 'inactive' })
      }));
      assert.equal(self.status, 400);
      assert.match(self.body.error, /own account/i);

      const lastAdmin = await json(await fetch(`${base}/api/users/5`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ role: 'finance' })
      }));
      assert.equal(lastAdmin.status, 400);
      assert.match(lastAdmin.body.error, /last active admin/i);
    });
  });

  test('rejects invalid role and non-integer approval_limit', async () => {
    const db = await createMemoryDatabase();
    await seedUsers(db);
    const app = createApp({ db, config: loadDbConfig({}), authConfig: TEST_AUTH });
    await withServer(app, async (base) => {
      const { cookie } = await loginAs(base);
      const role = await json(await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'Bad Role',
          email: 'bad-role@example.com',
          role: 'superuser',
          department_id: 1
        })
      }));
      assert.equal(role.status, 400);

      const cents = await json(await fetch(`${base}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          name: 'Bad Limit',
          email: 'bad-limit@example.com',
          role: 'requester',
          department_id: 1,
          approval_limit: 10.5
        })
      }));
      assert.equal(cents.status, 400);
      assert.match(cents.body.error, /integer/i);
    });
  });
});
