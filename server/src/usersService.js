/**
 * Admin user maintenance: create / edit / soft-deactivate.
 * Passwords are hashed (bcrypt) in user_credentials — never returned on the API.
 */

import { requireIntegerCents } from './money.js';
import {
  MasterDataError,
  isUniqueConstraint,
  parsePositiveId,
  uniqueConflictMessage
} from './masterData.js';
import {
  USER_PUBLIC_COLUMNS,
  assertPasswordPolicy,
  hashPassword,
  loadPublicUser,
  verifyPassword
} from './auth.js';
import {
  passwordExceedsLoginLimit,
  assertPasswordAcceptable,
  deploymentForbidsDemoPassword,
  passwordIsDemoSeed
} from './demoCredentials.js';

export const USER_ROLES = ['requester', 'approver', 'procurement', 'finance', 'admin'];
export const USER_STATUSES = ['active', 'inactive'];

export class UsersError extends MasterDataError {
  constructor(message, statusCode = 400) {
    super(message, statusCode);
    this.name = 'UsersError';
  }
}

export function normalizeUserRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (!USER_ROLES.includes(role)) {
    throw new UsersError(
      `Invalid role "${value}". Must be one of: ${USER_ROLES.join(', ')}.`,
      400
    );
  }
  return role;
}

export function normalizeUserStatus(value) {
  if (value == null || value === '') return null;
  const status = String(value).trim().toLowerCase();
  if (!USER_STATUSES.includes(status)) {
    throw new UsersError(
      `Invalid user status "${value}". Must be one of: ${USER_STATUSES.join(', ')}.`,
      400
    );
  }
  return status;
}

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) throw new UsersError('Email is required', 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new UsersError('Email is invalid', 400);
  }
  return email;
}

function normalizeName(value) {
  const name = String(value || '').trim();
  if (!name) throw new UsersError('Name is required', 400);
  return name;
}

function normalizeTitle(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value == null || value === '') return null;
  return String(value).trim() || null;
}

function normalizeApprovalLimit(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const cents = requireIntegerCents(value, 'approval_limit');
  if (cents < 0) throw new UsersError('approval_limit must be >= 0 cents', 400);
  return cents;
}

async function assertDepartment(db, departmentId) {
  if (departmentId == null || departmentId === '') return null;
  const id = parsePositiveId(departmentId, 'department_id');
  const dept = await db.prepare(`SELECT id FROM departments WHERE id = ?`).get(id);
  if (!dept) throw new UsersError('Department not found', 404);
  return id;
}

export async function countUsers(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
  return Number(row?.n || 0);
}

export async function listUsers(db, { status } = {}) {
  const filter = status == null || status === '' ? 'all' : String(status).trim().toLowerCase();
  let sql = `
    SELECT ${USER_PUBLIC_COLUMNS}
    FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN user_credentials c ON c.user_id = u.id
    WHERE 1=1
  `;
  const params = [];
  if (filter && filter !== 'all') {
    const normalized = normalizeUserStatus(filter);
    sql += ` AND COALESCE(u.status, 'active') = ?`;
    params.push(normalized);
  }
  sql += ` ORDER BY CASE COALESCE(u.status, 'active') WHEN 'active' THEN 0 ELSE 1 END, u.id ASC`;
  return await db.prepare(sql).all(...params);
}

export async function loadUser(db, id) {
  const userId = parsePositiveId(id, 'user id');
  const user = await loadPublicUser(db, userId);
  if (!user) throw new UsersError('User not found', 404);
  return user;
}

async function countActiveAdmins(db, exceptUserId = null) {
  const row = exceptUserId
    ? await db.prepare(`
        SELECT COUNT(*) AS n FROM users
        WHERE role = 'admin' AND COALESCE(status, 'active') = 'active' AND id != ?
      `).get(exceptUserId)
    : await db.prepare(`
        SELECT COUNT(*) AS n FROM users
        WHERE role = 'admin' AND COALESCE(status, 'active') = 'active'
      `).get();
  return Number(row?.n || 0);
}

async function bumpSessionVersion(db, userId) {
  await db.prepare(`
    UPDATE users
    SET session_version = COALESCE(session_version, 1) + 1
    WHERE id = ?
  `).run(userId);
}

async function writePassword(db, userId, password, rounds, env = process.env) {
  assertPasswordAcceptable(password, env);
  const hash = await hashPassword(assertPasswordPolicy(password), rounds);
  const existing = await db.prepare(`SELECT user_id FROM user_credentials WHERE user_id = ?`).get(userId);
  if (existing) {
    await db.prepare(`
      UPDATE user_credentials
      SET password_hash = ?, password_updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(hash, userId);
  } else {
    await db.prepare(`
      INSERT INTO user_credentials (user_id, password_hash)
      VALUES (?, ?)
    `).run(userId, hash);
  }
}

export async function createUser(db, body = {}, { bcryptRounds = 10, env = process.env } = {}) {
  if (body.password) {
    assertPasswordPolicy(body.password);
    assertPasswordAcceptable(body.password, env);
  }
  const name = normalizeName(body.name);
  const email = normalizeEmail(body.email);
  const role = normalizeUserRole(body.role);
  const departmentId = await assertDepartment(db, body.department_id);
  const title = normalizeTitle(body.title);
  const approvalLimit = normalizeApprovalLimit(body.approval_limit, 0);
  const status = normalizeUserStatus(body.status) || 'active';
  const avatar = body.avatar ? String(body.avatar).trim() : null;

  let result;
  try {
    result = await db.prepare(`
      INSERT INTO users (name, email, role, department_id, title, approval_limit, avatar, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, email, role, departmentId, title, approvalLimit, avatar, status);
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new UsersError(uniqueConflictMessage(error, 'A user with that email already exists'), 409);
    }
    throw error;
  }

  let createdId = Number(result.lastInsertRowid);
  if (!createdId) {
    const lookup = await db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
    createdId = Number(lookup?.id || 0);
  }

  if (body.password) {
    await writePassword(db, createdId, body.password, bcryptRounds, env);
  }

  return loadUser(db, createdId);
}

export async function updateUser(db, id, body = {}, actor = null) {
  const current = await loadUser(db, id);
  const nextName = body.name !== undefined ? normalizeName(body.name) : current.name;
  const nextEmail = body.email !== undefined ? normalizeEmail(body.email) : current.email;
  const nextRole = body.role !== undefined ? normalizeUserRole(body.role) : current.role;
  const nextDepartmentId = body.department_id !== undefined
    ? await assertDepartment(db, body.department_id)
    : current.department_id;
  const nextTitle = body.title !== undefined ? normalizeTitle(body.title, current.title) : current.title;
  const nextLimit = body.approval_limit !== undefined
    ? normalizeApprovalLimit(body.approval_limit, current.approval_limit)
    : current.approval_limit;
  const nextAvatar = body.avatar !== undefined
    ? (body.avatar ? String(body.avatar).trim() : null)
    : current.avatar;
  const nextStatus = body.status !== undefined
    ? (normalizeUserStatus(body.status) || current.status)
    : current.status;

  if (nextRole !== 'admin' && current.role === 'admin' && current.status === 'active') {
    const others = await countActiveAdmins(db, current.id);
    if (others === 0) {
      throw new UsersError('Cannot remove admin role from the last active admin', 400);
    }
  }

  if (nextStatus === 'inactive' && current.status !== 'inactive') {
    await assertCanDeactivate(db, current, actor);
  }

  try {
    await db.prepare(`
      UPDATE users
      SET name = ?, email = ?, role = ?, department_id = ?, title = ?,
          approval_limit = ?, avatar = ?, status = ?
      WHERE id = ?
    `).run(
      nextName,
      nextEmail,
      nextRole,
      nextDepartmentId,
      nextTitle,
      nextLimit,
      nextAvatar,
      nextStatus,
      current.id
    );
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new UsersError(uniqueConflictMessage(error, 'A user with that email already exists'), 409);
    }
    throw error;
  }

  const roleChanged = nextRole !== current.role;
  const deactivated = nextStatus === 'inactive' && current.status !== 'inactive';
  if (roleChanged || deactivated) await bumpSessionVersion(db, current.id);

  return loadUser(db, current.id);
}

async function assertCanDeactivate(db, user, actor) {
  if (actor && Number(actor.id) === Number(user.id)) {
    throw new UsersError('You cannot deactivate your own account', 400);
  }
  if (user.role === 'admin' && user.status === 'active') {
    const others = await countActiveAdmins(db, user.id);
    if (others === 0) {
      throw new UsersError('Cannot deactivate the last active admin', 400);
    }
  }
}

export async function setUserStatus(db, id, status, actor = null) {
  const user = await loadUser(db, id);
  const next = normalizeUserStatus(status);
  if (!next) throw new UsersError('status is required', 400);
  if (next === 'inactive') {
    await assertCanDeactivate(db, user, actor);
  }
  const deactivated = next === 'inactive' && user.status !== 'inactive';
  await db.prepare(`UPDATE users SET status = ? WHERE id = ?`).run(next, user.id);
  if (deactivated) await bumpSessionVersion(db, user.id);
  return loadUser(db, user.id);
}

export async function setUserPassword(db, id, password, { bcryptRounds = 10, env = process.env } = {}) {
  const user = await loadUser(db, id);
  await writePassword(db, user.id, password, bcryptRounds, env);
  await bumpSessionVersion(db, user.id);
  return loadUser(db, user.id);
}

export async function changeOwnPassword(db, userId, currentPassword, newPassword, options = {}) {
  if (currentPassword == null || currentPassword === '' || newPassword == null || newPassword === '') {
    throw new UsersError('Current password and a new password are required', 400);
  }
  const presented = String(currentPassword);
  if (passwordExceedsLoginLimit(presented)) {
    throw new UsersError('Current password is incorrect', 400);
  }
  const row = await db.prepare(`SELECT password_hash FROM user_credentials WHERE user_id = ?`).get(userId);
  if (!row?.password_hash) throw new UsersError('Current password is incorrect', 400);
  const ok = await verifyPassword(presented, row.password_hash);
  if (!ok) throw new UsersError('Current password is incorrect', 400);
  return setUserPassword(db, userId, newPassword, options);
}

export async function bootstrapFirstAdmin(db, body = {}, { bcryptRounds = 10, env = process.env } = {}) {
  const existing = await countUsers(db);
  if (existing > 0) {
    throw new UsersError(
      'This tenant already has users. Sign in as an admin to create more.',
      409
    );
  }
  if (!body.password) {
    throw new UsersError('Password is required to create the first admin', 400);
  }
  return createUser(db, {
    name: body.name || 'Administrator',
    email: body.email,
    role: 'admin',
    department_id: body.department_id ?? null,
    title: body.title || 'Administrator',
    approval_limit: body.approval_limit ?? 0,
    password: body.password,
    status: 'active'
  }, { bcryptRounds, env });
}

export async function authenticateUser(db, email, password, { env = process.env } = {}) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || password == null || password === '') {
    throw new UsersError('Email and password are required', 400);
  }
  const presented = String(password);
  if (passwordExceedsLoginLimit(presented)) {
    throw new UsersError('Invalid email or password', 401);
  }
  if (deploymentForbidsDemoPassword(env) && passwordIsDemoSeed(presented)) {
    throw new UsersError('Invalid email or password', 401);
  }
  const row = await db.prepare(`
    SELECT u.id, COALESCE(u.status, 'active') AS status, c.password_hash
    FROM users u
    LEFT JOIN user_credentials c ON c.user_id = u.id
    WHERE lower(u.email) = ?
  `).get(normalized);

  const invalid = () => {
    const error = new UsersError('Invalid email or password', 401);
    return error;
  };
  if (!row || !row.password_hash) throw invalid();
  // Compare before the status check so an inactive account with the right
  // password takes the same time and returns the same 401 as a wrong password.
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok || row.status === 'inactive') {
    const error = invalid();
    if (ok && row.status === 'inactive') error.code = 'inactive';
    throw error;
  }
  return loadPublicUser(db, row.id);
}
