import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decideApprovalStep } from './approvalsService.js';
import { createAwardPurchaseOrders, proposeAward } from './sourcingAwardService.js';
import { CAROL, NOW, evaluate, seedCapsEvent, seedEvent, seedWorld } from './sourcingAwardFixtures.js';

describe('nit 2: the chain is validated inside the propose transaction', () => {
  test('an owner change between the chain being built and the transaction starting gives 409 and strands nothing', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await evaluate(db, ctx);
    const original = db.immediateTransaction.bind(db);
    let moved = false;
    db.immediateTransaction = (fn) => original(async (...args) => {
      if (!moved) {
        moved = true;
        // An admin reassigns the owner in the gap.
        await db.prepare(`UPDATE sourcing_events SET owner_user_id = 6, row_version = row_version + 1 WHERE id = ?`).run(ctx.eventId);
      }
      return fn(...args);
    });
    await assert.rejects(
      proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW }),
      (e) => e.statusCode === 409 && e.code === 'event_state_changed'
    );
    db.immediateTransaction = original;
    assert.equal(Number((await db.prepare(`SELECT COUNT(*) AS n FROM sourcing_awards`).get()).n), 0);
    assert.equal(Number((await db.prepare(`SELECT COUNT(*) AS n FROM purchase_requisitions WHERE pr_number NOT LIKE 'PR-SRC%'`).get()).n), 0);
  });
});

describe('nit 3: parallel PO callers', () => {
  async function approvedCapsAward(db, suppliers) {
    const caps = await seedCapsEvent(db, { lines: suppliers, suppliers });
    await evaluate(db, { eventId: caps.eventId });
    const view = await proposeAward(db, CAROL, caps.eventId, {
      award_type: 'split',
      reason: 'Spreiding over leveranciers',
      lines: caps.lineIds.map((id, index) => ({ event_line_id: id, bid_id: caps.bids[index % caps.bids.length].bidId }))
    }, { now: NOW });
    for (let guard = 0; guard < 6; guard += 1) {
      const step = await db.prepare(`SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'`).get(view.award.requisition.id);
      if (!step) break;
      await decideApprovalStep(db, { approvalId: step.id, decision: 'approved', approver_id: step.approver_id, approver_name: 'x' });
    }
    return { caps, view };
  }

  test('two callers at once: no duplicate POs, no gaps in the numbers, and replayed only on a complete list', async () => {
    const db = await seedWorld();
    const { caps, view } = await approvedCapsAward(db, 6);
    const results = await Promise.all([
      createAwardPurchaseOrders(db, CAROL, caps.eventId, { timeBudgetMs: 0 }),
      createAwardPurchaseOrders(db, CAROL, caps.eventId, { timeBudgetMs: 0 })
    ]);
    for (const result of results) {
      if (result.replayed) {
        assert.equal(result.done, true, 'replayed only with done');
        assert.equal(result.purchase_orders.length, 6, 'replayed only with the complete list');
      }
      if (!result.done) assert.equal(result.replayed, false);
    }
    // Finish whatever is left, one chunk at a time.
    let last = results[0];
    for (let guard = 0; guard < 6 && !last.done; guard += 1) {
      last = await createAwardPurchaseOrders(db, CAROL, caps.eventId, { timeBudgetMs: 0 });
    }
    assert.equal(last.done, true);
    const rows = await db.prepare(`SELECT po_number, supplier_id FROM purchase_orders WHERE award_id = ? ORDER BY id`).all(view.award.id);
    assert.equal(rows.length, 6);
    assert.equal(new Set(rows.map((row) => row.supplier_id)).size, 6, 'one PO per supplier');
    const numbers = rows.map((row) => Number(row.po_number.split('-').pop()));
    assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6], 'no numbers were consumed by skipped inserts');
    const again = await createAwardPurchaseOrders(db, CAROL, caps.eventId);
    assert.equal(again.replayed, true);
    assert.equal(again.purchase_orders.length, 6);
  });

  test('a caller that finds its chunk already written reports progress, not a replay', async () => {
    const db = await seedWorld();
    const { caps } = await approvedCapsAward(db, 5);
    await createAwardPurchaseOrders(db, CAROL, caps.eventId, { timeBudgetMs: 0 });
    const second = await createAwardPurchaseOrders(db, CAROL, caps.eventId, { timeBudgetMs: 0 });
    assert.equal(second.done, false);
    assert.equal(second.replayed, false);
    assert.equal(second.purchase_orders.length, 4);
  });
});

describe('nit 4: the function limit matches the PO time budget', () => {
  test('api/index.js has maxDuration of at least 15 s and more than the ~10 s chunk budget', async () => {
    const { readFileSync } = await import('node:fs');
    const { AWARD_PO_TIME_BUDGET_MS } = await import('./purchaseOrdersService.js');
    const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
    const seconds = vercel.functions['api/index.js'].maxDuration;
    assert.ok(seconds >= 15, `maxDuration ${seconds}`);
    // One chunk can start just before the budget ends, so leave room for it.
    assert.ok(seconds * 1000 >= AWARD_PO_TIME_BUDGET_MS + 5000);
  });
});

describe('nit 5: a declared conflict hides prices from finance on /comparison too', () => {
  test('finance and admin with a declared conflict see a sealed comparison; without one they see prices', async () => {
    const { call, withApp } = await import('./sourcingAwardFixtures.js');
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await withApp(db, async (base) => {
      const comparison = (userId) => call(base, userId, 'GET', `/api/sourcing/events/${ctx.eventId}/comparison`);
      for (const userId of [4, 5]) {
        const open = await comparison(userId);
        assert.equal(open.status, 200);
        assert.ok(open.body.matrix, `user ${userId} sees prices before declaring a conflict`);
      }
      await db.prepare(`
        INSERT INTO sourcing_evaluators (event_id, user_id, coi_status, coi_declared_at, coi_note, added_by_user_id, created_at)
        VALUES (?, 4, 'conflict_declared', '2026-10-09T09:00:00.000Z', 'Aandelen in leverancier', 3, '2026-10-01T00:00:00.000Z'),
               (?, 5, 'conflict_declared', '2026-10-09T09:00:00.000Z', 'Familie', 3, '2026-10-01T00:00:00.000Z')
      `).run(ctx.eventId, ctx.eventId);
      for (const userId of [4, 5]) {
        const hidden = await comparison(userId);
        assert.equal(hidden.body.prices_hidden, true, `user ${userId}`);
        assert.equal(hidden.body.matrix, undefined);
        assert.doesNotMatch(JSON.stringify(hidden.body), /unit_price_cents|total_cents/);
      }
      // The owner is unaffected.
      assert.ok((await comparison(3)).body.matrix);
    });
  });
});
