import { APPROVAL_TIER2_CENTS, APPROVAL_TIER3_CENTS } from './money.js';

export { APPROVAL_TIER2_CENTS, APPROVAL_TIER3_CENTS };

export class ApprovalPolicyError extends Error {
  constructor(message, statusCode = 400, code) {
    super(message);
    this.name = 'ApprovalPolicyError';
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

/** Roles a step can escalate to when every user at its own tier is excluded. */
const ESCALATION_LADDER = ['approver', 'procurement', 'finance', 'admin'];

async function firstAllowedUser(db, role, excluded, departmentId = null) {
  const params = [role];
  let sql = `SELECT id, role, name, department_id FROM users
    WHERE role = ? AND COALESCE(status, 'active') = 'active'`;
  if (departmentId != null) {
    sql += ' AND department_id = ?';
    params.push(departmentId);
  }
  if (excluded.size) {
    sql += ` AND id NOT IN (${[...excluded].map(() => '?').join(', ')})`;
    params.push(...excluded);
  }
  sql += ' ORDER BY id ASC LIMIT 1';
  return db.prepare(sql).get(...params);
}

/**
 * Keep `user` unless excluded. Otherwise take the next user with the same
 * role, then escalate up the ladder (procurement -> finance -> admin).
 * Fails closed with 422 sod_no_alternate_approver when nobody is left.
 */
async function resolveAllowed(db, user, excluded, departmentId, { departmentStep = false } = {}) {
  if (!excluded.size || !excluded.has(Number(user.id))) return user;
  const sameRole = await firstAllowedUser(db, user.role, excluded, user.role === 'approver' ? departmentId : null);
  if (sameRole) return sameRole;
  if (departmentStep) {
    // A department head who is not role=approver (an admin mapped as head) falls back
    // to the department's approvers first, then up the ladder.
    const approver = await firstAllowedUser(db, 'approver', excluded, departmentId);
    if (approver) return approver;
  }
  const start = departmentStep ? 1 : Math.max(0, ESCALATION_LADDER.indexOf(user.role)) + 1;
  for (const role of ESCALATION_LADDER.slice(start)) {
    const next = await firstAllowedUser(db, role, excluded);
    if (next) return next;
  }
  throw new ApprovalPolicyError(
    'No eligible approver is left after segregation-of-duties exclusions.',
    422,
    'sod_no_alternate_approver'
  );
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
 * Thresholds: above 100000 cents (1,000) adds procurement; above 1000000 cents (10,000) adds finance/admin.
 */
export async function buildApprovalSteps({ totalAmount, departmentId, db, excludeUserIds = [] }) {
  const amount = Number(totalAmount) || 0;
  const deptId = Number(departmentId);
  const steps = [];
  const excluded = new Set((excludeUserIds || []).map(Number).filter(Number.isInteger));

  const deptApprover = await resolveAllowed(db, await resolveDepartmentApprover(db, deptId), excluded, deptId, { departmentStep: true });
  steps.push({
    step_order: 1,
    approver_id: deptApprover.id,
    role: deptApprover.role
  });

  if (amount > APPROVAL_TIER2_CENTS) {
    const procurement = await resolveAllowed(db, await resolveProcurement(db), excluded, deptId);
    steps.push({
      step_order: steps.length + 1,
      approver_id: procurement.id,
      role: procurement.role
    });
  }

  if (amount > APPROVAL_TIER3_CENTS) {
    const executive = await resolveAllowed(db, await resolveExecutive(db), excluded, deptId);
    steps.push({
      step_order: steps.length + 1,
      approver_id: executive.id,
      role: executive.role
    });
  }

  return steps;
}

/** Insert planned steps: step 1 pending, later steps waiting. */
export async function insertApprovalChain(db, prId, totalAmount, departmentId, { excludeUserIds = [] } = {}) {
  const steps = await buildApprovalSteps({ totalAmount, departmentId, db, excludeUserIds });
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
