import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createMemoryDatabase } from './db.js';
import { SqliteAdapter } from './sqliteAdapter.js';

describe('sqlite adapter transaction isolation', () => {
  test('a second transaction is not nested, and an outside read waits', async () => {
    const db = await createMemoryDatabase();
    let releaseA;
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    let markA;
    const aStarted = new Promise((resolve) => { markA = resolve; });

    const pendingA = db.transaction(async () => {
      db.prepare('INSERT INTO departments (code, name) VALUES (?, ?)').run('ZZ', 'Hidden');
      const inside = db.prepare('SELECT code FROM departments WHERE code = ?').get('ZZ');
      assert.equal(inside.code, 'ZZ');
      assert.equal(db.inTransaction(), true);
      markA();
      await gateA;
      throw new Error('rollback-a');
    })();

    await aStarted;
    assert.equal(db.inTransaction(), false);
    let outsideResolved = false;
    let outsideRow;
    const outside = db.prepare('SELECT code FROM departments WHERE code = ?').get('ZZ');
    assert.ok(outside && typeof outside.then === 'function');
    outside.then((row) => {
      outsideResolved = true;
      outsideRow = row;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(outsideResolved, false);

    const pendingB = db.transaction(async () => {
      db.prepare('INSERT INTO departments (code, name) VALUES (?, ?)').run('YY', 'Kept');
    })();

    releaseA();
    await assert.rejects(pendingA, /rollback-a/);
    await pendingB;
    await outside;
    assert.equal(outsideRow, undefined);
    assert.equal(db.prepare('SELECT code FROM departments WHERE code = ?').get('ZZ'), undefined);
    assert.equal(db.prepare('SELECT code FROM departments WHERE code = ?').get('YY').code, 'YY');
    db.close();
  });

  test('nested transaction on the same call stack uses a savepoint', async () => {
    const db = await createMemoryDatabase();
    await db.transaction(async () => {
      db.prepare('INSERT INTO departments (code, name) VALUES (?, ?)').run('AA', 'Outer');
      await db.transaction(async () => {
        db.prepare('INSERT INTO departments (code, name) VALUES (?, ?)').run('BB', 'Inner');
        throw new Error('inner');
      })().catch((error) => {
        assert.match(error.message, /inner/);
      });
      assert.equal(db.prepare('SELECT code FROM departments WHERE code = ?').get('AA').code, 'AA');
      assert.equal(db.prepare('SELECT code FROM departments WHERE code = ?').get('BB'), undefined);
    })();
    assert.equal(db.prepare('SELECT code FROM departments WHERE code = ?').get('AA').code, 'AA');
    db.close();
  });

  test('a statement waiting on another transaction times out', async () => {
    const raw = new Database(':memory:');
    const db = new SqliteAdapter(raw, { waitMs: 40 });
    db.exec('CREATE TABLE t (id INTEGER)');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const pending = db.transaction(async () => {
      await gate;
    })();
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      () => db.prepare('SELECT 1 AS n').get(),
      (error) => error.code === 'sqlite_transaction_timeout'
        && /timed out after 40ms/.test(error.message)
    );
    release();
    await pending;
    db.close();
  });

  test('batch commits the chunk or rolls it back together', async () => {
    const db = await createMemoryDatabase();
    await db.batch([
      { sql: 'INSERT INTO departments (code, name) VALUES (?, ?)', args: ['AA', 'Alpha'] }
    ]);
    assert.equal(db.prepare('SELECT code FROM departments WHERE code = ?').get('AA').code, 'AA');
    await assert.rejects(
      () => db.batch([
        { sql: 'INSERT INTO departments (code, name) VALUES (?, ?)', args: ['BB', 'Beta'] },
        { sql: 'INSERT INTO departments (code, name) VALUES (?, ?)', args: ['AA', 'Duplicate'] }
      ]),
      /UNIQUE/
    );
    assert.equal(db.prepare('SELECT code FROM departments WHERE code = ?').get('BB'), undefined);
    db.close();
  });
});
