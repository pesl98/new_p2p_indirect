/**
 * better-sqlite3 adapter with the same prepare/run/get/all/exec/transaction
 * surface as TursoHttpClient. Methods are synchronous (await-safe) when this
 * connection is idle.
 *
 * One connection cannot hold two transactions. Nesting follows the async
 * call that opened the transaction (AsyncLocalStorage), not a process-wide
 * counter. A transaction or statement from another async context waits until
 * the open transaction commits or rolls back, so it is not executed inside it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const txLocal = new AsyncLocalStorage();

/** How long a foreign statement waits for the open transaction. */
export const SQLITE_TX_WAIT_MS = 15000;

export class SqliteAdapter {
  constructor(raw, { waitMs = SQLITE_TX_WAIT_MS } = {}) {
    this.raw = raw;
    this._active = null;
    this._waitMs = waitMs;
  }

  get mode() {
    return 'sqlite';
  }

  get useTurso() {
    return false;
  }

  inTransaction() {
    const store = txLocal.getStore();
    return Boolean(store && store === this._active && store.depth > 0);
  }

  /**
   * Run `fn` outside this connection's transaction store. Async work created
   * inside `fn` does not inherit the open transaction.
   */
  runOutsideTransaction(fn) {
    return txLocal.exit(fn);
  }

  _waitFor(done) {
    const waitMs = this._waitMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`SQLite transaction wait timed out after ${waitMs}ms`);
        error.code = 'sqlite_transaction_timeout';
        reject(error);
      }, waitMs);
      Promise.resolve(done).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  _runSync(fn) {
    const store = txLocal.getStore();
    if (this._active && store !== this._active) {
      return this._waitFor(this._active.done).then(() => this._runSync(fn));
    }
    return fn();
  }

  /**
   * Several writes in one short transaction. The preview seed uses this so
   * a Turso load is not one interactive transaction of hundreds of round trips.
   */
  async batch(statements) {
    if (!statements?.length) return;
    await this.transaction(async () => {
      for (const item of statements) {
        if (item?.exec) await this.exec(item.sql);
        else if (item?.sql) await this.prepare(item.sql).run(...(item.args || []));
      }
    })();
  }

  prepare(sql) {
    const stmt = this.raw.prepare(sql);
    return {
      get: (...params) => this._runSync(() => stmt.get(...params)),
      all: (...params) => this._runSync(() => stmt.all(...params)),
      run: (...params) => this._runSync(() => {
        const result = stmt.run(...params);
        return {
          lastInsertRowid: Number(result.lastInsertRowid),
          changes: Number(result.changes)
        };
      })
    };
  }

  exec(sql) {
    return this._runSync(() => {
      this.raw.exec(sql);
    });
  }

  pragma(source) {
    return this._runSync(() => this.raw.pragma(source));
  }

  transaction(fn) {
    return this._transaction(fn, 'BEGIN');
  }

  /** Reserve the write lock before the callback reads, so a second writer waits. */
  immediateTransaction(fn) {
    return this._transaction(fn, 'BEGIN IMMEDIATE');
  }

  _transaction(fn, beginSql) {
    const adapter = this;
    const run = async (...args) => {
      const store = txLocal.getStore();
      if (store && store === adapter._active && store.depth > 0) {
        return adapter._nested(fn, args);
      }
      while (adapter._active) {
        await adapter._waitFor(adapter._active.done);
      }

      let resolveDone;
      const done = new Promise((resolve) => { resolveDone = resolve; });
      const context = { depth: 0, done };
      adapter._active = context;
      try {
        return await txLocal.run(context, () => adapter._runRoot(fn, args, beginSql, context));
      } finally {
        context.depth = 0;
        if (adapter._active === context) adapter._active = null;
        resolveDone();
      }
    };
    run.then = (onFulfilled, onRejected) => run().then(onFulfilled, onRejected);
    return run;
  }

  async _runRoot(fn, args, beginSql, context) {
    if (beginSql === 'BEGIN IMMEDIATE') {
      // A blocking busy wait freezes this process, including the writer
      // that already holds the lock. Fail the BEGIN and let the caller retry.
      const previous = Number(this.raw.pragma('busy_timeout', { simple: true })) || 0;
      this.raw.pragma('busy_timeout = 0');
      try {
        this.raw.exec(beginSql);
      } catch (error) {
        this.raw.pragma(`busy_timeout = ${previous}`);
        throw error;
      }
      this.raw.pragma(`busy_timeout = ${previous}`);
    } else {
      this.raw.exec(beginSql);
    }
    context.depth = 1;
    try {
      const result = await fn(...args);
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // ignore rollback failures
      }
      throw error;
    } finally {
      context.depth = 0;
    }
  }

  async _nested(fn, args) {
    const store = txLocal.getStore();
    this.raw.exec('SAVEPOINT pf_tx');
    store.depth += 1;
    try {
      const result = await fn(...args);
      this.raw.exec('RELEASE pf_tx');
      store.depth -= 1;
      return result;
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK TO pf_tx');
        this.raw.exec('RELEASE pf_tx');
      } catch {
        // ignore rollback failures
      }
      store.depth = Math.max(0, store.depth - 1);
      throw error;
    }
  }

  close() {
    this.raw.close();
  }
}
