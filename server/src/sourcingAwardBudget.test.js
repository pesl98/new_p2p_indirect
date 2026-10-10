import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { call, seedCapsEvent, seedWorld, watchPipeline, withApp } from './sourcingAwardFixtures.js';

describe('B4: statement budget at the caps (50 lines, 20 suppliers)', () => {
  test('every interactive transaction stays within 25 statements including BEGIN, COMMIT and rowid reads', async () => {
    const db = await seedWorld();
    const caps = await seedCapsEvent(db, { lines: 50, suppliers: 20 });
    const watch = watchPipeline(db);
    const measured = {};
    try {
      await withApp(db, async (base) => {
        assert.equal((await call(base, 3, 'POST', `/api/sourcing/events/${caps.eventId}/coi`, { status: 'none_declared' })).status, 200);
        let mark = watch.results.length;
        const evaluated = await call(base, 3, 'POST', `/api/sourcing/events/${caps.eventId}/evaluate`, { override_reason: 'Geen scores nodig in deze test' });
        assert.equal(evaluated.status, 200, JSON.stringify(evaluated.body));
        measured.evaluate = watch.results.slice(mark);

        // Make the owner's declaration so the award can be proposed.
        mark = watch.results.length;
        const award = await call(base, 3, 'POST', `/api/sourcing/events/${caps.eventId}/awards`, {
          award_type: 'split',
          reason: 'Spreiding over twintig leveranciers',
          lines: caps.lineIds.map((id, index) => ({ event_line_id: id, bid_id: caps.bids[index % caps.bids.length].bidId }))
        });
        assert.equal(award.status, 201, JSON.stringify(award.body));
        assert.equal(award.body.award.lines.length, 50);
        measured.award = watch.results.slice(mark);

        mark = watch.results.length;
        for (let guard = 0; guard < 6; guard += 1) {
          const step = await db.prepare(`
            SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'
          `).get(award.body.award.requisition.id);
          if (!step) break;
          const decided = await call(base, step.approver_id, 'POST', `/api/approvals/${step.id}/decide`, { decision: 'approved', comments: 'ok' });
          assert.equal(decided.status, 200, JSON.stringify(decided.body));
        }
        measured.approval = watch.results.slice(mark);

        mark = watch.results.length;
        const first = await call(base, 3, 'POST', `/api/sourcing/events/${caps.eventId}/purchase-orders`);
        assert.equal(first.status, 201, JSON.stringify(first.body));
        assert.equal(first.body.done, true);
        assert.equal(first.body.purchase_orders.length, 20);
        measured.purchase_orders = watch.results.slice(mark);
      });
    } finally {
      watch.restore();
    }
    console.log(`# STATEMENTS (prepared/pipeline incl BEGIN+COMMIT): ${JSON.stringify(measured)}`);
    for (const [name, rows] of Object.entries(measured)) {
      assert.ok(rows.length > 0, name);
      for (const row of rows) assert.ok(row.pipeline <= 25, `${name} used ${row.pipeline} pipeline statements`);
    }
    assert.ok(measured.award.every((row) => row.pipeline <= 23), 'the award stays at 23 or less');
  });

  test('the time budget stops PO creation early and the next call finishes it, without duplicates', async () => {
    const db = await seedWorld();
    const caps = await seedCapsEvent(db, { lines: 6, suppliers: 5 });
    await withApp(db, async (base) => {
      await call(base, 3, 'POST', `/api/sourcing/events/${caps.eventId}/coi`, { status: 'none_declared' });
      await call(base, 3, 'POST', `/api/sourcing/events/${caps.eventId}/evaluate`, { override_reason: 'Geen scores nodig in deze test' });
      const award = await call(base, 3, 'POST', `/api/sourcing/events/${caps.eventId}/awards`, {
        award_type: 'split',
        reason: 'Spreiding over vijf leveranciers',
        lines: caps.lineIds.map((id, index) => ({ event_line_id: id, bid_id: caps.bids[index % caps.bids.length].bidId }))
      });
      assert.equal(award.status, 201, JSON.stringify(award.body));
      for (let guard = 0; guard < 6; guard += 1) {
        const step = await db.prepare(`SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'`).get(award.body.award.requisition.id);
        if (!step) break;
        await call(base, step.approver_id, 'POST', `/api/approvals/${step.id}/decide`, { decision: 'approved' });
      }
      const { createAwardPurchaseOrders } = await import('./sourcingAwardService.js');
      const first = await createAwardPurchaseOrders(db, { id: 3, name: 'Carol Zhang', role: 'procurement' }, caps.eventId, { timeBudgetMs: 0 });
      assert.equal(first.done, false);
      assert.equal(first.purchase_orders.length, 2, 'one chunk of two suppliers');
      assert.equal(first.remaining.length, 3);
      assert.equal((await db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(award.body.award.requisition.id)).status, 'approved');
      let last = first;
      for (let guard = 0; guard < 5 && !last.done; guard += 1) {
        last = await createAwardPurchaseOrders(db, { id: 3, name: 'Carol Zhang', role: 'procurement' }, caps.eventId, { timeBudgetMs: 0 });
      }
      assert.equal(last.done, true);
      assert.deepEqual(last.remaining, []);
      const count = await db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT supplier_id) AS s FROM purchase_orders WHERE award_id IS NOT NULL`).get();
      assert.equal(Number(count.n), 5);
      assert.equal(Number(count.s), 5);
      assert.equal((await db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(award.body.award.requisition.id)).status, 'converted_to_po');
    });
  });
});
