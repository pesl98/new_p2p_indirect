/**
 * Map a verified IdP identity onto a local user and record the attempt.
 *
 * The IdP subject is stored in user_identities. Email match requires a
 * verified address (OIDC email_verified, or a signed SAML assertion).
 * Unknown users are rejected unless provisioning is explicitly enabled.
 * The role always comes from tenant_settings / SSO_DEFAULT_ROLE, never
 * from a token claim or the request body.
 *
 * sso_login_events and sso_assertion_uses are append-only. This is login
 * evidence, not the Sprint 3 audit report.
 */

import { loadPublicUser } from './auth.js';
import { isUniqueConstraint } from './masterData.js';
import { createUser, normalizeEmail, normalizeUserRole, USER_ROLES } from './usersService.js';

export const SSO_REQUEST_TTL_SECONDS = 10 * 60;

const MESSAGES = {
  sso_not_configured: 'SSO is not configured for this customer.',
  sso_state_invalid: 'SSO sign-in state was rejected.',
  sso_nonce_invalid: 'SSO sign-in nonce was rejected.',
  sso_signature_invalid: 'SSO signature was rejected.',
  sso_audience_invalid: 'SSO audience was rejected.',
  sso_expired: 'SSO sign-in has expired.',
  sso_token_invalid: 'SSO sign-in was rejected.',
  sso_pkce_invalid: 'SSO PKCE check was rejected.',
  sso_user_unknown: 'No ProcureFlow user is mapped to this identity.',
  sso_user_inactive: 'This account is inactive.',
  sso_replay: 'This SSO sign-in was already used.',
  sso_recipient_invalid: 'SAML recipient was rejected.',
  sso_email_unverified: 'The identity provider did not confirm the email.',
  sso_provisioning_misconfigured: 'SSO provisioning is misconfigured.',
  sso_idp_unavailable: 'The identity provider could not be reached.',
  sso_identity_conflict: 'This identity is already linked to another user.',
  sso_failed: 'SSO sign-in failed.'
};

export class SsoError extends Error {
  constructor(code, statusCode = 401) {
    super(MESSAGES[code] || MESSAGES.sso_token_invalid);
    this.name = 'SsoError';
    this.code = MESSAGES[code] ? code : 'sso_token_invalid';
    this.statusCode = statusCode;
  }
}

export function classifyProviderError(error) {
  if (error instanceof SsoError) return error;
  const blob = [
    error?.message,
    error?.error,
    error?.error_description,
    error?.cause?.message,
    error?.cause?.error,
    error?.cause?.error_description
  ].filter(Boolean).join(' ');
  const code = classifyMessage(blob);
  const status = code === 'sso_idp_unavailable' ? 503 : 401;
  const wrapped = new SsoError(code, status);
  wrapped.cause = error;
  return wrapped;
}

function classifyMessage(blob) {
  const text = String(blob || '');
  if (/signature/i.test(text)) return 'sso_signature_invalid';
  if (/nonce/i.test(text)) return 'sso_nonce_invalid';
  if (/audience|\baud\b/i.test(text)) return 'sso_audience_invalid';
  // Match the PKCE failure itself. A token-endpoint body always carries
  // code_verifier, and invalid_grant is used for many IdP errors.
  if (/\bPKCE\b/i.test(text)) return 'sso_pkce_invalid';
  if (/InResponseTo|\bstate\b/i.test(text)) return 'sso_state_invalid';
  if (/expir|NotOnOrAfter|not yet valid|subject confirmation|clocks skewed|too old|timestamp/i.test(text)) {
    return 'sso_expired';
  }
  if (/recipient/i.test(text)) return 'sso_recipient_invalid';
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(text)) return 'sso_idp_unavailable';
  return 'sso_token_invalid';
}

export async function ensureTenantSettings(db) {
  let row = await db.prepare(`SELECT id, sso_provisioning, sso_default_role FROM tenant_settings WHERE id = 1`).get();
  if (!row) {
    await db.prepare(
      `INSERT INTO tenant_settings (id, sso_provisioning, sso_default_role) VALUES (1, 0, 'requester')`
    ).run();
    row = await db.prepare(`SELECT id, sso_provisioning, sso_default_role FROM tenant_settings WHERE id = 1`).get();
  }
  return row;
}

export async function getSsoPolicy(db, ssoConfig) {
  const row = await ensureTenantSettings(db);
  const fromDb = Number(row.sso_provisioning) === 1;
  const fromEnv = ssoConfig?.provisioningEnabled === true;
  let defaultRole = row.sso_default_role || 'requester';
  let roleInvalid = false;
  if (ssoConfig?.defaultRole) {
    if (!USER_ROLES.includes(ssoConfig.defaultRole)) {
      roleInvalid = true;
      defaultRole = null;
    } else {
      defaultRole = ssoConfig.defaultRole;
    }
  } else if (ssoConfig?.defaultRoleInvalid) {
    roleInvalid = true;
    defaultRole = null;
  }
  return {
    provisioning: (fromEnv || fromDb) && !roleInvalid,
    fromEnv,
    fromDb,
    defaultRole,
    roleInvalid: roleInvalid || Boolean(ssoConfig?.defaultRoleInvalid),
    settingsRole: row.sso_default_role,
    settingsProvisioning: fromDb
  };
}

export async function updateSsoSettings(db, body = {}) {
  const current = await ensureTenantSettings(db);
  let provisioning = Number(current.sso_provisioning) === 1;
  if (body.sso_provisioning !== undefined) {
    const flag = body.sso_provisioning;
    if (flag === true || flag === 1 || flag === '1') provisioning = true;
    else if (flag === false || flag === 0 || flag === '0') provisioning = false;
    else {
      const error = new SsoError('sso_provisioning_misconfigured', 400);
      error.message = 'sso_provisioning must be true or false.';
      throw error;
    }
  }
  let role = current.sso_default_role;
  if (body.sso_default_role !== undefined) {
    role = normalizeUserRole(body.sso_default_role);
  }
  await db.prepare(
    `UPDATE tenant_settings SET sso_provisioning = ?, sso_default_role = ? WHERE id = 1`
  ).run(provisioning ? 1 : 0, role);
  return ensureTenantSettings(db);
}

export async function saveSsoRequest(db, { id, provider, payload, ttlSeconds = SSO_REQUEST_TTL_SECONDS }) {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`DELETE FROM sso_requests WHERE expires_at < ?`).run(now);
  await db.prepare(
    `INSERT INTO sso_requests (id, provider, payload, expires_at) VALUES (?, ?, ?, ?)`
  ).run(id, provider, String(payload), now + ttlSeconds);
}

export async function consumeSsoRequest(db, id, provider, now = Date.now()) {
  if (!id || !provider) return null;
  return db.transaction(async () => {
    const row = await db.prepare(
      `SELECT id, provider, payload, expires_at FROM sso_requests WHERE id = ? AND provider = ?`
    ).get(id, provider);
    if (!row) return null;
    await db.prepare(`DELETE FROM sso_requests WHERE id = ?`).run(id);
    if (Number(row.expires_at) < Math.floor(now / 1000)) return null;
    return row;
  });
}

export function samlRequestCache(db) {
  return {
    async saveAsync(key, value) {
      await saveSsoRequest(db, { id: key, provider: 'saml', payload: String(value) });
      return { value: String(value), createdAt: Date.now() };
    },
    async getAsync(key) {
      if (!key) return null;
      const row = await db.prepare(
        `SELECT payload, expires_at FROM sso_requests WHERE id = ? AND provider = 'saml'`
      ).get(key);
      if (!row) return null;
      if (Number(row.expires_at) < Math.floor(Date.now() / 1000)) return null;
      return String(row.payload);
    },
    async removeAsync(key) {
      if (!key) return null;
      const row = await db.prepare(`SELECT payload FROM sso_requests WHERE id = ? AND provider = 'saml'`).get(key);
      await db.prepare(`DELETE FROM sso_requests WHERE id = ? AND provider = 'saml'`).run(key);
      return row?.payload ?? null;
    }
  };
}

async function insertEvent(db, event) {
  await db.prepare(`
    INSERT INTO sso_login_events (provider, outcome, subject, email, user_id, reason, assertion_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.provider,
    event.outcome,
    event.subject || null,
    event.email || null,
    event.userId || null,
    event.reason || null,
    event.assertionId || null
  );
}

async function recordFailure(db, identity, error) {
  try {
    await insertEvent(db, {
      provider: identity.provider,
      outcome: 'failure',
      subject: identity.subject || null,
      email: identity.email || null,
      reason: error?.code || 'sso_token_invalid',
      assertionId: identity.assertionId || null
    });
  } catch (logError) {
    console.error('Failed to record SSO failure', logError);
  }
}

export async function completeSsoLogin(db, ssoConfig, identity) {
  const provider = identity?.provider;
  if (provider !== 'oidc' && provider !== 'saml') {
    throw new SsoError('sso_token_invalid');
  }
  try {
    return await db.transaction(async () => {
      await insertAssertionUse(db, provider, identity.assertionId);
      const policy = await getSsoPolicy(db, ssoConfig);
      const user = await resolveSsoUser(db, policy, identity);
      await insertEvent(db, {
        provider,
        outcome: 'success',
        subject: identity.subject,
        email: identity.email || user.email,
        userId: user.id,
        assertionId: identity.assertionId
      });
      return user;
    });
  } catch (error) {
    const ssoError = error instanceof SsoError ? error : new SsoError('sso_failed', error.statusCode || 500);
    if (!(error instanceof SsoError) && error?.statusCode) ssoError.statusCode = error.statusCode;
    await recordFailure(db, identity, ssoError);
    throw ssoError;
  }
}

async function insertAssertionUse(db, provider, assertionId) {
  const id = String(assertionId || '').trim();
  if (!id || id.length > 512) throw new SsoError('sso_token_invalid');
  try {
    await db.prepare(
      `INSERT INTO sso_assertion_uses (provider, assertion_id) VALUES (?, ?)`
    ).run(provider, id);
  } catch (error) {
    if (isUniqueConstraint(error)) throw new SsoError('sso_replay');
    throw error;
  }
}

async function resolveSsoUser(db, policy, identity) {
  const subject = normalizeSubject(identity.subject);
  const linked = await db.prepare(
    `SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?`
  ).get(identity.provider, subject);

  if (linked) {
    return requireActiveUser(db, linked.user_id);
  }

  let email = null;
  if (identity.email) {
    try {
      email = normalizeEmail(identity.email);
    } catch {
      throw new SsoError('sso_token_invalid');
    }
  }

  if (identity.emailVerified !== true) {
    throw new SsoError('sso_email_unverified');
  }
  if (!email) throw new SsoError('sso_user_unknown', 403);

  const existing = await db.prepare(`SELECT id FROM users WHERE lower(email) = ?`).get(email);
  if (existing) {
    const user = await requireActiveUser(db, existing.id);
    await linkIdentity(db, user.id, identity.provider, subject, email);
    return user;
  }

  const wantsProvisioning = policy.fromEnv || policy.fromDb;
  if (!wantsProvisioning) throw new SsoError('sso_user_unknown', 403);
  if (policy.roleInvalid || !policy.defaultRole) {
    throw new SsoError('sso_provisioning_misconfigured', 503);
  }

  const name = cleanName(identity.name) || email.split('@')[0];
  const created = await createUser(db, {
    name,
    email,
    role: policy.defaultRole,
    department_id: null,
    approval_limit: 0,
    status: 'active'
  });
  await linkIdentity(db, created.id, identity.provider, subject, email);
  return created;
}

async function requireActiveUser(db, userId) {
  const user = await loadPublicUser(db, userId);
  if (!user) throw new SsoError('sso_user_unknown', 403);
  if (user.status === 'inactive') throw new SsoError('sso_user_inactive', 403);
  return user;
}

async function linkIdentity(db, userId, provider, subject, email) {
  const existing = await db.prepare(
    `SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?`
  ).get(provider, subject);
  if (existing) {
    if (Number(existing.user_id) !== Number(userId)) throw new SsoError('sso_identity_conflict', 403);
    return;
  }
  try {
    await db.prepare(
      `INSERT INTO user_identities (user_id, provider, subject, email) VALUES (?, ?, ?, ?)`
    ).run(userId, provider, subject, email);
  } catch (error) {
    if (isUniqueConstraint(error)) throw new SsoError('sso_identity_conflict', 403);
    throw error;
  }
}

function normalizeSubject(value) {
  const subject = String(value ?? '').trim();
  if (!subject || subject.length > 512 || subject.includes('\u0000')) {
    throw new SsoError('sso_token_invalid');
  }
  return subject;
}

function cleanName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 200) return '';
  return name;
}

export async function recordProviderFailure(db, provider, error, extra = {}) {
  const ssoError = error instanceof SsoError ? error : classifyProviderError(error);
  await recordFailure(db, {
    provider,
    subject: extra.subject || null,
    email: extra.email || null,
    assertionId: extra.assertionId || null
  }, ssoError);
  return ssoError;
}
