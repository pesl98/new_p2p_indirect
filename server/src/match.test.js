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

function insertPoLine(db, { ordered, received, unitPriceCents, invoiced = 0 }) {
  db.prepare(`
    INSERT INTO purchase_orders (id, po_number, supplier_id, created_by, status, total_amount, issue_date)
    VALUES (1, 'PO-TEST-001', 1, 1, 'partially_received', ?, '2026-09-01')
  `).run(ordered * unitPriceCents);

  db.prepare(`
    INSERT INTO po_items (id, po_id, item_description, category, quantity, unit_price, total_price, quantity_received, quantity_invoiced)
    VALUES (1, 1, 'Test Monitor', 'IT Hardware', ?, ?, ?, ?, ?)
  `).run(ordered, unitPriceCents, ordered * unitPriceCents, received, invoiced);
}

function invoicePayload({ qty, unitPriceCents, invoiceNumber = 'INV-TEST-1' }) {
  return {
    invoice_number: invoiceNumber,
    po_id: 1,
    supplier_id: 1,
    invoice_date: '2026-09-04',
    due_date: '2026-10-04',
    tax_amount: 0,
    items: [
      {
        po_item_id: 1,
        description: 'Test Monitor',
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
