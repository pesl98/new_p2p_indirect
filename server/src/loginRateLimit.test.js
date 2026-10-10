import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { clientAddress, loginAttemptKey, rateLimit } from './security.js';
import { seedWorld, withApp } from './sourcingAwardFixtures.js';

const fakeReq = (email, ip = '10.0.0.1', headers = {}) => ({ ip, body: { email }, headers, socket: { remoteAddress: ip } });

describe('login rate limit key', () => {
  test('one account has one bucket, normalised; other accounts and X-Forwarded-For do not change it', () => {
    const a = loginAttemptKey(fakeReq('Alice@Example.com'));
    assert.equal(a, loginAttemptKey(fakeReq('  alice@example.com ')));
    assert.notEqual(a, loginAttemptKey(fakeReq('bob@example.com')));
    assert.notEqual(a, loginAttemptKey(fakeReq('alice@example.com', '10.0.0.2')));
    assert.equal(a, loginAttemptKey(fakeReq('alice@example.com', '10.0.0.1', { 'x-forwarded-for': '1.2.3.4' })), 'X-Forwarded-For is not read');
    assert.ok(loginAttemptKey(fakeReq('x'.repeat(100000))).length < 80, 'long input is hashed');
    assert.equal(clientAddress({ socket: { remoteAddress: '::1' } }), '::1');
    assert.match(loginAttemptKey({ body: undefined, socket: {} }), /^unknown\|/);
  });

  test('the table stays bounded under a flood of distinct keys', () => {
    let t = 0;
    const limiter = rateLimit({ max: 1, windowMs: 1_000_000, now: () => t, key: (req) => req.k });
    const res = { set() {}, status() { return this; }, json() { return this; } };
    for (let i = 0; i < 60_000; i += 1) limiter({ k: `k${i}` }, res, () => {});
    // Not observable directly; a flood must not throw or stall, and early keys were evicted.
    let allowed = 0;
    limiter({ k: 'k0' }, res, () => { allowed += 1; });
    assert.equal(allowed, 1, 'the oldest key was dropped and starts a fresh window');
  });

  test('over HTTP with TRUST_PROXY off: hammering one account locks that account, not the others', async () => {
    const previous = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    const db = await seedWorld();
    try {
      await withApp(db, async (base) => {
        const attempt = (email) => fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `9.9.9.${Math.floor(Math.random() * 200)}` },
          body: JSON.stringify({ email, password: 'wrong-password' })
        });
        const statuses = [];
        for (let i = 0; i < 12; i += 1) statuses.push((await attempt('victim@example.com')).status);
        assert.equal(statuses.slice(0, 10).every((code) => code === 401), true, JSON.stringify(statuses));
        assert.deepEqual(statuses.slice(10), [429, 429]);
        // A spoofed X-Forwarded-For did not buy a fresh bucket, and someone else is not locked out.
        const other = await attempt('someone.else@example.com');
        assert.equal(other.status, 401);
        const blocked = await attempt('victim@example.com');
        assert.equal(blocked.status, 429);
        assert.ok(blocked.headers.get('retry-after'));
      });
    } finally {
      if (previous == null) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = previous;
    }
  });
});
