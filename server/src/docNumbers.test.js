import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nextDocumentNumber } from './docNumbers.js';

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
             (2, 'Carol', 'carol@example.com', 'procurement', 1);
    INSERT INTO suppliers (id, name, code) VALUES (1, 'Vendor Co', 'SUP-1');
  `);
  return db;
}

describe('document numbering', () => {
  test('starts at 001 when the year has no documents', () => {
    const db = createTestDb();
    assert.equal(nextDocumentNumber(db, 'pr', 2026), 'PR-2026-001');
    assert.equal(nextDocumentNumber(db, 'po', 2026), 'PO-2026-001');
    assert.equal(nextDocumentNumber(db, 'grn', 2026), 'GRN-2026-001');
    assert.equal(nextDocumentNumber(db, 'ses', 2026), 'SES-2026-001');
  });

  test('MAX suffix skips gaps so COUNT(*)+1 cannot collide', () => {
    const db = createTestDb();
    db.prepare(`
      INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount)
      VALUES ('PR-2026-001', 1, 1, 'draft', 100),
             ('PR-2026-003', 1, 1, 'draft', 100)
    `).run();

    // COUNT(*)+1 would emit PR-2026-003 and hit UNIQUE(pr_number).
    assert.equal(nextDocumentNumber(db, 'pr', 2026), 'PR-2026-004');
  });

  test('sequential creates inside a transaction get unique incrementing numbers', () => {
    const db = createTestDb();
    const numbers = db.transaction(() => {
      const allocated = [];
      for (let i = 0; i < 5; i += 1) {
        const prNumber = nextDocumentNumber(db, 'pr', 2026);
        db.prepare(`
          INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount)
          VALUES (?, 1, 1, 'draft', 100)
        `).run(prNumber);
        allocated.push(prNumber);
      }
      return allocated;
    })();

    assert.deepEqual(numbers, [
      'PR-2026-001',
      'PR-2026-002',
      'PR-2026-003',
      'PR-2026-004',
      'PR-2026-005'
    ]);
    const unique = new Set(numbers);
    assert.equal(unique.size, numbers.length);
  });

  test('SES MAX suffix skips gaps independently of GRN', () => {
    const db = createTestDb();
    db.prepare(`
      INSERT INTO purchase_orders (po_number, supplier_id, created_by, status, total_amount, issue_date)
      VALUES ('PO-2026-001', 1, 2, 'issued', 100, '2026-09-01')
    `).run();
    const poId = db.prepare(`SELECT id FROM purchase_orders WHERE po_number = 'PO-2026-001'`).get().id;
    db.prepare(`
      INSERT INTO service_entry_sheets (ses_number, po_id, created_by, status)
      VALUES ('SES-2026-001', ?, 1, 'draft'),
             ('SES-2026-003', ?, 1, 'draft')
    `).run(poId, poId);

    assert.equal(nextDocumentNumber(db, 'ses', 2026), 'SES-2026-004');
    assert.equal(nextDocumentNumber(db, 'grn', 2026), 'GRN-2026-001');
  });

  test('PO and GRN sequences are independent and year-scoped', () => {
    const db = createTestDb();
    db.prepare(`
      INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount)
      VALUES ('PR-2025-099', 1, 1, 'draft', 100),
             ('PR-2026-002', 1, 1, 'draft', 100)
    `).run();
    db.prepare(`
      INSERT INTO purchase_orders (po_number, supplier_id, created_by, status, total_amount, issue_date)
      VALUES ('PO-2026-001', 1, 2, 'issued', 100, '2026-09-01')
    `).run();

    assert.equal(nextDocumentNumber(db, 'pr', 2026), 'PR-2026-003');
    assert.equal(nextDocumentNumber(db, 'pr', 2025), 'PR-2025-100');
    assert.equal(nextDocumentNumber(db, 'po', 2026), 'PO-2026-002');
  });
});
