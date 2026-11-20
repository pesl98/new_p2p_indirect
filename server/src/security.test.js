import test from 'node:test';
import assert from 'node:assert/strict';
import { corsOptions, originCheck, rateLimit, parseOriginAllowlist } from './security.js';
import { warnIfInsecureSessionSecret, loadAuthConfig, sessionSecretProblem } from './auth.js';

function run(mw, req) {
  const res = {
    code: 200, headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; }
  };
  let nexted = false;
  mw({ get: (h) => req.headers?.[h.toLowerCase()], ...req }, res, () => { nexted = true; });
  return { res, nexted };
}

test('allowlist parsing trims and strips slashes', () => {
  assert.deepEqual(parseOriginAllowlist({ CORS_ORIGINS: ' https://a.test/ , https://b.test' }), ['https://a.test', 'https://b.test']);
});

test('cors: production rejects unlisted origins, allows listed', () => {
  const prod = corsOptions({ NODE_ENV: 'production', CORS_ORIGINS: 'https://a.test' });
  const check = (o) => { let r; prod.origin(o, (_, v) => { r = v; }); return r; };
  assert.equal(check('https://a.test'), true);
  assert.equal(check('https://evil.test'), false);
  const none = corsOptions({ NODE_ENV: 'production' });
  none.origin('https://a.test', (_, v) => assert.equal(v, false));
});

test('originCheck blocks cross-origin POST in production, allows same host', () => {
  const mw = originCheck({ NODE_ENV: 'production' });
  const bad = run(mw, { method: 'POST', headers: { origin: 'https://evil.test', host: 'app.test' } });
  assert.equal(bad.res.code, 403);
  const ok = run(mw, { method: 'POST', headers: { origin: 'https://app.test', host: 'app.test' } });
  assert.equal(ok.nexted, true);
  assert.equal(run(mw, { method: 'GET', headers: { origin: 'https://evil.test', host: 'app.test' } }).nexted, true);
});

test('rateLimit returns 429 after max and resets after window', () => {
  let t = 0;
  const mw = rateLimit({ max: 2, windowMs: 1000, now: () => t });
  const req = { ip: '1.1.1.1' };
  assert.equal(run(mw, req).nexted, true);
  assert.equal(run(mw, req).nexted, true);
  const blocked = run(mw, req);
  assert.equal(blocked.res.code, 429);
  assert.ok(blocked.res.headers['Retry-After']);
  t = 1500;
  assert.equal(run(mw, req).nexted, true);
});

test('missing SESSION_SECRET throws in production only', () => {
  const prod = { NODE_ENV: 'production' };
  assert.throws(() => warnIfInsecureSessionSecret(loadAuthConfig(prod), prod), /SESSION_SECRET/);
  assert.doesNotThrow(() => warnIfInsecureSessionSecret(loadAuthConfig({}), {}));
  const set = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32) };
  assert.doesNotThrow(() => warnIfInsecureSessionSecret(loadAuthConfig(set), set));
});

test('production and preview refuse the development default and a short SESSION_SECRET', () => {
  const known = loadAuthConfig({}).sessionSecret;
  const preview = { VERCEL: '1', VERCEL_ENV: 'preview' };
  const production = { NODE_ENV: 'production', VERCEL_ENV: 'production' };
  for (const env of [preview, production]) {
    const explicitDefault = loadAuthConfig({ ...env, SESSION_SECRET: known });
    assert.equal(explicitDefault.usingDevSecret, false);
    assert.equal(sessionSecretProblem(explicitDefault), 'default');
    assert.throws(() => warnIfInsecureSessionSecret(explicitDefault, env), /SESSION_SECRET/);
    const short = loadAuthConfig({ ...env, SESSION_SECRET: 'x'.repeat(31) });
    assert.equal(sessionSecretProblem(short), 'short');
    assert.throws(() => warnIfInsecureSessionSecret(short, env), /32/);
    const ok = loadAuthConfig({ ...env, SESSION_SECRET: 'x'.repeat(32) });
    assert.equal(sessionSecretProblem(ok), null);
    assert.doesNotThrow(() => warnIfInsecureSessionSecret(ok, env));
  }
  const localShort = loadAuthConfig({ SESSION_SECRET: 'x'.repeat(8) });
  assert.equal(sessionSecretProblem(localShort), 'short');
  assert.doesNotThrow(() => warnIfInsecureSessionSecret(localShort, {}));
  const thrown = (() => {
    try {
      warnIfInsecureSessionSecret(loadAuthConfig({ NODE_ENV: 'production', SESSION_SECRET: known }), { NODE_ENV: 'production' });
    } catch (error) {
      return error;
    }
    return null;
  })();
  assert.ok(thrown);
  assert.equal(thrown.code, 'session_secret_insecure');
  assert.equal(thrown.message.includes(known), false);
  const vercelDev = { VERCEL: '1' };
  assert.throws(
    () => warnIfInsecureSessionSecret(loadAuthConfig({ ...vercelDev, SESSION_SECRET: 'x'.repeat(31) }), vercelDev),
    (error) => error.code === 'session_secret_insecure'
  );
  assert.doesNotThrow(() => warnIfInsecureSessionSecret(
    loadAuthConfig({ ...vercelDev, SESSION_SECRET: 'x'.repeat(32) }),
    vercelDev
  ));
});

test('session_secret_insecure names missing, default, or too short and omits the value', () => {
  const known = loadAuthConfig({}).sessionSecret;
  const prod = { NODE_ENV: 'production' };
  const cases = [
    [loadAuthConfig(prod), 'missing', /missing/],
    [loadAuthConfig({ ...prod, SESSION_SECRET: known }), 'default', /development default/],
    [loadAuthConfig({ ...prod, SESSION_SECRET: 'x'.repeat(31) }), 'short', /too short/]
  ];
  for (const [config, reason, pattern] of cases) {
    assert.equal(sessionSecretProblem(config), reason);
    assert.throws(
      () => warnIfInsecureSessionSecret(config, prod),
      (error) => {
        assert.equal(error.code, 'session_secret_insecure');
        assert.equal(error.reason, reason);
        assert.match(error.message, pattern);
        assert.equal(error.message.includes(known), false);
        assert.equal(error.message.includes('x'.repeat(31)), false);
        return true;
      }
    );
  }
});
