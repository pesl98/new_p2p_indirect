import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createGoodsReceipt, GoodsReceiptError } from './goodsReceiptsService.js';

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
    INSERT INTO users (id, name, email, role, department_id)
      VALUES (1, 'Alice', 'alice@example.com', 'requester', 1),
             (3, 'Carol', 'carol@example.com', 'procurement', 1);
    INSERT INTO suppliers (id, name, code) VALUES (1, 'Vendor Co', 'SUP-1');
    INSERT INTO purchase_orders (id, po_number, supplier_id, created_by, status, total_amount, issue_date)
      VALUES (1, 'PO-2026-001', 1, 3, 'issued', 259000, '2026-08-29');
    INSERT INTO po_items (id, po_id, item_description, category, quantity, unit_price, total_price, quantity_received, quantity_invoiced)
      VALUES (1, 1, 'Herman Miller Aeron', 'Office Supplies', 2, 129500, 259000, 0, 0);
  `);
  return db;
}

function receiptPayload(overrides = {}) {
  return {
    po_id: 1,
    received_by: 3,
    receipt_date: '2026-09-04',
    items: [{ po_item_id: 1, quantity_received: 2, condition: 'good' }],
    ...overrides
  };
}

describe('goods receipt over-receipt control', () => {
  test('accepts a receipt that does not exceed ordered qty', () => {
    const db = createTestDb();
    const result = createGoodsReceipt(db, receiptPayload({ items: [{ po_item_id: 1, quantity_received: 2 }] }));
    assert.equal(result.grnNumber, 'GRN-2026-001');
    assert.equal(result.newPOStatus, 'received');
    const poItem = db.prepare(`SELECT quantity_received FROM po_items WHERE id = 1`).get();
    assert.equal(poItem.quantity_received, 2);
  });

  test('rejects over-receipt with 400 unless allow_over_receipt is set', () => {
    const db = createTestDb();
    createGoodsReceipt(db, receiptPayload({ items: [{ po_item_id: 1, quantity_received: 2 }] }));

    assert.throws(
      () => createGoodsReceipt(db, receiptPayload({ items: [{ po_item_id: 1, quantity_received: 1 }] })),
      (err) => err instanceof GoodsReceiptError && err.statusCode === 400 && /allow_over_receipt/i.test(err.message)
    );

    const poItem = db.prepare(`SELECT quantity_received FROM po_items WHERE id = 1`).get();
    assert.equal(poItem.quantity_received, 2);
    const grnCount = db.prepare(`SELECT COUNT(*) as cnt FROM goods_receipts`).get();
    assert.equal(grnCount.cnt, 1);
  });

  test('allow_over_receipt records the overage and writes an audit log', () => {
    const db = createTestDb();
    createGoodsReceipt(db, receiptPayload({ items: [{ po_item_id: 1, quantity_received: 2 }] }));

    const result = createGoodsReceipt(db, receiptPayload({
      items: [{ po_item_id: 1, quantity_received: 1, comments: 'Vendor shipped extra' }],
      allow_over_receipt: true,
      actor_name: 'Carol Zhang'
    }));

    assert.equal(result.overReceipt, true);
    const poItem = db.prepare(`SELECT quantity_received FROM po_items WHERE id = 1`).get();
    assert.equal(poItem.quantity_received, 3);

    const overrideLog = db.prepare(`
      SELECT action, details FROM audit_logs
      WHERE entity_type = 'goods_receipt' AND entity_id = ? AND action = 'OVER_RECEIPT_OVERRIDE'
    `).get(result.grId);
    assert.ok(overrideLog);
    assert.match(overrideLog.details, /cumulative 3 vs ordered 2/);
  });

  test('a single receipt that exceeds ordered qty is also blocked by default', () => {
    const db = createTestDb();
    assert.throws(
      () => createGoodsReceipt(db, receiptPayload({ items: [{ po_item_id: 1, quantity_received: 5 }] })),
      (err) => err instanceof GoodsReceiptError && err.statusCode === 400
    );
    const poItem = db.prepare(`SELECT quantity_received FROM po_items WHERE id = 1`).get();
    assert.equal(poItem.quantity_received, 0);
  });
});
