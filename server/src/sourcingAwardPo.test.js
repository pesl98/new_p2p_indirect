import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decideApprovalStep } from './approvalsService.js';
import { proposeAward } from './sourcingAwardService.js';
import { CAROL, NOW, call, evaluate, seedEvent, seedWorld, withApp } from './sourcingAwardFixtures.js';

async function approvedFullAward(db) {
  const ctx = await seedEvent(db);
  await evaluate(db, ctx);
  const view = await proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW });
  const prId = view.award.requisition.id;
  for (let guard = 0; guard < 5; guard += 1) {
    const step = await db.prepare(`SELECT id, approver_id FROM approval_requests WHERE requisition_id = ? AND status = 'pending'`).get(prId);
    if (!step) break;
    const user = await db.prepare(`SELECT name FROM users WHERE id = ?`).get(step.approver_id);
    await decideApprovalStep(db, { approvalId: step.id, decision: 'approved', approver_id: step.approver_id, approver_name: user.name });
  }
  return { ctx, view, prId };
}

describe('B2: award requisitions only convert through the award route', () => {
  test('the legacy convert refuses an award requisition for every role, with or without supplier_mappings', async () => {
    const db = await seedWorld();
    const { view, prId } = await approvedFullAward(db);
    const items = await db.prepare(`SELECT id FROM requisition_items WHERE requisition_id = ?`).all(prId);
    await withApp(db, async (base) => {
      for (const userId of [3, 5, 6]) {
        for (const body of [
          { requisition_id: prId },
          { requisition_id: prId, supplier_mappings: { [items[0].id]: 3 } },
          { requisition_id: prId, supplier_mappings: [{ requisition_item_id: items[0].id, supplier_id: 3 }] }
        ]) {
          const res = await call(base, userId, 'POST', '/api/purchase-orders/from-requisition', body);
          assert.equal(res.status, 409, JSON.stringify(res.body));
          assert.equal(res.body.code, 'award_requisition_via_sourcing');
        }
      }
      const count = await db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders WHERE requisition_id = ?`).get(prId);
      assert.equal(Number(count.n), 0);
      assert.equal((await db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId)).status, 'approved');
      assert.ok(view);
    });
  });

  test('the award route creates the POs at the awarded supplier, and a repeat is an idempotent 200', async () => {
    const db = await seedWorld();
    const { ctx, view, prId } = await approvedFullAward(db);
    await withApp(db, async (base) => {
      const first = await call(base, 3, 'POST', `/api/sourcing/events/${ctx.eventId}/purchase-orders`);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body.done, true);
      assert.deepEqual(first.body.remaining, []);
      assert.equal(first.body.purchase_orders.length, 1);
      assert.equal(first.body.purchase_orders[0].award_id, view.award.id);
      assert.equal(first.body.purchase_orders[0].supplier_id, 2);

      const again = await call(base, 3, 'POST', `/api/sourcing/events/${ctx.eventId}/purchase-orders`);
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.replayed, true);
      assert.equal(again.body.purchase_orders.length, 1);
      assert.equal(again.body.purchase_orders[0].po_number, first.body.purchase_orders[0].po_number);

      const count = await db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders WHERE requisition_id = ?`).get(prId);
      assert.equal(Number(count.n), 1);
      assert.equal((await db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId)).status, 'converted_to_po');
      assert.match((await db.prepare(`SELECT notes FROM purchase_orders WHERE award_id = ?`).get(view.award.id)).notes, /RFQ-2026-001/);
      // Finance may not create POs.
      assert.equal((await call(base, 4, 'POST', `/api/sourcing/events/${ctx.eventId}/purchase-orders`)).status, 403);
    });
  });

  test('the database allows one PO per award and supplier; ordinary POs are not constrained', async () => {
    const db = await seedWorld();
    const { ctx, view } = await approvedFullAward(db);
    await withApp(db, async (base) => {
      await call(base, 3, 'POST', `/api/sourcing/events/${ctx.eventId}/purchase-orders`);
    });
    await assert.rejects(
      async () => db.prepare(`
        INSERT INTO purchase_orders (po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date, award_id)
        VALUES ('PO-DUP-1', NULL, 2, 3, 'issued', 1, '2026-10-10', ?)
      `).run(view.award.id),
      /UNIQUE/i
    );
    await db.prepare(`
      INSERT INTO purchase_orders (po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date)
      VALUES ('PO-PLAIN-1', NULL, 2, 3, 'issued', 1, '2026-10-10')
    `).run();
  });

  test('before the award is approved the route refuses with 409', async () => {
    const db = await seedWorld();
    const ctx = await seedEvent(db);
    await evaluate(db, ctx);
    await proposeAward(db, CAROL, ctx.eventId, { award_type: 'full', bid_id: ctx.bids[2] }, { now: NOW });
    await withApp(db, async (base) => {
      const res = await call(base, 3, 'POST', `/api/sourcing/events/${ctx.eventId}/purchase-orders`);
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'award_not_approved');
    });
  });
});
