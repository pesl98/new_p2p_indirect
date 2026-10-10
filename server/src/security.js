/**
 * Small, dependency-free HTTP hardening: security headers, CORS allowlist,
 * Origin check for state-changing requests, and a fixed-window rate limiter.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function parseOriginAllowlist(env = process.env) {
  return String(env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function isProduction(env) {
  return Boolean(env.VERCEL || env.NODE_ENV === 'production');
}

export function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
  next();
}

/** Options for the `cors` package. Same-origin only unless allowlisted. */
export function corsOptions(env = process.env) {
  const allowed = new Set(parseOriginAllowlist(env));
  const dev = !isProduction(env);
  return {
    credentials: true,
    origin(origin, cb) {
      if (!origin) return cb(null, false);
      // Dev only: the Vite dev server runs on another port.
      if (allowed.has(origin) || (dev && allowed.size === 0)) return cb(null, true);
      return cb(null, false);
    }
  };
}

/** Reject cross-site state-changing requests (CSRF defence in depth). */
export function originCheck(env = process.env) {
  const allowed = new Set(parseOriginAllowlist(env));
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    if (!origin) return next();
    if (allowed.has(origin)) return next();
    let host = '';
    try { host = new URL(origin).host; } catch { /* invalid origin */ }
    if (host && host === req.get('host')) return next();
    if (!isProduction(env) && allowed.size === 0) return next();
    return res.status(403).json({ error: 'Cross-origin request blocked', code: 'origin_not_allowed' });
  };
}

/** Fixed-window in-memory limiter keyed by client IP (per instance). */
export function rateLimit({ windowMs = 15 * 60 * 1000, max = 20, now = () => Date.now() } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.reset <= t) {
      entry = { count: 0, reset: t + windowMs };
      hits.set(key, entry);
      if (hits.size > 10000) {
        for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
      }
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.reset - t) / 1000))));
      return res.status(429).json({ error: 'Too many requests, try again later', code: 'rate_limited' });
    }
    return next();
  };
}
