import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryDatabase } from './db.js';
import { createApp } from './app.js';
import { loadDbConfig } from './dbConfig.js';
import { hashPassword, loadAuthConfig } from './auth.js';
import {
  DEFAULT_BASE_URL,
  SMOKE_HELP,
  checkAuthConfigResponse,
  checkHealthResponse,
  checkUnauthenticatedMeResponse,
  checkUsersResponse,
  describeFetchError,
  formatSmokeReport,
  normalizeBaseUrl,
  parseSmokeArgs,
  resolveSmokeOptions,
  runSmokeChecks,
  runSmokeCli
} from './smoke.js';

const TEST_AUTH = loadAuthConfig({}, {
  sessionSecret: 'test-session-secret',
  bcryptRounds: 4,
  cookieSecure: false,
  demoPersonaSwitcher: false
});

function captureStreams() {
  const stdout = { text: '', write(chunk) { this.text += chunk; } };
  const stderr = { text: '', write(chunk) { this.text += chunk; } };
  return { stdout, stderr };
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

describe('smoke arg / URL parsing', () => {
  test('defaults BASE_URL to local listen address', () => {
    const options = resolveSmokeOptions([], {});
    assert.equal(options.baseUrl, DEFAULT_BASE_URL);
    assert.equal(options.email, null);
    assert.equal(options.password, null);
  });

  test('CLI --base-url wins over BASE_URL env', () => {
    const options = resolveSmokeOptions(
      ['--base-url', 'https://acme.vercel.app'],
      { BASE_URL: 'http://127.0.0.1:5000' }
    );
    assert.equal(options.baseUrl, 'https://acme.vercel.app');
  });

  test('parses equals-form flags and SMOKE_* credentials', () => {
    const args = parseSmokeArgs(['--base-url=https://beta.vercel.app', '--json']);
    assert.equal(args.baseUrl, 'https://beta.vercel.app');
    assert.equal(args.json, true);
    const options = resolveSmokeOptions(['--email', 'ada@acme.test'], {
      SMOKE_PASSWORD: 'secret-pass'
    });
    assert.equal(options.email, 'ada@acme.test');
    assert.equal(options.password, 'secret-pass');
  });

  test('normalizeBaseUrl strips trailing slash and requires http(s)', () => {
    assert.equal(normalizeBaseUrl('http://127.0.0.1:5000/'), 'http://127.0.0.1:5000');
    assert.equal(normalizeBaseUrl('https://acme.vercel.app'), 'https://acme.vercel.app');
    assert.throws(() => normalizeBaseUrl('ftp://nope'), /http or https/);
    assert.throws(() => normalizeBaseUrl('not a url'), /not a valid URL/);
  });
});

describe('smoke response evaluators', () => {
  test('health accepts sqlite and turso-http', () => {
    assert.equal(checkHealthResponse({
      status: 200,
      json: { status: 'ok', db: 'sqlite' }
    }).ok, true);
    assert.equal(checkHealthResponse({
      status: 200,
      json: { status: 'ok', db: 'turso-http' }
    }).ok, true);
    assert.equal(checkHealthResponse({
      status: 200,
      json: { status: 'ok', db: 'mystery' }
    }).ok, false);
  });

  test('Turso 503 is a clear fail, not a generic HTTP error', () => {
    const result = checkHealthResponse({
      status: 503,
      json: { error: 'TursoConfigError', detail: 'missing TURSO_DATABASE_URL' }
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /Production and Preview/);
    assert.match(result.message, /Redeploy/);
  });

  test('auth/config and users stay consistent for empty vs bootstrapped', () => {
    const emptyCfg = checkAuthConfigResponse({
      status: 200,
      json: { auth: 'session', bootstrapNeeded: true, demoPersonaSwitcher: false }
    });
    assert.equal(emptyCfg.ok, true);
    assert.match(emptyCfg.detail, /empty tenant/);

    const usersEmpty = checkUsersResponse({ status: 200, json: [] }, { bootstrapNeeded: true });
    assert.equal(usersEmpty.ok, true);

    const mismatch = checkUsersResponse({
      status: 200,
      json: [{ id: 1, email: 'ada@acme.test' }]
    }, { bootstrapNeeded: true });
    assert.equal(mismatch.ok, false);

    const leaked = checkUsersResponse({
      status: 200,
      json: [{ id: 1, password_hash: 'nope' }]
    }, { bootstrapNeeded: false });
    assert.equal(leaked.ok, false);
  });

  test('unauthenticated /api/auth/me must be 401', () => {
    assert.equal(checkUnauthenticatedMeResponse({ status: 401, json: { user: null } }).ok, true);
    assert.equal(checkUnauthenticatedMeResponse({ status: 200, json: { user: { id: 1 } } }).ok, false);
  });

  test('connection-refused hint mentions npm start and BASE_URL', () => {
    const message = describeFetchError(
      { code: 'ECONNREFUSED', message: 'fetch failed' },
      'http://127.0.0.1:5000/api/health'
    );
    assert.match(message, /npm start/);
    assert.match(message, /Vercel/);
  });
});

describe('smoke against a live Express app', () => {
  test('empty tenant: health, auth/config, users [], me 401', async () => {
    const db = await createMemoryDatabase();
    const app = createApp({ db, config: loadDbConfig({}), authConfig: TEST_AUTH });
    await withServer(app, async (base) => {
      const result = await runSmokeChecks({ baseUrl: base, timeoutMs: 5000 });
      assert.equal(result.ok, true, formatSmokeReport(result));
      const names = result.checks.map((check) => check.name);
      assert.deepEqual(names, [
        'GET /api/health',
        'GET /api/auth/config',
        'GET /api/users',
        'GET /api/auth/me',
        'GET /api/departments',
        'GET /api/catalog',
        'POST /api/auth/login'
      ]);
      const skipped = result.checks.find((check) => check.name === 'POST /api/auth/login');
      assert.equal(skipped.skipped, true);
      const users = result.checks.find((check) => check.name === 'GET /api/users');
      assert.match(users.detail, /0 users/);
    });
  });

  test('after bootstrap, optional login check passes', async () => {
    const db = await createMemoryDatabase();
    const app = createApp({ db, config: loadDbConfig({}), authConfig: TEST_AUTH });
    await withServer(app, async (base) => {
      const created = await fetch(`${base}/api/auth/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Ada Admin',
          email: 'ada@acme.test',
          password: 'a-secure-pass'
        })
      });
      assert.equal(created.status, 201, await created.text());

      const result = await runSmokeChecks({
        baseUrl: base,
        email: 'ada@acme.test',
        password: 'a-secure-pass',
        timeoutMs: 5000
      });
      assert.equal(result.ok, true, formatSmokeReport(result));
      const login = result.checks.find((check) => check.name === 'POST /api/auth/login');
      assert.equal(login.ok, true);
      assert.equal(login.skipped, undefined);
      const me = result.checks.find((check) => check.name === 'GET /api/auth/me (session)');
      assert.equal(me.ok, true);
    });
  });

  test('bad login credentials fail the smoke', async () => {
    const db = await createMemoryDatabase();
    const hash = await hashPassword('right-password', 4);
    db.exec(`
      INSERT INTO users (id, name, email, role, title, approval_limit, status)
      VALUES (1, 'Ada', 'ada@acme.test', 'admin', 'Admin', 0, 'active');
    `);
    db.prepare(`INSERT INTO user_credentials (user_id, password_hash) VALUES (?, ?)`).run(1, hash);
    const app = createApp({ db, config: loadDbConfig({}), authConfig: TEST_AUTH });
    await withServer(app, async (base) => {
      const result = await runSmokeChecks({
        baseUrl: base,
        email: 'ada@acme.test',
        password: 'wrong-password',
        timeoutMs: 5000
      });
      assert.equal(result.ok, false);
      const login = result.checks.find((check) => check.name === 'POST /api/auth/login');
      assert.equal(login.ok, false);
    });
  });

  test('Vercel without Turso fails with Redeploy hint', async () => {
    const app = createApp({
      config: loadDbConfig({ VERCEL: '1' })
    });
    await withServer(app, async (base) => {
      const { stdout, stderr } = captureStreams();
      const code = await runSmokeCli({
        argv: ['--base-url', base, '--json'],
        env: {},
        stdout,
        stderr
      });
      assert.equal(code, 1);
      const report = JSON.parse(stdout.text);
      assert.equal(report.ok, false);
      assert.match(report.checks[0].message, /Redeploy/);
    });
  });

  test('unreachable BASE_URL exits 1 with a start-the-app hint', async () => {
    const { stdout, stderr } = captureStreams();
    const code = await runSmokeCli({
      argv: ['--base-url', 'http://127.0.0.1:1', '--timeout', '800'],
      env: {},
      stdout,
      stderr
    });
    assert.equal(code, 1);
    assert.match(stdout.text, /FAIL {2}GET \/api\/health/);
    assert.match(stdout.text, /npm start|connection refused|failed/i);
  });

  test('--help prints the runbook pointer', async () => {
    const { stdout } = captureStreams();
    const code = await runSmokeCli({
      argv: ['--help'],
      stdout,
      stderr: captureStreams().stderr
    });
    assert.equal(code, 0);
    assert.equal(stdout.text, SMOKE_HELP);
  });

  test('email without password is refused', async () => {
    const { stderr } = captureStreams();
    const code = await runSmokeCli({
      argv: ['--email', 'ada@acme.test'],
      env: {},
      stdout: captureStreams().stdout,
      stderr
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /both --email and --password/);
  });
});
