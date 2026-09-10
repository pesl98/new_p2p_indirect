/**
 * Approval delegation / out-of-office substitute approver.
 * Resolve at list/decide time — do not rewrite approval_requests.approver_id.
 * Persona auth is client-only (same as master-data). APIs are demo-open.
 */

import { parsePositiveId } from './masterData.js';

export class DelegationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'DelegationError';
    this.statusCode = statusCode;
  }
}

const DELEGATION_SELECT = `
  SELECT
    ad.id,
    ad.delegator_user_id,
    ad.delegate_user_id,
    ad.starts_at,
    ad.ends_at,
    ad.active,
    ad.reason,
    ad.created_by_user_id,
    ad.created_by_name,
    ad.created_at,
    ad.revoked_at,
    ad.revoked_by_user_id,
    ad.revoked_by_name,
    delegator.name AS delegator_name,
    delegator.role AS delegator_role,
    delegator.title AS delegator_title,
    delegate.name AS delegate_name,
    delegate.role AS delegate_role,
    delegate.title AS delegate_title
  FROM approval_delegations ad
  JOIN users delegator ON delegator.id = ad.delegator_user_id
  JOIN users delegate ON delegate.id = ad.delegate_user_id
`;

function actorName(value, fallback = 'Administrator') {
  const name = value == null ? '' : String(value).trim();
  return name || fallback;
}

function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

/**
 * Normalize optional window timestamps to ISO-8601 so SQLite and Turso
 * can compare them lexicographically against Date.toISOString().
 * Date-only YYYY-MM-DD becomes start-of-day (or end-of-day) UTC.
 */
export function normalizeOptionalTimestamp(value, { endOfDay = false } = {}) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return endOfDay ? `${raw}T23:59:59.999Z` : `${raw}T00:00:00.000Z`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new DelegationError(`Invalid timestamp "${value}"`, 400);
  }
  return parsed.toISOString();
}

export function isDelegationCoveringAt(row, atIso = new Date().toISOString()) {
  if (!row || Number(row.active) !== 1) return false;
  if (row.starts_at && String(row.starts_at) > atIso) return false;
  if (row.ends_at && String(row.ends_at) < atIso) return false;
  return true;
}

function decorateDelegation(row, atIso = new Date().toISOString()) {
  if (!row) return row;
  return {
    ...row,
    active: Number(row.active) === 1 ? 1 : 0,
    covering_now: isDelegationCoveringAt(row, atIso) ? 1 : 0
  };
}

export async function loadDelegation(db, id) {
  const delegationId = parsePositiveId(id, 'delegation id');
  const row = await db.prepare(`${DELEGATION_SELECT} WHERE ad.id = ?`).get(delegationId);
  if (!row) {
    throw new DelegationError('Delegation not found', 404);
  }
  return decorateDelegation(row);
}

export async function listDelegations(db, filters = {}) {
  const clauses = [];
  const params = [];

  if (filters.user_id != null && filters.user_id !== '') {
    const userId = parsePositiveId(filters.user_id, 'user_id');
    clauses.push('(ad.delegator_user_id = ? OR ad.delegate_user_id = ?)');
    params.push(userId, userId);
  }
  if (filters.delegator_user_id != null && filters.delegator_user_id !== '') {
    clauses.push('ad.delegator_user_id = ?');
    params.push(parsePositiveId(filters.delegator_user_id, 'delegator_user_id'));
  }
  if (filters.delegate_user_id != null && filters.delegate_user_id !== '') {
    clauses.push('ad.delegate_user_id = ?');
    params.push(parsePositiveId(filters.delegate_user_id, 'delegate_user_id'));
  }
  if (filters.active != null && filters.active !== '') {
    const active = filters.active === true || filters.active === 1 || filters.active === '1' || filters.active === 'true'
      ? 1
      : 0;
    clauses.push('ad.active = ?');
    params.push(active);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.prepare(`
    ${DELEGATION_SELECT}
    ${where}
    ORDER BY ad.active DESC, ad.id DESC
  `).all(...params);
  const atIso = new Date().toISOString();
  return rows.map((row) => decorateDelegation(row, atIso));
}

/**
 * Active (flag + window) delegation from delegator → delegate covering `at`.
 * Direct only — no transitive chains.
 */
export async function findActiveDelegation(db, delegatorUserId, delegateUserId, atIso = new Date().toISOString()) {
  const delegatorId = Number(delegatorUserId);
  const delegateId = Number(delegateUserId);
  if (!Number.isFinite(delegatorId) || !Number.isFinite(delegateId)) return null;
  const row = await db.prepare(`
    ${DELEGATION_SELECT}
    WHERE ad.delegator_user_id = ?
      AND ad.delegate_user_id = ?
      AND ad.active = 1
      AND (ad.starts_at IS NULL OR ad.starts_at <= ?)
      AND (ad.ends_at IS NULL OR ad.ends_at >= ?)
    ORDER BY ad.id DESC
    LIMIT 1
  `).get(delegatorId, delegateId, atIso, atIso);
  return row ? decorateDelegation(row, atIso) : null;
}

/**
 * Who may decide a pending step: the mapped approver, or an active delegate.
 */
export async function resolveDecisionActor(db, stepApproverId, actorId) {
  if (actorId == null || actorId === '') {
    throw new DelegationError('approver_id is required', 400);
  }
  if (Number(actorId) === Number(stepApproverId)) {
    return { authorized: true, viaDelegation: false, delegation: null };
  }
  const delegation = await findActiveDelegation(db, stepApproverId, actorId);
  if (delegation) {
    return { authorized: true, viaDelegation: true, delegation };
  }
  return { authorized: false, viaDelegation: false, delegation: null };
}

export async function createDelegation(db, payload = {}) {
  const delegatorId = parsePositiveId(payload.delegator_user_id, 'delegator_user_id');
  const delegateId = parsePositiveId(payload.delegate_user_id, 'delegate_user_id');
  if (delegatorId === delegateId) {
    throw new DelegationError('Cannot delegate to yourself', 400);
  }

  const delegator = await db.prepare(`SELECT id, name, role, title FROM users WHERE id = ?`).get(delegatorId);
  if (!delegator) {
    throw new DelegationError('Delegator user not found', 404);
  }
  const delegate = await db.prepare(`SELECT id, name, role, title FROM users WHERE id = ?`).get(delegateId);
  if (!delegate) {
    throw new DelegationError('Delegate user not found', 404);
  }

  const startsAt = normalizeOptionalTimestamp(payload.starts_at, { endOfDay: false });
  const endsAt = normalizeOptionalTimestamp(payload.ends_at, { endOfDay: true });
  if (startsAt && endsAt && startsAt > endsAt) {
    throw new DelegationError('starts_at must be before ends_at', 400);
  }

  const reason = optionalText(payload.reason);
  const actor = actorName(payload.actor_name || payload.created_by_name, delegator.name);
  let createdByUserId = null;
  if (payload.created_by_user_id != null && payload.created_by_user_id !== '') {
    createdByUserId = parsePositiveId(payload.created_by_user_id, 'created_by_user_id');
    const creator = await db.prepare(`SELECT id FROM users WHERE id = ?`).get(createdByUserId);
    if (!creator) {
      throw new DelegationError('created_by user not found', 404);
    }
  } else if (payload.actor_user_id != null && payload.actor_user_id !== '') {
    createdByUserId = parsePositiveId(payload.actor_user_id, 'actor_user_id');
  }

  const result = await db.prepare(`
    INSERT INTO approval_delegations (
      delegator_user_id, delegate_user_id, starts_at, ends_at, active, reason,
      created_by_user_id, created_by_name
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `).run(delegatorId, delegateId, startsAt, endsAt, reason, createdByUserId, actor);

  const id = Number(result.lastInsertRowid);
  const windowLabel = startsAt || endsAt
    ? `Window ${startsAt || 'open'} → ${endsAt || 'open-ended'}.`
    : 'Open-ended while active.';
  const reasonLabel = reason ? ` Reason: ${reason}` : '';
  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES ('approval_delegation', ?, 'DELEGATION_CREATED', ?, ?)
  `).run(
    id,
    actor,
    `${delegator.name} (id=${delegator.id}) → ${delegate.name} (id=${delegate.id}). ${windowLabel}${reasonLabel}`
  );

  return loadDelegation(db, id);
}

export async function revokeDelegation(db, id, payload = {}) {
  const current = await loadDelegation(db, id);
  if (Number(current.active) !== 1) {
    throw new DelegationError('Delegation is not active', 400);
  }

  const actor = actorName(payload.actor_name || payload.revoked_by_name, 'Administrator');
  let revokedByUserId = null;
  if (payload.revoked_by_user_id != null && payload.revoked_by_user_id !== '') {
    revokedByUserId = parsePositiveId(payload.revoked_by_user_id, 'revoked_by_user_id');
  } else if (payload.actor_user_id != null && payload.actor_user_id !== '') {
    revokedByUserId = parsePositiveId(payload.actor_user_id, 'actor_user_id');
  }

  await db.prepare(`
    UPDATE approval_delegations
    SET active = 0,
        revoked_at = CURRENT_TIMESTAMP,
        revoked_by_user_id = ?,
        revoked_by_name = ?
    WHERE id = ?
  `).run(revokedByUserId, actor, current.id);

  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES ('approval_delegation', ?, 'DELEGATION_REVOKED', ?, ?)
  `).run(
    current.id,
    actor,
    `Revoked ${current.delegator_name} (id=${current.delegator_user_id}) → ${current.delegate_name} (id=${current.delegate_user_id}).`
  );

  return loadDelegation(db, current.id);
}
