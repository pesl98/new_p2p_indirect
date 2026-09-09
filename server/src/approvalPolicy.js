import { APPROVAL_TIER2_CENTS, APPROVAL_TIER3_CENTS } from './money.js';

export { APPROVAL_TIER2_CENTS, APPROVAL_TIER3_CENTS };

export class ApprovalPolicyError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ApprovalPolicyError';
    this.statusCode = statusCode;
  }
}

async function firstUserByRole(db, role, departmentId = null) {
  if (departmentId != null) {
    return await db.prepare(
      `SELECT id, role, name, department_id
       FROM users
       WHERE role = ? AND department_id = ?
       ORDER BY id ASC
       LIMIT 1`
    ).get(role, departmentId);
  }
  return await db.prepare(
    `SELECT id, role, name, department_id
     FROM users
     WHERE role = ?
     ORDER BY id ASC
     LIMIT 1`
  ).get(role);
}

/**
 * Step-1 department head: mapped departments.approver_user_id first,
 * then legacy first user with role=approver in that department.
 */
async function resolveDepartmentApprover(db, departmentId) {
  const deptId = Number(departmentId);
  const dept = await db.prepare(
    `SELECT id, code, name, approver_user_id FROM departments WHERE id = ?`
  ).get(deptId);

  if (dept?.approver_user_id != null) {
    const mapped = await db.prepare(
      `SELECT id, role, name, department_id FROM users WHERE id = ?`
    ).get(dept.approver_user_id);
    if (mapped) return mapped;
    throw new ApprovalPolicyError(
      `Cannot resolve department approver for department_id=${departmentId}: mapped user id=${dept.approver_user_id} not found`
    );
  }

  const approver = await firstUserByRole(db, 'approver', deptId);
  if (!approver) {
    throw new ApprovalPolicyError(
      `Cannot resolve department approver for department_id=${departmentId}. Assign a department head in Org Admin.`
    );
  }
  return approver;
}

async function resolveProcurement(db) {
  const user = await firstUserByRole(db, 'procurement');
  if (!user) {
    throw new ApprovalPolicyError('Cannot resolve a procurement approver (role=procurement)');
  }
  return user;
}

async function resolveExecutive(db) {
  const finance = await firstUserByRole(db, 'finance');
  if (finance) return finance;
  const admin = await firstUserByRole(db, 'admin');
  if (admin) return admin;
  throw new ApprovalPolicyError(
    'Cannot resolve an executive approver (role=finance or role=admin)'
  );
}

/**
 * Build ordered approval steps from amount (integer cents) and department.
 * Thresholds: > $1,000 (100000¢) adds procurement; > $10,000 (1000000¢) adds finance/admin.
 */
export async function buildApprovalSteps({ totalAmount, departmentId, db }) {
  const amount = Number(totalAmount) || 0;
  const deptId = Number(departmentId);
  const steps = [];

  const deptApprover = await resolveDepartmentApprover(db, deptId);
  steps.push({
    step_order: 1,
    approver_id: deptApprover.id,
    role: deptApprover.role
  });

  if (amount > APPROVAL_TIER2_CENTS) {
    const procurement = await resolveProcurement(db);
    steps.push({
      step_order: steps.length + 1,
      approver_id: procurement.id,
      role: procurement.role
    });
  }

  if (amount > APPROVAL_TIER3_CENTS) {
    const executive = await resolveExecutive(db);
    steps.push({
      step_order: steps.length + 1,
      approver_id: executive.id,
      role: executive.role
    });
  }

  return steps;
}

/** Insert planned steps: step 1 pending, later steps waiting. */
export async function insertApprovalChain(db, prId, totalAmount, departmentId) {
  const steps = await buildApprovalSteps({ totalAmount, departmentId, db });
  const insert = db.prepare(`
    INSERT INTO approval_requests (requisition_id, approver_id, step_order, status)
    VALUES (?, ?, ?, ?)
  `);
  for (const step of steps) {
    const status = step.step_order === 1 ? 'pending' : 'waiting';
    await insert.run(prId, step.approver_id, step.step_order, status);
  }
  return steps;
}
