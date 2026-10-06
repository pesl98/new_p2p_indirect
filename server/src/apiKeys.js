/**
 * Scoped API keys for machine clients (Sprint 4).
 *
 * The plaintext key is returned once from create and is never stored.
 * Lookup uses SHA-256(key). The key is the actor on integration writes.
 * It does not mint a user session and does not accept a user id.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { actorFromSession, appendComplianceEvent, utcTimestamp } from './complianceAudit.js';

export const API_KEY_SCOPES = Object.freeze([
  'vendors:write',
  'catalog:write',
  'export:read'
]);

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
export const MAX_RATE_LIMIT_PER_MINUTE = 6000;

export class IntegrationError extends Error {
  constructor(message, statusCode = 400, code = 'integration_error') {
    super(message);
    this.name = 'IntegrationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function hashApiKey(plaintext) {
  return createHash('sha256').update(String(plaintext)).digest('hex');
}

export function generateApiKey() {
  const token = `pfk_${randomBytes(32).toString('base64url')}`;
  return { token, prefix: token.slice(0, 12) };
}

function hashesEqual(storedHex, computedHex) {
  const a = Buffer.from(String(storedHex));
  const b = Buffer.from(String(computedHex));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseScopes(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value == null || value === '') return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function normalizeScopes(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new IntegrationError(
      `scopes must be a non-empty array of: ${API_KEY_SCOPES.join(', ')}`,
      400,
      'invalid_scopes'
    );
  }
  const scopes = [];
  for (const item of value) {
    const scope = String(item || '').trim();
    if (!API_KEY_SCOPES.includes(scope)) {
      throw new IntegrationError(
        `Unknown scope "${scope}". Allowed: ${API_KEY_SCOPES.join(', ')}`,
        400,
        'invalid_scopes'
      );
    }
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  return scopes;
}

function normalizeName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) {
    throw new IntegrationError('name is required (1-80 characters)', 400, 'invalid_name');
  }
  return name;
}

function normalizeRateLimit(value) {
  if (value == null || value === '') return DEFAULT_RATE_LIMIT_PER_MINUTE;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_RATE_LIMIT_PER_MINUTE) {
    throw new IntegrationError(
      `rate_limit_per_minute must be an integer from 1 to ${MAX_RATE_LIMIT_PER_MINUTE}`,
      400,
      'invalid_rate_limit'
    );
  }
  return n;
}

function normalizeExpiry(value, now = new Date()) {
  if (value == null || value === '') return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) {
    throw new IntegrationError('expires_at must be an ISO-8601 timestamp', 400, 'invalid_expiry');
  }
  if (parsed <= now.getTime()) {
    throw new IntegrationError('expires_at must be in the future', 400, 'invalid_expiry');
  }
  return new Date(parsed).toISOString();
}

export function publicApiKey(row) {
  return {
    id: Number(row.id),
    name: row.name,
    key_prefix: row.key_prefix,
    scopes: parseScopes(row.scopes),
    expires_at: row.expires_at || null,
    revoked_at: row.revoked_at || null,
    last_used_at: row.last_used_at || null,
    rate_limit_per_minute: Number(row.rate_limit_per_minute),
    created_by_name: row.created_by_name,
    created_at: row.created_at
  };
}

export function integrationPrincipal(key) {
  return {
    actor_user_id: null,
    actor_name: key.name,
    actor_role: 'integration',
    api_key_id: Number(key.id),
    key_prefix: key.key_prefix
  };
}

export async function createApiKey(db, actor, input = {}, now = new Date()) {
  const session = actorFromSession(actor);
  const name = normalizeName(input.name);
  const scopes = normalizeScopes(input.scopes);
  const rateLimit = normalizeRateLimit(input.rate_limit_per_minute);
  const expiresAt = normalizeExpiry(input.expires_at, now);
  const { token, prefix } = generateApiKey();
  const createdAt = now.toISOString();
  const result = await db.prepare(`
    INSERT INTO api_keys (
      name, key_prefix, key_hash, scopes, expires_at, rate_limit_per_minute,
      created_by_user_id, created_by_name, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    prefix,
    hashApiKey(token),
    JSON.stringify(scopes),
    expiresAt,
    rateLimit,
    session.actor_user_id,
    session.actor_name,
    createdAt
  );
  const id = Number(result.lastInsertRowid);
  await appendComplianceEvent(db, {
    ...session,
    action: 'API_KEY_CREATED',
    entity_type: 'api_key',
    entity_id: id,
    details: JSON.stringify({
      name,
      key_prefix: prefix,
      scopes,
      expires_at: expiresAt,
      rate_limit_per_minute: rateLimit
    }),
    created_at: utcTimestamp(now)
  });
  const row = await db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(id);
  return { ...publicApiKey(row), key: token };
}

export async function listApiKeys(db) {
  const rows = await db.prepare(`
    SELECT id, name, key_prefix, scopes, expires_at, revoked_at, last_used_at,
           rate_limit_per_minute, created_by_name, created_at
    FROM api_keys
    ORDER BY id DESC
  `).all();
  return (rows || []).map(publicApiKey);
}

export async function revokeApiKey(db, actor, id, now = new Date()) {
  const session = actorFromSession(actor);
  const keyId = Number(id);
  if (!Number.isInteger(keyId) || keyId <= 0) {
    throw new IntegrationError('Invalid API key id', 400, 'invalid_api_key_id');
  }
  const row = await db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(keyId);
  if (!row) throw new IntegrationError('API key not found', 404, 'api_key_not_found');
  if (row.revoked_at) {
    throw new IntegrationError('API key is already revoked', 409, 'api_key_already_revoked');
  }
  const revokedAt = now.toISOString();
  await db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`).run(revokedAt, keyId);
  await appendComplianceEvent(db, {
    ...session,
    action: 'API_KEY_REVOKED',
    entity_type: 'api_key',
    entity_id: keyId,
    details: JSON.stringify({ name: row.name, key_prefix: row.key_prefix }),
    created_at: utcTimestamp(now)
  });
  const updated = await db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(keyId);
  return publicApiKey(updated);
}

function readBearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const match = /^Bearer\s+(\S+)$/i.exec(String(header));
  if (!match) return { token: null, presented: Boolean(String(header).trim()) };
  return { token: match[1], presented: true };
}

function isExpired(expiresAt, now) {
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) return true;
  return parsed <= now.getTime();
}

async function consumeRateLimit(db, row, now) {
  const windowStart = Math.floor(now.getTime() / 60000);
  await db.prepare(`
    INSERT INTO api_key_rate_windows (api_key_id, window_start, request_count)
    VALUES (?, ?, 1)
    ON CONFLICT(api_key_id, window_start) DO UPDATE SET request_count = request_count + 1
  `).run(row.id, windowStart);
  const current = await db.prepare(`
    SELECT request_count FROM api_key_rate_windows
    WHERE api_key_id = ? AND window_start = ?
  `).get(row.id, windowStart);
  await db.prepare(`
    DELETE FROM api_key_rate_windows WHERE api_key_id = ? AND window_start < ?
  `).run(row.id, windowStart - 2);
  const count = Number(current?.request_count || 0);
  const limit = Number(row.rate_limit_per_minute);
  if (count > limit) {
    const retryAfter = 60 - (Math.floor(now.getTime() / 1000) % 60);
    const error = new IntegrationError('Rate limit exceeded', 429, 'rate_limited');
    error.retryAfterSeconds = retryAfter || 60;
    throw error;
  }
}

/**
 * Authenticate a machine request. pf_session is ignored.
 * Missing, malformed, unknown, revoked, and expired keys are 401.
 * A valid key without `scope` is 403. Over the per-key limit is 429.
 */
export async function authenticateIntegrationKey(req, scope, now = new Date()) {
  const { token, presented } = readBearerToken(req);
  if (!token) {
    throw new IntegrationError(
      presented ? 'Invalid API key' : 'API key required',
      401,
      presented ? 'api_key_invalid' : 'api_key_required'
    );
  }
  if (!token.startsWith('pfk_') || token.length < 20) {
    throw new IntegrationError('Invalid API key', 401, 'api_key_invalid');
  }
  const computed = hashApiKey(token);
  const row = await req.db.prepare(`SELECT * FROM api_keys WHERE key_hash = ?`).get(computed);
  if (!row || !hashesEqual(row.key_hash, computed)) {
    throw new IntegrationError('Invalid API key', 401, 'api_key_invalid');
  }
  if (row.revoked_at) {
    throw new IntegrationError('API key revoked', 401, 'api_key_revoked');
  }
  if (isExpired(row.expires_at, now)) {
    throw new IntegrationError('API key expired', 401, 'api_key_expired');
  }
  await req.db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).run(now.toISOString(), row.id);
  await consumeRateLimit(req.db, row, now);
  const scopes = parseScopes(row.scopes);
  if (scope && !scopes.includes(scope)) {
    throw new IntegrationError('Insufficient API key scope', 403, 'api_key_scope');
  }
  return {
    ...publicApiKey({ ...row, last_used_at: now.toISOString(), scopes: JSON.stringify(scopes) }),
    scopes
  };
}
