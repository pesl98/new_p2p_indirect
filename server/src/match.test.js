import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createVendorInvoice } from './invoicesService.js';
import { priceToleranceCents } from './match.js';

const schemaSql = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'),
  'utf8'
);

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schemaSql);
  db.exec(`
    INSERT INTO departments (id, code, name) VALUES (1, 'MKT', 'Marketing');
    INSERT INTO users (id, name, email, role, department_id, approval_limit)
      VALUES (1, 'Tester', 'tester@example.com', 'procurement', 1, 0);
    INSERT INTO suppliers (id, name, code) VALUES (1, 'Vendor Co', 'SUP-1');
  `);
  return db;
}

function insertPoLine(db, {
  ordered,
  received,
  unitPriceCents,
  invoiced = 0,
  accepted = 0,
  lineType = 'goods',
  category = 'IT Hardware',
  description = 'Test Monitor',
  poId = 1,
  itemId = 1,
  poNumber = 'PO-TEST-001'
}) {
  const existingPo = db.prepare(`SELECT id FROM purchase_orders WHERE id = ?`).get(poId);
  if (!existingPo) {
    db.prepare(`
      INSERT INTO purchase_orders (id, po_number, supplier_id, created_by, status, total_amount, issue_date)
      VALUES (?, ?, 1, 1, 'partially_received', ?, '2026-09-01')
    `).run(poId, poNumber, ordered * unitPriceCents);
  }

  db.prepare(`
    INSERT INTO po_items (id, po_id, item_description, category, quantity, unit_price, total_price, quantity_received, quantity_accepted, quantity_invoiced, line_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    itemId,
    poId,
    description,
    category,
    ordered,
    unitPriceCents,
    ordered * unitPriceCents,
    received,
    accepted,
    invoiced,
    lineType
  );
}

function invoicePayload({
  qty,
  unitPriceCents,
  invoiceNumber = 'INV-TEST-1',
  poId = 1,
  itemId = 1,
  description = 'Test Monitor'
}) {
  return {
    invoice_number: invoiceNumber,
    po_id: poId,
    supplier_id: 1,
    invoice_date: '2026-09-04',
    due_date: '2026-10-04',
    tax_amount: 0,
    items: [
      {
        po_item_id: itemId,
        description,
        quantity_invoiced: qty,
        unit_price: unitPriceCents
      }
    ]
  };
}

describe('3-way match engine', () => {
  test('perfect match when qty and unit price match PO and GRN exactly', () => {
    const db = createTestDb();
    insertPoLine(db, { ordered: 2, received: 2, unitPriceCents: 129500 });

    const result = createVendorInvoice(db, invoicePayload({ qty: 2, unitPriceCents: 129500 }));
    assert.equal(result.matchOutcome.overallMatchStatus, 'perfect_match');
    assert.equal(result.matchOutcome.invoiceStatus, 'matched');

    const invoice = db.prepare(`SELECT match_status, status FROM invoices WHERE id = ?`).get(result.invoiceId);
    assert.equal(invoice.match_status, 'perfect_match');
    assert.equal(invoice.status, 'matched');

    const poItem = db.prepare(`SELECT quantity_invoiced FROM po_items WHERE id = 1`).get();
    assert.equal(poItem.quantity_invoiced, 2);
  });

  test('price within 1% tolerance sets tolerated_match', () => {
    const db = createTestDb();
    const poPrice = 74900;
    const tolerance = priceToleranceCents(poPrice);
    assert.ok(tolerance > 0);

    insertPoLine(db, { ordered: 2, received: 2, unitPriceCents: poPrice });
    const result = createVendorInvoice(db, invoicePayload({ qty: 2, unitPriceCents: poPrice + tolerance }));

    assert.equal(result.matchOutcome.overallMatchStatus, 'tolerated_match');
    assert.equal(result.matchOutcome.invoiceStatus, 'matched');

    const line = db.prepare(`SELECT status, price_variance FROM match_results WHERE invoice_id = ?`).get(result.invoiceId);
    assert.equal(line.status, 'warning');
    assert.equal(line.price_variance, tolerance);
  });

  test('price over 1% tolerance sets price_variance', () => {
    const db = createTestDb();
    const poPrice = 74900;
    insertPoLine(db, { ordered: 2, received: 2, unitPriceCents: poPrice });

    const result = createVendorInvoice(db, invoicePayload({ qty: 2, unitPriceCents: poPrice + 5000 }));
    assert.equal(result.matchOutcome.overallMatchStatus, 'price_variance');
    assert.equal(result.matchOutcome.invoiceStatus, 'variance_flagged');

    const line = db.prepare(`SELECT status, price_variance FROM match_results WHERE invoice_id = ?`).get(result.invoiceId);
    assert.equal(line.status, 'fail');
    assert.equal(line.price_variance, 5000);

    const poItem = db.prepare(`SELECT quantity_invoiced FROM po_items WHERE id = 1`).get();
    assert.equal(poItem.quantity_invoiced, 2, 'claimed qty is recorded even when price match fails');
  });

  test('qty invoiced greater than received sets quantity_variance', () => {
    const db = createTestDb();
    insertPoLine(db, { ordered: 4, received: 2, unitPriceCents: 74900 });

    const result = createVendorInvoice(db, invoicePayload({ qty: 3, unitPriceCents: 74900 }));
    assert.equal(result.matchOutcome.overallMatchStatus, 'quantity_variance');
    assert.equal(result.matchOutcome.invoiceStatus, 'variance_flagged');

    const line = db.prepare(`SELECT qty_variance, status FROM match_results WHERE invoice_id = ?`).get(result.invoiceId);
    assert.equal(line.qty_variance, 1);
    assert.equal(line.status, 'fail');
  });

  test('second invoice that overbills vs received fails', () => {
    const db = createTestDb();
    insertPoLine(db, { ordered: 4, received: 2, unitPriceCents: 74900 });

    const first = createVendorInvoice(db, invoicePayload({ qty: 2, unitPriceCents: 74900, invoiceNumber: 'INV-1' }));
    assert.equal(first.matchOutcome.overallMatchStatus, 'perfect_match');

    const second = createVendorInvoice(db, invoicePayload({ qty: 1, unitPriceCents: 74900, invoiceNumber: 'INV-2' }));
    assert.equal(second.matchOutcome.overallMatchStatus, 'quantity_variance');
    assert.equal(second.matchOutcome.invoiceStatus, 'variance_flagged');

    const poItem = db.prepare(`SELECT quantity_invoiced FROM po_items WHERE id = 1`).get();
    assert.equal(poItem.quantity_invoiced, 3, 'both claims recorded for audit');

    const invoices = db.prepare(`SELECT invoice_number, match_status FROM invoices ORDER BY id`).all();
    assert.equal(invoices[0].match_status, 'perfect_match');
    assert.equal(invoices[1].match_status, 'quantity_variance');
  });

  test('qty and price failures together set total_variance', () => {
    const db = createTestDb();
    insertPoLine(db, { ordered: 4, received: 2, unitPriceCents: 74900 });

    const result = createVendorInvoice(db, invoicePayload({ qty: 4, unitPriceCents: 79900 }));
    assert.equal(result.matchOutcome.overallMatchStatus, 'total_variance');
  });
});

describe('invoice number uniqueness', () => {
  test('rejects a duplicate invoice number for the same supplier', () => {
    const db = createTestDb();
    insertPoLine(db, { ordered: 2, received: 2, unitPriceCents: 129500 });
    createVendorInvoice(db, invoicePayload({ qty: 1, unitPriceCents: 129500, invoiceNumber: 'INV-DUP-1' }));

    assert.throws(
      () => createVendorInvoice(db, invoicePayload({ qty: 1, unitPriceCents: 129500, invoiceNumber: 'INV-DUP-1' })),
      (err) => err.statusCode === 400 && /already exists for this supplier/i.test(err.message)
    );
  });

  test('allows the same invoice number from a different supplier', () => {
    const db = createTestDb();
    db.exec(`INSERT INTO suppliers (id, name, code) VALUES (2, 'Other Vendor', 'SUP-2')`);
    insertPoLine(db, { ordered: 2, received: 2, unitPriceCents: 129500 });
    db.prepare(`
      INSERT INTO purchase_orders (id, po_number, supplier_id, created_by, status, total_amount, issue_date)
      VALUES (2, 'PO-TEST-002', 2, 1, 'issued', 129500, '2026-09-01')
    `).run();
    db.prepare(`
      INSERT INTO po_items (id, po_id, item_description, category, quantity, unit_price, total_price, quantity_received, quantity_invoiced)
      VALUES (2, 2, 'Other Item', 'IT Hardware', 1, 129500, 129500, 1, 0)
    `).run();

    createVendorInvoice(db, invoicePayload({ qty: 1, unitPriceCents: 129500, invoiceNumber: 'INV-SHARED' }));
    const second = createVendorInvoice(db, {
      invoice_number: 'INV-SHARED',
      po_id: 2,
      supplier_id: 2,
      invoice_date: '2026-09-04',
      due_date: '2026-10-04',
      tax_amount: 0,
      items: [{ po_item_id: 2, description: 'Other Item', quantity_invoiced: 1, unit_price: 129500 }]
    });
    assert.ok(second.invoiceId);
  });
});

describe('service SES-backed 2-way match', () => {
  test('service invoice matches PO + accepted SES without any GRN', () => {
    const db = createTestDb();
    insertPoLine(db, {
      ordered: 1,
      received: 0,
      accepted: 1,
      unitPriceCents: 1250000,
      lineType: 'service',
      category: 'Consulting & Professional Services',
      description: 'SOC 2 Type II Annual Security Penetration Test'
    });

    const result = createVendorInvoice(db, invoicePayload({
      qty: 1,
      unitPriceCents: 1250000,
      description: 'SOC 2 Type II Annual Security Penetration Test'
    }));
    assert.equal(result.matchOutcome.overallMatchStatus, 'perfect_match');
    assert.equal(result.matchOutcome.invoiceStatus, 'matched');

    const line = db.prepare(`SELECT received_qty, status, message FROM match_results WHERE invoice_id = ?`).get(result.invoiceId);
    assert.equal(line.received_qty, 1);
    assert.equal(line.status, 'pass');
    assert.match(line.message, /SES-backed match/i);
  });

  test('service invoice without accepted SES fails quantity match', () => {
    const db = createTestDb();
    insertPoLine(db, {
      ordered: 1,
      received: 0,
      accepted: 0,
      unitPriceCents: 1250000,
      lineType: 'service',
      category: 'Consulting & Professional Services',
      description: 'SOC 2 Type II Annual Security Penetration Test'
    });

    const result = createVendorInvoice(db, invoicePayload({
      qty: 1,
      unitPriceCents: 1250000,
      description: 'SOC 2 Type II Annual Security Penetration Test'
    }));
    assert.equal(result.matchOutcome.overallMatchStatus, 'quantity_variance');
    assert.equal(result.matchOutcome.invoiceStatus, 'variance_flagged');

    const line = db.prepare(`SELECT message FROM match_results WHERE invoice_id = ?`).get(result.invoiceId);
    assert.match(line.message, /accepted on SES/i);
  });

  test('mixed PO: goods 3-way and service SES 2-way both pass', () => {
    const db = createTestDb();
    insertPoLine(db, {
      ordered: 2,
      received: 2,
      unitPriceCents: 74900,
      lineType: 'goods',
      category: 'IT Hardware',
      description: 'Dell Monitor'
    });
    insertPoLine(db, {
      ordered: 1,
      received: 0,
      accepted: 1,
      unitPriceCents: 54000,
      lineType: 'service',
      category: 'Software & Cloud',
      description: 'Figma Organization Annual User License',
      itemId: 2,
      poId: 1
    });

    const result = createVendorInvoice(db, {
      invoice_number: 'INV-MIXED-1',
      po_id: 1,
      supplier_id: 1,
      invoice_date: '2026-09-04',
      due_date: '2026-10-04',
      tax_amount: 0,
      items: [
        { po_item_id: 1, description: 'Dell Monitor', quantity_invoiced: 2, unit_price: 74900 },
        { po_item_id: 2, description: 'Figma Organization Annual User License', quantity_invoiced: 1, unit_price: 54000 }
      ]
    });
    assert.equal(result.matchOutcome.overallMatchStatus, 'perfect_match');

    const lines = db.prepare(`SELECT po_item_id, status, message FROM match_results WHERE invoice_id = ? ORDER BY po_item_id`).all(result.invoiceId);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].status, 'pass');
    assert.match(lines[0].message, /physical receipts/i);
    assert.equal(lines[1].status, 'pass');
    assert.match(lines[1].message, /SES-backed match/i);
  });

  test('mixed PO overall status is quantity_variance when only the service line fails', () => {
    const db = createTestDb();
    insertPoLine(db, {
      ordered: 2,
      received: 2,
      unitPriceCents: 74900,
      lineType: 'goods'
    });
    insertPoLine(db, {
      ordered: 1,
      received: 0,
      accepted: 0,
      unitPriceCents: 54000,
      lineType: 'service',
      category: 'Software & Cloud',
      description: 'Figma seat',
      itemId: 2,
      poId: 1
    });

    const result = createVendorInvoice(db, {
      invoice_number: 'INV-MIXED-FAIL',
      po_id: 1,
      supplier_id: 1,
      invoice_date: '2026-09-04',
      due_date: '2026-10-04',
      tax_amount: 0,
      items: [
        { po_item_id: 1, description: 'Test Monitor', quantity_invoiced: 2, unit_price: 74900 },
        { po_item_id: 2, description: 'Figma seat', quantity_invoiced: 1, unit_price: 54000 }
      ]
    });
    assert.equal(result.matchOutcome.overallMatchStatus, 'quantity_variance');
    assert.equal(result.matchOutcome.invoiceStatus, 'variance_flagged');
  });
});

