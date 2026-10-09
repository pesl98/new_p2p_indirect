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

function excludedIds(excludeUserIds) {
  return new Set(
    (excludeUserIds || [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
  );
}

async function firstEligibleUser(db, role, departmentId, exclude) {
  const blocked = [...exclude];
  let sql = `SELECT id, role, name, department_id FROM users WHERE role = ?`;
  const params = [role];
  if (departmentId != null) {
    sql += ` AND department_id = ?`;
    params.push(departmentId);
  }
  if (blocked.length) {
    sql += ` AND id NOT IN (${blocked.map(() => '?').join(', ')})`;
    params.push(...blocked);
  }
  sql += ` ORDER BY id ASC LIMIT 1`;
  return db.prepare(sql).get(...params);
}

async function escalateApprover(db, exclude) {
  for (const role of ['procurement', 'finance', 'admin']) {
    const user = await firstEligibleUser(db, role, null, exclude);
    if (user) return user;
  }
  return null;
}

function noAlternate() {
  const error = new ApprovalPolicyError(
    'No approver is left after segregation of duties.',
    422
  );
  error.code = 'sod_no_alternate_approver';
  return error;
}

/**
 * Department head, skipping excluded users. The next person with the same
 * role is tried first. If nobody with that role is left, the step escalates
 * procurement → finance → admin.
 */
async function resolveDepartmentApproverExcluding(db, departmentId, exclude) {
  const deptId = Number(departmentId);
  const dept = await db.prepare(
    `SELECT id, approver_user_id FROM departments WHERE id = ?`
  ).get(deptId);
  if (dept?.approver_user_id != null && !exclude.has(Number(dept.approver_user_id))) {
    const mapped = await db.prepare(
      `SELECT id, role, name, department_id FROM users WHERE id = ?`
    ).get(dept.approver_user_id);
    if (mapped) return mapped;
  }
  const inDepartment = await firstEligibleUser(db, 'approver', deptId, exclude);
  if (inDepartment) return inDepartment;
  const anyApprover = await firstEligibleUser(db, 'approver', null, exclude);
  if (anyApprover) return anyApprover;
  const escalated = await escalateApprover(db, exclude);
  if (!escalated) throw noAlternate();
  return escalated;
}

async function resolveRoleExcluding(db, role, exclude, ladder) {
  const direct = await firstEligibleUser(db, role, null, exclude);
  if (direct) return direct;
  for (const next of ladder) {
    const user = await firstEligibleUser(db, next, null, exclude);
    if (user) return user;
  }
  throw noAlternate();
}

/**
 * Build ordered approval steps from amount (integer cents) and department.
 * Thresholds: above 100000 cents (1,000) adds procurement; above 1000000 cents (10,000) adds finance/admin.
 * excludeUserIds is used for an award above the segregation threshold. With an
 * empty list the resolvers are unchanged.
 */
export async function buildApprovalSteps({ totalAmount, departmentId, db, excludeUserIds = [] }) {
  const amount = Number(totalAmount) || 0;
  const deptId = Number(departmentId);
  const exclude = excludedIds(excludeUserIds);
  const steps = [];

  const deptApprover = exclude.size
    ? await resolveDepartmentApproverExcluding(db, deptId, exclude)
    : await resolveDepartmentApprover(db, deptId);
  steps.push({
    step_order: 1,
    approver_id: deptApprover.id,
    role: deptApprover.role
  });

  if (amount > APPROVAL_TIER2_CENTS) {
    const procurement = exclude.size
      ? await resolveRoleExcluding(db, 'procurement', exclude, ['finance', 'admin'])
      : await resolveProcurement(db);
    steps.push({
      step_order: steps.length + 1,
      approver_id: procurement.id,
      role: procurement.role
    });
  }

  if (amount > APPROVAL_TIER3_CENTS) {
    const executive = exclude.size
      ? await resolveRoleExcluding(db, 'finance', exclude, ['admin'])
      : await resolveExecutive(db);
    steps.push({
      step_order: steps.length + 1,
      approver_id: executive.id,
      role: executive.role
    });
  }

  return steps;
}

/** Insert planned steps: step 1 pending, later steps waiting. */
export async function insertApprovalChain(db, prId, totalAmount, departmentId, options = {}) {
  const steps = await buildApprovalSteps({
    totalAmount,
    departmentId,
    db,
    excludeUserIds: options.excludeUserIds || []
  });
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
