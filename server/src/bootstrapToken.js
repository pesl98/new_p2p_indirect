/**
 * One-time HTTP gate for POST /api/auth/bootstrap.
 *
 * Unset (or shorter than 32 characters) means the route is disabled.
 * The process still boots: existing deployments that already have users
 * do not need this variable. npm run bootstrap-admin talks to the database
 * directly and does not read it.
 *
 * Comparison is SHA-256 digests so timingSafeEqual always sees equal lengths.
 * This module never logs the token.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export const MIN_BOOTSTRAP_TOKEN_LENGTH = 32;
export const BOOTSTRAP_TOKEN_HEADER = 'x-bootstrap-token';

export function readBootstrapToken(env = process.env) {
  if (!env || env.BOOTSTRAP_TOKEN == null) return '';
  return String(env.BOOTSTRAP_TOKEN).trim();
}

/** The configured secret, or null when HTTP bootstrap must stay disabled. */
export function configuredBootstrapToken(env = process.env) {
  const token = readBootstrapToken(env);
  if (token.length < MIN_BOOTSTRAP_TOKEN_LENGTH) return null;
  return token;
}

/**
 * Warn when a token is set but too short to enable the route.
 * A missing token is the normal case and is silent. The value is not logged.
 * Returns true when a warning was emitted.
 */
export function warnIfShortBootstrapToken(env = process.env, log = console) {
  const token = readBootstrapToken(env);
  if (!token || token.length >= MIN_BOOTSTRAP_TOKEN_LENGTH) return false;
  log.warn?.(
    `BOOTSTRAP_TOKEN is shorter than ${MIN_BOOTSTRAP_TOKEN_LENGTH} characters. `
    + 'HTTP first-admin bootstrap stays disabled. The value was not logged.'
  );
  return true;
}

/** Constant-time compare of equal-length digests. Never throws on length. */
export function bootstrapTokensMatch(presented, expected) {
  const left = createHash('sha256').update(presented == null ? '' : String(presented), 'utf8').digest();
  const right = createHash('sha256').update(expected == null ? '' : String(expected), 'utf8').digest();
  return timingSafeEqual(left, right);
}

/**
 * Refusal for an empty tenant. Null means the presented header matches a
 * configured token and the caller may create the first admin.
 * Call this only after the "users already exist" check: that case stays 409.
 */
export function bootstrapHttpRefusal(env, presented) {
  const configured = configuredBootstrapToken(env);
  if (!configured) {
    return {
      statusCode: 403,
      body: {
        error: 'First-admin HTTP bootstrap is disabled. Create the first admin with npm run bootstrap-admin.',
        code: 'bootstrap_disabled'
      }
    };
  }
  if (!bootstrapTokensMatch(presented, configured)) {
    return {
      statusCode: 403,
      body: {
        error: 'Bootstrap token is missing or invalid.',
        code: 'bootstrap_token_invalid'
      }
    };
  }
  return null;
}
