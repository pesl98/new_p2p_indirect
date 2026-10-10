import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeAward } from './sourcingAwardService.js';
import { reassignOwner } from './sourcingEvaluationService.js';
import { CAROL, ELENA, NOW, call, evaluate, seedEvent, seedWorld, withApp } from './sourcingAwardFixtures.js';

describe('reassignOwner checks for an open award inside its own transaction', () => {
  test('refused while an award is pending; allowed after it is rejected', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await evaluate(db, ctx);
    const view = await proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW });
    await assert.rejects(
      reassignOwner(db, ELENA, ctx.eventId, { user_id: 6, reason: 'Eigenaar wisselt van team' }, { now: NOW }),
      (e) => e.statusCode === 409 && e.code === 'award_already_open'
    );
    assert.equal((await db.prepare(`SELECT owner_user_id FROM sourcing_events WHERE id = ?`).get(ctx.eventId)).owner_user_id, 3);
    await db.prepare(`UPDATE sourcing_awards SET status = 'rejected' WHERE id = ?`).run(view.award.id);
    await reassignOwner(db, ELENA, ctx.eventId, { user_id: 6, reason: 'Eigenaar wisselt van team' }, { now: NOW });
    assert.equal((await db.prepare(`SELECT owner_user_id FROM sourcing_events WHERE id = ?`).get(ctx.eventId)).owner_user_id, 6);
  });

  test('an award that appears after the request started still blocks the change', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await evaluate(db, ctx);
    // Nothing is open when the request begins; the award lands just before its transaction.
    const original = db.immediateTransaction.bind(db);
    let proposed = false;
    db.immediateTransaction = (fn) => original(async (...args) => {
      if (!proposed) {
        proposed = true;
        await db.prepare(`
          INSERT INTO sourcing_awards (event_id, award_type, status, total_cents, is_lowest, comparison_snapshot_json, proposed_by_user_id, owner_user_id, proposed_at)
          VALUES (?, 'full', 'pending_approval', 1, 1, '{}', 3, 3, '2026-10-20T12:00:00Z')
        `).run(ctx.eventId);
      }
      return fn(...args);
    });
    await assert.rejects(
      reassignOwner(db, ELENA, ctx.eventId, { user_id: 6, reason: 'Eigenaar wisselt van team' }, { now: NOW }),
      (e) => e.statusCode === 409 && e.code === 'award_already_open'
    );
    db.immediateTransaction = original;
    assert.equal((await db.prepare(`SELECT owner_user_id FROM sourcing_events WHERE id = ?`).get(ctx.eventId)).owner_user_id, 3);
  });

  test('only an admin can reassign, over HTTP too', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await evaluate(db, ctx);
    await withApp(db, async (base) => {
      assert.equal((await call(base, 3, 'POST', `/api/sourcing/events/${ctx.eventId}/owner`, { user_id: 6, reason: 'Wisseling van eigenaar' })).status, 403);
      assert.equal((await call(base, 5, 'POST', `/api/sourcing/events/${ctx.eventId}/owner`, { user_id: 6, reason: 'Wisseling van eigenaar' })).status, 200);
    });
  });
});
