import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decideApprovalStep } from './approvalsService.js';
import { queryApprovalCompliance } from './complianceReports.js';
import { proposeAward } from './sourcingAwardService.js';
import { BOB, CAROL, DAVID, ELENA, FRANK, NOW, evaluate, seedEvent, seedWorld } from './sourcingAwardFixtures.js';

async function awardFor(db, proposer, { ownerRfq = CAROL, sourcePr = false } = {}) {
  const ctx = await seedEvent(db, { sourcePr });
  await evaluate(db, ctx);
  const view = await proposeAward(db, proposer, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW });
  const steps = await db.prepare(`
    SELECT id, approver_id, step_order FROM approval_requests WHERE requisition_id = ? ORDER BY step_order
  `).all(view.award.requisition.id);
  return { ctx, view, steps, prId: view.award.requisition.id };
}

function decide(db, step, user) {
  return decideApprovalStep(db, {
    approvalId: step.id,
    decision: 'approved',
    approver_id: user.id,
    approver_name: user.name
  });
}

const forbidden = (e) => e.statusCode === 403 && e.code === 'sod_award_self_approval';

describe('B1: owner and proposer cannot decide their own award', () => {
  test('the award records its owner and proposer, and the chain excludes both', async () => {
    const db = await seedWorld();
    // Elena (admin) proposes on Carol's RFQ.
    const { view, steps } = await awardFor(db, ELENA);
    const row = await db.prepare(`SELECT owner_user_id, proposed_by_user_id FROM sourcing_awards WHERE id = ?`).get(view.award.id);
    assert.equal(row.owner_user_id, 3);
    assert.equal(row.proposed_by_user_id, 5);
    assert.ok(!steps.some((step) => [3, 5].includes(step.approver_id)), JSON.stringify(steps));
    const snapshot = JSON.parse((await db.prepare(`SELECT comparison_snapshot_json AS s FROM sourcing_awards WHERE id = ?`).get(view.award.id)).s);
    assert.equal(snapshot.owner_user_id, 3);
    assert.equal(snapshot.proposed_by_user_id, 5);
  });

  test('repro 1: an admin proposes, delegates the next step to themselves, and cannot approve', async () => {
    const db = await seedWorld();
    // Total above 10.000 so finance (David) is a step; Elena proposes.
    await db.prepare(`UPDATE sourcing_bid_lines SET unit_price_cents = unit_price_cents`).run();
    const { steps, prId } = await awardFor(db, ELENA);
    assert.ok(steps.length >= 2);
    const stepOne = steps[0];
    // Elena sets up a delegation from the step's approver to herself.
    await db.prepare(`
      INSERT INTO approval_delegations (delegator_user_id, delegate_user_id, active, reason, created_by_user_id, created_by_name)
      VALUES (?, 5, 1, 'Eigen delegatie', 5, 'Elena Rostova')
    `).run(stepOne.approver_id);
    await assert.rejects(decide(db, stepOne, ELENA), forbidden);
    const still = await db.prepare(`SELECT status FROM approval_requests WHERE id = ?`).get(stepOne.id);
    assert.equal(still.status, 'pending');
    const pr = await db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId);
    assert.equal(pr.status, 'pending_approval');
  });

  test('repro 2: a department head who proposes is routed around, and cannot approve as dept approver', async () => {
    const db = await seedWorld();
    // Elena (admin) is the mapped department head of Marketing.
    await db.prepare(`UPDATE departments SET approver_user_id = 5 WHERE id = 1`).run();
    const { steps } = await awardFor(db, ELENA);
    assert.notEqual(steps[0].approver_id, 5, 'the dept head step is re-resolved around the proposer');
    // Even forced back onto the step she cannot decide it.
    await db.prepare(`UPDATE approval_requests SET approver_id = 5 WHERE id = ?`).run(steps[0].id);
    await assert.rejects(decide(db, steps[0], ELENA), forbidden);
  });

  test('direct, delegate, delegator, and delegation-creator paths are all refused for owner and proposer', async () => {
    const db = await seedWorld();
    const { steps } = await awardFor(db, ELENA);
    const [first] = steps;

    // Owner directly.
    await db.prepare(`UPDATE approval_requests SET approver_id = 3 WHERE id = ?`).run(first.id);
    await assert.rejects(decide(db, first, CAROL), forbidden);
    // A third party decides the owner's step through a delegation (owner is the delegator).
    await db.prepare(`
      INSERT INTO approval_delegations (delegator_user_id, delegate_user_id, active, reason, created_by_user_id, created_by_name)
      VALUES (3, 6, 1, 'Afwezig', 3, 'Carol')
    `).run();
    await assert.rejects(decide(db, first, FRANK), forbidden);

    // Proposer as the delegate of the real approver.
    await db.prepare(`UPDATE approval_requests SET approver_id = 2 WHERE id = ?`).run(first.id);
    await db.prepare(`
      INSERT INTO approval_delegations (delegator_user_id, delegate_user_id, active, reason, created_by_user_id, created_by_name)
      VALUES (2, 5, 1, 'Afwezig', 2, 'Bob')
    `).run();
    await assert.rejects(decide(db, first, ELENA), forbidden);

    // A third party decides through a delegation the proposer created.
    await db.prepare(`
      INSERT INTO approval_delegations (delegator_user_id, delegate_user_id, active, reason, created_by_user_id, created_by_name)
      VALUES (2, 6, 1, 'Door beheerder', 5, 'Elena Rostova')
    `).run();
    await assert.rejects(decide(db, first, FRANK), forbidden);

    // The legitimate approver still can.
    await db.prepare(`UPDATE approval_delegations SET active = 0`).run();
    const result = await decide(db, first, BOB);
    assert.ok(['step_approved', 'approved'].includes(result.outcome));
  });

  test('an evaluator with a declared conflict is excluded and refused', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await db.prepare(`
      INSERT INTO sourcing_evaluators (event_id, user_id, coi_status, coi_declared_at, coi_note, added_by_user_id, created_at)
      VALUES (?, 6, 'conflict_declared', '2026-10-09T09:00:00.000Z', 'Neef bij leverancier', 3, '2026-10-01T00:00:00.000Z')
    `).run(ctx.eventId);
    await evaluate(db, ctx);
    const view = await proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW });
    const steps = await db.prepare(`SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? ORDER BY step_order`).all(view.award.requisition.id);
    assert.deepEqual(steps.map((s) => s.approver_id), [2, 4], 'Frank is skipped, finance steps in');
    await db.prepare(`UPDATE approval_requests SET approver_id = 6 WHERE id = ?`).run(steps[0].id);
    await assert.rejects(decide(db, steps[0], FRANK), forbidden);
  });

  test('the compliance report expects the chain without the proposer and flags a proposer on a step', async () => {
    const db = await seedWorld();
    const { steps } = await awardFor(db, ELENA);
    let report = await queryApprovalCompliance(db);
    assert.equal(report.findings.filter((row) => row.code === 'wrong_approver').length, 0);
    assert.equal(report.findings.filter((row) => row.code === 'sourcing_award_self_approval').length, 0);
    await db.prepare(`UPDATE approval_requests SET approver_id = 5 WHERE id = ?`).run(steps[1].id);
    report = await queryApprovalCompliance(db);
    const hits = report.findings.filter((row) => row.code === 'sourcing_award_self_approval');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].actor_user_id, 5);
    assert.ok(DAVID && FRANK);
  });
});
