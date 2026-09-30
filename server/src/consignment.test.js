import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { applySchema, createMemoryDatabase } from './db.js';
import {
  ConsignmentError,
  getConsignmentOverview,
  issueConsignment,
  receiveConsignment
} from './consignmentService.js';
import { createGoodsReceipt, GoodsReceiptError } from './goodsReceiptsService.js';
import { createVendorInvoice } from './invoicesService.js';

async function createTestDb() {
  const db = await createMemoryDatabase();
  db.exec(`
    INSERT INTO departments (id, code, name) VALUES (1, 'FAC', 'Facilities');
    INSERT INTO users (id, name, email, role, department_id)
      VALUES (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1);
    INSERT INTO suppliers (id, name, code, payment_terms, status)
      VALUES (4, 'FacilityCare', 'SUP-FCJ', 'Net 30', 'active'),
             (3, 'WorkSpace', 'SUP-WED', 'Net 45', 'active');
    INSERT INTO catalog_items (id, sku, name, category, unit, unit_price, preferred_supplier_id, line_type, status)
      VALUES (16, 'SKU-FAC-003', 'Sanitizer Stand', 'Facilities & MRO', 'set', 14500, 4, 'goods', 'active'),
             (12, 'SKU-OFF-004', 'Copy Paper', 'Office Supplies', 'case', 5800, 3, 'goods', 'active'),
             (17, 'SKU-SRV-001', 'UX Audit', 'Consulting & Professional Services', 'sprint', 850000, 4, 'service', 'active');
    INSERT INTO purchase_orders (id, po_number, supplier_id, created_by, status, total_amount, issue_date, order_source)
      VALUES (1, 'PO-2026-001', 3, 3, 'issued', 11600, '2026-09-01', 'standard');
    INSERT INTO po_items (
      id, po_id, item_description, category, quantity, unit_price, total_price,
      quantity_received, quantity_consumed, quantity_invoiced, line_type, receipt_basis
    ) VALUES (
      1, 1, 'Copy Paper', 'Office Supplies', 2, 5800, 11600,
      0, 0, 0, 'goods', 'grn'
    );
  `);
  return db;
}

function receiptPayload(overrides = {}) {
  return {
    supplier_id: 4,
    catalog_item_id: 16,
    location_label: 'HQ facilities cage',
    quantity: 12,
    unit_price: 14500,
    received_by: 3,
    receipt_date: '2026-09-10',
    actor_name: 'Carol Zhang',
    ...overrides
  };
}

describe('consignment stock', () => {
  test('receiving consignment increases on-hand and does not book a GRN or PO', async () => {
    const db = await createTestDb();
    const result = await receiveConsignment(db, receiptPayload());

    assert.equal(result.receiptNumber, 'CSN-2026-001');
    assert.equal(result.quantityOnHand, 12);

    const balance = db.prepare(`SELECT quantity_on_hand, unit_price FROM consignment_balances WHERE id = ?`).get(result.balanceId);
    assert.equal(balance.quantity_on_hand, 12);
    assert.equal(balance.unit_price, 14500);

    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM goods_receipts`).get().cnt, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM purchase_orders WHERE order_source = 'consignment'`).get().cnt, 0);
    assert.equal(db.prepare(`SELECT quantity_received FROM po_items WHERE id = 1`).get().quantity_received, 0);

    const again = await receiveConsignment(db, receiptPayload({ quantity: 3, receipt_date: '2026-09-11' }));
    assert.equal(again.receiptNumber, 'CSN-2026-002');
    assert.equal(again.balanceId, result.balanceId);
    assert.equal(again.quantityOnHand, 15);
  });

  test('rejects service catalog items and does not open a balance', async () => {
    const db = await createTestDb();
    await assert.rejects(
      () => receiveConsignment(db, receiptPayload({ catalog_item_id: 17 })),
      (err) => err instanceof ConsignmentError && err.statusCode === 400 && /service/i.test(err.message)
    );
    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM consignment_balances`).get().cnt, 0);
  });

  test('issuing consignment creates a draw-down PO and leaves owned GRN qty at zero', async () => {
    const db = await createTestDb();
    const received = await receiveConsignment(db, receiptPayload());
    const issued = await issueConsignment(db, {
      balance_id: received.balanceId,
      quantity: 4,
      issued_by: 3,
      issue_date: '2026-09-18',
      actor_name: 'Carol Zhang',
      notes: 'Lobby stands put into use'
    });

    assert.equal(issued.issueNumber, 'CSI-2026-001');
    assert.equal(issued.poNumber, 'PO-2026-002');
    assert.equal(issued.poStatus, 'received');
    assert.equal(issued.quantityOnHand, 8);
    assert.equal(issued.amountCents, 58000);

    const po = db.prepare(`SELECT order_source, total_amount, requisition_id, status FROM purchase_orders WHERE id = ?`).get(issued.poId);
    assert.equal(po.order_source, 'consignment');
    assert.equal(po.total_amount, 58000);
    assert.equal(po.requisition_id, null);
    assert.equal(po.status, 'received');

    const line = db.prepare(`
      SELECT quantity, quantity_received, quantity_consumed, quantity_invoiced, receipt_basis, line_type
      FROM po_items WHERE id = ?
    `).get(issued.poItemId);
    assert.equal(line.quantity, 4);
    assert.equal(line.quantity_received, 0);
    assert.equal(line.quantity_consumed, 4);
    assert.equal(line.quantity_invoiced, 0);
    assert.equal(line.receipt_basis, 'consignment');
    assert.equal(line.line_type, 'goods');

    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM goods_receipts`).get().cnt, 0);
    assert.equal(db.prepare(`SELECT quantity_received FROM po_items WHERE id = 1`).get().quantity_received, 0);
  });

  test('rejects an issue larger than on-hand and leaves the balance unchanged', async () => {
    const db = await createTestDb();
    const received = await receiveConsignment(db, receiptPayload({ quantity: 2 }));
    await assert.rejects(
      () => issueConsignment(db, { balance_id: received.balanceId, quantity: 3, issued_by: 3 }),
      (err) => err instanceof ConsignmentError && err.statusCode === 400 && /on hand/i.test(err.message)
    );
    assert.equal(
      db.prepare(`SELECT quantity_on_hand FROM consignment_balances WHERE id = ?`).get(received.balanceId).quantity_on_hand,
      2
    );
    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM consignment_issues`).get().cnt, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM purchase_orders WHERE order_source = 'consignment'`).get().cnt, 0);
  });

  test('invoice match uses drawn qty and still requires a GRN for owned goods', async () => {
    const db = await createTestDb();
    const received = await receiveConsignment(db, receiptPayload());
    const issued = await issueConsignment(db, {
      balance_id: received.balanceId,
      quantity: 4,
      issued_by: 3,
      issue_date: '2026-09-18'
    });

    const consignmentInvoice = await createVendorInvoice(db, {
      invoice_number: 'INV-FCJ-4402',
      po_id: issued.poId,
      supplier_id: 4,
      invoice_date: '2026-09-20',
      due_date: '2026-10-20',
      tax_amount: 0,
      items: [{
        po_item_id: issued.poItemId,
        description: 'Sanitizer Stand',
        quantity_invoiced: 4,
        unit_price: 14500
      }]
    });
    assert.equal(consignmentInvoice.matchOutcome.overallMatchStatus, 'perfect_match');
    assert.equal(consignmentInvoice.matchOutcome.invoiceStatus, 'matched');
    const consignmentLine = db.prepare(`
      SELECT quantity_received, quantity_consumed, quantity_invoiced FROM po_items WHERE id = ?
    `).get(issued.poItemId);
    assert.equal(consignmentLine.quantity_received, 0);
    assert.equal(consignmentLine.quantity_consumed, 4);
    assert.equal(consignmentLine.quantity_invoiced, 4);
    const message = db.prepare(`SELECT message FROM match_results WHERE po_item_id = ?`).get(issued.poItemId).message;
    assert.match(message, /consignment/i);
    assert.match(message, /no GRN/i);

    const ownedInvoice = await createVendorInvoice(db, {
      invoice_number: 'INV-WED-1',
      po_id: 1,
      supplier_id: 3,
      invoice_date: '2026-09-20',
      due_date: '2026-10-20',
      tax_amount: 0,
      items: [{
        po_item_id: 1,
        description: 'Copy Paper',
        quantity_invoiced: 2,
        unit_price: 5800
      }]
    });
    assert.equal(ownedInvoice.matchOutcome.overallMatchStatus, 'quantity_variance');
    const ownedLine = db.prepare(`SELECT quantity_received, quantity_consumed FROM po_items WHERE id = 1`).get();
    assert.equal(ownedLine.quantity_received, 0);
    assert.equal(ownedLine.quantity_consumed, 0);
  });

  test('a GRN cannot be posted against a consignment PO and a normal GRN ignores consignment', async () => {
    const db = await createTestDb();
    const received = await receiveConsignment(db, receiptPayload({ quantity: 5 }));
    const issued = await issueConsignment(db, {
      balance_id: received.balanceId,
      quantity: 2,
      issued_by: 3,
      issue_date: '2026-09-18'
    });

    await assert.rejects(
      () => createGoodsReceipt(db, {
        po_id: issued.poId,
        received_by: 3,
        receipt_date: '2026-09-19',
        items: [{ po_item_id: issued.poItemId, quantity_received: 2 }]
      }),
      (err) => err instanceof GoodsReceiptError && err.statusCode === 400 && /consignment/i.test(err.message)
    );
    assert.equal(db.prepare(`SELECT quantity_received FROM po_items WHERE id = ?`).get(issued.poItemId).quantity_received, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM goods_receipts`).get().cnt, 0);
    assert.equal(
      db.prepare(`SELECT quantity_on_hand FROM consignment_balances WHERE id = ?`).get(received.balanceId).quantity_on_hand,
      3
    );

    const grn = await createGoodsReceipt(db, {
      po_id: 1,
      received_by: 3,
      receipt_date: '2026-09-19',
      items: [{ po_item_id: 1, quantity_received: 2, condition: 'good' }]
    });
    assert.equal(grn.grnNumber, 'GRN-2026-001');
    assert.equal(db.prepare(`SELECT quantity_received FROM po_items WHERE id = 1`).get().quantity_received, 2);
    assert.equal(
      db.prepare(`SELECT quantity_on_hand FROM consignment_balances WHERE id = ?`).get(received.balanceId).quantity_on_hand,
      3
    );

    const overview = await getConsignmentOverview(db);
    const balance = overview.balances.find((row) => row.id === received.balanceId);
    assert.equal(balance.quantity_on_hand, 3);
    assert.equal(balance.sku, 'SKU-FAC-003');
    const ownedPaper = overview.owned_stock.find((row) => row.item_name === 'Copy Paper');
    assert.equal(ownedPaper.quantity_received, 2);
    assert.equal(overview.owned_stock.some((row) => row.sku === 'SKU-FAC-003'), false);
  });

  test('applySchema adds consignment tables and PO columns on an older database', async () => {
    const db = await createMemoryDatabase();
    db.exec(`
      DROP TABLE consignment_issues;
      DROP TABLE consignment_receipts;
      DROP TABLE consignment_balances;
      ALTER TABLE po_items DROP COLUMN quantity_consumed;
      ALTER TABLE po_items DROP COLUMN receipt_basis;
      ALTER TABLE purchase_orders DROP COLUMN order_source;
    `);
    await applySchema(db);

    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'consignment_%'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(tables, ['consignment_balances', 'consignment_issues', 'consignment_receipts']);

    const poCols = db.prepare(`PRAGMA table_info(purchase_orders)`).all().map((col) => col.name);
    const itemCols = db.prepare(`PRAGMA table_info(po_items)`).all().map((col) => col.name);
    assert.ok(poCols.includes('order_source'));
    assert.ok(itemCols.includes('receipt_basis'));
    assert.ok(itemCols.includes('quantity_consumed'));

    const received = await receiveConsignment(db, {
      supplier_id: 1,
      catalog_item_id: 1,
      quantity: 1,
      received_by: 1,
      receipt_date: '2026-09-01'
    }).catch((err) => err);
    assert.ok(received instanceof ConsignmentError);
  });
});
