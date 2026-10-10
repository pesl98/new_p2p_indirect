import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decideApprovalStep } from './approvalsService.js';
import { loadPortalView } from './sourcingPortalService.js';
import { proposeAward, publishOutcome } from './sourcingAwardService.js';
import { CAROL, DAVID, NOW, evaluate, seedEvent, seedWorld } from './sourcingAwardFixtures.js';

const MAIL_ENV = { MAIL_PROVIDER: 'smtp', MAIL_FROM: 'inkoop@procure.example', MAIL_SMTP_URL: 'smtp://relay.invalid:25' };

async function approveAll(db, prId) {
  for (let guard = 0; guard < 6; guard += 1) {
    const step = await db.prepare(`
      SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'
    `).get(prId);
    if (!step) return;
    const user = await db.prepare(`SELECT name FROM users WHERE id = ?`).get(step.approver_id);
    await decideApprovalStep(db, { approvalId: step.id, decision: 'approved', approver_id: step.approver_id, approver_name: user.name });
  }
}

async function awardedWorld() {
  const db = await seedWorld();
  const ctx = await seedEvent(db);
  await evaluate(db, ctx);
  const view = await proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW });
  await approveAll(db, view.award.requisition.id);
  return { db, ctx };
}

async function portalCtx(db, ctx, supplierId) {
  const inv = await db.prepare(`SELECT id FROM sourcing_invitations WHERE event_id = ? AND supplier_id = ?`).get(ctx.eventId, supplierId);
  return { event_id: ctx.eventId, supplier_id: supplierId, invitation_id: Number(inv.id) };
}

describe('award outcome', () => {
  test('nothing is visible to suppliers until the buyer shares the outcome', async () => {
    const { db, ctx } = await awardedWorld();
    for (const supplier of [2, 3, 4]) {
      const view = await loadPortalView(db, await portalCtx(db, ctx, supplier), NOW);
      assert.equal(view.outcome, null);
      assert.equal(view.event.status, 'closed', 'awarded is internal until the outcome is shared');
    }
    await publishOutcome(db, CAROL, ctx.eventId, { now: NOW });
    const shared = await loadPortalView(db, await portalCtx(db, ctx, 2), NOW);
    assert.equal(shared.event.status, 'awarded');
  });

  test('an evaluated RFQ reads as closed in the portal', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await evaluate(db, ctx);
    const status = (await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(ctx.eventId)).status;
    assert.equal(status, 'evaluated');
    const view = await loadPortalView(db, await portalCtx(db, ctx, 2), NOW);
    assert.equal(view.event.status, 'closed');
  });

  test('winner sees own lines and prices; others only "not awarded"; replay mails nobody twice', async () => {
    const { db, ctx } = await awardedWorld();
    const sent = [];
    const options = { now: NOW, env: MAIL_ENV, awaitMail: true, mailTransport: async (message) => { sent.push(message); } };
    await assert.rejects(publishOutcome(db, DAVID, ctx.eventId, options), (e) => e.statusCode === 403);
    const first = await publishOutcome(db, CAROL, ctx.eventId, options);
    assert.equal(first.replayed, false);
    assert.equal(sent.length, 3);
    assert.ok(sent.every((m) => !/\d+,\d{2}|€|pfi_/.test(m.text)), 'mail carries no amounts or links');

    const winner = await loadPortalView(db, await portalCtx(db, ctx, 2), NOW);
    assert.equal(winner.outcome.awarded, true);
    assert.deepEqual(winner.outcome.lines.map((l) => l.unit_price_cents), [10000, 5000]);
    for (const supplier of [3, 4]) {
      const loser = await loadPortalView(db, await portalCtx(db, ctx, supplier), NOW);
      assert.equal(loser.outcome.awarded, false);
      assert.deepEqual(loser.outcome.lines, []);
      const text = JSON.stringify({ ...loser, bid: null });
      assert.doesNotMatch(text, /Alpha|Beta|Gamma|10000/);
    }

    const again = await publishOutcome(db, CAROL, ctx.eventId, options);
    assert.equal(again.replayed, true);
    assert.equal(sent.length, 3);
  });

  test('only an awarded RFQ can share an outcome', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await assert.rejects(publishOutcome(db, CAROL, ctx.eventId, { now: NOW }), (e) => e.statusCode === 409);
  });
});
