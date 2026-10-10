import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeAward } from './sourcingAwardService.js';
import { CAROL, NOW, call, evaluate, seedEvent, seedWorld, withApp } from './sourcingAwardFixtures.js';

async function proposed(db) {
  const ctx = await seedEvent(db);
  await evaluate(db, ctx);
  const view = await proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW });
  return { ctx, view, prId: view.award.requisition.id };
}

describe('award prices are hidden from conflicted users and colleague buyers', () => {
  test('GET /award and the approval snapshot', async () => {
    const db = await seedWorld();
    await db.prepare(`INSERT INTO users (id, name, email, role, department_id, title, status) VALUES (7, 'Gina Buyer', 'gina@example.com', 'procurement', 1, 'Buyer', 'active')`).run();
    const { ctx, prId } = await proposed(db);
    await withApp(db, async (base) => {
      const award = (userId) => call(base, userId, 'GET', `/api/sourcing/events/${ctx.eventId}/award`);
      const snapshot = (userId) => call(base, userId, 'GET', `/api/approvals/award-snapshot/${prId}`);

      // Owner, admin and finance see prices.
      for (const userId of [3, 4, 5]) {
        const res = await award(userId);
        assert.equal(res.status, 200);
        assert.equal(res.body.award.prices_hidden, undefined, `user ${userId}`);
        assert.equal(res.body.award.total_cents, 125000);
        assert.ok(res.body.award.snapshot.matrix);
      }
      // A colleague buyer (Gina, procurement, not owner, not evaluator, not in the chain) does not.
      let res = await award(7);
      assert.equal(res.body.award.prices_hidden, true);
      assert.equal(res.body.award.total_cents, null);
      assert.equal(res.body.award.snapshot.matrix, undefined);
      assert.doesNotMatch(JSON.stringify(res.body), /unit_price_cents|line_total_cents|supplier_name/);
      res = await snapshot(7);
      assert.equal(res.status, 200);
      assert.equal(res.body.prices_hidden, true);
      assert.equal(res.body.snapshot.matrix, undefined);
      assert.equal(res.body.total_cents, null);

      // The approver in the chain must see what they approve.
      res = await snapshot(2);
      assert.equal(res.status, 200);
      assert.equal(res.body.prices_hidden, undefined);
      assert.ok(res.body.snapshot.matrix);
      // A requester has no business here.
      assert.equal((await snapshot(1)).status, 403);

      // Gina as an evaluator with a clean declaration may see them.
      await db.prepare(`
        INSERT INTO sourcing_evaluators (event_id, user_id, coi_status, coi_declared_at, added_by_user_id, created_at)
        VALUES (?, 7, 'none_declared', '2026-10-09T09:00:00.000Z', 3, '2026-10-01T00:00:00.000Z')
      `).run(ctx.eventId);
      assert.ok((await award(7)).body.award.snapshot.matrix);
      assert.ok((await snapshot(7)).body.snapshot.matrix);

      // A declared conflict takes the prices away again, even from an approver in the chain.
      await db.prepare(`UPDATE sourcing_evaluators SET coi_status = 'conflict_declared', coi_note = 'Neef' WHERE event_id = ? AND user_id = 7`).run(ctx.eventId);
      assert.equal((await award(7)).body.award.prices_hidden, true);
      assert.equal((await snapshot(7)).body.prices_hidden, true);
      await db.prepare(`INSERT INTO sourcing_evaluators (event_id, user_id, coi_status, coi_note, added_by_user_id, created_at) VALUES (?, 2, 'conflict_declared', 'Familie', 3, '2026-10-01T00:00:00.000Z')`).run(ctx.eventId);
      assert.equal((await snapshot(2)).body.prices_hidden, true, 'conflict beats approval-chain access');
    });
  });
});
