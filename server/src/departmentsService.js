/**
 * Org-admin maintenance for department step-1 approvers.
 * Persona auth is client-only (same as master-data). APIs are demo-open.
 */

import { parsePositiveId } from './masterData.js';

export const ELIGIBLE_APPROVER_ROLES = ['approver', 'admin', 'finance', 'procurement'];

export class DepartmentAdminError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'DepartmentAdminError';
    this.statusCode = statusCode;
  }
}

const DEPARTMENT_SELECT = `
  SELECT
    d.id,
    d.code,
    d.name,
    d.approver_user_id,
    au.name AS approver_name,
    au.role AS approver_role,
    au.title AS approver_title,
    au.email AS approver_email,
    b.total_budget,
    b.committed_amount,
    b.actual_spent,
    (b.total_budget - b.committed_amount - b.actual_spent) AS remaining_budget
  FROM departments d
  LEFT JOIN users au ON au.id = d.approver_user_id
  LEFT JOIN budgets b ON d.id = b.department_id AND b.fiscal_year = 2026
`;

export async function listDepartments(db) {
  return db.prepare(`${DEPARTMENT_SELECT} ORDER BY d.id ASC`).all();
}

export async function loadDepartment(db, id) {
  const departmentId = parsePositiveId(id, 'department id');
  const row = await db.prepare(`${DEPARTMENT_SELECT} WHERE d.id = ?`).get(departmentId);
  if (!row) {
    throw new DepartmentAdminError('Department not found', 404);
  }
  return row;
}

export async function listEligibleApprovers(db) {
  const placeholders = ELIGIBLE_APPROVER_ROLES.map(() => '?').join(', ');
  return db.prepare(`
    SELECT
      u.id,
      u.name,
      u.email,
      u.role,
      u.title,
      u.department_id,
      u.approval_limit,
      d.name AS department_name,
      d.code AS department_code
    FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    WHERE u.role IN (${placeholders})
    ORDER BY CASE u.role
      WHEN 'approver' THEN 0
      WHEN 'admin' THEN 1
      WHEN 'finance' THEN 2
      ELSE 3
    END, u.name ASC
  `).all(...ELIGIBLE_APPROVER_ROLES);
}

function parseApproverUserId(value) {
  if (value == null || value === '' || value === 'null') return null;
  return parsePositiveId(value, 'approver_user_id');
}

function actorName(value) {
  const name = value == null ? '' : String(value).trim();
  return name || 'Administrator';
}

export async function setDepartmentApprover(db, departmentId, payload = {}) {
  const id = parsePositiveId(departmentId, 'department id');
  const current = await db.prepare(
    `SELECT id, code, name, approver_user_id FROM departments WHERE id = ?`
  ).get(id);
  if (!current) {
    throw new DepartmentAdminError('Department not found', 404);
  }

  if (!Object.prototype.hasOwnProperty.call(payload, 'approver_user_id')) {
    throw new DepartmentAdminError('approver_user_id is required', 400);
  }

  const nextId = parseApproverUserId(payload.approver_user_id);
  let nextUser = null;
  if (nextId != null) {
    nextUser = await db.prepare(
      `SELECT id, name, role, title, email FROM users WHERE id = ?`
    ).get(nextId);
    if (!nextUser) {
      throw new DepartmentAdminError('Approver user not found', 404);
    }
  }

  const previousId = current.approver_user_id == null ? null : Number(current.approver_user_id);
  const changed = previousId !== nextId;
  const actor = actorName(payload.actor_name);

  if (changed) {
    await db.prepare(
      `UPDATE departments SET approver_user_id = ? WHERE id = ?`
    ).run(nextId, id);

    const previous = previousId == null
      ? await Promise.resolve(null)
      : await db.prepare(`SELECT id, name FROM users WHERE id = ?`).get(previousId);

    const action = nextId == null ? 'APPROVER_CLEARED' : 'APPROVER_ASSIGNED';
    const fromLabel = previous
      ? `${previous.name} (id=${previous.id})`
      : 'unassigned';
    const toLabel = nextUser
      ? `${nextUser.name} (id=${nextUser.id}, role=${nextUser.role})`
      : 'unassigned (legacy role=approver lookup)';
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('department', ?, ?, ?, ?)
    `).run(
      id,
      action,
      actor,
      `${current.code} ${current.name}: step-1 approver ${fromLabel} → ${toLabel}`
    );
  }

  return loadDepartment(db, id);
}
