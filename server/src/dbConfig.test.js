import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  TURSO_REQUIRED_MSG,
  TursoConfigError,
  assertDeployableConfig,
  loadDbConfig,
  runningOnVercel
} from './dbConfig.js';
import { createApp } from './app.js';
import { configErrorHtml, wantsJson } from './configError.js';

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

describe('dual-mode DB selection', () => {
  test('local default is sqlite when Turso env is unset', () => {
    const env = {};
    const config = loadDbConfig(env);
    assert.equal(config.useTurso, false);
    assert.equal(config.onVercel, false);
    assert.equal(runningOnVercel(env), false);
  });

  test('Turso env selects remote HTTP mode', () => {
    const config = loadDbConfig({
      TURSO_DATABASE_URL: 'libsql://example.turso.io',
      TURSO_AUTH_TOKEN: 'tok_test'
    });
    assert.equal(config.useTurso, true);
    assert.equal(config.tursoUrl, 'libsql://example.turso.io');
    assert.equal(config.preferHttp, true);
  });

  test('Vercel without Turso is refused', () => {
    const config = loadDbConfig({ VERCEL: '1' });
    assert.equal(config.onVercel, true);
    assert.equal(config.useTurso, false);
    assert.throws(
      () => assertDeployableConfig(config),
      (err) => err instanceof TursoConfigError && /TURSO_DATABASE_URL/.test(err.message)
    );
  });

  test('VERCEL_ENV also counts as Vercel', () => {
    assert.equal(runningOnVercel({ VERCEL_ENV: 'preview' }), true);
  });
});

describe('Vercel config error page', () => {
  test('createApp without Turso on Vercel serves 503 HTML with setup steps', async () => {
    const app = createApp({
      config: loadDbConfig({ VERCEL: '1' })
    });
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/`);
      const text = await response.text();
      assert.equal(response.status, 503);
      assert.match(text, /TURSO_DATABASE_URL/);
      assert.match(text, /TURSO_AUTH_TOKEN/);
      assert.match(text, /Preview/);
    });
  });

  test('API requests get JSON instead of HTML', async () => {
    const app = createApp({
      config: loadDbConfig({ VERCEL: '1' })
    });
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/health`, {
        headers: { Accept: 'application/json' }
      });
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.error, 'TursoConfigError');
      assert.match(body.detail, /TURSO_DATABASE_URL/);
    });
  });

  test('config HTML mentions database token not org JWT', () => {
    const html = configErrorHtml(TURSO_REQUIRED_MSG);
    assert.match(html, /database token/);
    assert.match(html, /turso db tokens create/);
  });

  test('wantsJson is true for /api paths', () => {
    assert.equal(wantsJson({ path: '/api/health', headers: {} }), true);
    assert.equal(wantsJson({ path: '/', headers: { accept: 'text/html' } }), false);
  });
});
