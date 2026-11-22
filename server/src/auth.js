/**
 * Per-tenant session auth (httpOnly cookie + bcrypt password hashes).
 *
 * Identity is local to the connected database (SQLite file or Turso DB).
 * There is no org_id / shared-row tenancy. OIDC and SAML callbacks resolve
 * an external subject to a local `users.id` and call `signSessionToken`.
 * The `pf_session` cookie stays the only request identity — do not add a
 * second header or accept persona ids from the body.
 *
 * Cookie payload is HMAC-SHA256 signed — not a JWT library. SESSION_SECRET
 * must be set in customer deploys; local/dev falls back to an insecure default.
 *
 * The payload includes `sv` (users.session_version). Each authenticated
 * request compares it to the database. A mismatch, a missing user, or
 * status inactive clears the cookie. Tokens minted before `sv` existed
 * are treated as version 1, the column default, so a deploy does not
 * log every existing session out.
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { runningOnVercel } from './dbConfig.js';
import { loadSsoConfig } from './ssoConfig.js';

export const SESSION_COOKIE = 'pf_session';
export const MIN_PASSWORD_LENGTH = 8;
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Column default. A signed cookie with no `sv` is this version. */
export const DEFAULT_SESSION_VERSION = 1;

const sessionVersions = new WeakMap();

/** Documented local-demo password only. Never a production secret. */
export const DEMO_SEED_PASSWORD = 'ProcureFlow!demo';

/**
 * Default when IDENTITY_PROVIDER is unset. Runtime value comes from
 * loadAuthConfig().sso (local, oidc, or saml).
 */
export const IDENTITY_PROVIDER = 'local';

const DEV_SESSION_SECRET = 'procureflow-dev-insecure-session-secret';

/** Production and Preview refuse anything shorter than this. */
export const MIN_SESSION_SECRET_LENGTH = 32;

export function isDemoPersonaSwitcher(env = process.env) {
  const flag = String(env.DEMO_PERSONA_SWITCHER || '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes') return true;
  if (flag === '0' || flag === 'false' || flag === 'no') return false;
  return false;
}

export function loadAuthConfig(env = process.env, overrides = {}) {
  const sessionSecret = String(overrides.sessionSecret || env.SESSION_SECRET || '').trim()
    || DEV_SESSION_SECRET;
  const bcryptRounds = Number(overrides.bcryptRounds ?? env.BCRYPT_ROUNDS) || 10;
  const cookieSecure = overrides.cookieSecure ?? Boolean(env.VERCEL || env.NODE_ENV === 'production');
  const sso = loadSsoConfig(env);
  return {
    sessionSecret,
    bcryptRounds: Number.isInteger(bcryptRounds) && bcryptRounds >= 4 ? bcryptRounds : 10,
    cookieSecure,
    demoPersonaSwitcher: overrides.demoPersonaSwitcher ?? isDemoPersonaSwitcher(env),
    sessionTtlSeconds: overrides.sessionTtlSeconds || SESSION_TTL_SECONDS,
    usingDevSecret: !String(overrides.sessionSecret || env.SESSION_SECRET || '').trim(),
    sso,
    identityProvider: sso.identityProvider,
    localLogin: sso.localLogin
  };
}

export function normalizeSessionVersion(value) {
  if (value == null || value === '') return DEFAULT_SESSION_VERSION;
  const version = Number(value);
  return Number.isInteger(version) && version >= 0 ? version : DEFAULT_SESSION_VERSION;
}

export function rememberSessionVersion(user, version) {
  if (user && typeof user === 'object') {
    sessionVersions.set(user, normalizeSessionVersion(version));
  }
  return user;
}

export function sessionVersionOf(user) {
  if (user && sessionVersions.has(user)) return sessionVersions.get(user);
  return DEFAULT_SESSION_VERSION;
}

export function attachSessionCookie(res, config, userId, sessionVersion = DEFAULT_SESSION_VERSION) {
  const token = signSessionToken(
    userId,
    config.sessionSecret,
    Date.now(),
    config.sessionTtlSeconds,
    normalizeSessionVersion(sessionVersion)
  );
  res.setHeader('Set-Cookie', sessionCookieHeader(token, {
    ttlSeconds: config.sessionTtlSeconds,
    secure: config.cookieSecure
  }));
}

/** Sign a cookie for a user row that loadPublicUser already stamped. */
export function issueSessionCookie(res, config, user) {
  const userId = Number(user?.id ?? user);
  const version = user && typeof user === 'object' ? sessionVersionOf(user) : DEFAULT_SESSION_VERSION;
  attachSessionCookie(res, config, userId, version);
}

export function clearSessionCookie(res, config) {
  res.setHeader('Set-Cookie', sessionCookieHeader('', {
    secure: Boolean(config?.cookieSecure),
    clear: true
  }));
}

export async function hashPassword(password, rounds = 10) {
  return bcrypt.hash(String(password), rounds);
}

export async function verifyPassword(password, passwordHash) {
  if (!passwordHash) return false;
  return bcrypt.compare(String(password), String(passwordHash));
}

export function assertPasswordPolicy(password) {
  const value = password == null ? '' : String(password);
  if (value.length < MIN_PASSWORD_LENGTH) {
    const error = new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function signPayload(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/**
 * `sessionVersion === null` omits `sv` (pre-upgrade cookie shape).
 * Omitted argument embeds DEFAULT_SESSION_VERSION.
 */
export function signSessionToken(userId, secret, now = Date.now(), ttlSeconds = SESSION_TTL_SECONDS, sessionVersion = DEFAULT_SESSION_VERSION) {
  const payload = {
    uid: Number(userId),
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + ttlSeconds
  };
  if (sessionVersion !== null) payload.sv = normalizeSessionVersion(sessionVersion);
  const payloadB64 = toBase64Url(JSON.stringify(payload));
  const sig = signPayload(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

export function verifySessionToken(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expected = signPayload(payloadB64, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const uid = Number(payload?.uid);
  const exp = Number(payload?.exp);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  if (!Number.isFinite(exp) || exp < Math.floor(now / 1000)) return null;
  let sessionVersion = null;
  if (Object.prototype.hasOwnProperty.call(payload, 'sv')) {
    const sv = Number(payload.sv);
    if (!Number.isInteger(sv) || sv < 0) return null;
    sessionVersion = sv;
  }
  return { userId: uid, iat: payload.iat, exp, sessionVersion };
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function sessionCookieHeader(token, { ttlSeconds = SESSION_TTL_SECONDS, secure = false, clear = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${clear ? '' : encodeURIComponent(token || '')}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (clear) {
    parts.push('Max-Age=0');
  } else {
    parts.push(`Max-Age=${ttlSeconds}`);
  }
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const USER_PUBLIC_COLUMNS = `
  u.id, u.name, u.email, u.role, u.department_id, u.title,
  u.approval_limit, u.avatar, COALESCE(u.status, 'active') AS status,
  d.name AS department_name, d.code AS department_code,
  CASE WHEN c.user_id IS NULL THEN 0 ELSE 1 END AS has_password
`;

export async function loadPublicUser(db, userId) {
  if (!userId) return null;
  const user = await db.prepare(`
    SELECT ${USER_PUBLIC_COLUMNS},
           COALESCE(u.session_version, ${DEFAULT_SESSION_VERSION}) AS session_version
    FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    LEFT JOIN user_credentials c ON c.user_id = u.id
    WHERE u.id = ?
  `).get(userId);
  if (!user) return null;
  rememberSessionVersion(user, user.session_version);
  delete user.session_version;
  return user;
}

export async function attachSession(req, res, next) {
  try {
    const config = req.authConfig || loadAuthConfig();
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    const session = verifySessionToken(token, config.sessionSecret);
    if (!session) {
      req.user = null;
      return next();
    }
    const user = await loadPublicUser(req.db, session.userId);
    const presented = session.sessionVersion == null
      ? DEFAULT_SESSION_VERSION
      : session.sessionVersion;
    const current = sessionVersionOf(user);
    if (!user || user.status === 'inactive' || presented !== current) {
      req.user = null;
      clearSessionCookie(res, config);
      return next();
    }
    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  return next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }
  return next();
}

/**
 * Missing, the development default (even when SESSION_SECRET is set to that
 * value), or shorter than MIN_SESSION_SECRET_LENGTH. Local development is
 * allowed to boot with the default. The reason is a label, never the secret.
 */
const SESSION_SECRET_PROBLEM_TEXT = {
  missing: 'SESSION_SECRET is missing.',
  default: 'SESSION_SECRET is the development default.',
  short: `SESSION_SECRET is too short (fewer than ${MIN_SESSION_SECRET_LENGTH} characters).`
};

export function sessionSecretProblem(config) {
  const secret = String(config?.sessionSecret || '');
  if (!secret || config?.usingDevSecret) return 'missing';
  if (secret === DEV_SESSION_SECRET) return 'default';
  if (secret.length < MIN_SESSION_SECRET_LENGTH) return 'short';
  return null;
}

export function warnIfInsecureSessionSecret(config, env = process.env) {
  const problem = sessionSecretProblem(config);
  if (!problem) return;
  if (runningOnVercel(env) || env.NODE_ENV === 'production') {
    const error = new Error(
      `${SESSION_SECRET_PROBLEM_TEXT[problem]} `
      + `Set SESSION_SECRET to a unique value of at least ${MIN_SESSION_SECRET_LENGTH} characters. `
      + 'Refusing to start.'
    );
    error.statusCode = 503;
    error.code = 'session_secret_insecure';
    error.reason = problem;
    throw error;
  }
}
