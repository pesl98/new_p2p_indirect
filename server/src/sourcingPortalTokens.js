/**
 * Per-invitation magic links.
 *
 * The plaintext token is `pfi_<rand>.<tag>`. Only SHA-256(token) is stored.
 * The tag is the first 16 bytes of HMAC-SHA256(PORTAL_TOKEN_SECRET, "pfi:v1:" + rand).
 * A bad tag is rejected before any database write.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const PORTAL_TOKEN_PREFIX = 'pfi_';
export const PORTAL_SECRET_MIN_LENGTH = 32;
export const INVITATION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

const RAND_BYTES = 32;
const TAG_BYTES = 16;

export function portalTokenSecret(env = process.env) {
  const secret = String(env.PORTAL_TOKEN_SECRET || '').trim();
  if (secret.length < PORTAL_SECRET_MIN_LENGTH) return null;
  return secret;
}

export function hashPortalToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function hmacTag(secret, rand) {
  return createHmac('sha256', secret).update(`pfi:v1:${rand}`).digest().subarray(0, TAG_BYTES);
}

export function mintPortalToken(secret = portalTokenSecret()) {
  if (!secret) {
    const error = new Error('Portal tokens are not configured.');
    error.statusCode = 503;
    error.code = 'portal_not_configured';
    throw error;
  }
  const rand = randomBytes(RAND_BYTES).toString('base64url');
  const tag = hmacTag(secret, rand).toString('base64url');
  const token = `${PORTAL_TOKEN_PREFIX}${rand}.${tag}`;
  return {
    token,
    token_hash: hashPortalToken(token),
    token_prefix: token.slice(0, 12)
  };
}

export function portalLink(token, env = process.env) {
  const base = String(env.APP_BASE_URL || '').trim().replace(/\/$/, '');
  const path = `/portal.html#t=${encodeURIComponent(token)}`;
  return base ? `${base}${path}` : path;
}

/**
 * Syntax, then a constant-time HMAC check. Returns the hash to look up,
 * or null when the token must be rejected with no database write.
 */
export function verifyPortalTokenMac(token, secret = portalTokenSecret()) {
  const text = String(token || '');
  const match = /^pfi_([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/.exec(text);
  if (!match || !secret) return null;
  let given;
  try {
    given = Buffer.from(match[2], 'base64url');
  } catch {
    given = Buffer.alloc(0);
  }
  const expected = hmacTag(secret, match[1]);
  const sameLength = given.length === expected.length;
  const compared = sameLength ? given : Buffer.alloc(expected.length);
  const macOk = timingSafeEqual(compared, expected) && sameLength;
  if (!macOk) return null;
  return hashPortalToken(text);
}

/** Indexed lookup, then a constant-time compare of the stored hash. */
export function portalHashesEqual(storedHex, computedHex) {
  const stored = Buffer.from(String(storedHex || ''));
  const computed = Buffer.from(String(computedHex || ''));
  const dummy = Buffer.alloc(computed.length, 0);
  const left = stored.length === computed.length ? stored : dummy;
  const equal = left.length === computed.length && timingSafeEqual(left, computed);
  return equal && stored.length === computed.length;
}

export function invitationExpiry(deadlineAt, extraMs = INVITATION_EXPIRY_MS) {
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline)) return null;
  return new Date(deadline + extraMs).toISOString();
}
