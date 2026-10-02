import { loadAuthConfig, signSessionToken } from './auth.js';

/** httpOnly-equivalent Cookie header for tests. Uses the same secret as createApp. */
export function sessionCookie(userId, authConfig) {
  const config = authConfig || loadAuthConfig();
  const token = signSessionToken(
    userId,
    config.sessionSecret,
    Date.now(),
    config.sessionTtlSeconds
  );
  return `pf_session=${encodeURIComponent(token)}`;
}

export function withCookie(userId, options = {}, authConfig) {
  const headers = { ...(options.headers || {}) };
  const cookie = sessionCookie(userId, authConfig);
  headers.Cookie = headers.Cookie ? `${cookie}; ${headers.Cookie}` : cookie;
  return { ...options, headers };
}
