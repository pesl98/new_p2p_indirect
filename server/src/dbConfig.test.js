import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  PREVIEW_PRODUCTION_DB_ALLOW_ENV,
  TURSO_REQUIRED_MSG,
  TursoConfigError,
  assertDeployableConfig,
  loadDbConfig,
  normalizeDatabaseUrl,
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

  test('production still uses TURSO_DATABASE_URL when preview vars are absent', () => {
    const config = loadDbConfig({
      VERCEL: '1',
      VERCEL_ENV: 'production',
      TURSO_DATABASE_URL: 'libsql://prod.turso.io',
      TURSO_AUTH_TOKEN: 'prod-token'
    });
    assert.equal(config.useTurso, true);
    assert.equal(config.tursoUrl, 'libsql://prod.turso.io');
    assert.equal(config.tursoAuthToken, 'prod-token');
    assert.equal(config.previewDatabase, false);
    assert.equal(config.previewBlocked, null);
  });

  test('local dev ignores preview variables', () => {
    const config = loadDbConfig({
      TURSO_PREVIEW_DATABASE_URL: 'libsql://preview.turso.io',
      TURSO_PREVIEW_AUTH_TOKEN: 'preview-token'
    });
    assert.equal(config.useTurso, false);
    assert.equal(config.onVercel, false);
    assert.equal(config.previewDatabase, false);
  });

  test('preview without its own database is refused', () => {
    const logs = [];
    const config = withMutedError(() => loadDbConfig({
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      TURSO_DATABASE_URL: 'libsql://prod.turso.io',
      TURSO_AUTH_TOKEN: 'prod-token'
    }), logs);
    assert.equal(config.useTurso, false);
    assert.equal(config.tursoUrl, null);
    assert.equal(config.previewBlocked.code, 'preview_db_unconfigured');
    assert.match(logs.join('\n'), /preview_db_unconfigured/);
    assert.doesNotMatch(logs.join('\n'), /prod-token/);
    assert.throws(
      () => assertDeployableConfig(config),
      (err) => err instanceof TursoConfigError && err.code === 'preview_db_unconfigured'
    );
  });

  test('preview URL equal to production is refused, including libsql and https', () => {
    const logs = [];
    const config = withMutedError(() => loadDbConfig({
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      TURSO_PRODUCTION_DATABASE_URL: 'https://prod.turso.io',
      TURSO_PREVIEW_DATABASE_URL: 'libsql://prod.turso.io/',
      TURSO_PREVIEW_AUTH_TOKEN: 'preview-token'
    }), logs);
    assert.equal(normalizeDatabaseUrl('libsql://prod.turso.io/'), normalizeDatabaseUrl('https://prod.turso.io'));
    assert.equal(config.previewBlocked.code, 'preview_db_matches_production');
    assert.equal(config.tursoAuthToken, null);
    assert.match(logs.join('\n'), /preview_db_matches_production/);
    assert.doesNotMatch(logs.join('\n'), /preview-token/);
  });

  test('preview uses its own URL when it differs from production', () => {
    const config = loadDbConfig({
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      TURSO_DATABASE_URL: 'libsql://prod.turso.io',
      TURSO_AUTH_TOKEN: 'prod-token',
      TURSO_PREVIEW_DATABASE_URL: 'libsql://preview.turso.io',
      TURSO_PREVIEW_AUTH_TOKEN: 'preview-token'
    });
    assert.equal(config.previewDatabase, true);
    assert.equal(config.useTurso, true);
    assert.equal(config.tursoUrl, 'libsql://preview.turso.io');
    assert.equal(config.tursoAuthToken, 'preview-token');
    assert.equal(assertDeployableConfig(config).tursoUrl, 'libsql://preview.turso.io');
  });

  test('preview without a production URL to compare is refused', () => {
    const config = withMutedError(() => loadDbConfig({
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      TURSO_PREVIEW_DATABASE_URL: 'libsql://preview.turso.io',
      TURSO_PREVIEW_AUTH_TOKEN: 'preview-token'
    }));
    assert.equal(config.previewBlocked.code, 'preview_db_unverified');
    assert.equal(config.useTurso, false);
  });

  test('ALLOW_PREVIEW_PRODUCTION_DATABASE=allow is the only escape hatch and is logged', () => {
    const logs = [];
    const config = withMutedError(() => loadDbConfig({
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      TURSO_DATABASE_URL: 'libsql://prod.turso.io',
      TURSO_AUTH_TOKEN: 'prod-token',
      [PREVIEW_PRODUCTION_DB_ALLOW_ENV]: 'allow'
    }), logs);
    assert.equal(config.allowPreviewProductionDatabase, true);
    assert.equal(config.useTurso, true);
    assert.equal(config.tursoUrl, 'libsql://prod.turso.io');
    assert.match(logs.join('\n'), /PREVIEW IS SERVING THE PRODUCTION DATABASE/);
    const ignored = withMutedError(() => loadDbConfig({
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      TURSO_DATABASE_URL: 'libsql://prod.turso.io',
      TURSO_AUTH_TOKEN: 'prod-token',
      [PREVIEW_PRODUCTION_DB_ALLOW_ENV]: '1'
    }));
    assert.equal(ignored.previewBlocked.code, 'preview_db_unconfigured');
  });
});

function withMutedError(fn, logs = []) {
  const original = console.error;
  console.error = (...args) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

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

  test('preview health reports why the database was refused', async () => {
    const app = withMutedError(() => createApp({
      env: {
        VERCEL: '1',
        VERCEL_ENV: 'preview',
        TURSO_DATABASE_URL: 'libsql://prod.turso.io',
        TURSO_AUTH_TOKEN: 'prod-token'
      }
    }));
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/health`);
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.error, 'TursoConfigError');
      assert.equal(body.code, 'preview_db_unconfigured');
      assert.match(body.detail, /TURSO_PREVIEW_DATABASE_URL/);
      assert.doesNotMatch(body.detail, /prod-token/);
      const page = await fetch(`${base}/`);
      const html = await page.text();
      assert.equal(page.status, 503);
      assert.match(html, /TURSO_PREVIEW_DATABASE_URL/);
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
