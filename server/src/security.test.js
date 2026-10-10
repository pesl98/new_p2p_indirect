import test from 'node:test';
import assert from 'node:assert/strict';
import { corsOptions, originCheck, rateLimit, parseOriginAllowlist } from './security.js';
import { warnIfInsecureSessionSecret, loadAuthConfig } from './auth.js';

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
