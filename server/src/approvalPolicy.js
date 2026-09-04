import { APPROVAL_TIER2_CENTS, APPROVAL_TIER3_CENTS } from './money.js';

export { APPROVAL_TIER2_CENTS, APPROVAL_TIER3_CENTS };

export class ApprovalPolicyError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ApprovalPolicyError';
    this.statusCode = statusCode;
  }
}

function firstUserByRole(db, role, departmentId = null) {
  if (departmentId != null) {
    return db.prepare(
      `SELECT id, role, name, department_id
       FROM users
       WHERE role = ? AND department_id = ?
       ORDER BY id ASC
       LIMIT 1`
    ).get(role, departmentId);
  }
  return db.prepare(
    `SELECT id, role, name, department_id
     FROM users
     WHERE role = ?
     ORDER BY id ASC
     LIMIT 1`
  ).get(role);
}

function resolveDepartmentApprover(db, departmentId) {
  const approver = firstUserByRole(db, 'approver', departmentId);
  if (!approver) {
    throw new ApprovalPolicyError(
      `Cannot resolve department approver for department_id=${departmentId}`
    );
  }
  return approver;
}

function resolveProcurement(db) {
  const user = firstUserByRole(db, 'procurement');
  if (!user) {
    throw new ApprovalPolicyError('Cannot resolve a procurement approver (role=procurement)');
  }
  return user;
}

function resolveExecutive(db) {
  const finance = firstUserByRole(db, 'finance');
  if (finance) return finance;
  const admin = firstUserByRole(db, 'admin');
  if (admin) return admin;
  throw new ApprovalPolicyError(
    'Cannot resolve an executive approver (role=finance or role=admin)'
  );
}

/**
 * Build ordered approval steps from amount (integer cents) and department.
 * Thresholds: > $1,000 (100000¢) adds procurement; > $10,000 (1000000¢) adds finance/admin.
 */
export function buildApprovalSteps({ totalAmount, departmentId, db }) {
  const amount = Number(totalAmount) || 0;
  const deptId = Number(departmentId);
  const steps = [];

  const deptApprover = resolveDepartmentApprover(db, deptId);
  steps.push({
    step_order: 1,
    approver_id: deptApprover.id,
    role: deptApprover.role
  });

  if (amount > APPROVAL_TIER2_CENTS) {
    const procurement = resolveProcurement(db);
    steps.push({
      step_order: steps.length + 1,
      approver_id: procurement.id,
      role: procurement.role
    });
  }

  if (amount > APPROVAL_TIER3_CENTS) {
    const executive = resolveExecutive(db);
    steps.push({
      step_order: steps.length + 1,
      approver_id: executive.id,
      role: executive.role
    });
  }

  return steps;
}

/** Insert planned steps: step 1 pending, later steps waiting. */
export function insertApprovalChain(db, prId, totalAmount, departmentId) {
  const steps = buildApprovalSteps({ totalAmount, departmentId, db });
  const insert = db.prepare(`
    INSERT INTO approval_requests (requisition_id, approver_id, step_order, status)
    VALUES (?, ?, ?, ?)
  `);
  for (const step of steps) {
    const status = step.step_order === 1 ? 'pending' : 'waiting';
    insert.run(prId, step.approver_id, step.step_order, status);
  }
  return steps;
}
