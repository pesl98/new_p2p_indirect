/**
 * Local demo credentials stay available for `npm run seed` and Preview demo
 * data. Customer and production processes refuse them. Nothing in this file
 * logs a password or a database URL.
 */

import { timingSafeEqual } from 'node:crypto';
import { DEMO_SEED_PASSWORD, isDemoPersonaSwitcher } from './auth.js';
import { loadDbConfig, runningOnVercel } from './dbConfig.js';

/** bcrypt uses only the first 72 UTF-8 bytes. Enforced when a password is set. */
export const MAX_PASSWORD_BYTES = 72;
/** Login rejects only huge bodies. A stored hash of a longer password can still be checked. */
export const MAX_LOGIN_PASSWORD_BYTES = 1024;

const previewForbiddenCache = new WeakMap();

function vercelEnv(env) {
  return String(env.VERCEL_ENV || '').trim();
}

/**
 * Preview may sign in with the demo seed only when this process opened the
 * preview database. ALLOW_PREVIEW_PRODUCTION_DATABASE=allow sets
 * previewDatabase to false and serves production, so the demo password is
 * refused there. Production, any other Vercel environment, and a laptop
 * whose shell points at Turso may not use it either.
 */
function previewForbidsDemoPassword(env) {
  if (previewForbiddenCache.has(env)) return previewForbiddenCache.get(env);
  const forbidden = loadDbConfig(env, { quiet: true }).previewDatabase !== true;
  previewForbiddenCache.set(env, forbidden);
  return forbidden;
}

export function deploymentForbidsDemoPassword(env = process.env) {
  if (vercelEnv(env) === 'preview') return previewForbidsDemoPassword(env);
  if (vercelEnv(env) === 'production') return true;
  if (env.NODE_ENV === 'production') return true;
  if (runningOnVercel(env)) return true;
  if (String(env.TURSO_DATABASE_URL || '').trim()) return true;
  if (String(env.TURSO_AUTH_TOKEN || '').trim()) return true;
  return false;
}

export function passwordIsDemoSeed(password) {
  const value = password == null ? '' : String(password);
  const left = Buffer.from(value);
  const right = Buffer.from(DEMO_SEED_PASSWORD);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function passwordByteLength(password) {
  return Buffer.byteLength(password == null ? '' : String(password), 'utf8');
}

export function passwordExceedsBcryptLimit(password) {
  return passwordByteLength(password) > MAX_PASSWORD_BYTES;
}

export function passwordExceedsLoginLimit(password) {
  return passwordByteLength(password) > MAX_LOGIN_PASSWORD_BYTES;
}

export function assertPasswordAcceptable(password, env = process.env) {
  if (passwordExceedsBcryptLimit(password)) {
    const error = new Error(`Password must be at most ${MAX_PASSWORD_BYTES} bytes.`);
    error.statusCode = 400;
    error.code = 'password_too_long';
    throw error;
  }
  if (deploymentForbidsDemoPassword(env) && passwordIsDemoSeed(password)) {
    const error = new Error('That password is not allowed on a customer or production deployment.');
    error.statusCode = 400;
    error.code = 'demo_password_forbidden';
    throw error;
  }
}

/** Header persona switcher is a local walkthrough. Vercel and production refuse to boot with it on. */
export function warnIfDemoPersonaSwitcher(env = process.env) {
  if (!isDemoPersonaSwitcher(env)) return;
  const outsideLocal = runningOnVercel(env)
    || env.NODE_ENV === 'production'
    || vercelEnv(env) === 'production'
    || vercelEnv(env) === 'preview';
  if (!outsideLocal) return;
  const error = new Error('DEMO_PERSONA_SWITCHER must be unset outside local development. Refusing to start.');
  error.statusCode = 503;
  error.name = 'AuthConfigError';
  error.code = 'demo_persona_switcher_forbidden';
  throw error;
}
