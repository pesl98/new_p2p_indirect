/**
 * Append-only compliance ledger for events audit_logs and the SSO tables
 * do not already store.
 *
 * Hash chain: each row stores prev_hash and row_hash. prev_hash is the
 * literal GENESIS on the first row, otherwise the previous row's row_hash.
 * row_hash is SHA-256 (hex) of `${prevHash}\n${canonicalJson}`. The database
 * trigger rejects a broken link, a missing hash, and any UPDATE or DELETE.
 * The verification report recomputes the digest. SQLite and Turso HTTP do
 * not share a SHA-256 function, so the digest is computed here.
 *
 * Actor fields come from the session user the caller passes. This module
 * does not read a request body.
 */

import { createHash } from 'node:crypto';

export const GENESIS_HASH = 'GENESIS';

export class ComplianceAuditError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'ComplianceAuditError';
    this.statusCode = statusCode;
  }
}

export function utcTimestamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function actorFromSession(user) {
  if (!user || user.id == null) {
    throw new ComplianceAuditError('A signed-in user is required to write this audit event', 401);
  }
  const name = String(user.name || user.email || '').trim();
  if (!name) {
    throw new ComplianceAuditError('The signed-in user has no name to stamp on the audit event', 500);
  }
  return {
    actor_user_id: Number(user.id),
    actor_name: name,
    actor_role: user.role || null
  };
}

export function canonicalCompliancePayload(event) {
  return JSON.stringify({
    action: event.action,
    actor_user_id: event.actor_user_id == null ? null : Number(event.actor_user_id),
    actor_name: event.actor_name,
    actor_role: event.actor_role ?? null,
    entity_type: event.entity_type,
    entity_id: event.entity_id == null || event.entity_id === '' ? null : Number(event.entity_id),
    details: event.details ?? null,
    created_at: event.created_at
  });
}

export function complianceRowHash(prevHash, canonical) {
  return createHash('sha256').update(`${prevHash}\n${canonical}`).digest('hex');
}

export async function appendComplianceEvent(db, input) {
  const actorName = String(input.actor_name || '').trim();
  if (!actorName) throw new ComplianceAuditError('compliance event requires actor_name');
  if (!input.action || !input.entity_type) {
    throw new ComplianceAuditError('compliance event requires action and entity_type');
  }

  const writeOnce = async () => {
    const prev = await db.prepare(
      `SELECT row_hash FROM compliance_audit_events ORDER BY id DESC LIMIT 1`
    ).get();
    const prevHash = prev?.row_hash || GENESIS_HASH;
    const createdAt = input.created_at || utcTimestamp();
    const event = {
      action: String(input.action),
      actor_user_id: input.actor_user_id == null || input.actor_user_id === ''
        ? null
        : Number(input.actor_user_id),
      actor_name: actorName,
      actor_role: input.actor_role || null,
      entity_type: String(input.entity_type),
      entity_id: input.entity_id == null || input.entity_id === '' ? null : Number(input.entity_id),
      details: input.details == null ? null : String(input.details),
      created_at: createdAt
    };
    const rowHash = complianceRowHash(prevHash, canonicalCompliancePayload(event));
    const result = await db.prepare(`
      INSERT INTO compliance_audit_events (
        created_at, action, actor_user_id, actor_name, actor_role,
        entity_type, entity_id, details, prev_hash, row_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.created_at,
      event.action,
      event.actor_user_id,
      event.actor_name,
      event.actor_role,
      event.entity_type,
      event.entity_id,
      event.details,
      prevHash,
      rowHash
    );
    return {
      id: Number(result.lastInsertRowid),
      ...event,
      prev_hash: prevHash,
      row_hash: rowHash
    };
  };

  try {
    return await writeOnce();
  } catch (error) {
    if (/prev_hash mismatch/i.test(String(error?.message || ''))) {
      return writeOnce();
    }
    throw error;
  }
}

export async function recordLocalLoginSuccess(db, user) {
  return appendComplianceEvent(db, {
    ...actorFromSession(user),
    action: 'LOCAL_LOGIN_SUCCESS',
    entity_type: 'user',
    entity_id: user.id,
    details: 'password'
  });
}

export async function recordLocalLoginFailure(db, email, error) {
  const normalized = String(email || '').trim().toLowerCase();
  let matched = null;
  if (normalized) {
    matched = await db.prepare(
      `SELECT id FROM users WHERE lower(email) = ?`
    ).get(normalized);
  }
  const inactive = error?.statusCode === 403;
  return appendComplianceEvent(db, {
    actor_user_id: matched?.id ?? null,
    actor_name: normalized || 'unknown',
    actor_role: null,
    action: inactive ? 'LOCAL_LOGIN_INACTIVE' : 'LOCAL_LOGIN_FAILURE',
    entity_type: 'user',
    entity_id: matched?.id ?? null,
    details: inactive ? 'inactive' : 'invalid_credentials'
  });
}

export async function recordLogout(db, user) {
  return appendComplianceEvent(db, {
    ...actorFromSession(user),
    action: 'LOGOUT',
    entity_type: 'user',
    entity_id: user.id,
    details: null
  });
}

export async function recordBootstrapAdmin(db, user) {
  return appendComplianceEvent(db, {
    ...actorFromSession(user),
    action: 'BOOTSTRAP_ADMIN',
    entity_type: 'user',
    entity_id: user.id,
    details: 'first_admin'
  });
}

export async function recordUserChange(db, actor, { action, user, details }) {
  return appendComplianceEvent(db, {
    ...actorFromSession(actor),
    action,
    entity_type: 'user',
    entity_id: user.id,
    details: details == null ? null : JSON.stringify(details)
  });
}

export async function recordSsoSettingsChange(db, actor, saved) {
  return appendComplianceEvent(db, {
    ...actorFromSession(actor),
    action: 'SSO_SETTINGS_UPDATED',
    entity_type: 'tenant_settings',
    entity_id: 1,
    details: JSON.stringify({
      provisioning: Number(saved.sso_provisioning) === 1,
      defaultRole: saved.sso_default_role
    })
  });
}

export async function recordSsoProvisionedUser(db, user, provider) {
  return appendComplianceEvent(db, {
    ...actorFromSession(user),
    action: 'USER_CREATED',
    entity_type: 'user',
    entity_id: user.id,
    details: JSON.stringify({
      source: 'sso_provisioning',
      provider,
      role: user.role,
      email: user.email
    })
  });
}

export async function recordComplianceExport(db, actor, { report, filters }) {
  return appendComplianceEvent(db, {
    ...actorFromSession(actor),
    action: 'COMPLIANCE_EXPORT',
    entity_type: 'compliance_report',
    entity_id: null,
    details: JSON.stringify({
      report,
      format: 'csv',
      filters: filters || null
    })
  });
}
