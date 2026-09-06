import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  DocumentTrailError,
  getDocumentTrail,
  searchDocumentTrails,
  toIsoTimestamp
} from './documentTrailService.js';

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
    INSERT INTO users (id, name, email, role, department_id, title) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Specialist'),
      (2, 'Bob Martinez', 'bob@example.com', 'approver', 1, 'VP of Marketing'),
      (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Sourcing'),
      (4, 'David Miller', 'david@example.com', 'finance', 1, 'Controller');
    INSERT INTO suppliers (id, name, code, payment_terms) VALUES
      (1, 'TechSupply Global', 'SUP-TSG', 'Net 30'),
      (3, 'WorkSpace Ergonomics Depot', 'SUP-WED', 'Net 45'),
      (5, 'Apex Advisory & Digital', 'SUP-AAD', 'Net 60');
  `);
  return db;
}

function seedCompleteGoodsChain(db) {
  db.exec(`
    INSERT INTO purchase_requisitions
      (id, pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date, created_at)
    VALUES
      (1, 'PR-2026-001', 1, 1, 'converted_to_po', 259000, 'Ergonomic chairs', '2026-09-15', '2026-08-27 09:00:00');

    INSERT INTO requisition_items
      (id, requisition_id, item_description, category, quantity, unit_price, total_price, estimated_supplier_id, line_type)
    VALUES
      (1, 1, 'Aeron Chair', 'Office Supplies', 2, 129500, 259000, 3, 'goods');

    INSERT INTO approval_requests
      (id, requisition_id, approver_id, step_order, status, comments, decided_at, created_at)
    VALUES
      (1, 1, 2, 1, 'approved', 'Dept head approved', '2026-08-28 14:20:00', '2026-08-27 10:00:00'),
      (2, 1, 3, 2, 'approved', 'Sourcing approved', '2026-08-28 16:05:00', '2026-08-27 10:00:00');

    INSERT INTO purchase_orders
      (id, po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date, created_at)
    VALUES
      (1, 'PO-2026-001', 1, 3, 3, 'received', 259000, '2026-08-29', '2026-08-29 09:30:00');

    INSERT INTO po_items
      (id, po_id, requisition_item_id, item_description, category, quantity, unit_price, total_price, quantity_received, quantity_invoiced, line_type)
    VALUES
      (1, 1, 1, 'Aeron Chair', 'Office Supplies', 2, 129500, 259000, 2, 2, 'goods');

    INSERT INTO goods_receipts
      (id, grn_number, po_id, received_by, receipt_date, created_at)
    VALUES
      (1, 'GRN-2026-001', 1, 3, '2026-09-02', '2026-09-02 11:00:00');

    INSERT INTO invoices
      (id, invoice_number, po_id, supplier_id, invoice_date, due_date, subtotal, tax_amount, total_amount, status, match_status, payment_reference, created_at)
    VALUES
      (1, 'INV-WED-9042', 1, 3, '2026-09-02', '2026-10-17', 259000, 0, 259000, 'paid', 'perfect_match', 'ACH-1017', '2026-09-02 15:00:00');

    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details, created_at)
    VALUES
      ('invoice', 1, 'APPROVED_PAYMENT', 'David Miller', 'Approved invoice INV-WED-9042 for payment', '2026-09-03 10:00:00'),
      ('invoice', 1, 'PAID', 'David Miller', 'Marked as paid with reference ACH-1017', '2026-09-04 08:00:00');
  `);
}

function seedSplitPoChain(db) {
  db.exec(`
    INSERT INTO purchase_requisitions
      (id, pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date, created_at)
    VALUES
      (6, 'PR-2026-006', 1, 1, 'converted_to_po', 204400, 'Studio refresh split', '2026-10-05', '2026-09-03 08:00:00');

    INSERT INTO requisition_items
      (id, requisition_id, item_description, category, quantity, unit_price, total_price, estimated_supplier_id, line_type)
    VALUES
      (10, 6, 'Dell Monitor', 'IT Hardware', 1, 74900, 74900, 1, 'goods'),
      (11, 6, 'Aeron Chair', 'Office Supplies', 1, 129500, 129500, 3, 'goods');

    INSERT INTO approval_requests
      (id, requisition_id, approver_id, step_order, status, comments, decided_at, created_at)
    VALUES
      (10, 6, 2, 1, 'approved', 'Approved split', '2026-09-03 09:40:00', '2026-09-03 08:30:00'),
      (11, 6, 3, 2, 'approved', 'Two vendors', '2026-09-03 11:15:00', '2026-09-03 08:30:00');

    INSERT INTO purchase_orders
      (id, po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date, created_at)
    VALUES
      (10, 'PO-2026-010', 6, 1, 3, 'issued', 74900, '2026-09-04', '2026-09-04 09:00:00'),
      (11, 'PO-2026-011', 6, 3, 3, 'issued', 129500, '2026-09-04', '2026-09-04 09:01:00');

    INSERT INTO po_items
      (id, po_id, requisition_item_id, item_description, category, quantity, unit_price, total_price, line_type)
    VALUES
      (10, 10, 10, 'Dell Monitor', 'IT Hardware', 1, 74900, 74900, 'goods'),
      (11, 11, 11, 'Aeron Chair', 'Office Supplies', 1, 129500, 129500, 'goods');
  `);
}

function seedStandalonePo(db) {
  db.exec(`
    INSERT INTO purchase_orders
      (id, po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date, created_at)
    VALUES
      (2, 'PO-2026-002', NULL, 1, 3, 'partially_received', 299600, '2026-08-30', '2026-08-30 10:00:00');

    INSERT INTO po_items
      (id, po_id, item_description, category, quantity, unit_price, total_price, quantity_received, line_type)
    VALUES
      (2, 2, 'Dell Monitor', 'IT Hardware', 4, 74900, 299600, 2, 'goods');

    INSERT INTO goods_receipts
      (id, grn_number, po_id, received_by, receipt_date, created_at)
    VALUES
      (2, 'GRN-2026-002', 2, 3, '2026-09-03', '2026-09-03 12:00:00');
  `);
}

function seedDraftPr(db) {
  db.exec(`
    INSERT INTO purchase_requisitions
      (id, pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date, created_at)
    VALUES
      (4, 'PR-2026-004', 1, 1, 'draft', 54700, 'Kitchen refill', '2026-09-25', '2026-09-05 09:00:00');
  `);
}

describe('toIsoTimestamp', () => {
  test('converts SQLite datetime and date-only values to ISO-8601', () => {
    assert.equal(toIsoTimestamp('2026-08-28 14:20:00'), '2026-08-28T14:20:00.000Z');
    assert.equal(toIsoTimestamp('2026-08-29'), '2026-08-29T00:00:00.000Z');
    assert.equal(toIsoTimestamp('2026-09-02T15:00:00.000Z'), '2026-09-02T15:00:00.000Z');
    assert.equal(toIsoTimestamp(null), null);
  });
});

describe('document trail — complete goods chain', () => {
  test('returns PR header, approvals, PO, GRN, invoice match, and AP events in cents + ISO', () => {
    const db = createTestDb();
    seedCompleteGoodsChain(db);

    const trail = getDocumentTrail(db, { requisition_id: 1 });

    assert.equal(trail.starting_point.type, 'requisition');
    assert.equal(trail.starting_point.number, 'PR-2026-001');
    assert.equal(trail.requisition.pr_number, 'PR-2026-001');
    assert.equal(trail.requisition.status, 'converted_to_po');
    assert.equal(trail.requisition.total_amount, 259000);
    assert.equal(trail.requisition.requester_name, 'Alice Chen');
    assert.match(trail.requisition.created_at, /^\d{4}-\d{2}-\d{2}T/);

    assert.equal(trail.approvals.length, 2);
    assert.equal(trail.approvals[0].approver_name, 'Bob Martinez');
    assert.equal(trail.approvals[0].status, 'approved');
    assert.equal(trail.approvals[0].decided_at, '2026-08-28T14:20:00.000Z');
    assert.equal(trail.approvals[1].approver_name, 'Carol Zhang');

    assert.equal(trail.purchase_orders.length, 1);
    assert.equal(trail.split, false);
    const po = trail.purchase_orders[0];
    assert.equal(po.po_number, 'PO-2026-001');
    assert.equal(po.supplier_name, 'WorkSpace Ergonomics Depot');
    assert.equal(po.total_amount, 259000);
    assert.equal(po.goods_receipts[0].grn_number, 'GRN-2026-001');
    assert.equal(po.goods_receipts[0].received_by_name, 'Carol Zhang');
    assert.equal(po.service_entry_sheets.length, 0);
    assert.equal(po.receiving.goods, 'recorded');
    assert.equal(po.receiving.services, 'not_applicable');

    assert.equal(po.invoices.length, 1);
    assert.equal(po.invoices[0].invoice_number, 'INV-WED-9042');
    assert.equal(po.invoices[0].status, 'paid');
    assert.equal(po.invoices[0].match_status, 'perfect_match');
    assert.equal(po.invoices[0].total_amount, 259000);
    assert.equal(po.invoices[0].ap_events.length, 2);
    assert.deepEqual(
      po.invoices[0].ap_events.map((event) => event.action),
      ['APPROVED_PAYMENT', 'PAID']
    );
    assert.equal(po.invoices[0].ap_events[0].actor_name, 'David Miller');

    const kinds = trail.timeline.map((event) => event.kind);
    assert.deepEqual(kinds, [
      'requisition',
      'approval',
      'approval',
      'purchase_order',
      'goods_receipt',
      'invoice',
      'ap_event',
      'ap_event'
    ]);
    assert.ok(trail.timeline.every((event) => event.at && /^\d{4}-\d{2}-\d{2}T/.test(event.at)));
    assert.equal(trail.timeline.filter((event) => event.source === 'audit').length, 2);
    assert.ok(trail.timeline.every((event) => event.source === 'document' || event.source === 'audit'));
    const secondApproval = trail.timeline.filter((event) => event.kind === 'approval')[1];
    assert.equal(secondApproval.entity_id, 2);
    assert.equal(secondApproval.focus_id, 1);
    assert.equal(trail.timeline.find((event) => event.kind === 'ap_event').focus_id, 1);

    const stageByKey = Object.fromEntries(trail.stages.map((stage) => [stage.key, stage.status]));
    assert.equal(stageByKey.requisition, 'complete');
    assert.equal(stageByKey.approvals, 'complete');
    assert.equal(stageByKey.purchase_orders, 'complete');
    assert.equal(stageByKey.receiving, 'complete');
    assert.equal(stageByKey.invoice, 'complete');
    assert.equal(stageByKey.ap, 'complete');
  });

  test('looks up the same chain by pr_number, po_id, po_number, and q', () => {
    const db = createTestDb();
    seedCompleteGoodsChain(db);

    const byPr = getDocumentTrail(db, { pr_number: 'pr-2026-001' });
    const byPoId = getDocumentTrail(db, { po_id: 1 });
    const byPoNumber = getDocumentTrail(db, { po_number: 'PO-2026-001' });
    const byQ = getDocumentTrail(db, { q: 'INV-WED-9042' });

    assert.equal(byPr.requisition.id, 1);
    assert.equal(byPoId.requisition.id, 1);
    assert.equal(byPoNumber.purchase_orders[0].id, 1);
    assert.equal(byQ.purchase_orders[0].invoices[0].invoice_number, 'INV-WED-9042');
  });
});

describe('document trail — multi-supplier split', () => {
  test('one PR returns two PO branches and not_started receiving/invoice/AP', () => {
    const db = createTestDb();
    seedSplitPoChain(db);

    const trail = getDocumentTrail(db, { pr_number: 'PR-2026-006' });
    assert.equal(trail.split, true);
    assert.equal(trail.purchase_orders.length, 2);
    assert.deepEqual(
      trail.purchase_orders.map((po) => po.po_number),
      ['PO-2026-010', 'PO-2026-011']
    );
    assert.deepEqual(
      trail.purchase_orders.map((po) => po.supplier_name),
      ['TechSupply Global', 'WorkSpace Ergonomics Depot']
    );
    assert.equal(trail.purchase_orders[0].total_amount, 74900);
    assert.equal(trail.purchase_orders[1].total_amount, 129500);

    for (const po of trail.purchase_orders) {
      assert.equal(po.goods_receipts.length, 0);
      assert.equal(po.invoices.length, 0);
      assert.equal(po.receiving.goods, 'not_started');
    }

    const poEvents = trail.timeline.filter((event) => event.kind === 'purchase_order');
    assert.equal(poEvents.length, 2);
    assert.ok(poEvents.every((event) => event.po_id && event.supplier_name));

    const stageByKey = Object.fromEntries(trail.stages.map((stage) => [stage.key, stage.status]));
    assert.equal(stageByKey.purchase_orders, 'complete');
    assert.equal(stageByKey.receiving, 'not_started');
    assert.equal(stageByKey.invoice, 'not_started');
    assert.equal(stageByKey.ap, 'not_started');

    const viaChildPo = getDocumentTrail(db, { po_id: 10 });
    assert.equal(viaChildPo.purchase_orders.length, 2);
    assert.equal(viaChildPo.requisition.pr_number, 'PR-2026-006');
  });
});

describe('document trail — edge lookups', () => {
  test('PO without a requisition still returns GRN and empty PR/approvals', () => {
    const db = createTestDb();
    seedStandalonePo(db);

    const trail = getDocumentTrail(db, { po_number: 'PO-2026-002' });
    assert.equal(trail.starting_point.type, 'purchase_order');
    assert.equal(trail.requisition, null);
    assert.equal(trail.approvals.length, 0);
    assert.equal(trail.purchase_orders[0].goods_receipts[0].grn_number, 'GRN-2026-002');
    assert.equal(trail.stages.find((stage) => stage.key === 'requisition').status, 'not_applicable');
    assert.equal(trail.stages.find((stage) => stage.key === 'receiving').status, 'complete');
    assert.equal(trail.stages.find((stage) => stage.key === 'invoice').status, 'not_started');
  });

  test('draft PR has empty later stages and no invented timeline events', () => {
    const db = createTestDb();
    seedDraftPr(db);

    const trail = getDocumentTrail(db, { requisition_id: 4 });
    assert.equal(trail.approvals.length, 0);
    assert.equal(trail.purchase_orders.length, 0);
    assert.equal(trail.timeline.length, 1);
    assert.equal(trail.timeline[0].kind, 'requisition');
    assert.equal(trail.stages.find((stage) => stage.key === 'purchase_orders').status, 'not_started');
    assert.equal(trail.stages.find((stage) => stage.key === 'receiving').status, 'not_started');
  });

  test('missing lookup and unknown documents fail closed', () => {
    const db = createTestDb();
    seedCompleteGoodsChain(db);

    assert.throws(
      () => getDocumentTrail(db, {}),
      (err) => err instanceof DocumentTrailError && err.statusCode === 400
    );
    assert.throws(
      () => getDocumentTrail(db, { pr_number: 'PR-NOPE' }),
      (err) => err instanceof DocumentTrailError && err.statusCode === 404
    );
    assert.throws(
      () => getDocumentTrail(db, { po_id: 999 }),
      (err) => err instanceof DocumentTrailError && err.statusCode === 404
    );
    assert.throws(
      () => getDocumentTrail(db, { q: 'UNKNOWN-DOC' }),
      (err) => err instanceof DocumentTrailError && err.statusCode === 404
    );
  });

  test('search returns PRs, POs, and invoices for the picker', () => {
    const db = createTestDb();
    seedCompleteGoodsChain(db);
    seedSplitPoChain(db);

    const all = searchDocumentTrails(db, '');
    assert.ok(all.requisitions.some((pr) => pr.pr_number === 'PR-2026-001'));
    assert.ok(all.purchase_orders.some((po) => po.po_number === 'PO-2026-001'));

    const filtered = searchDocumentTrails(db, 'PR-2026-006');
    assert.equal(filtered.requisitions.length, 1);
    assert.equal(filtered.requisitions[0].pr_number, 'PR-2026-006');

    const invoices = searchDocumentTrails(db, 'INV-WED');
    assert.equal(invoices.invoices[0].invoice_number, 'INV-WED-9042');
    assert.match(all.requisitions[0].created_at, /^\d{4}-\d{2}-\d{2}T/);
  });
});
