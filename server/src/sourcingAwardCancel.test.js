import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decideApprovalStep } from './approvalsService.js';
import { proposeAward } from './sourcingAwardService.js';
import { cancelEvent } from './sourcingService.js';
import { CAROL, NOW, evaluate, seedEvent, seedWorld } from './sourcingAwardFixtures.js';

async function pendingAward(db, { sourcePr = true } = {}) {
  const ctx = await seedEvent(db, { sourcePr });
  await evaluate(db, ctx);
  const view = await proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW });
  const prId = view.award.requisition.id;
  const steps = await db.prepare(`SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? ORDER BY step_order`).all(prId);
  return { ctx, view, prId, steps };
}

const sentMessages = [];
const transport = async (message) => { sentMessages.push(message); return { status: 'sent' }; };

describe('B5: cancel from closed and evaluated', () => {
  test('a closed RFQ can be cancelled; the notice carries no link or token', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await db.prepare(`UPDATE sourcing_invitations SET token_hash = 'secrethash' || id, token_prefix = 'pfi_abc123def456' WHERE event_id = ?`).run(ctx.eventId);
    sentMessages.length = 0;
    const view = await cancelEvent(db, CAROL, ctx.eventId, { reason: 'Behoefte vervalt' }, { now: NOW, mailTransport: transport });
    assert.equal(view.status, 'cancelled');
    assert.equal(view.cancelled_before_deadline, 0);
    assert.ok(view.notice, 'invitees are told');
    const everything = JSON.stringify([view.notice, sentMessages]);
    assert.doesNotMatch(everything, /pfi_|portal\.html|#t=|secrethash|token/i);
    const hook = await db.prepare(`SELECT COUNT(*) AS n FROM webhook_outbox WHERE event_type = 'sourcing_event.cancelled'`).get();
    assert.equal(Number(hook.n), 1);
  });

  test('cancelling an evaluated RFQ rejects the pending award and its requisition in the same transaction', async () => {
    const db = await seedWorld();
    const { ctx, view, prId, steps } = await pendingAward(db);
    const result = await cancelEvent(db, CAROL, ctx.eventId, { reason: 'Aanvraag ingetrokken' }, { now: NOW });
    assert.equal(result.status, 'cancelled');
    assert.equal((await db.prepare(`SELECT status FROM sourcing_awards WHERE id = ?`).get(view.award.id)).status, 'rejected');
    assert.equal((await db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId)).status, 'rejected');
    const open = await db.prepare(`SELECT COUNT(*) AS n FROM approval_requests WHERE requisition_id = ? AND status IN ('pending', 'waiting')`).get(prId);
    assert.equal(Number(open.n), 0);
    const compliance = await db.prepare(`SELECT details FROM compliance_audit_events WHERE action = 'SOURCING_AWARD_WITHDRAWN'`).get();
    assert.match(compliance.details, /Aanvraag ingetrokken/);
    // Nobody can approve it any more, and the budget never moved.
    await assert.rejects(
      decideApprovalStep(db, { approvalId: steps[0].id, decision: 'approved', approver_id: steps[0].approver_id, approver_name: 'x' }),
      (e) => e.statusCode === 409 && e.code === 'approval_already_decided'
    );
    assert.equal(Number((await db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get()).committed_amount), 200000);
    // The source requisition is no longer locked by an open RFQ.
    const { findOpenSourcingEvent } = await import('./sourcingService.js');
    assert.equal(await findOpenSourcingEvent(db, ctx.sourcePrId), undefined);
  });

  test('an approved award (awarded RFQ) cannot be cancelled', async () => {
    const db = await seedWorld();
    const { ctx, prId } = await pendingAward(db);
    for (let guard = 0; guard < 5; guard += 1) {
      const step = await db.prepare(`SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'`).get(prId);
      if (!step) break;
      await decideApprovalStep(db, { approvalId: step.id, decision: 'approved', approver_id: step.approver_id, approver_name: 'x' });
    }
    await assert.rejects(
      cancelEvent(db, CAROL, ctx.eventId, { reason: 'Te laat voor annuleren' }, { now: NOW }),
      (e) => e.statusCode === 409
    );
    assert.equal((await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(ctx.eventId)).status, 'awarded');
  });

  test('the UPDATE guard holds when the award is approved between cancel\'s read and its transaction', async () => {
    const db = await seedWorld();
    const { ctx, view } = await pendingAward(db, { sourcePr: false });
    const originalTx = db.immediateTransaction.bind(db);
    db.immediateTransaction = (fn) => originalTx(async (...args) => {
      // A final approval commits just before cancel's transaction starts.
      await db.prepare(`UPDATE sourcing_awards SET status = 'approved' WHERE id = ?`).run(view.award.id);
      await db.prepare(`UPDATE sourcing_events SET status = 'awarded' WHERE id = ?`).run(ctx.eventId);
      return fn(...args);
    });
    await assert.rejects(
      cancelEvent(db, CAROL, ctx.eventId, { reason: 'Gelijktijdig geannuleerd' }, { now: NOW }),
      (e) => e.statusCode === 409
    );
    db.immediateTransaction = originalTx;
    assert.equal((await db.prepare(`SELECT status FROM sourcing_awards WHERE id = ?`).get(view.award.id)).status, 'approved');
  });

  test('a final approval racing a cancel ends in one consistent state', async () => {
    const db = await seedWorld();
    const { ctx, view, prId } = await pendingAward(db, { sourcePr: false });
    // Approve all but the last step, then race the final approval against the cancel.
    const steps = await db.prepare(`SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? ORDER BY step_order`).all(prId);
    for (const step of steps.slice(0, -1)) {
      await decideApprovalStep(db, { approvalId: step.id, decision: 'approved', approver_id: step.approver_id, approver_name: 'x' });
    }
    const last = steps[steps.length - 1];
    const results = await Promise.allSettled([
      decideApprovalStep(db, { approvalId: last.id, decision: 'approved', approver_id: last.approver_id, approver_name: 'x' }),
      cancelEvent(db, CAROL, ctx.eventId, { reason: 'Gelijktijdig geannuleerd' }, { now: NOW })
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.status)));
    const event = await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(ctx.eventId);
    const award = await db.prepare(`SELECT status FROM sourcing_awards WHERE id = ?`).get(view.award.id);
    const pr = await db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId);
    const budget = Number((await db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get()).committed_amount);
    if (event.status === 'cancelled') {
      assert.deepEqual([award.status, pr.status, budget], ['rejected', 'rejected', 200000]);
    } else {
      assert.deepEqual([event.status, award.status, pr.status], ['awarded', 'approved', 'approved']);
      assert.equal(budget, 200000 + 125000);
    }
  });
});
