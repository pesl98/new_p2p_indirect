import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  acceptServiceEntrySheet,
  createServiceEntrySheet,
  rejectServiceEntrySheet,
  ServiceEntrySheetError,
  submitServiceEntrySheet
} from './serviceEntrySheetsService.js';
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
    INSERT INTO departments (id, code, name) VALUES (1, 'ITE', 'IT');
    INSERT INTO users (id, name, email, role, department_id)
      VALUES (1, 'Alice', 'alice@example.com', 'requester', 1),
             (3, 'Carol', 'carol@example.com', 'procurement', 1);
    INSERT INTO suppliers (id, name, code) VALUES (1, 'Apex Advisory', 'SUP-AAD');
    INSERT INTO purchase_orders (id, po_number, supplier_id, created_by, status, total_amount, issue_date)
      VALUES (1, 'PO-2026-010', 1, 3, 'issued', 1250000, '2026-08-26');
    INSERT INTO po_items (id, po_id, item_description, category, quantity, unit_price, total_price, line_type)
      VALUES (1, 1, 'SOC 2 Type II Annual Security Penetration Test', 'Consulting & Professional Services', 1, 1250000, 1250000, 'service');
  `);
  return db;
}

function sesPayload(overrides = {}) {
  return {
    po_id: 1,
    created_by: 1,
    service_period_start: '2026-09-01',
    service_period_end: '2026-09-20',
    items: [{ po_item_id: 1, quantity_accepted: 1, comments: 'Work complete' }],
    submitImmediately: true,
    actor_name: 'Alice Chen',
    ...overrides
  };
}

describe('service entry sheet numbering and lifecycle', () => {
  test('allocates SES-YYYY-NNN via MAX suffix', () => {
    const db = createTestDb();
    const first = createServiceEntrySheet(db, sesPayload({ submitImmediately: false }));
    assert.equal(first.sesNumber, 'SES-2026-001');
    assert.equal(first.status, 'draft');

    db.prepare(`
      INSERT INTO service_entry_sheets (ses_number, po_id, created_by, status)
      VALUES ('SES-2026-003', 1, 1, 'draft')
    `).run();

    const next = createServiceEntrySheet(db, sesPayload({
      submitImmediately: false,
      items: [{ po_item_id: 1, quantity_accepted: 1 }]
    }));
    assert.equal(next.sesNumber, 'SES-2026-004');
  });

  test('submit then accept increments quantity_accepted and marks PO received', () => {
    const db = createTestDb();
    const created = createServiceEntrySheet(db, sesPayload({ submitImmediately: false }));
    const submitted = submitServiceEntrySheet(db, created.sesId, { actor_name: 'Alice Chen' });
    assert.equal(submitted.status, 'submitted');

    const accepted = acceptServiceEntrySheet(db, created.sesId, {
      decided_by: 3,
      actor_name: 'Carol Zhang'
    });
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.newPOStatus, 'received');

    const poItem = db.prepare(`SELECT quantity_accepted, quantity_received FROM po_items WHERE id = 1`).get();
    assert.equal(poItem.quantity_accepted, 1);
    assert.equal(poItem.quantity_received, 0, 'SES must not write GRN quantity_received');
  });

  test('rejects a goods line and does not increment accepted qty', () => {
    const db = createTestDb();
    db.prepare(`
      UPDATE po_items SET line_type = 'goods', category = 'IT Hardware' WHERE id = 1
    `).run();

    assert.throws(
      () => createServiceEntrySheet(db, sesPayload()),
      (err) => err instanceof ServiceEntrySheetError && err.statusCode === 400 && /goods line/i.test(err.message)
    );
  });
});

describe('SES over-acceptance control', () => {
  test('rejects over-acceptance unless allow_over_acceptance is set', () => {
    const db = createTestDb();
    const first = createServiceEntrySheet(db, sesPayload());
    acceptServiceEntrySheet(db, first.sesId, { decided_by: 3, actor_name: 'Carol Zhang' });

    const second = createServiceEntrySheet(db, sesPayload({
      items: [{ po_item_id: 1, quantity_accepted: 1, comments: 'Extra week' }]
    }));

    assert.throws(
      () => acceptServiceEntrySheet(db, second.sesId, { decided_by: 3 }),
      (err) => err instanceof ServiceEntrySheetError && err.statusCode === 400 && /allow_over_acceptance/i.test(err.message)
    );

    const poItem = db.prepare(`SELECT quantity_accepted FROM po_items WHERE id = 1`).get();
    assert.equal(poItem.quantity_accepted, 1);
    const stillSubmitted = db.prepare(`SELECT status FROM service_entry_sheets WHERE id = ?`).get(second.sesId);
    assert.equal(stillSubmitted.status, 'submitted');
  });

  test('allow_over_acceptance records the overage and writes an audit log', () => {
    const db = createTestDb();
    const first = createServiceEntrySheet(db, sesPayload());
    acceptServiceEntrySheet(db, first.sesId, { decided_by: 3, actor_name: 'Carol Zhang' });

    const second = createServiceEntrySheet(db, sesPayload({
      items: [{ po_item_id: 1, quantity_accepted: 1 }]
    }));
    const result = acceptServiceEntrySheet(db, second.sesId, {
      decided_by: 3,
      actor_name: 'Carol Zhang',
      allow_over_acceptance: true
    });

    assert.equal(result.overAcceptance, true);
    const poItem = db.prepare(`SELECT quantity_accepted FROM po_items WHERE id = 1`).get();
    assert.equal(poItem.quantity_accepted, 2);

    const overrideLog = db.prepare(`
      SELECT action, details FROM audit_logs
      WHERE entity_type = 'service_entry_sheet' AND entity_id = ? AND action = 'OVER_ACCEPTANCE_OVERRIDE'
    `).get(result.sesId);
    assert.ok(overrideLog);
    assert.match(overrideLog.details, /cumulative 2 vs ordered 1/);
  });

  test('rejecting a submitted SES does not increment accepted qty', () => {
    const db = createTestDb();
    const created = createServiceEntrySheet(db, sesPayload());
    rejectServiceEntrySheet(db, created.sesId, {
      decided_by: 3,
      actor_name: 'Carol Zhang',
      decision_comments: 'Scope incomplete'
    });
    const poItem = db.prepare(`SELECT quantity_accepted FROM po_items WHERE id = 1`).get();
    assert.equal(poItem.quantity_accepted, 0);
  });
});

describe('GRN vs SES line-type guard', () => {
  test('GRN against a service line is rejected', () => {
    const db = createTestDb();
    assert.throws(
      () => createGoodsReceipt(db, {
        po_id: 1,
        received_by: 3,
        receipt_date: '2026-09-04',
        items: [{ po_item_id: 1, quantity_received: 1, condition: 'good' }]
      }),
      (err) => err instanceof GoodsReceiptError && /Service Entry Sheet/i.test(err.message)
    );
  });
});
