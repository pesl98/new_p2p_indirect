import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from './db.js';
import { APPROVAL_TIER2_CENTS, insertApprovalChain } from './approvalPolicy.js';
import { ApprovalDecisionError, decideApprovalStep } from './approvalsService.js';


async function createTestDb() {
  const db = await createMemoryDatabase();
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
  test('cannot decide a waiting step', async () => {
    const db = await createTestDb();
    const amount = APPROVAL_TIER2_CENTS + 500;
    const prId = await insertPr(db, amount);
    await insertApprovalChain(db, prId, amount, 1);
    const waiting = chainRows(db, prId)[1];
    assert.equal(waiting.status, 'waiting');

    assert.rejects(
      async () => decideApprovalStep(db, {
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

  test('wrong approver_id is rejected with 403', async () => {
    const db = await createTestDb();
    const amount = APPROVAL_TIER2_CENTS + 500;
    const prId = await insertPr(db, amount);
    await insertApprovalChain(db, prId, amount, 1);
    const pending = chainRows(db, prId)[0];

    assert.rejects(
      async () => decideApprovalStep(db, {
        approvalId: pending.id,
        decision: 'approved',
        approver_id: 3,
        approver_name: 'Carol Zhang'
      }),
      (err) => err instanceof ApprovalDecisionError && err.statusCode === 403
    );
    assert.equal(chainRows(db, prId)[0].status, 'pending');
  });

  test('approve step 1 promotes step 2 from waiting to pending', async () => {
    const db = await createTestDb();
    const amount = APPROVAL_TIER2_CENTS + 500;
    const prId = await insertPr(db, amount);
    await insertApprovalChain(db, prId, amount, 1);
    const [step1, step2] = chainRows(db, prId);

    const result = await decideApprovalStep(db, {
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

  test('reject skips remaining waiting steps and sets PR rejected', async () => {
    const db = await createTestDb();
    const amount = APPROVAL_TIER2_CENTS + 500;
    const prId = await insertPr(db, amount);
    await insertApprovalChain(db, prId, amount, 1);
    const [step1] = chainRows(db, prId);

    const result = await decideApprovalStep(db, {
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

  test('budget commits only when the final step is approved', async () => {
    const db = await createTestDb();
    const amount = APPROVAL_TIER2_CENTS + 500;
    const prId = await insertPr(db, amount);
    await insertApprovalChain(db, prId, amount, 1);
    const [step1] = chainRows(db, prId);

    await decideApprovalStep(db, {
      approvalId: step1.id,
      decision: 'approved',
      approver_id: step1.approver_id,
      approver_name: 'Bob Martinez'
    });

    const midBudget = db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get();
    assert.equal(midBudget.committed_amount, 1000);

    const step2 = chainRows(db, prId)[1];
    const result = await decideApprovalStep(db, {
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

  test('single-step PR commits budget on the first (final) approve', async () => {
    const db = await createTestDb();
    const amount = 50_000;
    const prId = await insertPr(db, amount);
    await insertApprovalChain(db, prId, amount, 1);
    const [step1] = chainRows(db, prId);
    assert.equal(chainRows(db, prId).length, 1);

    const result = await decideApprovalStep(db, {
      approvalId: step1.id,
      decision: 'approved',
      approver_id: step1.approver_id,
      approver_name: 'Bob Martinez'
    });
    assert.equal(result.budgetCommitted, true);
    const budget = db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get();
    assert.equal(budget.committed_amount, 1000 + amount);
  });

  test('final approve fails closed when remaining budget is insufficient', async () => {
    const db = await createTestDb();
    db.prepare(`UPDATE budgets SET committed_amount = 14950000, actual_spent = 0 WHERE department_id = 1`).run();
    const prAmount = 50_001;
    const prId = await insertPr(db, prAmount);
    await insertApprovalChain(db, prId, prAmount, 1);
    const [step1] = chainRows(db, prId);

    assert.rejects(
      async () => decideApprovalStep(db, {
        approvalId: step1.id,
        decision: 'approved',
        approver_id: step1.approver_id,
        approver_name: 'Bob Martinez'
      }),
      (err) => err instanceof ApprovalDecisionError
        && err.statusCode === 400
        && /Insufficient remaining budget/i.test(err.message)
    );

    const pr = db.prepare(`SELECT status FROM purchase_requisitions WHERE id = ?`).get(prId);
    assert.equal(pr.status, 'pending_approval');
    assert.equal(chainRows(db, prId)[0].status, 'pending');
    const budget = db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get();
    assert.equal(budget.committed_amount, 14950000);
  });

  test('final approve succeeds when remaining budget equals PR total', async () => {
    const db = await createTestDb();
    const amount = 50_000;
    db.prepare(`UPDATE budgets SET committed_amount = 14950000, actual_spent = 0 WHERE department_id = 1`).run();
    const prId = await insertPr(db, amount);
    await insertApprovalChain(db, prId, amount, 1);
    const [step1] = chainRows(db, prId);

    const result = await decideApprovalStep(db, {
      approvalId: step1.id,
      decision: 'approved',
      approver_id: step1.approver_id,
      approver_name: 'Bob Martinez'
    });
    assert.equal(result.budgetCommitted, true);
    const budget = db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get();
    assert.equal(budget.committed_amount, 15000000);
  });

  test('intermediate step still approves when remaining budget is insufficient', async () => {
    const db = await createTestDb();
    db.prepare(`UPDATE budgets SET committed_amount = 14950000, actual_spent = 0 WHERE department_id = 1`).run();
    const amount = APPROVAL_TIER2_CENTS + 500;
    const prId = await insertPr(db, amount);
    await insertApprovalChain(db, prId, amount, 1);
    const [step1] = chainRows(db, prId);

    const result = await decideApprovalStep(db, {
      approvalId: step1.id,
      decision: 'approved',
      approver_id: step1.approver_id,
      approver_name: 'Bob Martinez'
    });
    assert.equal(result.outcome, 'step_approved');
    assert.equal(result.budgetCommitted, false);
    const budget = db.prepare(`SELECT committed_amount FROM budgets WHERE department_id = 1`).get();
    assert.equal(budget.committed_amount, 14950000);
  });

  test('override_budget allows final approve when remaining is insufficient', async () => {
    const db = await createTestDb();
    db.prepare(`UPDATE budgets SET committed_amount = 14950000, actual_spent = 0 WHERE department_id = 1`).run();
    const amount = 60_000;
    const prId = await insertPr(db, amount);
    await insertApprovalChain(db, prId, amount, 1);
    const [step1] = chainRows(db, prId);

    const result = await decideApprovalStep(db, {
      approvalId: step1.id,
      decision: 'approved',
      approver_id: step1.approver_id,
      approver_name: 'Bob Martinez',
      override_budget: true
    });
    assert.equal(result.budgetCommitted, true);
    const log = db.prepare(`
      SELECT action FROM audit_logs WHERE entity_type = 'requisition' AND entity_id = ? AND action = 'BUDGET_OVERRIDE'
    `).get(prId);
    assert.ok(log);
  });
});
