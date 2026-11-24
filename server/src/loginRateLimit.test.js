import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { clientAddress, loginAttemptKey, loginEmailHash, rateLimit } from './security.js';
import { seedWorld, withApp } from './sourcingAwardFixtures.js';
import { applySchema, createMemoryDatabase } from './db.js';
import { SqliteAdapter } from './sqliteAdapter.js';
import { hashPassword } from './auth.js';
import {
  LOGIN_ACCOUNT_MAX,
  LOGIN_ADDRESS_MAX,
  LOGIN_RATE_MAX_TRACKED,
  LOGIN_WINDOW_MS,
  clearSuccessfulLoginAccount,
  loginRateLimit
} from './loginRateLimit.js';

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
        assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
        assert.deepEqual(await blocked.json(), {
          error: 'Too many requests, try again later',
          code: 'rate_limited'
        });
      });
    } finally {
      if (previous == null) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = previous;
    }
  });
});

const TOO_MANY = { error: 'Too many requests, try again later', code: 'rate_limited' };
const INVALID = { error: 'Invalid email or password' };

function requestFor({ email, ip = '203.0.113.10', db, forwardedFor }) {
  return {
    db,
    ip,
    body: { email },
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    socket: { remoteAddress: ip }
  };
}

async function invoke(limiter, req) {
  const res = {
    code: 200,
    headers: {},
    body: undefined,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
  let nextError = null;
  let nexted = false;
  await limiter(req, res, (error) => {
    if (error) nextError = error;
    else nexted = true;
  });
  if (nextError) throw nextError;
  return { res, nexted };
}

async function accountRows(db, email) {
  return db.prepare(
    `SELECT bucket_key, attempt_count, reset_at FROM login_rate_windows
     WHERE scope = 'account' AND subject_key = ? ORDER BY bucket_key`
  ).all(loginEmailHash(email));
}

describe('persisted login rate limit', () => {
  test('thresholds stay at 10 per account and 300 per address, each for 15 minutes', () => {
    assert.equal(LOGIN_ACCOUNT_MAX, 10);
    assert.equal(LOGIN_ADDRESS_MAX, 300);
    assert.equal(LOGIN_WINDOW_MS, 15 * 60 * 1000);
    assert.equal(LOGIN_RATE_MAX_TRACKED, 50_000);
  });

  test('applySchema adds login_rate_windows to an existing database and can run twice', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const db = new SqliteAdapter(raw);
    await db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL,
        department_id INTEGER,
        title TEXT,
        approval_limit INTEGER DEFAULT 0,
        avatar TEXT,
        status TEXT NOT NULL DEFAULT 'active'
      );
    `);
    await applySchema(db);
    await applySchema(db);
    const tables = await db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'login_rate_windows'`
    ).all();
    assert.equal(tables.length, 1);
    await db.prepare(
      `INSERT INTO login_rate_windows (scope, bucket_key, subject_key, attempt_count, reset_at)
       VALUES ('account', '203.0.113.8|abc', 'abc', 1, 10)`
    ).run();
    const row = await db.prepare(`SELECT attempt_count FROM login_rate_windows WHERE bucket_key = ?`).get('203.0.113.8|abc');
    assert.equal(Number(row.attempt_count), 1);
  });

  test('two limiter instances share one database', async () => {
    const db = await createMemoryDatabase();
    const now = () => 1_700_000_000_000;
    const first = loginRateLimit({ now, accountMax: 3, addressMax: 100, windowMs: 60_000 });
    const second = loginRateLimit({ now, accountMax: 3, addressMax: 100, windowMs: 60_000 });
    const req = () => requestFor({ email: 'shared-bucket@example.com', ip: '198.51.100.10', db });

    assert.equal((await invoke(first, req())).nexted, true);
    assert.equal((await invoke(second, req())).nexted, true);
    assert.equal((await invoke(first, req())).nexted, true);
    const blocked = await invoke(second, req());
    assert.equal(blocked.nexted, false);
    assert.equal(blocked.res.code, 429);
    assert.deepEqual(blocked.res.body, TOO_MANY);
    assert.equal(blocked.res.headers['Retry-After'], '60');

    const other = await invoke(second, requestFor({
      email: 'other-bucket@example.com',
      ip: '198.51.100.10',
      db
    }));
    assert.equal(other.nexted, true, 'a different email behind the same address is its own account window');
  });

  test('the window expires, and a later attempt deletes expired rows', async () => {
    const db = await createMemoryDatabase();
    let t = 5_000;
    const limiter = loginRateLimit({ now: () => t, accountMax: 1, addressMax: 100, windowMs: 1_000 });
    const req = () => requestFor({ email: 'window@example.com', ip: '198.51.100.20', db });

    await db.prepare(
      `INSERT INTO login_rate_windows (scope, bucket_key, subject_key, attempt_count, reset_at)
       VALUES ('account', 'stale-key', 'stale-subject', 4, 1),
              ('address', '198.51.100.77', '', 2, 9_000)`
    ).run();

    assert.equal((await invoke(limiter, req())).nexted, true);
    const blocked = await invoke(limiter, req());
    assert.equal(blocked.res.code, 429);
    assert.equal(blocked.res.headers['Retry-After'], '1');
    assert.deepEqual(blocked.res.body, TOO_MANY);

    const stale = await db.prepare(
      `SELECT 1 FROM login_rate_windows WHERE bucket_key = 'stale-key'`
    ).get();
    assert.equal(stale, undefined, 'the opportunistic delete removes rows whose window has ended');
    const liveAddress = await db.prepare(
      `SELECT attempt_count FROM login_rate_windows WHERE scope = 'address' AND bucket_key = '198.51.100.77'`
    ).get();
    assert.equal(Number(liveAddress.attempt_count), 2, 'a window that is still open stays');

    t = 6_000;
    const again = await invoke(limiter, req());
    assert.equal(again.nexted, true);
    const rows = await accountRows(db, 'window@example.com');
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].attempt_count), 1);
    assert.equal(Number(rows[0].reset_at), 7_000);
  });

  test('a successful login clears that email on every address and leaves the address cap', async () => {
    const db = await createMemoryDatabase();
    const now = () => 50_000;
    const limiter = loginRateLimit({ now, accountMax: 10, addressMax: 100, windowMs: 60_000 });
    const alice = (ip) => requestFor({ email: 'Alice@Example.com', ip, db });
    const bob = requestFor({ email: 'bob@example.com', ip: '198.51.100.30', db });

    assert.equal((await invoke(limiter, alice('198.51.100.30'))).nexted, true);
    assert.equal((await invoke(limiter, alice('198.51.100.31'))).nexted, true);
    assert.equal((await invoke(limiter, requestFor({
      email: '  alice@example.com  ',
      ip: '198.51.100.30',
      db
    }))).nexted, true);
    assert.equal((await invoke(limiter, bob)).nexted, true);

    const before = await accountRows(db, 'alice@example.com');
    assert.equal(before.length, 2);
    assert.equal(Number(before.find((row) => row.bucket_key.startsWith('198.51.100.30|')).attempt_count), 2);

    await clearSuccessfulLoginAccount(alice('198.51.100.30'));
    assert.equal((await accountRows(db, 'alice@example.com')).length, 0);
    const bobRows = await accountRows(db, 'bob@example.com');
    assert.equal(bobRows.length, 1);
    const address = await db.prepare(
      `SELECT attempt_count FROM login_rate_windows WHERE scope = 'address' AND bucket_key = '198.51.100.30'`
    ).get();
    assert.equal(Number(address.attempt_count), 3, 'the address window is not cleared on success');

    const stored = await db.prepare(`SELECT bucket_key, subject_key FROM login_rate_windows`).all();
    for (const row of stored) {
      assert.equal(String(row.bucket_key).includes('@'), false);
      assert.equal(String(row.subject_key).includes('@'), false);
    }
  });

  test('active rows stay within the tracked-key cap', async () => {
    const db = await createMemoryDatabase();
    const now = 20_000;
    const limiter = loginRateLimit({
      now: () => now,
      accountMax: 100,
      addressMax: 100,
      windowMs: 60_000,
      maxTrackedKeys: 2
    });
    await db.prepare(`
      INSERT INTO login_rate_windows (scope, bucket_key, subject_key, attempt_count, reset_at) VALUES
        ('address', '198.51.100.1', '', 1, 21000),
        ('address', '198.51.100.2', '', 1, 22000),
        ('address', '198.51.100.3', '', 1, 23000),
        ('account', '198.51.100.3|old', 'old', 1, 24000)
    `).run();

    assert.equal((await invoke(limiter, requestFor({
      email: 'capped@example.com',
      ip: '198.51.100.9',
      db
    }))).nexted, true);

    const rows = await db.prepare(
      `SELECT scope, bucket_key, reset_at FROM login_rate_windows ORDER BY reset_at DESC`
    ).all();
    assert.equal(rows.length, 2);
    assert.equal(rows.every((row) => Number(row.reset_at) === now + 60_000), true);
    const keys = rows.map((row) => row.bucket_key);
    assert.ok(keys.includes('198.51.100.9'));
    assert.ok(keys.some((key) => key.startsWith('198.51.100.9|')));
  });

  test('a missing table logs once and falls back per instance, without crashing', async () => {
    const db = await createMemoryDatabase();
    await db.exec('DROP TABLE login_rate_windows');
    const lines = [];
    const log = { error: (message) => lines.push(String(message)) };
    const now = () => 80_000;
    const first = loginRateLimit({ now, accountMax: 1, addressMax: 100, windowMs: 60_000, log });
    const second = loginRateLimit({ now, accountMax: 1, addressMax: 100, windowMs: 60_000, log });
    const req = () => requestFor({ email: 'fallback@example.com', ip: '198.51.100.40', db });

    assert.equal((await invoke(first, req())).nexted, true);
    const blocked = await invoke(first, req());
    assert.equal(blocked.res.code, 429);
    assert.deepEqual(blocked.res.body, TOO_MANY);
    assert.equal(blocked.res.headers['Retry-After'], '60');
    assert.equal((await invoke(first, req())).res.code, 429);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /login_rate_windows is missing/);
    assert.equal(lines[0].includes('fallback@example.com'), false);

    const otherInstance = await invoke(second, req());
    assert.equal(otherInstance.nexted, true, 'the fallback memory is not shared across instances');
    assert.equal(lines.length, 2);
    await clearSuccessfulLoginAccount(req(), log);
    assert.equal((await invoke(first, req())).nexted, true, 'success clears the in-memory account window');
  });

  test('X-Forwarded-For is the client only when trust proxy is already on', async () => {
    const previous = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = '1';
    const db = await seedWorld();
    try {
      await withApp(db, async (base) => {
        const attempt = (email, forwardedFor) => fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor },
          body: JSON.stringify({ email, password: 'wrong-password' })
        });
        const locked = [];
        for (let i = 0; i < 11; i += 1) locked.push((await attempt('proxy-victim@example.com', '203.0.113.50')).status);
        assert.equal(locked.slice(0, 10).every((code) => code === 401), true, JSON.stringify(locked));
        assert.deepEqual(locked.slice(10), [429]);
        const otherAddress = await attempt('proxy-victim@example.com', '203.0.113.51');
        assert.equal(otherAddress.status, 401);
        const sameAddress = await attempt('proxy-victim@example.com', '203.0.113.50');
        assert.equal(sameAddress.status, 429);
        assert.ok(Number(sameAddress.headers.get('retry-after')) >= 1);
      });
    } finally {
      if (previous == null) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = previous;
    }
  });

  test('unknown and inactive failures count like a wrong password, and success resets', async () => {
    const db = await seedWorld();
    const password = 'correct-horse';
    const hash = await hashPassword(password, 4);
    await db.prepare(`INSERT INTO user_credentials (user_id, password_hash) VALUES (1, ?)`).run(hash);
    await db.prepare(`UPDATE users SET status = 'inactive' WHERE id = 1`).run();

    await withApp(db, async (base) => {
      const attempt = (email, secret) => fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: secret })
      }).then(async (res) => ({ status: res.status, body: await res.json(), headers: res.headers }));

      const unknown = await attempt('ghost@example.com', 'wrong-password');
      const inactiveRight = await attempt('Alice@Example.com', password);
      const inactiveWrong = await attempt('alice@example.com', 'wrong-password');
      assert.equal(unknown.status, 401);
      assert.deepEqual(unknown.body, INVALID);
      assert.deepEqual(inactiveRight.body, INVALID);
      assert.deepEqual(inactiveWrong.body, INVALID);
      assert.equal(unknown.body.code, undefined);
      assert.equal(inactiveRight.body.code, undefined);

      const aliceRows = await accountRows(db, 'alice@example.com');
      const ghostRows = await accountRows(db, 'ghost@example.com');
      assert.equal(aliceRows.length, 1);
      assert.equal(Number(aliceRows[0].attempt_count), 2);
      assert.equal(Number(ghostRows[0].attempt_count), 1);
      assert.equal(String(aliceRows[0].bucket_key).includes('alice'), false);

      for (let i = 0; i < 8; i += 1) {
        const next = await attempt('alice@example.com', 'wrong-password');
        assert.equal(next.status, 401);
      }
      const limited = await attempt('alice@example.com', password);
      assert.equal(limited.status, 429);
      assert.deepEqual(limited.body, TOO_MANY);
      assert.ok(Number(limited.headers.get('retry-after')) >= 1);

      await db.prepare(`UPDATE users SET status = 'active' WHERE id = 1`).run();
      await db.prepare(`DELETE FROM login_rate_windows WHERE scope = 'account'`).run();

      for (let i = 0; i < 9; i += 1) {
        assert.equal((await attempt('alice@example.com', 'wrong-password')).status, 401);
      }
      const signedIn = await attempt('alice@example.com', password);
      assert.equal(signedIn.status, 200);
      assert.equal(signedIn.body.user.email, 'alice@example.com');
      assert.equal((await accountRows(db, 'alice@example.com')).length, 0);
      const after = await attempt('alice@example.com', 'wrong-password');
      assert.equal(after.status, 401, 'success cleared the account window');
      const address = await db.prepare(
        `SELECT attempt_count FROM login_rate_windows WHERE scope = 'address'`
      ).get();
      assert.ok(Number(address.attempt_count) >= 11);
    });
  });

  test('login still answers when the table was not migrated yet', async () => {
    const db = await seedWorld();
    await db.exec('DROP TABLE login_rate_windows');
    const lines = [];
    const original = console.error;
    console.error = (...args) => {
      lines.push(args.map((part) => String(part)).join(' '));
    };
    try {
      await withApp(db, async (base) => {
        const first = await fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password' })
        });
        assert.equal(first.status, 401);
        assert.deepEqual(await first.json(), INVALID);
        const second = await fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password' })
        });
        assert.equal(second.status, 401);
      });
    } finally {
      console.error = original;
    }
    const notes = lines.filter((line) => line.includes('login_rate_windows'));
    assert.equal(notes.length, 1);
    assert.equal(notes.some((line) => line.includes('nobody@example.com')), false);
  });
});
