/**
 * SQLite and Turso can refuse BEGIN IMMEDIATE while another writer holds the lock
 * (busy_timeout is 0), or report SQLITE_BUSY_SNAPSHOT when a read transaction
 * cannot be upgraded. Retry the whole transaction a few times, then answer with a
 * clean status instead of a 500:
 *   - still busy                 -> 503 busy, with Retry-After
 *   - snapshot (state moved on)  -> 409 busy_snapshot
 * Errors that are the caller's outcome (anything with a statusCode) are not retried.
 */

const ATTEMPTS = 3;

export class BusyError extends Error {
  constructor(message, statusCode, code, retryAfterSeconds = null) {
    super(message);
    this.name = 'BusyError';
    this.statusCode = statusCode;
    this.code = code;
    if (retryAfterSeconds != null) this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isSnapshotConflict(error) {
  return String(error?.code || '') === 'SQLITE_BUSY_SNAPSHOT' || /SQLITE_BUSY_SNAPSHOT/i.test(String(error?.message || ''));
}

export function isBusyConflict(error) {
  const code = String(error?.code || '');
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_BUSY_TIMEOUT') return true;
  return /SQLITE_BUSY|database is locked/i.test(String(error?.message || ''));
}

export function retryDelayMs(random = Math.random) {
  return 100 + Math.floor(random() * 201);
}

export async function withBusyRetry(work, { random = Math.random, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (error?.statusCode || !isBusyConflict(error)) throw error;
      if (attempt === ATTEMPTS) {
        if (isSnapshotConflict(error)) {
          throw new BusyError('The data changed while it was being saved. Reload and try again.', 409, 'busy_snapshot');
        }
        throw new BusyError('The database is busy. Try again.', 503, 'busy', 1);
      }
      await sleep(retryDelayMs(random));
    }
  }
  throw new BusyError('The database is busy. Try again.', 503, 'busy', 1);
}
