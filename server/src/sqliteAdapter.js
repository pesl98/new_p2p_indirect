/**
 * better-sqlite3 adapter with the same prepare/run/get/all/exec/transaction
 * surface as TursoHttpClient. Methods are synchronous (await-safe).
 * Transactions accept async callbacks (BEGIN/COMMIT around the work).
 */

export class SqliteAdapter {
  constructor(raw) {
    this.raw = raw;
    this._inTransaction = 0;
  }

  get mode() {
    return 'sqlite';
  }

  get useTurso() {
    return false;
  }

  prepare(sql) {
    const stmt = this.raw.prepare(sql);
    return {
      get: (...params) => stmt.get(...params),
      all: (...params) => stmt.all(...params),
      run: (...params) => {
        const result = stmt.run(...params);
        return {
          lastInsertRowid: Number(result.lastInsertRowid),
          changes: Number(result.changes)
        };
      }
    };
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  pragma(source) {
    return this.raw.pragma(source);
  }

  transaction(fn) {
    const adapter = this;
    const run = async (...args) => {
      const nested = adapter._inTransaction > 0;
      if (!nested) {
        adapter.raw.exec('BEGIN');
      } else {
        adapter.raw.exec('SAVEPOINT pf_tx');
      }
      adapter._inTransaction += 1;
      try {
        const result = await fn(...args);
        if (!nested) {
          adapter.raw.exec('COMMIT');
        } else {
          adapter.raw.exec('RELEASE pf_tx');
        }
        adapter._inTransaction -= 1;
        return result;
      } catch (error) {
        try {
          if (!nested) {
            adapter.raw.exec('ROLLBACK');
          } else {
            adapter.raw.exec('ROLLBACK TO pf_tx');
            adapter.raw.exec('RELEASE pf_tx');
          }
        } catch {
          // ignore rollback failures
        }
        adapter._inTransaction = Math.max(0, adapter._inTransaction - 1);
        throw error;
      }
    };
    run.then = (onFulfilled, onRejected) => run().then(onFulfilled, onRejected);
    return run;
  }

  close() {
    this.raw.close();
  }
}
