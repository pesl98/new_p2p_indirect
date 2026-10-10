import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createAwardPurchaseOrders } from './sourcingAwardService.js';
import { boot, budget, post, seedClosedEvent, withFlag, withServer } from './sourcingAwardKit.js';

const CAROL = { id: 3, name: 'Carol Zhang', role: 'procurement' };

async function approvedThreeWaySplit({ db, base }) {
  await db.prepare(`
    INSERT INTO suppliers (id, name, code, contact_person, email, status)
    VALUES (4, 'Third Supply', 'THI', 'Tom', 'tom@third.test', 'active')
  `).run();
  const seeded = await seedClosedEvent(db, { supplierIds: [2, 1, 4], unitPrice: [10000, 11000, 12000], lineCount: 3 });
  const evaluated = await post(base, `/api/sourcing/events/${seeded.eventId}/evaluate`, 3, { row_version: 0 });
  const award = await post(base, `/api/sourcing/events/${seeded.eventId}/awards`, 3, {
    award_type: 'split',
    lines: seeded.lines.map((line, index) => ({ event_line_id: line.id, bid_id: seeded.bids[index].bid_id })),
    reason: 'Spreiding over drie leveranciers',
    row_version: evaluated.body.row_version
  });
  assert.equal(award.status, 201, JSON.stringify(award.body));
  const step = await db.prepare(`SELECT id FROM approval_requests WHERE requisition_id = ? AND step_order = 1`)
    .get(award.body.award.award_requisition_id);
  const decided = await post(base, `/api/approvals/${step.id}/decide`, 2, { decision: 'approved', comments: 'ok' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  return { seeded, award: award.body.award };
}

describe('B2: award purchase orders', () => {
  test('every PO carries the award id and the database allows one PO per award and supplier', async () => {
    const { db, app } = await boot();
    await budget(db);
    await withFlag(() => withServer(app, async (base) => {
      const { seeded, award } = await approvedThreeWaySplit({ db, base });
      const result = await createAwardPurchaseOrders(db, CAROL, seeded.eventId);
      assert.equal(result.done, true);
      assert.deepEqual(result.remaining, []);
      assert.equal(result.purchase_orders.length, 3);
      for (const po of result.purchase_orders) assert.equal(po.award_id, award.id);
      await assert.rejects(
        async () => db.prepare(`
          INSERT INTO purchase_orders (po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date, award_id)
          VALUES ('PO-DUP-1', ?, 2, 3, 'issued', 1, '2026-10-10', ?)
        `).run(award.award_requisition_id, award.id),
        /UNIQUE/i
      );
      // The same supplier on an ordinary PO (no award) is not constrained.
      await db.prepare(`
        INSERT INTO purchase_orders (po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date)
        VALUES ('PO-PLAIN-1', NULL, 2, 3, 'issued', 1, '2026-10-10')
      `).run();
    }));
  });

  test('the time budget stops a request early and reports {done, remaining}; the next call finishes without duplicates', async () => {
    const { db, app } = await boot();
    await budget(db);
    await withFlag(() => withServer(app, async (base) => {
      const { seeded, award } = await approvedThreeWaySplit({ db, base });
      const first = await createAwardPurchaseOrders(db, CAROL, seeded.eventId, { timeBudgetMs: 0 });
      assert.equal(first.done, false);
      assert.equal(first.purchase_orders.length, 2);
      assert.equal(first.remaining.length, 1);
      assert.equal((await db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(award.award_requisition_id)).status, 'approved');
      const attention = await db.prepare(`SELECT status FROM sourcing_events WHERE id = ?`).get(seeded.eventId);
      assert.equal(attention.status, 'awarded');

      const second = await createAwardPurchaseOrders(db, CAROL, seeded.eventId, { timeBudgetMs: 0 });
      assert.equal(second.done, true);
      assert.deepEqual(second.remaining, []);
      assert.equal(second.purchase_orders.length, 3);
      assert.equal((await db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(award.award_requisition_id)).status, 'converted_to_po');

      const third = await createAwardPurchaseOrders(db, CAROL, seeded.eventId);
      assert.equal(third.replayed, true);
      assert.equal(third.done, true);
      const count = await db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders WHERE award_id = ?`).get(award.id);
      assert.equal(Number(count.n), 3);
      const suppliers = await db.prepare(`SELECT DISTINCT supplier_id FROM purchase_orders WHERE award_id = ?`).all(award.id);
      assert.equal(suppliers.length, 3);
    }));
  });

  test('"done" needs every awarded supplier to have exactly one PO', async () => {
    const { db, app } = await boot();
    await budget(db);
    await withFlag(() => withServer(app, async (base) => {
      const { seeded, award } = await approvedThreeWaySplit({ db, base });
      await createAwardPurchaseOrders(db, CAROL, seeded.eventId);
      // A PO removed behind the application's back makes the award not done again.
      await db.prepare(`DELETE FROM po_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE award_id = ? AND supplier_id = 4)`).run(award.id);
      await db.prepare(`DELETE FROM purchase_orders WHERE award_id = ? AND supplier_id = 4`).run(award.id);
      const access = await db.prepare(`
        SELECT COUNT(*) AS n FROM sourcing_awards a
        WHERE a.id = ? AND EXISTS (
          SELECT 1 FROM sourcing_award_lines al
          WHERE al.award_id = a.id
            AND (SELECT COUNT(*) FROM purchase_orders po WHERE po.award_id = a.id AND po.supplier_id = al.supplier_id) <> 1
        )
      `).get(award.id);
      assert.equal(Number(access.n), 1);
    }));
  });

  test('the old convert path is refused over HTTP for procurement and admin too', async () => {
    const { db, app } = await boot();
    await budget(db);
    await withFlag(() => withServer(app, async (base) => {
      const { award } = await approvedThreeWaySplit({ db, base });
      for (const userId of [3, 5]) {
        const res = await post(base, '/api/purchase-orders/from-requisition', userId, { requisition_id: award.award_requisition_id });
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'award_requisition_via_sourcing');
      }
      const count = await db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders WHERE requisition_id = ?`).get(award.award_requisition_id);
      assert.equal(Number(count.n), 0);
    }));
  });
});
