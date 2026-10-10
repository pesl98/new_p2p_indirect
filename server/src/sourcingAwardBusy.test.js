import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decideApprovalStep } from './approvalsService.js';
import { withBusyRetry } from './busyRetry.js';
import { proposeAward, createAwardPurchaseOrders } from './sourcingAwardService.js';
import { CAROL, NOW, call, evaluate, seedEvent, seedWorld, withApp } from './sourcingAwardFixtures.js';

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

async function singleStepAward(db) {
  // Small total (one approval step): 2 lines at 20000 each is above 1000; use the default chain.
  const ctx = await seedEvent(db);
  await evaluate(db, ctx);
  const view = await proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW });
  const prId = view.award.requisition.id;
  const steps = await db.prepare(`SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? ORDER BY step_order`).all(prId);
  return { ctx, view, prId, steps };
}

describe('busy locks answer 409/503, never 500', () => {
  test('withBusyRetry: retries, then 503 busy or 409 busy_snapshot', async () => {
    let calls = 0;
    const ok = await withBusyRetry(async () => {
      calls += 1;
      if (calls < 3) throw busy('SQLITE_BUSY');
      return 'done';
    }, { sleep: async () => {} });
    assert.equal(ok, 'done');
    await assert.rejects(
      withBusyRetry(async () => { throw busy('SQLITE_BUSY'); }, { sleep: async () => {} }),
      (e) => e.statusCode === 503 && e.code === 'busy' && e.retryAfterSeconds === 1
    );
    await assert.rejects(
      withBusyRetry(async () => { throw busy('SQLITE_BUSY_SNAPSHOT'); }, { sleep: async () => {} }),
      (e) => e.statusCode === 409 && e.code === 'busy_snapshot'
    );
    // An application error is not retried and keeps its own status.
    let attempts = 0;
    await assert.rejects(
      withBusyRetry(async () => { attempts += 1; const e = new Error('no'); e.statusCode = 403; throw e; }, { sleep: async () => {} }),
      (e) => e.statusCode === 403
    );
    assert.equal(attempts, 1);
  });

  test('final approval over HTTP: transient BUSY is retried; BUSY_SNAPSHOT is 409; a stuck lock is 503 with Retry-After', async () => {
    const db = await seedWorld();
    const { steps } = await singleStepAward(db);
    await withApp(db, async (base) => {
      const original = db.immediateTransaction.bind(db);
      let failures = 0;
      db.immediateTransaction = (fn) => (failures < 2 ? (failures += 1, thenableFailure(busy('SQLITE_BUSY'))) : original(fn));
      let res = await call(base, steps[0].approver_id, 'POST', `/api/approvals/${steps[0].id}/decide`, { decision: 'approved' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(failures, 2);

      db.immediateTransaction = () => thenableFailure(busy('SQLITE_BUSY_SNAPSHOT'));
      res = await call(base, steps[1].approver_id, 'POST', `/api/approvals/${steps[1].id}/decide`, { decision: 'approved' });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'busy_snapshot');

      db.immediateTransaction = () => thenableFailure(busy('SQLITE_BUSY'));
      res = await call(base, steps[1].approver_id, 'POST', `/api/approvals/${steps[1].id}/decide`, { decision: 'approved' });
      assert.equal(res.status, 503);
      assert.equal(res.body.code, 'busy');
      assert.equal(res.headers.get('retry-after'), '1');
      db.immediateTransaction = original;
    });
  });

  test('two simultaneous final approvals: one wins, the other is 409 approval_already_decided', async () => {
    const db = await seedWorld();
    const { steps, ctx } = await singleStepAward(db);
    await decideApprovalStep(db, { approvalId: steps[0].id, decision: 'approved', approver_id: steps[0].approver_id, approver_name: 'x' });
    await withApp(db, async (base) => {
      const results = await Promise.all([
        call(base, steps[1].approver_id, 'POST', `/api/approvals/${steps[1].id}/decide`, { decision: 'approved' }),
        call(base, steps[1].approver_id, 'POST', `/api/approvals/${steps[1].id}/decide`, { decision: 'approved' })
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], JSON.stringify(results.map((r) => r.body)));
      assert.equal(results.find((r) => r.status === 409).body.code, 'approval_already_decided');
      assert.equal((await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(ctx.eventId)).status, 'awarded');
      assert.equal(Number((await db.prepare(`SELECT COUNT(*) AS n FROM webhook_outbox WHERE event_type = 'sourcing_event.awarded'`).get()).n), 1);
      assert.equal(Number((await db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get()).committed_amount), 200000 + 125000);
    });
  });

  test('award-to-PO conversion retries BUSY and reports 409/503 instead of throwing a raw SQLite error', async () => {
    const db = await seedWorld();
    const { ctx, prId } = await singleStepAward(db);
    for (let guard = 0; guard < 5; guard += 1) {
      const step = await db.prepare(`SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'`).get(prId);
      if (!step) break;
      await decideApprovalStep(db, { approvalId: step.id, decision: 'approved', approver_id: step.approver_id, approver_name: 'x' });
    }
    const original = db.immediateTransaction.bind(db);
    db.immediateTransaction = () => thenableFailure(busy('SQLITE_BUSY_SNAPSHOT'));
    await assert.rejects(createAwardPurchaseOrders(db, CAROL, ctx.eventId), (e) => e.statusCode === 409 && e.code === 'busy_snapshot');
    db.immediateTransaction = () => thenableFailure(busy('SQLITE_BUSY'));
    await assert.rejects(createAwardPurchaseOrders(db, CAROL, ctx.eventId), (e) => e.statusCode === 503 && e.code === 'busy');
    let failures = 0;
    db.immediateTransaction = (fn) => (failures < 1 ? (failures += 1, thenableFailure(busy('SQLITE_BUSY'))) : original(fn));
    const done = await createAwardPurchaseOrders(db, CAROL, ctx.eventId);
    db.immediateTransaction = original;
    assert.equal(done.done, true);
    assert.equal(done.purchase_orders.length, 1);
  });
});
