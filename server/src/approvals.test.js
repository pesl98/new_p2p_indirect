import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { APPROVAL_TIER2_CENTS, insertApprovalChain } from './approvalPolicy.js';
import { ApprovalDecisionError, decideApprovalStep } from './approvalsService.js';

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
      (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Head of Strategic Sourcing'),
      (4, 'David Miller', 'david@example.com', 'finance', 1, 'Controller');
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
    VALUES (1, 2026, 15000000, 1000, 0);
  `);
  return db;
}

function insertPr(db, amount) {
  const result = db.prepare(`
    INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount)
    VALUES (?, 1, 1, 'pending_approval', ?)
  `).run(`PR-TEST-${Math.random().toString(16).slice(2)}`, amount);
  return Number(result.lastInsertRowid);
}

function chainRows(db, prId) {
  return db.prepare(
    `SELECT id, step_order, approver_id, status FROM approval_requests WHERE requisition_id = ? ORDER BY step_order`
  ).all(prId);
}

describe('sequential approval decisions', () => {
  test('cannot decide a waiting step', () => {
    const db = createTestDb();
    const amount = APPROVAL_TIER2_CENTS + 500;
    const prId = insertPr(db, amount);
    insertApprovalChain(db, prId, amount, 1);
    const waiting = chainRows(db, prId)[1];
    assert.equal(waiting.status, 'waiting');

    assert.throws(
      () => decideApprovalStep(db, {
        approvalId: waiting.id,
        decision: 'approved',
        approver_id: waiting.approver_id,
        approver_name: 'Carol Zhang'
      }),
      (err) => err instanceof ApprovalDecisionError && err.statusCode === 400
    );

    assert.equal(chainRows(db, prId)[1].status, 'waiting');
    const pr = db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId);
    assert.equal(pr.status, 'pending_approval');
  });

  test('wrong approver_id is rejected with 403', () => {
    const db = createTestDb();
    const amount = APPROVAL_TIER2_CENTS + 500;
    const prId = insertPr(db, amount);
    insertApprovalChain(db, prId, amount, 1);
    const pending = chainRows(db, prId)[0];

    assert.throws(
      () => decideApprovalStep(db, {
        approvalId: pending.id,
        decision: 'approved',
        approver_id: 3,
        approver_name: 'Carol Zhang'
      }),
      (err) => err instanceof ApprovalDecisionError && err.statusCode === 403
    );
    assert.equal(chainRows(db, prId)[0].status, 'pending');
  });

  test('approve step 1 promotes step 2 from waiting to pending', () => {
    const db = createTestDb();
    const amount = APPROVAL_TIER2_CENTS + 500;
    const prId = insertPr(db, amount);
    insertApprovalChain(db, prId, amount, 1);
    const [step1, step2] = chainRows(db, prId);

    const result = decideApprovalStep(db, {
      approvalId: step1.id,
      decision: 'approved',
      comments: 'Dept OK',
      approver_id: step1.approver_id,
      approver_name: 'Bob Martinez'
    });

    assert.equal(result.outcome, 'step_approved');
    assert.equal(result.budgetCommitted, false);
    const rows = chainRows(db, prId);
    assert.equal(rows[0].status, 'approved');
    assert.equal(rows[1].status, 'pending');
    const pr = db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId);
    assert.equal(pr.status, 'pending_approval');
    const budget = db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get();
    assert.equal(budget.committed_amount, 1000);
  });

  test('reject skips remaining waiting steps and sets PR rejected', () => {
    const db = createTestDb();
    const amount = APPROVAL_TIER2_CENTS + 500;
    const prId = insertPr(db, amount);
    insertApprovalChain(db, prId, amount, 1);
    const [step1] = chainRows(db, prId);

    const result = decideApprovalStep(db, {
      approvalId: step1.id,
      decision: 'rejected',
      comments: 'Not needed',
      approver_id: step1.approver_id,
      approver_name: 'Bob Martinez'
    });

    assert.equal(result.outcome, 'rejected');
    const rows = chainRows(db, prId);
    assert.equal(rows[0].status, 'rejected');
    assert.equal(rows[1].status, 'skipped');
    const pr = db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId);
    assert.equal(pr.status, 'rejected');
    const budget = db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get();
    assert.equal(budget.committed_amount, 1000);
  });

  test('budget commits only when the final step is approved', () => {
    const db = createTestDb();
    const amount = APPROVAL_TIER2_CENTS + 500;
    const prId = insertPr(db, amount);
    insertApprovalChain(db, prId, amount, 1);
    const [step1] = chainRows(db, prId);

    decideApprovalStep(db, {
      approvalId: step1.id,
      decision: 'approved',
      approver_id: step1.approver_id,
      approver_name: 'Bob Martinez'
    });

    const midBudget = db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get();
    assert.equal(midBudget.committed_amount, 1000);

    const step2 = chainRows(db, prId)[1];
    const result = decideApprovalStep(db, {
      approvalId: step2.id,
      decision: 'approved',
      approver_id: step2.approver_id,
      approver_name: 'Carol Zhang'
    });

    assert.equal(result.outcome, 'approved');
    assert.equal(result.budgetCommitted, true);
    const pr = db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId);
    assert.equal(pr.status, 'approved');
    const budget = db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get();
    assert.equal(budget.committed_amount, 1000 + amount);
  });

  test('single-step PR commits budget on the first (final) approve', () => {
    const db = createTestDb();
    const amount = 50_000;
    const prId = insertPr(db, amount);
    insertApprovalChain(db, prId, amount, 1);
    const [step1] = chainRows(db, prId);
    assert.equal(chainRows(db, prId).length, 1);

    const result = decideApprovalStep(db, {
      approvalId: step1.id,
      decision: 'approved',
      approver_id: step1.approver_id,
      approver_name: 'Bob Martinez'
    });
    assert.equal(result.budgetCommitted, true);
    const budget = db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get();
    assert.equal(budget.committed_amount, 1000 + amount);
  });
});
