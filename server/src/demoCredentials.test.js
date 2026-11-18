import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { DEMO_SEED_PASSWORD, hashPassword, loadAuthConfig } from './auth.js';
import {
  MAX_PASSWORD_BYTES,
  deploymentForbidsDemoPassword,
  warnIfDemoPersonaSwitcher
} from './demoCredentials.js';
import { authenticateUser, bootstrapFirstAdmin, countUsers, setUserPassword } from './usersService.js';

const CUSTOMER_HOST = 'libsql://customer.example.test';
const OTHER_PASSWORD = 'local-admin-pass-1';

function customerEnv(extra = {}) {
  return {
    NODE_ENV: 'production',
    VERCEL_ENV: 'production',
    SESSION_SECRET: 'x'.repeat(32),
    ...extra
  };
}

function previewDatabaseEnv(extra = {}) {
  return {
    VERCEL: '1',
    NODE_ENV: 'production',
    VERCEL_ENV: 'preview',
    TURSO_DATABASE_URL: 'libsql://prod.example.test',
    TURSO_AUTH_TOKEN: 'prod-token',
    TURSO_PREVIEW_DATABASE_URL: 'libsql://preview.example.test',
    TURSO_PREVIEW_AUTH_TOKEN: 'preview-token',
    ...extra
  };
}

function withMutedError(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

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

function appFor(db, env) {
  return createApp({
    db,
    config: loadDbConfig({}),
    env,
    authConfig: loadAuthConfig(env, { bcryptRounds: 4, cookieSecure: false })
  });
}

describe('demo credentials outside local', () => {
  test('production, Vercel, and a Turso shell forbid the demo password; preview does not', () => {
    assert.equal(deploymentForbidsDemoPassword({}), false);
    assert.equal(deploymentForbidsDemoPassword({ NODE_ENV: 'development' }), false);
    assert.equal(deploymentForbidsDemoPassword({ NODE_ENV: 'production' }), true);
    assert.equal(deploymentForbidsDemoPassword({ VERCEL_ENV: 'production' }), true);
    assert.equal(deploymentForbidsDemoPassword({ VERCEL: '1' }), true);
    assert.equal(deploymentForbidsDemoPassword({ TURSO_DATABASE_URL: CUSTOMER_HOST }), true);
    assert.equal(deploymentForbidsDemoPassword({ TURSO_AUTH_TOKEN: 'present' }), true);
    assert.equal(loadDbConfig(previewDatabaseEnv()).previewDatabase, true);
    assert.equal(deploymentForbidsDemoPassword(previewDatabaseEnv()), false);
    assert.equal(withMutedError(() => deploymentForbidsDemoPassword({
      NODE_ENV: 'production',
      VERCEL_ENV: 'preview',
      TURSO_DATABASE_URL: CUSTOMER_HOST,
      TURSO_AUTH_TOKEN: 'present'
    })), true);
  });

  test('boot refuses the persona switcher on production and preview', () => {
    assert.throws(
      () => warnIfDemoPersonaSwitcher({ NODE_ENV: 'production', DEMO_PERSONA_SWITCHER: '1' }),
      (error) => error.code === 'demo_persona_switcher_forbidden'
    );
    assert.throws(
      () => warnIfDemoPersonaSwitcher({ VERCEL: '1', VERCEL_ENV: 'preview', DEMO_PERSONA_SWITCHER: 'true' }),
      (error) => error.code === 'demo_persona_switcher_forbidden'
    );
    assert.doesNotThrow(() => warnIfDemoPersonaSwitcher({ DEMO_PERSONA_SWITCHER: '1' }));
    assert.doesNotThrow(() => warnIfDemoPersonaSwitcher({ NODE_ENV: 'production', DEMO_PERSONA_SWITCHER: '0' }));
  });

  test('a production process does not boot while the persona switcher is on', async () => {
    const env = customerEnv({ DEMO_PERSONA_SWITCHER: '1' });
    const app = createApp({
      config: loadDbConfig({}),
      env,
      authConfig: loadAuthConfig(env, { bcryptRounds: 4, cookieSecure: false })
    });
    await withServer(app, async (base) => {
      const { status, body } = await json(await fetch(`${base}/api/health`));
      assert.equal(status, 503);
      assert.equal(body.code, 'demo_persona_switcher_forbidden');
      assert.equal(JSON.stringify(body).includes(DEMO_SEED_PASSWORD), false);
    });
  });

  test('local still reports the switcher and production login rejects the demo password', async () => {
    const localDb = await createMemoryDatabase();
    try {
      const local = createApp({
        db: localDb,
        config: loadDbConfig({}),
        env: { DEMO_PERSONA_SWITCHER: '1' }
      });
      await withServer(local, async (base) => {
        const { status, body } = await json(await fetch(`${base}/api/auth/config`));
        assert.equal(status, 200);
        assert.equal(body.demoPersonaSwitcher, true);
      });
    } finally {
      localDb.close();
    }

    const db = await createMemoryDatabase();
    try {
      const hash = await hashPassword(DEMO_SEED_PASSWORD, 4);
      const other = await hashPassword(OTHER_PASSWORD, 4);
      db.exec(`
        INSERT INTO users (id, name, email, role, title, approval_limit, status) VALUES
          (1, 'Elena Rostova', 'elena@example.com', 'admin', 'CFO', 0, 'active'),
          (2, 'Ada Admin', 'ada@example.com', 'admin', 'Admin', 0, 'active');
      `);
      db.prepare(`INSERT INTO user_credentials (user_id, password_hash) VALUES (?, ?)`).run(1, hash);
      db.prepare(`INSERT INTO user_credentials (user_id, password_hash) VALUES (?, ?)`).run(2, other);
      const app = appFor(db, customerEnv());
      await withServer(app, async (base) => {
        const denied = await json(await fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'elena@example.com', password: DEMO_SEED_PASSWORD })
        }));
        assert.equal(denied.status, 401);
        assert.equal(denied.body.error, 'Invalid email or password');
        assert.equal(JSON.stringify(denied.body).includes(DEMO_SEED_PASSWORD), false);
        const allowed = await json(await fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'ada@example.com', password: OTHER_PASSWORD })
        }));
        assert.equal(allowed.status, 200);
        assert.equal(allowed.body.user.email, 'ada@example.com');
        const huge = await json(await fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'ada@example.com', password: 'x'.repeat(MAX_PASSWORD_BYTES + 1) })
        }));
        assert.equal(huge.status, 401);
        assert.equal(huge.body.error, 'Invalid email or password');
      });
    } finally {
      db.close();
    }
  });

  test('preview can still sign in with the demo password', async () => {
    const db = await createMemoryDatabase();
    try {
      const hash = await hashPassword(DEMO_SEED_PASSWORD, 4);
      db.exec(`INSERT INTO users (id, name, email, role, title, approval_limit, status)
        VALUES (1, 'Elena Rostova', 'elena@example.com', 'admin', 'CFO', 0, 'active')`);
      db.prepare(`INSERT INTO user_credentials (user_id, password_hash) VALUES (?, ?)`).run(1, hash);
      const user = await authenticateUser(db, 'elena@example.com', DEMO_SEED_PASSWORD, {
        env: previewDatabaseEnv()
      });
      assert.equal(user.email, 'elena@example.com');
      const hatchEnv = {
        VERCEL: '1',
        NODE_ENV: 'production',
        VERCEL_ENV: 'preview',
        TURSO_DATABASE_URL: 'libsql://prod.example.test',
        TURSO_AUTH_TOKEN: 'prod-token',
        ALLOW_PREVIEW_PRODUCTION_DATABASE: 'allow'
      };
      assert.equal(withMutedError(() => loadDbConfig(hatchEnv).previewDatabase), false);
      await assert.rejects(
        () => withMutedError(() => authenticateUser(db, 'elena@example.com', DEMO_SEED_PASSWORD, {
          env: hatchEnv
        })),
        (error) => {
          assert.equal(error.statusCode, 401);
          assert.equal(String(error.message).includes(DEMO_SEED_PASSWORD), false);
          return true;
        }
      );
    } finally {
      db.close();
    }
  });

  test('bootstrap and password set refuse the demo password before any user row is written', async () => {
    const db = await createMemoryDatabase();
    const env = { TURSO_DATABASE_URL: CUSTOMER_HOST, TURSO_AUTH_TOKEN: 'present' };
    try {
      await assert.rejects(
        () => bootstrapFirstAdmin(db, {
          email: 'ada@example.com',
          password: DEMO_SEED_PASSWORD
        }, { bcryptRounds: 4, env }),
        (error) => {
          assert.equal(error.statusCode, 400);
          assert.equal(error.code, 'demo_password_forbidden');
          assert.equal(String(error.message).includes(DEMO_SEED_PASSWORD), false);
          assert.equal(String(error.message).includes(CUSTOMER_HOST), false);
          assert.equal(String(error.message).includes('present'), false);
          return true;
        }
      );
      assert.equal(await countUsers(db), 0);

      const created = await bootstrapFirstAdmin(db, {
        email: 'ada@example.com',
        password: OTHER_PASSWORD
      }, { bcryptRounds: 4, env });
      await assert.rejects(
        () => setUserPassword(db, created.id, DEMO_SEED_PASSWORD, { bcryptRounds: 4, env }),
        (error) => error.code === 'demo_password_forbidden'
      );
      await assert.rejects(
        () => setUserPassword(db, created.id, 'x'.repeat(MAX_PASSWORD_BYTES + 1), { bcryptRounds: 4, env }),
        (error) => error.code === 'password_too_long'
      );
      const twoByte = 'é';
      assert.equal(Buffer.byteLength(twoByte, 'utf8'), 2);
      const atLimit = await setUserPassword(db, created.id, twoByte.repeat(MAX_PASSWORD_BYTES / 2), { bcryptRounds: 4, env });
      assert.equal(atLimit.email, 'ada@example.com');
      await assert.rejects(
        () => setUserPassword(db, created.id, twoByte.repeat((MAX_PASSWORD_BYTES / 2) + 1), { bcryptRounds: 4, env }),
        (error) => error.code === 'password_too_long'
      );
      const previewDb = await createMemoryDatabase();
      try {
        const preview = await bootstrapFirstAdmin(previewDb, {
          email: 'preview@example.com',
          password: DEMO_SEED_PASSWORD
        }, {
          bcryptRounds: 4,
          env: previewDatabaseEnv()
        });
        assert.equal(preview.email, 'preview@example.com');
      } finally {
        previewDb.close();
      }
    } finally {
      db.close();
    }
  });
});
