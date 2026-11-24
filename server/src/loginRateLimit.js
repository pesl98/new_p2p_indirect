/**
 * Sign-in rate limit stored in login_rate_windows.
 *
 * One row per open window, shared by every serverless instance. The account
 * key is the client address plus a hash of the normalised email. The address
 * key is the client address alone. Express `req.ip` already applies trust
 * proxy (on for Vercel, or TRUST_PROXY=1 / true / yes), so X-Forwarded-For is
 * not read here.
 *
 * A successful password login deletes the account rows for that email on
 * every address. The address cap stays.
 *
 * If the table is missing, this process logs once and uses an in-memory
 * window so a deploy before migrate does not refuse login.
 */

import { clientAddress, loginEmailHash } from './security.js';

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_ACCOUNT_MAX = 10;
export const LOGIN_ADDRESS_MAX = 300;

/** Same hard cap the in-memory limiter used. Oldest windows are dropped past this. */
export const LOGIN_RATE_MAX_TRACKED = 50_000;

const UPSERT_SQL = `
  INSERT INTO login_rate_windows (scope, bucket_key, subject_key, attempt_count, reset_at)
  VALUES (?, ?, ?, 1, ?)
  ON CONFLICT(scope, bucket_key) DO UPDATE SET
    attempt_count = CASE
      WHEN login_rate_windows.reset_at <= ? THEN 1
      ELSE login_rate_windows.attempt_count + 1
    END,
    reset_at = CASE
      WHEN login_rate_windows.reset_at <= ? THEN ?
      ELSE login_rate_windows.reset_at
    END,
    subject_key = excluded.subject_key
  RETURNING attempt_count, reset_at
`;

/** Fallback windows from every limiter in this process. Success-clear walks these when the table is missing. */
const accountMemories = new Set();

export function isMissingLoginRateTable(error) {
  const message = String(error?.message || '');
  return /no such table/i.test(message) && /login_rate_windows/i.test(message);
}

function block(res, resetAt, now) {
  const seconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
  res.set('Retry-After', String(seconds));
  res.status(429).json({ error: 'Too many requests, try again later', code: 'rate_limited' });
}

function hitMemory(memory, scope, bucketKey, subjectKey, now, windowMs, maxTracked) {
  const id = `${scope}\0${bucketKey}`;
  let entry = memory.get(id);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs, scope, subjectKey };
    memory.set(id, entry);
    if (memory.size > 10000 || memory.size > maxTracked) {
      for (const [key, value] of memory) if (value.resetAt <= now) memory.delete(key);
      while (memory.size > maxTracked) memory.delete(memory.keys().next().value);
    }
  }
  entry.count += 1;
  return entry;
}

/**
 * Drop the oldest windows once the table is past `maxTracked`. The count
 * runs first, so a table under the cap does not scan and delete. After a
 * count shows slack, this process skips further counts for a fraction of
 * that slack (at most 64 new keys). The periodic prune always counts.
 * A failure must not fail the sign-in; the caller still has a count.
 */
function createTrim(maxTracked, log) {
  let keysUntilCheck = 0;
  return async function maybeTrim(db, force) {
    if (!force && keysUntilCheck > 0) {
      keysUntilCheck -= 1;
      return;
    }
    try {
      const row = await db.prepare(`SELECT COUNT(*) AS n FROM login_rate_windows`).get();
      const n = Number(row?.n || 0);
      if (n <= maxTracked) {
        keysUntilCheck = Math.min(64, Math.floor((maxTracked - n) / 4));
        return;
      }
      keysUntilCheck = 0;
      await db.prepare(`
        DELETE FROM login_rate_windows
        WHERE rowid NOT IN (
          SELECT rowid FROM login_rate_windows
          ORDER BY reset_at DESC, rowid DESC
          LIMIT ?
        )
      `).run(maxTracked);
    } catch (error) {
      if (isMissingLoginRateTable(error)) throw error;
      log.error?.(`login rate limit: could not cap login_rate_windows (${error.message})`);
    }
  };
}

async function upsert(db, scope, bucketKey, subjectKey, now, windowMs) {
  const resetAt = now + windowMs;
  const row = await db.prepare(UPSERT_SQL).get(
    scope,
    bucketKey,
    subjectKey,
    resetAt,
    now,
    now,
    resetAt
  );
  if (!row) {
    throw new Error('login rate limit: upsert returned no row');
  }
  return {
    count: Number(row.attempt_count),
    resetAt: Number(row.reset_at)
  };
}

/**
 * Fixed windows for POST /api/auth/login and POST /api/auth/bootstrap.
 * `now` returns epoch milliseconds. Defaults match the previous in-memory limiter.
 */
export function loginRateLimit({
  now = Date.now,
  log = console,
  windowMs = LOGIN_WINDOW_MS,
  accountMax = LOGIN_ACCOUNT_MAX,
  addressMax = LOGIN_ADDRESS_MAX,
  maxTrackedKeys = LOGIN_RATE_MAX_TRACKED
} = {}) {
  const maxTracked = Number.isInteger(maxTrackedKeys) && maxTrackedKeys > 0
    ? maxTrackedKeys
    : LOGIN_RATE_MAX_TRACKED;
  const maybeTrim = createTrim(maxTracked, log);
  const clock = typeof now === 'function' ? now : Date.now;
  const memory = new Map();
  accountMemories.add(memory);
  let dbReady = true;
  let loggedMissing = false;
  let prunedThrough = 0;

  return async function loginRateLimitMiddleware(req, res, next) {
    try {
      const t = Number(clock());
      const address = clientAddress(req);
      const subject = loginEmailHash(req.body?.email);
      const accountKey = `${address}|${subject}`;

      if (dbReady && req.db) {
        try {
          // Once per window per process. The upsert below still resets this
          // key when its own row has expired, so a skipped prune cannot
          // keep a live counter open.
          let didPrune = false;
          if (t >= prunedThrough) {
            await req.db.prepare(`DELETE FROM login_rate_windows WHERE reset_at <= ?`).run(t);
            prunedThrough = t + windowMs;
            didPrune = true;
          }
          const addressHit = await upsert(req.db, 'address', address, '', t, windowMs);
          if (addressHit.count > addressMax) {
            if (didPrune || addressHit.count === 1) await maybeTrim(req.db, didPrune);
            return block(res, addressHit.resetAt, t);
          }
          const accountHit = await upsert(req.db, 'account', accountKey, subject, t, windowMs);
          // New windows add rows. Count, and delete only past the cap. The
          // periodic prune always counts, so a burst cannot skip the check.
          if (didPrune || addressHit.count === 1 || accountHit.count === 1) {
            await maybeTrim(req.db, didPrune);
          }
          if (accountHit.count > accountMax) return block(res, accountHit.resetAt, t);
          return next();
        } catch (error) {
          if (!isMissingLoginRateTable(error)) throw error;
          dbReady = false;
          if (!loggedMissing) {
            loggedMissing = true;
            log.error?.(
              'login rate limit: table login_rate_windows is missing; using the in-memory limiter until this process restarts'
            );
          }
        }
      }

      const addressHit = hitMemory(memory, 'address', address, '', t, windowMs, maxTracked);
      if (addressHit.count > addressMax) return block(res, addressHit.resetAt, t);
      const accountHit = hitMemory(memory, 'account', accountKey, subject, t, windowMs, maxTracked);
      if (accountHit.count > accountMax) return block(res, accountHit.resetAt, t);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * Drop every account window for this email. Address windows stay.
 * Never throws: a missing table, or a database error, must not fail a
 * login that already authenticated.
 */
export async function clearSuccessfulLoginAccount(req, log = console) {
  const subject = loginEmailHash(req?.body?.email);
  if (req?.db) {
    try {
      await req.db.prepare(
        `DELETE FROM login_rate_windows WHERE scope = 'account' AND subject_key = ?`
      ).run(subject);
    } catch (error) {
      if (!isMissingLoginRateTable(error)) {
        log.error?.(`login rate limit: could not clear the account window (${error.message})`);
      }
    }
  }
  for (const memory of accountMemories) {
    for (const [key, entry] of memory) {
      if (entry.scope === 'account' && entry.subjectKey === subject) memory.delete(key);
    }
  }
}
