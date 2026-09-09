import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from './db.js';
import {
  APPROVAL_TIER2_CENTS,
  APPROVAL_TIER3_CENTS,
  ApprovalPolicyError,
  buildApprovalSteps,
  insertApprovalChain
} from './approvalPolicy.js';


async function createTestDb({ includeFinance = true, includeAdmin = true, includeApprover = true } = {}) {
  const db = await createMemoryDatabase();
  
  db.exec(`
    INSERT INTO departments (id, code, name) VALUES
      (1, 'MKT', 'Marketing'),
      (2, 'ITE', 'IT'),
      (5, 'ADM', 'Finance & Administration');
    INSERT INTO users (id, name, email, role, department_id, title) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'requester', 1, 'Brand Marketing Specialist');
  `);

  if (includeApprover) {
    db.prepare(`
      INSERT INTO users (id, name, email, role, department_id, title)
      VALUES (2, 'Bob Martinez', 'bob@example.com', 'approver', 1, 'VP of Marketing')
    `).run();
  }

  db.prepare(`
    INSERT INTO users (id, name, email, role, department_id, title)
    VALUES (3, 'Carol Zhang', 'carol@example.com', 'procurement', 1, 'Head of Strategic Sourcing')
  `).run();

  if (includeFinance) {
    db.prepare(`
      INSERT INTO users (id, name, email, role, department_id, title)
      VALUES (4, 'David Miller', 'david@example.com', 'finance', 5, 'Financial Controller')
    `).run();
  }

  if (includeAdmin) {
    db.prepare(`
      INSERT INTO users (id, name, email, role, department_id, title)
      VALUES (5, 'Elena Rostova', 'elena@example.com', 'admin', 5, 'Chief Financial Officer (CFO)')
    `).run();
  }

  db.prepare(`
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
    VALUES (1, 2026, 15000000, 0, 0)
  `).run();

  return db;
}

describe('approval policy tiers', () => {
  test('amount ≤ $1,000 (100000¢) yields only the department approver', async () => {
    const db = await createTestDb();
    const steps = await buildApprovalSteps({ totalAmount: APPROVAL_TIER2_CENTS, departmentId: 1, db });
    assert.equal(steps.length, 1);
    assert.deepEqual(steps[0], { step_order: 1, approver_id: 2, role: 'approver' });
  });

  test('tier1 < amount ≤ tier2 yields approver then procurement; step 2 starts waiting', async () => {
    const db = await createTestDb();
    const amount = APPROVAL_TIER2_CENTS + 1;
    const steps = await buildApprovalSteps({ totalAmount: amount, departmentId: 1, db });
    assert.equal(steps.length, 2);
    assert.equal(steps[0].role, 'approver');
    assert.equal(steps[1].role, 'procurement');
    assert.equal(steps[1].approver_id, 3);

    const prId = await insertPr(db, amount);
    await insertApprovalChain(db, prId, amount, 1);
    const rows = db.prepare(
      `SELECT step_order, approver_id, status FROM approval_requests WHERE requisition_id = ? ORDER BY step_order`
    ).all(prId);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[1].status, 'waiting');
  });

  test('amount > $10,000 (1000000¢) yields three steps including finance', async () => {
    const db = await createTestDb();
    const amount = APPROVAL_TIER3_CENTS + 1;
    const steps = await buildApprovalSteps({ totalAmount: amount, departmentId: 1, db });
    assert.equal(steps.length, 3);
    assert.equal(steps[0].role, 'approver');
    assert.equal(steps[1].role, 'procurement');
    assert.equal(steps[2].role, 'finance');
    assert.equal(steps[2].approver_id, 4);
  });

  test('executive tier falls back to admin/CFO when no finance user exists', async () => {
    const db = await createTestDb({ includeFinance: false });
    const steps = await buildApprovalSteps({
      totalAmount: APPROVAL_TIER3_CENTS + 1,
      departmentId: 1,
      db
    });
    assert.equal(steps[2].role, 'admin');
    assert.equal(steps[2].approver_id, 5);
  });

  test('fails with 400 when a required department approver cannot be resolved', async () => {
    const db = await createTestDb({ includeApprover: false });
    assert.rejects(
      async () => buildApprovalSteps({ totalAmount: 50000, departmentId: 1, db }),
      (err) => err instanceof ApprovalPolicyError && err.statusCode === 400
    );
  });

  test('does not hardcode user ids 2/3/4 — different ids still resolve by role', async () => {
    const db = await createMemoryDatabase();
        db.exec(`
      INSERT INTO departments (id, code, name) VALUES (10, 'MKT', 'Marketing');
      INSERT INTO users (id, name, email, role, department_id, title) VALUES
        (20, 'Pat Approver', 'pat@example.com', 'approver', 10, 'Dept Head'),
        (30, 'Quinn Procure', 'quinn@example.com', 'procurement', 10, 'Buyer'),
        (40, 'Riley Finance', 'riley@example.com', 'finance', 10, 'Controller');
    `);
    const steps = await buildApprovalSteps({
      totalAmount: APPROVAL_TIER3_CENTS + 50,
      departmentId: 10,
      db
    });
    assert.deepEqual(steps.map((s) => s.approver_id), [20, 30, 40]);
  });

  test('mapped approver_user_id wins over role=approver in the department', async () => {
    const db = await createTestDb();
    db.exec(`UPDATE departments SET approver_user_id = 4 WHERE id = 1`);
    const steps = await buildApprovalSteps({ totalAmount: 50000, departmentId: 1, db });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].approver_id, 4);
    assert.equal(steps[0].role, 'finance');
  });

  test('mapping lets a department without role=approver still submit', async () => {
    const db = await createTestDb({ includeApprover: false });
    db.exec(`UPDATE departments SET approver_user_id = 5 WHERE id = 2`);
    const steps = await buildApprovalSteps({ totalAmount: 50000, departmentId: 2, db });
    assert.equal(steps[0].approver_id, 5);
    assert.equal(steps[0].role, 'admin');
  });

  test('unmapped department with no role=approver fails closed', async () => {
    const db = await createTestDb({ includeApprover: false });
    await assert.rejects(
      async () => buildApprovalSteps({ totalAmount: 50000, departmentId: 2, db }),
      (err) => err instanceof ApprovalPolicyError
        && err.statusCode === 400
        && /Org Admin/.test(err.message)
    );
  });

  test('three-tier chain is unchanged when mapping points at the dept head', async () => {
    const db = await createTestDb();
    db.exec(`UPDATE departments SET approver_user_id = 2 WHERE id = 1`);
    const steps = await buildApprovalSteps({
      totalAmount: APPROVAL_TIER3_CENTS + 1,
      departmentId: 1,
      db
    });
    assert.equal(steps.length, 3);
    assert.deepEqual(steps.map((s) => s.approver_id), [2, 3, 4]);
    assert.deepEqual(steps.map((s) => s.role), ['approver', 'procurement', 'finance']);
  });
});

function insertPr(db, amount, departmentId = 1) {
  const result = db.prepare(`
    INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount)
    VALUES (?, 1, ?, 'pending_approval', ?)
  `).run(`PR-TEST-${Math.random().toString(16).slice(2)}`, departmentId, amount);
  return result.lastInsertRowid;
}
