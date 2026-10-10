import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { awardSodThresholdCents, guardAwardSelfApproval } from './sourcingApprovalHooks.js';
import { queryApprovalCompliance } from './complianceReports.js';
import { boot, budget, post, seedClosedEvent, withFlag, withServer } from './sourcingAwardKit.js';

async function proposeAs(base, db, seeded, proposerId, body = {}) {
  const evaluated = await post(base, `/api/sourcing/events/${seeded.eventId}/evaluate`, proposerId, { row_version: 0 });
  assert.equal(evaluated.status, 200, JSON.stringify(evaluated.body));
  const award = await post(base, `/api/sourcing/events/${seeded.eventId}/awards`, proposerId, {
    award_type: 'full',
    bid_id: seeded.bids[0].bid_id,
    row_version: evaluated.body.row_version,
    ...body
  });
  assert.equal(award.status, 201, JSON.stringify(award.body));
  const prId = award.body.award.award_requisition_id;
  const steps = await db.prepare(`
    SELECT id, approver_id, step_order FROM approval_requests WHERE requisition_id = ? ORDER BY step_order
  `).all(prId);
  return { award: award.body.award, prId, steps };
}

async function decide(base, stepId, userId) {
  return post(base, `/api/approvals/${stepId}/decide`, userId, { decision: 'approved', comments: 'ok' });
}

describe('B1: award segregation of duties above the threshold', () => {
  test('the award keeps the owner and proposer; the proposer and owner are excluded from the chain', async () => {
    const { db, app } = await boot();
    await budget(db);
    const seeded = await seedClosedEvent(db, { unitPrice: 80000, lineCount: 2 });
    await withFlag(() => withServer(app, async (base) => {
      // Elena (admin, user 5) proposes for owner Carol (user 3).
      const { award, steps } = await proposeAs(base, db, seeded, 5);
      const row = await db.prepare(`SELECT owner_user_id, proposed_by_user_id FROM sourcing_awards WHERE id = ?`).get(award.id);
      assert.equal(row.owner_user_id, 3);
      assert.equal(row.proposed_by_user_id, 5);
      assert.ok(!steps.some((step) => [3, 5].includes(step.approver_id)));
      const snapshot = JSON.parse((await db.prepare(`SELECT comparison_snapshot_json AS s FROM sourcing_awards WHERE id = ?`).get(award.id)).s);
      assert.equal(snapshot.owner_user_id, 3);
      assert.equal(snapshot.proposed_by_user_id, 5);
    }));
  });

  test('owner, proposer (even an admin), delegate and delegator are all refused with 403', async () => {
    const { db, app } = await boot();
    await budget(db);
    const seeded = await seedClosedEvent(db, { unitPrice: 80000, lineCount: 2 });
    await withFlag(() => withServer(app, async (base) => {
      const { steps } = await proposeAs(base, db, seeded, 5);
      const [first, second] = steps;

      // Directly: the owner is forced onto a step.
      await db.prepare(`UPDATE approval_requests SET approver_id = 3 WHERE id = ?`).run(first.id);
      let res = await decide(base, first.id, 3);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'sod_award_self_approval');

      // As delegator: a third person decides the owner's step through a delegation.
      await db.prepare(`
        INSERT INTO approval_delegations (delegator_user_id, delegate_user_id, active, reason, created_by_name)
        VALUES (3, 6, 1, 'Afwezig', 'Carol')
      `).run();
      res = await decide(base, first.id, 6);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'sod_award_self_approval');

      // Via admin: the proposer is an admin and is forced onto the step.
      await db.prepare(`UPDATE approval_requests SET approver_id = 5 WHERE id = ?`).run(first.id);
      res = await decide(base, first.id, 5);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'sod_award_self_approval');

      // As delegate: the proposer acts for the real step approver.
      await db.prepare(`UPDATE approval_requests SET approver_id = 2 WHERE id = ?`).run(first.id);
      await db.prepare(`
        INSERT INTO approval_delegations (delegator_user_id, delegate_user_id, active, reason, created_by_name)
        VALUES (2, 5, 1, 'Afwezig', 'Bob')
      `).run();
      res = await decide(base, first.id, 5);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'sod_award_self_approval');

      // The legitimate approver still can.
      res = await decide(base, first.id, 2);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(second);
    }));
  });

  test('an evaluator with a declared conflict is excluded from the chain and cannot approve', async () => {
    const { db, app } = await boot();
    await budget(db);
    const seeded = await seedClosedEvent(db, { unitPrice: 80000, lineCount: 2 });
    await db.prepare(`
      INSERT INTO sourcing_evaluators (event_id, user_id, coi_status, coi_declared_at, coi_note, added_by_user_id, created_at)
      VALUES (?, 6, 'conflict_declared', '2026-10-09T09:00:00.000Z', 'Neef bij leverancier', 3, '2026-10-01T00:00:00.000Z')
    `).run(seeded.eventId);
    await withFlag(() => withServer(app, async (base) => {
      const { steps } = await proposeAs(base, db, seeded, 3);
      assert.deepEqual(steps.map((step) => step.approver_id), [2, 4], 'Frank is skipped, finance escalates');
      await db.prepare(`UPDATE approval_requests SET approver_id = 6 WHERE id = ?`).run(steps[0].id);
      const res = await decide(base, steps[0].id, 6);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'sod_award_self_approval');
    }));
  });

  test('the owner cannot change while an award is open, and the award keeps the original owner', async () => {
    const { db, app } = await boot();
    await budget(db);
    const seeded = await seedClosedEvent(db, { unitPrice: 80000, lineCount: 2 });
    await withFlag(() => withServer(app, async (base) => {
      const { award } = await proposeAs(base, db, seeded, 3);
      const event = await db.prepare(`SELECT row_version FROM sourcing_events WHERE id = ?`).get(seeded.eventId);
      const moved = await post(base, `/api/sourcing/events/${seeded.eventId}/owner`, 5, { user_id: 6, row_version: event.row_version });
      assert.equal(moved.status, 409);
      assert.equal(moved.body.code, 'award_open');
      const row = await db.prepare(`SELECT owner_user_id FROM sourcing_awards WHERE id = ?`).get(award.id);
      assert.equal(row.owner_user_id, 3);
      // Even if the event row is forced to a new owner, the award snapshot still binds the original owner.
      await db.prepare(`UPDATE sourcing_events SET owner_user_id = 6 WHERE id = ?`).run(seeded.eventId);
      const steps = await db.prepare(`SELECT id FROM approval_requests WHERE requisition_id = ? ORDER BY step_order`).all(award.award_requisition_id);
      await db.prepare(`UPDATE approval_requests SET approver_id = 3 WHERE id = ?`).run(steps[0].id);
      const res = await decide(base, steps[0].id, 3);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'sod_award_self_approval');
    }));
  });

  test('at exactly the threshold the guard does not apply; one cent above it does', async () => {
    const { db, app } = await boot();
    await budget(db);
    const seeded = await seedClosedEvent(db, { unitPrice: 50000, lineCount: 2 });
    await withFlag(() => withServer(app, async (base) => {
      const { award, prId } = await proposeAs(base, db, seeded, 3);
      assert.equal(award.total_cents, 100000);
      assert.ok(await guardAwardSelfApproval(db, { requisitionId: prId, decidingUserId: 3 }), 'allowed at the threshold');
      await db.prepare(`UPDATE sourcing_awards SET total_cents = 100001 WHERE award_requisition_id = ?`).run(prId);
      await assert.rejects(
        guardAwardSelfApproval(db, { requisitionId: prId, decidingUserId: 3 }),
        (e) => e.statusCode === 403 && e.code === 'sod_award_self_approval'
      );
    }));
  });

  test('the threshold env is clamped to € 10.000 and bad values fall back', () => {
    assert.equal(awardSodThresholdCents({}), 100000);
    assert.equal(awardSodThresholdCents({ SOURCING_AWARD_SOD_THRESHOLD_CENTS: '250000' }), 250000);
    assert.equal(awardSodThresholdCents({ SOURCING_AWARD_SOD_THRESHOLD_CENTS: '99999999' }), 1000000);
    assert.equal(awardSodThresholdCents({ SOURCING_AWARD_SOD_THRESHOLD_CENTS: '-5' }), 100000);
    assert.equal(awardSodThresholdCents({ SOURCING_AWARD_SOD_THRESHOLD_CENTS: 'abc' }), 100000);
  });

  test('the compliance report builds the chain with the proposer excluded and flags a proposer on a step', async () => {
    const { db, app } = await boot();
    await budget(db);
    const seeded = await seedClosedEvent(db, { unitPrice: 80000, lineCount: 2 });
    await withFlag(() => withServer(app, async (base) => {
      const { award, steps } = await proposeAs(base, db, seeded, 5);
      let report = await queryApprovalCompliance(db);
      assert.equal(report.findings.filter((row) => row.code === 'wrong_approver').length, 0);
      assert.equal(report.findings.filter((row) => row.code === 'sourcing_award_self_approval').length, 0);
      await db.prepare(`UPDATE approval_requests SET approver_id = 5 WHERE id = ?`).run(steps[1].id);
      report = await queryApprovalCompliance(db);
      const hit = report.findings.filter((row) => row.code === 'sourcing_award_self_approval');
      assert.equal(hit.length, 1);
      assert.equal(hit[0].actor_user_id, 5);
      assert.ok(award);
    }));
  });
});
