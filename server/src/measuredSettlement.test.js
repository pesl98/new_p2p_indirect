import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { applySchema, createMemoryDatabase } from './db.js';
import { measuredAmountCents, parseMeasuredMilli } from './measuredQty.js';
import { openUtilityArrangement, recordUtilityConsumption } from './utilityService.js';
import { drawBulkContainer, fillBulkContainer, registerBulkContainer } from './bulkVesselService.js';
import { issueConsignment, receiveConsignment } from './consignmentService.js';
import { createGoodsReceipt, GoodsReceiptError } from './goodsReceiptsService.js';
import { createServiceEntrySheet, ServiceEntrySheetError } from './serviceEntrySheetsService.js';
import { applyPurchaseOrderChangeOrder, ChangeOrderError } from './changeOrdersService.js';
import { createVendorInvoice } from './invoicesService.js';

async function createTestDb() {
  const db = await createMemoryDatabase();
  db.exec(`
    INSERT INTO departments (id, code, name) VALUES (1, 'FAC', 'Facilities');
    INSERT INTO users (id, name, email, role, department_id)
      VALUES (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1);
    INSERT INTO suppliers (id, name, code, payment_terms, status)
      VALUES (7, 'MetroGrid Utilities', 'SUP-MGU', 'Net 30', 'active'),
             (8, 'Northwind Industrial Gases', 'SUP-NIG', 'Net 30', 'active'),
             (4, 'FacilityCare', 'SUP-FCJ', 'Net 30', 'active');
    INSERT INTO catalog_items (id, sku, name, category, unit, unit_price, preferred_supplier_id, line_type, status)
      VALUES (30, 'SKU-GAS-001', 'Industrial liquid nitrogen', 'Facilities & MRO', 'kg', 125, 8, 'goods', 'active'),
             (31, 'SKU-GAS-002', 'Welding-grade argon', 'Facilities & MRO', 'm3', 480, 8, 'goods', 'active'),
             (16, 'SKU-FAC-003', 'Sanitizer Stand', 'Facilities & MRO', 'set', 14500, 4, 'goods', 'active'),
             (17, 'SKU-SRV-001', 'UX Audit', 'Consulting & Professional Services', 'sprint', 850000, 4, 'service', 'active');
    INSERT INTO purchase_orders (id, po_number, supplier_id, created_by, status, total_amount, issue_date, order_source)
      VALUES (1, 'PO-2026-001', 4, 3, 'issued', 14500, '2026-09-01', 'standard');
    INSERT INTO po_items (
      id, po_id, item_description, category, quantity, unit_price, total_price,
      quantity_received, line_type, receipt_basis
    ) VALUES (
      1, 1, 'Sanitizer Stand', 'Facilities & MRO', 1, 14500, 14500,
      0, 'goods', 'grn'
    );
  `);
  return db;
}

function arrangementPayload(overrides = {}) {
  return {
    supplier_id: 7,
    utility_type: 'electricity',
    name: 'HQ campus electricity',
    meter_label: 'E-104',
    unit_of_measure: 'kWh',
    unit_price: 18,
    opened_by: 3,
    actor_name: 'Carol Zhang',
    ...overrides
  };
}

describe('measured quantity parsing', () => {
  test('stores up to 3 decimal places as milli-units and prices in cents', () => {
    assert.equal(parseMeasuredMilli('842.500', 'quantity'), 842500);
    assert.equal(parseMeasuredMilli(450.25, 'quantity'), 450250);
    assert.equal(parseMeasuredMilli('0.001', 'quantity'), 1);
    assert.equal(measuredAmountCents(842500, 18), 15165);
    assert.equal(measuredAmountCents(450250, 125), 56281);
    assert.throws(() => parseMeasuredMilli('1.2345', 'quantity'), /3 decimal/);
    assert.throws(() => parseMeasuredMilli(0, 'quantity'), /greater than 0/);
  });
});

describe('metered utilities', () => {
  test('a reading opens a payable for the measured usage and does not post a GRN', async () => {
    const db = await createTestDb();
    const opened = await openUtilityArrangement(db, arrangementPayload());
    assert.equal(opened.arrangementNumber, 'UTA-2026-001');

    const recorded = await recordUtilityConsumption(db, {
      arrangement_id: opened.arrangementId,
      period_start: '2026-09-01',
      period_end: '2026-09-30',
      reading_previous: '10240.000',
      reading_current: '11082.500',
      recorded_by: 3,
      actor_name: 'Carol Zhang'
    });

    assert.equal(recorded.consumptionNumber, 'UCN-2026-001');
    assert.equal(recorded.quantityMilli, 842500);
    assert.equal(recorded.amountCents, 15165);
    assert.equal(recorded.poStatus, 'received');

    const po = db.prepare(`SELECT order_source, settlement_kind, total_amount, requisition_id FROM purchase_orders WHERE id = ?`).get(recorded.poId);
    assert.equal(po.order_source, 'standard');
    assert.equal(po.settlement_kind, 'utility');
    assert.equal(po.total_amount, 15165);
    assert.equal(po.requisition_id, null);

    const line = db.prepare(`
      SELECT quantity, quantity_received, quantity_consumed, quantity_scale, unit_of_measure, settlement_kind, receipt_basis, line_type
      FROM po_items WHERE id = ?
    `).get(recorded.poItemId);
    assert.equal(line.quantity, 842500);
    assert.equal(line.quantity_consumed, 842500);
    assert.equal(line.quantity_received, 0);
    assert.equal(line.quantity_scale, 1000);
    assert.equal(line.unit_of_measure, 'kWh');
    assert.equal(line.settlement_kind, 'utility');
    assert.equal(line.receipt_basis, 'grn');
    assert.equal(line.line_type, 'goods');
    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM goods_receipts`).get().cnt, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM consignment_balances`).get().cnt, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM purchase_orders WHERE order_source = 'consignment'`).get().cnt, 0);
  });

  test('invoice match uses the measured consumption and rejects a GRN, SES, and change order', async () => {
    const db = await createTestDb();
    const opened = await openUtilityArrangement(db, arrangementPayload());
    const recorded = await recordUtilityConsumption(db, {
      arrangement_id: opened.arrangementId,
      period_start: '2026-09-01',
      period_end: '2026-09-30',
      quantity: 842.5,
      recorded_by: 3
    });

    const matched = await createVendorInvoice(db, {
      invoice_number: 'INV-MGU-0901',
      po_id: recorded.poId,
      supplier_id: 7,
      invoice_date: '2026-10-01',
      due_date: '2026-10-31',
      tax_amount: 0,
      items: [{
        po_item_id: recorded.poItemId,
        description: 'HQ electricity',
        quantity_invoiced: '842.500',
        unit_price: 18
      }]
    });
    assert.equal(matched.matchOutcome.overallMatchStatus, 'perfect_match');
    const message = db.prepare(`SELECT message FROM match_results WHERE invoice_id = ?`).get(matched.invoiceId).message;
    assert.match(message, /842\.500 kWh/);
    assert.match(message, /No GRN was posted/);
    const storedQty = db.prepare(`SELECT quantity_invoiced FROM invoice_items WHERE invoice_id = ?`).get(matched.invoiceId).quantity_invoiced;
    assert.equal(storedQty, 842500);

    const dbOver = await createTestDb();
    const openedOver = await openUtilityArrangement(dbOver, arrangementPayload());
    const recordedOver = await recordUtilityConsumption(dbOver, {
      arrangement_id: openedOver.arrangementId,
      period_start: '2026-09-01',
      period_end: '2026-09-30',
      quantity: 842.5,
      recorded_by: 3
    });
    const over = await createVendorInvoice(dbOver, {
      invoice_number: 'INV-MGU-0902',
      po_id: recordedOver.poId,
      supplier_id: 7,
      invoice_date: '2026-10-01',
      due_date: '2026-10-31',
      tax_amount: 0,
      items: [{
        po_item_id: recordedOver.poItemId,
        description: 'HQ electricity',
        quantity_invoiced: 900,
        unit_price: 18
      }]
    });
    assert.equal(over.matchOutcome.overallMatchStatus, 'quantity_variance');

    await assert.rejects(
      () => createGoodsReceipt(db, {
        po_id: recorded.poId,
        received_by: 3,
        receipt_date: '2026-09-30',
        items: [{ po_item_id: recorded.poItemId, quantity_received: 1 }]
      }),
      (err) => err instanceof GoodsReceiptError && /utility/i.test(err.message)
    );
    await assert.rejects(
      () => createServiceEntrySheet(db, {
        po_id: recorded.poId,
        created_by: 3,
        items: [{ po_item_id: recorded.poItemId, quantity_accepted: 1 }]
      }),
      (err) => err instanceof ServiceEntrySheetError && /Metered Utilities/i.test(err.message)
    );
    await assert.rejects(
      () => applyPurchaseOrderChangeOrder(db, recorded.poId, {
        reason: 'Adjust the billed kWh',
        actor_name: 'Carol Zhang',
        lines: [{ po_item_id: recorded.poItemId, quantity: 100 }]
      }),
      (err) => err instanceof ChangeOrderError && /measured consumption/i.test(err.message)
    );

    const goods = await createGoodsReceipt(db, {
      po_id: 1,
      received_by: 3,
      receipt_date: '2026-09-02',
      items: [{ po_item_id: 1, quantity_received: 1 }]
    });
    assert.ok(goods.grnNumber || goods.grn_number || goods.receiptId || goods.id);
    assert.equal(db.prepare(`SELECT quantity_received FROM po_items WHERE id = 1`).get().quantity_received, 1);
  });

  test('reading difference must be positive and must agree with a billed quantity', async () => {
    const db = await createTestDb();
    const opened = await openUtilityArrangement(db, arrangementPayload({ utility_type: 'water', unit_of_measure: 'm3', name: 'HQ water', meter_label: 'W-12', unit_price: 210 }));
    await assert.rejects(
      () => recordUtilityConsumption(db, {
        arrangement_id: opened.arrangementId,
        period_start: '2026-09-01',
        period_end: '2026-09-30',
        reading_previous: 10,
        reading_current: 10,
        recorded_by: 3
      }),
      /greater than the previous reading/
    );
    await assert.rejects(
      () => recordUtilityConsumption(db, {
        arrangement_id: opened.arrangementId,
        period_start: '2026-09-01',
        period_end: '2026-09-30',
        reading_previous: 10,
        reading_current: 12.5,
        quantity: 2,
        recorded_by: 3
      }),
      /does not match/
    );
  });
});

describe('vendor-managed bulk', () => {
  test('a silo stores measured level and a draw opens a payable without a GRN', async () => {
    const db = await createTestDb();
    const registered = await registerBulkContainer(db, {
      supplier_id: 8,
      catalog_item_id: 30,
      name: 'LN2 silo S-1',
      vessel_type: 'silo',
      unit_of_measure: 'kg',
      capacity: '5000.000',
      unit_price: 125,
      registered_by: 3,
      actor_name: 'Carol Zhang'
    });
    assert.equal(registered.containerNumber, 'BVL-2026-001');
    assert.equal(registered.levelMilli, 0);

    await assert.rejects(
      () => fillBulkContainer(db, {
        container_id: registered.containerId,
        quantity: 5000.001,
        filled_by: 3,
        fill_date: '2026-09-08'
      }),
      /free capacity/
    );

    const filled = await fillBulkContainer(db, {
      container_id: registered.containerId,
      quantity: 3200,
      filled_by: 3,
      fill_date: '2026-09-08'
    });
    assert.equal(filled.fillNumber, 'BFL-2026-001');
    assert.equal(filled.levelMilli, 3200000);
    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM goods_receipts`).get().cnt, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM purchase_orders WHERE settlement_kind = 'bulk'`).get().cnt, 0);

    await assert.rejects(
      () => drawBulkContainer(db, {
        container_id: registered.containerId,
        quantity: 3200.001,
        drawn_by: 3,
        draw_date: '2026-09-18'
      }),
      /Not enough measured product/
    );

    const drawn = await drawBulkContainer(db, {
      container_id: registered.containerId,
      quantity: '450.250',
      drawn_by: 3,
      draw_date: '2026-09-18',
      actor_name: 'Carol Zhang'
    });
    assert.equal(drawn.drawNumber, 'BDR-2026-001');
    assert.equal(drawn.quantityMilli, 450250);
    assert.equal(drawn.levelMilli, 2749750);
    assert.equal(drawn.amountCents, 56281);
    assert.equal(drawn.poStatus, 'received');

    const po = db.prepare(`SELECT order_source, settlement_kind FROM purchase_orders WHERE id = ?`).get(drawn.poId);
    assert.equal(po.order_source, 'standard');
    assert.equal(po.settlement_kind, 'bulk');
    const line = db.prepare(`
      SELECT quantity_received, quantity_consumed, quantity_scale, unit_of_measure, settlement_kind
      FROM po_items WHERE id = ?
    `).get(drawn.poItemId);
    assert.equal(line.quantity_received, 0);
    assert.equal(line.quantity_consumed, 450250);
    assert.equal(line.quantity_scale, 1000);
    assert.equal(line.unit_of_measure, 'kg');
    assert.equal(line.settlement_kind, 'bulk');
    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM goods_receipts`).get().cnt, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM consignment_issues`).get().cnt, 0);

    const cols = db.prepare(`PRAGMA table_info(bulk_containers)`).all().map((col) => col.name);
    assert.equal(cols.includes('location_label'), false);
    assert.ok(cols.includes('capacity_milli'));
    assert.ok(cols.includes('level_milli'));

    const matched = await createVendorInvoice(db, {
      invoice_number: 'INV-NIG-1801',
      po_id: drawn.poId,
      supplier_id: 8,
      invoice_date: '2026-09-20',
      due_date: '2026-10-20',
      tax_amount: 0,
      items: [{
        po_item_id: drawn.poItemId,
        description: 'Liquid nitrogen draw',
        quantity_invoiced: 450.25,
        unit_price: 125
      }]
    });
    assert.equal(matched.matchOutcome.overallMatchStatus, 'perfect_match');
    const message = db.prepare(`SELECT message FROM match_results WHERE invoice_id = ?`).get(matched.invoiceId).message;
    assert.match(message, /450\.250 kg/);
    assert.match(message, /bulk draw-down/);

    await assert.rejects(
      () => createGoodsReceipt(db, {
        po_id: drawn.poId,
        received_by: 3,
        receipt_date: '2026-09-18',
        items: [{ po_item_id: drawn.poItemId, quantity_received: 1 }]
      }),
      (err) => err instanceof GoodsReceiptError && /bulk/i.test(err.message)
    );
  });

  test('discrete consignment still rejects fractional units and stays on its own tables', async () => {
    const db = await createTestDb();
    await assert.rejects(
      () => receiveConsignment(db, {
        supplier_id: 4,
        catalog_item_id: 16,
        location_label: 'HQ facilities cage',
        quantity: 1.5,
        received_by: 3
      }),
      /whole number/
    );

    await receiveConsignment(db, {
      supplier_id: 4,
      catalog_item_id: 16,
      location_label: 'HQ facilities cage',
      quantity: 12,
      received_by: 3,
      receipt_date: '2026-09-10'
    });
    const issued = await issueConsignment(db, {
      balance_id: 1,
      quantity: 4,
      issued_by: 3,
      issue_date: '2026-09-18'
    });
    const po = db.prepare(`SELECT order_source, settlement_kind FROM purchase_orders WHERE id = ?`).get(issued.poId);
    assert.equal(po.order_source, 'consignment');
    assert.equal(po.settlement_kind, 'purchase');
    const line = db.prepare(`SELECT quantity, quantity_scale, receipt_basis, quantity_received FROM po_items WHERE id = ?`).get(issued.poItemId);
    assert.equal(line.quantity, 4);
    assert.equal(line.quantity_scale, 1);
    assert.equal(line.receipt_basis, 'consignment');
    assert.equal(line.quantity_received, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS cnt FROM bulk_containers`).get().cnt, 0);
  });

  test('applySchema adds measured columns on an older purchase-order table', async () => {
    const db = await createMemoryDatabase();
    db.exec(`
      ALTER TABLE po_items DROP COLUMN settlement_kind;
      ALTER TABLE po_items DROP COLUMN quantity_scale;
      ALTER TABLE po_items DROP COLUMN unit_of_measure;
      ALTER TABLE purchase_orders DROP COLUMN settlement_kind;
    `);
    await applySchema(db);
    const poCols = db.prepare(`PRAGMA table_info(purchase_orders)`).all().map((col) => col.name);
    const itemCols = db.prepare(`PRAGMA table_info(po_items)`).all().map((col) => col.name);
    assert.ok(poCols.includes('settlement_kind'));
    assert.ok(itemCols.includes('settlement_kind'));
    assert.ok(itemCols.includes('quantity_scale'));
    assert.ok(itemCols.includes('unit_of_measure'));
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bulk_containers'`).get());
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'utility_arrangements'`).get());
  });
});
