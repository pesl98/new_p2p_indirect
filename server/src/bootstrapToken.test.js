import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryDatabase, openDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { loadAuthConfig } from './auth.js';
import { runBootstrapAdminCli } from './bootstrapAdmin.js';
import {
  MIN_BOOTSTRAP_TOKEN_LENGTH,
  bootstrapTokensMatch
} from './bootstrapToken.js';

const TEST_AUTH = loadAuthConfig({}, {
  sessionSecret: 'test-session-secret',
  bcryptRounds: 4,
  cookieSecure: false,
  demoPersonaSwitcher: false
});

const TOKEN = 'a'.repeat(MIN_BOOTSTRAP_TOKEN_LENGTH);
const OTHER = 'b'.repeat(MIN_BOOTSTRAP_TOKEN_LENGTH);

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
    authConfig: TEST_AUTH,
    env
  });
}

async function userCount(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users').get();
  return Number(row.n);
}

function postBootstrap(base, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== undefined) headers['X-Bootstrap-Token'] = token;
  return fetch(`${base}/api/auth/bootstrap`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {
      name: 'Ada Admin',
      email: 'ada@acme.test',
      password: 'choose-a-long-password'
    })
  });
}

function captureConsole(fn) {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error
  };
  const lines = [];
  const spy = (...args) => {
    lines.push(args.map((part) => String(part)).join(' '));
  };
  console.log = spy;
  console.info = spy;
  console.warn = spy;
  console.error = spy;
  const restore = () => {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  };
  return Promise.resolve()
    .then(fn)
    .then((value) => {
      restore();
      return { value, lines };
    }, (error) => {
      restore();
      throw error;
    })
    .then((result) => ({ ...result, text: result.lines.join('\n') }));
}

function sqliteEnv(sqlitePath, extra = {}) {
  return {
    ...extra,
    PROCUREMENT_DB_PATH: sqlitePath,
    TURSO_DATABASE_URL: '',
    TURSO_AUTH_TOKEN: ''
  };
}

describe('bootstrap token compare', () => {
  test('equal-length digests match only the same secret', () => {
    assert.equal(bootstrapTokensMatch(TOKEN, TOKEN), true);
    assert.equal(bootstrapTokensMatch(OTHER, TOKEN), false);
    assert.equal(bootstrapTokensMatch('short', TOKEN), false);
    assert.equal(bootstrapTokensMatch(undefined, TOKEN), false);
    assert.equal(bootstrapTokensMatch(null, TOKEN), false);
  });
});

describe('POST /api/auth/bootstrap fail-closed', () => {
  test('no token configured is refused and creates no user', async () => {
    const db = await createMemoryDatabase();
    const { value: app, text } = await captureConsole(() => appFor(db, {}));
    assert.doesNotMatch(text, /BOOTSTRAP_TOKEN/);
    await withServer(app, async (base) => {
      const health = await json(await fetch(`${base}/api/health`));
      assert.equal(health.status, 200);
      assert.equal(health.body.status, 'ok');

      const refused = await json(await postBootstrap(base, { token: TOKEN }));
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, 'bootstrap_disabled');
      assert.equal(JSON.stringify(refused.body).includes(TOKEN), false);
      assert.equal(await userCount(db), 0);

      const audit = await db.prepare(
        `SELECT COUNT(*) AS n FROM compliance_audit_events`
      ).get();
      assert.equal(Number(audit.n), 0);
    });
  });

  test('configured token missing or wrong is 403 and creates no user', async () => {
    const db = await createMemoryDatabase();
    const app = appFor(db, { BOOTSTRAP_TOKEN: TOKEN });
    await withServer(app, async (base) => {
      const missing = await json(await postBootstrap(base));
      assert.equal(missing.status, 403);
      assert.equal(missing.body.code, 'bootstrap_token_invalid');

      const wrongCapture = await captureConsole(async () => (
        json(await postBootstrap(base, { token: OTHER }))
      ));
      const wrong = wrongCapture.value;
      assert.equal(wrong.status, 403);
      assert.equal(wrong.body.code, 'bootstrap_token_invalid');
      assert.equal(wrongCapture.text.includes(TOKEN), false);
      assert.equal(wrongCapture.text.includes(OTHER), false);
      assert.equal(JSON.stringify(wrong.body).includes(TOKEN), false);

      const fromBody = await json(await postBootstrap(base, {
        body: {
          name: 'Ada Admin',
          email: 'ada@acme.test',
          password: 'choose-a-long-password',
          bootstrapToken: TOKEN
        }
      }));
      assert.equal(fromBody.status, 403);
      assert.equal(fromBody.body.code, 'bootstrap_token_invalid');
      assert.equal(await userCount(db), 0);
    });
  });

  test('a short configured token is treated as unset and warned at startup', async () => {
    const db = await createMemoryDatabase();
    const short = 'c'.repeat(MIN_BOOTSTRAP_TOKEN_LENGTH - 1);
    const { value: app, text } = await captureConsole(() => appFor(db, { BOOTSTRAP_TOKEN: short }));
    assert.match(text, /BOOTSTRAP_TOKEN is shorter than 32 characters/);
    assert.equal(text.includes(short), false);
    await withServer(app, async (base) => {
      const health = await json(await fetch(`${base}/api/health`));
      assert.equal(health.status, 200);
      assert.equal(health.body.status, 'ok');
      const refused = await json(await postBootstrap(base, { token: short }));
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, 'bootstrap_disabled');
      assert.equal(await userCount(db), 0);
    });
  });

  test('the correct token on an empty database creates the admin and audits that user', async () => {
    const db = await createMemoryDatabase();
    const app = appFor(db, { BOOTSTRAP_TOKEN: `  ${TOKEN}  ` });
    await withServer(app, async (base) => {
      const created = await json(await postBootstrap(base, { token: TOKEN }));
      assert.equal(created.status, 201, created.body.error);
      assert.equal(created.body.user.email, 'ada@acme.test');
      assert.equal(created.body.user.role, 'admin');
      assert.equal(await userCount(db), 1);
      const audit = await db.prepare(`
        SELECT action, actor_user_id, actor_role, entity_id, details
        FROM compliance_audit_events
        WHERE action = 'BOOTSTRAP_ADMIN'
      `).get();
      assert.equal(Number(audit.actor_user_id), created.body.user.id);
      assert.equal(audit.actor_role, 'admin');
      assert.equal(Number(audit.entity_id), created.body.user.id);
      assert.equal(audit.details, 'first_admin');
    });
  });

  test('the correct token is refused once any user exists', async () => {
    const db = await createMemoryDatabase();
    const app = appFor(db, { BOOTSTRAP_TOKEN: TOKEN });
    await withServer(app, async (base) => {
      const first = await json(await postBootstrap(base, { token: TOKEN }));
      assert.equal(first.status, 201, first.body.error);
      const second = await json(await postBootstrap(base, {
        token: TOKEN,
        body: {
          name: 'Other',
          email: 'other@acme.test',
          password: 'choose-a-long-password'
        }
      }));
      assert.equal(second.status, 409);
      assert.match(second.body.error, /already has users/);
      assert.equal(await userCount(db), 1);
    });
  });

  test('existing users stay 409 when no token is configured', async () => {
    const db = await createMemoryDatabase();
    await db.prepare(`
      INSERT INTO users (name, email, role, title, approval_limit, status)
      VALUES ('Elena', 'elena@example.com', 'admin', 'CFO', 0, 'active')
    `).run();
    const app = appFor(db, {});
    await withServer(app, async (base) => {
      const health = await json(await fetch(`${base}/api/health`));
      assert.equal(health.status, 200);
      const refused = await json(await postBootstrap(base));
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, /already has users/);
      assert.equal(await userCount(db), 1);
    });
  });

  test('wrong tokens are rate-limited by the login limiter', async () => {
    const db = await createMemoryDatabase();
    const app = appFor(db, { BOOTSTRAP_TOKEN: TOKEN });
    await withServer(app, async (base) => {
      let last = null;
      for (let i = 0; i < 11; i += 1) {
        last = await json(await postBootstrap(base, { token: 'wrong-token-value' }));
      }
      assert.equal(last.status, 429);
      assert.equal(last.body.code, 'rate_limited');
      assert.equal(await userCount(db), 0);
    });
  });
});

describe('npm run bootstrap-admin', () => {
  test('creates the first admin without a token, and ignores a configured token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-bootstrap-token-'));
    const sqlitePath = path.join(dir, 'customer.db');
    const stdout = { text: '', write(chunk) { this.text += chunk; } };
    const stderr = { text: '', write(chunk) { this.text += chunk; } };
    const code = await runBootstrapAdminCli({
      argv: ['--email', 'admin@acme.test', '--password', 'choose-a-long-password', '--name', 'Ada Admin'],
      env: sqliteEnv(sqlitePath),
      stdout,
      stderr
    });
    assert.equal(code, 0, stderr.text);
    assert.match(stdout.text, /Created first admin: Ada Admin <admin@acme.test>/);
    assert.equal(stdout.text.includes('BOOTSTRAP_TOKEN'), false);

    const db = await openDatabase({
      useTurso: false,
      sqlitePath,
      onVercel: false
    }, { migrate: false });
    assert.equal(await userCount(db), 1);

    const secondPath = path.join(dir, 'with-token.db');
    const stdout2 = { text: '', write(chunk) { this.text += chunk; } };
    const stderr2 = { text: '', write(chunk) { this.text += chunk; } };
    const withToken = await runBootstrapAdminCli({
      argv: ['--email', 'admin@acme.test', '--password', 'choose-a-long-password'],
      env: sqliteEnv(secondPath, { BOOTSTRAP_TOKEN: TOKEN }),
      stdout: stdout2,
      stderr: stderr2
    });
    assert.equal(withToken, 0, stderr2.text);
    assert.equal(stdout2.text.includes(TOKEN), false);
    assert.equal(stderr2.text.includes(TOKEN), false);
    const db2 = await openDatabase({
      useTurso: false,
      sqlitePath: secondPath,
      onVercel: false
    }, { migrate: false });
    assert.equal(await userCount(db2), 1);
  });
});
