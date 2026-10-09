/**
 * Database rate windows shared by the supplier portal and buyer uploads.
 * scope_key examples: `buyer:<id>:upload`, `inv:<id>`, `inv:<id>:submit`,
 * `inv:<id>:upload`, `ip:<hash>`.
 */

import { createHash } from 'node:crypto';

export const BUYER_UPLOADS_PER_MINUTE = 10;
export const PORTAL_REQUESTS_PER_MINUTE = 60;
export const PORTAL_SUBMITS_PER_MINUTE = 10;
export const PORTAL_UPLOADS_PER_MINUTE = 10;
export const PORTAL_FAILED_LOOKUPS_PER_WINDOW = 20;
export const PORTAL_FAILED_LOOKUP_WINDOW_MS = 10 * 60 * 1000;

export async function consumeRateWindow(db, scopeKey, limit, now = new Date(), windowMs = 60000) {
  const windowStart = Math.floor(now.getTime() / windowMs);
  const row = await db.prepare(`
    INSERT INTO sourcing_portal_rate_windows (scope_key, window_start, request_count)
    VALUES (?, ?, 1)
    ON CONFLICT(scope_key, window_start) DO UPDATE SET request_count = request_count + 1
    RETURNING request_count
  `).get(scopeKey, windowStart);
  const count = Number(row?.request_count || 0);
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));
  const elapsed = Math.floor(now.getTime() / 1000) % windowSeconds;
  const retryAfterSeconds = windowSeconds - elapsed || windowSeconds;
  return {
    count,
    limited: count > limit,
    retryAfterSeconds
  };
}

export function clientIpHash(req, secret) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || '');
  const hop = forwarded.split(',')[0].trim() || 'unknown';
  return createHash('sha256').update(`${secret}\n${hop}`).digest('hex');
}
