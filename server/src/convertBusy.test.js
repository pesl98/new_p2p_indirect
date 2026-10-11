import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { call, seedWorld, withApp } from './sourcingAwardFixtures.js';

function thenableFailure(error) {
  const run = async () => { throw error; };
  run.then = (resolve, reject) => run().then(resolve, reject);
  return run;
}

function busy(code) {
  const error = new Error(code === 'SQLITE_BUSY_SNAPSHOT' ? 'database is busy (snapshot)' : 'database is locked');
  error.code = code;
  return error;
}

async function approvedPr(db) {
  await db.prepare(`
    INSERT INTO purchase_requisitions (id, pr_number, requester_id, department_id, status, total_amount, needed_by_date)
    VALUES (50, 'PR-CONV-1', 1, 1, 'approved', 10000, '2026-12-01')
  `).run();
  await db.prepare(`
    INSERT INTO requisition_items (requisition_id, item_description, category, quantity, unit_price, total_price, estimated_supplier_id)
    VALUES (50, 'Stoel', 'Office Supplies', 1, 10000, 10000, 2)
  `).run();
}

describe('legacy convert-to-PO route', () => {
  test('uses BEGIN IMMEDIATE: a busy lock is retried, a snapshot is 409, a stuck lock is 503 with Retry-After', async () => {
    const db = await seedWorld();
    await approvedPr(db);
    await withApp(db, async (base) => {
      const original = db.immediateTransaction.bind(db);
      const body = { requisition_id: 50 };
      let failures = 0;
      db.immediateTransaction = (fn) => (failures < 2 ? (failures += 1, thenableFailure(busy('SQLITE_BUSY'))) : original(fn));
      let res = await call(base, 3, 'POST', '/api/purchase-orders/from-requisition', body);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(failures, 2, 'the immediate transaction was retried');

      await db.prepare(`UPDATE purchase_requisitions SET status = 'approved' WHERE id = 50`).run();
      db.immediateTransaction = () => thenableFailure(busy('SQLITE_BUSY_SNAPSHOT'));
      res = await call(base, 3, 'POST', '/api/purchase-orders/from-requisition', body);
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'busy_snapshot');

      db.immediateTransaction = () => thenableFailure(busy('SQLITE_BUSY'));
      res = await call(base, 3, 'POST', '/api/purchase-orders/from-requisition', body);
      assert.equal(res.status, 503);
      assert.equal(res.body.code, 'busy');
      assert.equal(res.headers.get('retry-after'), '1');
      db.immediateTransaction = original;
    });
  });

  test('two simultaneous converts of one requisition issue one set of POs', async () => {
    const db = await seedWorld();
    await approvedPr(db);
    await withApp(db, async (base) => {
      const results = await Promise.all([1, 2].map(() => call(base, 3, 'POST', '/api/purchase-orders/from-requisition', { requisition_id: 50 })));
      assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.body)));
      const count = await db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders WHERE requisition_id = 50`).get();
      assert.equal(Number(count.n), 1);
    });
  });
});
