import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decideApprovalStep } from './approvalsService.js';
import { boot, budget, post, seedClosedEvent, withFlag, withServer } from './sourcingAwardKit.js';

async function singleStepAward(base, db) {
  const seeded = await seedClosedEvent(db, { unitPrice: 20000, lineCount: 2 });
  const evaluated = await post(base, `/api/sourcing/events/${seeded.eventId}/evaluate`, 3, { row_version: 0 });
  const award = await post(base, `/api/sourcing/events/${seeded.eventId}/awards`, 3, {
    award_type: 'full', bid_id: seeded.bids[0].bid_id, row_version: evaluated.body.row_version
  });
  assert.equal(award.status, 201, JSON.stringify(award.body));
  const step = await db.prepare(`SELECT id FROM approval_requests WHERE requisition_id = ? AND step_order = 1`)
    .get(award.body.award.award_requisition_id);
  return { seeded, stepId: step.id, award: award.body.award };
}

function failingTransaction(error) {
  const run = async () => { throw error; };
  run.then = (resolve, reject) => run().then(resolve, reject);
  return run;
}

describe('approval transaction', () => {
  test('two simultaneous final approvals: one wins, the other gets 409, the budget is committed once', async () => {
    const { db, app } = await boot();
    await budget(db);
    await withFlag(() => withServer(app, async (base) => {
      const { stepId, seeded } = await singleStepAward(base, db);
      const results = await Promise.all([
        post(base, `/api/approvals/${stepId}/decide`, 2, { decision: 'approved', comments: 'a' }),
        post(base, `/api/approvals/${stepId}/decide`, 2, { decision: 'approved', comments: 'b' })
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], JSON.stringify(results.map((r) => r.body)));
      const loser = results.find((r) => r.status === 409);
      assert.equal(loser.body.code, 'approval_already_decided');
      const budgetRow = await db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get();
      assert.equal(Number(budgetRow.committed_amount), 40000);
      const event = await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(seeded.eventId);
      assert.equal(event.status, 'awarded');
      const outbox = await db.prepare(`SELECT COUNT(*) AS n FROM webhook_outbox WHERE event_type = 'sourcing_event.awarded'`).get();
      assert.equal(Number(outbox.n), 1);
    }));
  });

  test('a busy write lock is retried instead of surfacing as a 500', async () => {
    const { db, app } = await boot();
    await budget(db);
    await withFlag(() => withServer(app, async (base) => {
      const { stepId } = await singleStepAward(base, db);
      const original = db.immediateTransaction.bind(db);
      let failures = 0;
      db.immediateTransaction = (fn) => {
        if (failures < 2) {
          failures += 1;
          const busy = new Error('database is locked');
          busy.code = 'SQLITE_BUSY';
          return failingTransaction(busy);
        }
        return original(fn);
      };
      const res = await post(base, `/api/approvals/${stepId}/decide`, 2, { decision: 'approved', comments: 'ok' });
      db.immediateTransaction = original;
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(failures, 2);
    }));
  });

  test('a lock that never frees is a 503 with a retry hint, not a 500', async () => {
    const { db, app } = await boot();
    await budget(db);
    await withFlag(() => withServer(app, async (base) => {
      const { stepId } = await singleStepAward(base, db);
      const original = db.immediateTransaction.bind(db);
      const busy = new Error('database is locked');
      busy.code = 'SQLITE_BUSY';
      db.immediateTransaction = () => failingTransaction(busy);
      const res = await post(base, `/api/approvals/${stepId}/decide`, 2, { decision: 'approved' });
      db.immediateTransaction = original;
      assert.equal(res.status, 503);
      assert.equal(res.body.code, 'busy');
    }));
  });

  test('the service rejects a second decision on a decided step with 409', async () => {
    const { db, app } = await boot();
    await budget(db);
    await withFlag(() => withServer(app, async (base) => {
      const { stepId } = await singleStepAward(base, db);
      await decideApprovalStep(db, { approvalId: stepId, decision: 'approved', approver_id: 2, approver_name: 'Bob' });
      await assert.rejects(
        decideApprovalStep(db, { approvalId: stepId, decision: 'rejected', approver_id: 2, approver_name: 'Bob' }),
        (e) => e.statusCode === 409 && e.code === 'approval_already_decided'
      );
    }));
  });
});
