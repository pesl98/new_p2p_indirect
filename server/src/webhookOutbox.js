/**
 * Signed outbound webhooks with a durable outbox.
 *
 * Signature (Stripe-style, one version):
 *   X-ProcureFlow-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
 *   signed payload = `${timestamp}.${rawBody}`
 * Receivers should reject timestamps more than 5 minutes off and dedupe on
 * the event id (`evt_<outbox id>`), which stays stable across retries.
 * The timestamp is the send time, so a retry is not a replay of an old signature.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getDb } from './db.js';
import {
  assertDeliverableWebhookUrl,
  loadIntegrationConfig
} from './integrationConfig.js';
import { appendComplianceEvent, utcTimestamp } from './complianceAudit.js';

export const WEBHOOK_SIGNATURE_HEADER = 'X-ProcureFlow-Signature';
export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const WEBHOOK_MAX_ATTEMPTS = 5;
export const WEBHOOK_BACKOFF_SECONDS = Object.freeze([30, 120, 600, 3600]);

export const WEBHOOK_EVENTS = Object.freeze({
  PO_ISSUED: 'po.issued',
  RECEIPT_POSTED: 'receipt.posted',
  INVOICE_CREATED: 'invoice.created',
  INVOICE_APPROVED: 'invoice.approved',
  INVOICE_PROPOSAL_POSTED: 'invoice_proposal.posted',
  INVOICE_PROPOSAL_REJECTED: 'invoice_proposal.rejected',
  PAYMENT_RUN_CREATED: 'payment_run.created',
  PAYMENT_RUN_PAID: 'payment_run.paid'
});

export function signWebhook(secret, timestampSeconds, rawBody) {
  const timestamp = Number(timestampSeconds);
  const mac = createHmac('sha256', String(secret)).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export function parseWebhookSignature(header) {
  const text = String(header || '');
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(text);
  if (!match) return null;
  return { t: Number(match[1]), v1: match[2] };
}

export function verifyWebhookSignature(
  secret,
  header,
  rawBody,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS
) {
  const parsed = parseWebhookSignature(header);
  if (!parsed) return { ok: false, reason: 'malformed' };
  if (Math.abs(Number(nowSeconds) - parsed.t) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp' };
  }
  const expectedMac = createHmac('sha256', String(secret)).update(`${parsed.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(parsed.v1);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature' };
  }
  return { ok: true, timestamp: parsed.t };
}

export function backoffSeconds(attemptCount) {
  const index = Math.max(0, Number(attemptCount) - 1);
  return WEBHOOK_BACKOFF_SECONDS[Math.min(index, WEBHOOK_BACKOFF_SECONDS.length - 1)];
}

export async function externalIdFor(db, entityType, entityId) {
  if (entityId == null) return null;
  if (entityType === 'invoice') {
    const row = await db.prepare(`
      SELECT external_id FROM integration_invoice_links WHERE invoice_id = ?
    `).get(entityId);
    return row?.external_id || null;
  }
  const row = await db.prepare(`
    SELECT external_id FROM integration_entity_links
    WHERE entity_type = ? AND entity_id = ?
  `).get(entityType, entityId);
  return row?.external_id || null;
}

export async function enqueueWebhook(db, { eventType, entityType, entityId, data, now = new Date() }) {
  const createdAt = now.toISOString();
  const result = await db.prepare(`
    INSERT INTO webhook_outbox (
      event_type, entity_type, entity_id, payload, status,
      attempt_count, next_attempt_at, created_at
    ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
  `).run(
    eventType,
    entityType,
    Number(entityId),
    JSON.stringify(data ?? {}),
    createdAt,
    createdAt
  );
  return Number(result.lastInsertRowid);
}

export function kickWebhookDispatch(db) {
  const config = loadIntegrationConfig();
  if (!config.ready) return;
  setImmediate(() => {
    dispatchWebhookOutbox(db, { config }).catch((error) => {
      console.error('webhook dispatch:', error.message);
    });
  });
}

function envelopeFor(row) {
  let data = {};
  try {
    data = JSON.parse(row.payload);
  } catch {
    data = { invalid_payload: true };
  }
  return {
    id: `evt_${row.id}`,
    type: row.event_type,
    created_at: row.created_at,
    data
  };
}

export function publicOutboxRow(row) {
  let payload = null;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = null;
  }
  return {
    id: Number(row.id),
    event_id: `evt_${row.id}`,
    event_type: row.event_type,
    entity_type: row.entity_type,
    entity_id: Number(row.entity_id),
    payload,
    status: row.status,
    attempt_count: Number(row.attempt_count),
    next_attempt_at: row.next_attempt_at,
    last_error: row.last_error || null,
    last_attempt_at: row.last_attempt_at || null,
    delivered_at: row.delivered_at || null,
    dead_at: row.dead_at || null,
    created_at: row.created_at
  };
}

async function claimAttempt(db, row, now) {
  const attempt = Number(row.attempt_count) + 1;
  const result = await db.prepare(`
    UPDATE webhook_outbox
    SET attempt_count = ?, last_attempt_at = ?
    WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?
  `).run(attempt, now.toISOString(), row.id, now.toISOString());
  return Number(result.changes) === 1 ? attempt : 0;
}

async function markDelivered(db, id, now) {
  await db.prepare(`
    UPDATE webhook_outbox
    SET status = 'delivered', delivered_at = ?, last_error = NULL, dead_at = NULL
    WHERE id = ?
  `).run(now.toISOString(), id);
}

async function markRetry(db, id, attempt, errorMessage, now) {
  if (attempt >= WEBHOOK_MAX_ATTEMPTS) {
    await db.prepare(`
      UPDATE webhook_outbox
      SET status = 'dead', last_error = ?, dead_at = ?, next_attempt_at = ?
      WHERE id = ?
    `).run(errorMessage, now.toISOString(), now.toISOString(), id);
    return 'dead';
  }
  const next = new Date(now.getTime() + backoffSeconds(attempt) * 1000).toISOString();
  await db.prepare(`
    UPDATE webhook_outbox
    SET status = 'pending', last_error = ?, next_attempt_at = ?
    WHERE id = ?
  `).run(errorMessage, next, id);
  return 'pending';
}

async function postWebhook(row, config, fetchImpl, now) {
  assertDeliverableWebhookUrl(config.webhookTargetUrl);
  const bodyObject = envelopeFor(row);
  const rawBody = JSON.stringify(bodyObject);
  const timestamp = Math.floor(now.getTime() / 1000);
  const signature = signWebhook(config.webhookSigningSecret, timestamp, rawBody);
  const response = await fetchImpl(config.webhookTargetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [WEBHOOK_SIGNATURE_HEADER]: signature,
      'X-ProcureFlow-Timestamp': String(timestamp),
      'X-ProcureFlow-Event': row.event_type,
      'X-ProcureFlow-Event-Id': bodyObject.id,
      'User-Agent': 'ProcureFlow-Webhooks/1'
    },
    body: rawBody,
    signal: AbortSignal.timeout(10_000)
  });
  const status = Number(response.status);
  if (response.ok || (status >= 200 && status < 300)) {
    return { ok: true, status };
  }
  let detail = '';
  try {
    detail = String(await response.text()).slice(0, 300);
  } catch {
    detail = '';
  }
  return { ok: false, status, error: `HTTP ${status}${detail ? `: ${detail}` : ''}` };
}

export async function dispatchWebhookOutbox(db, options = {}) {
  const config = options.config || loadIntegrationConfig();
  const now = options.now instanceof Date ? options.now : new Date();
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 25;
  const fetchImpl = options.fetchImpl || fetch;
  if (!config.webhookTargetUrl || !config.webhookSigningSecret) {
    return { delivered: 0, failed: 0, dead: 0, skipped: 'not_configured' };
  }

  const nowIso = now.toISOString();
  let rows;
  if (options.ids && options.ids.length) {
    const placeholders = options.ids.map(() => '?').join(', ');
    rows = await db.prepare(`
      SELECT * FROM webhook_outbox
      WHERE status = 'pending' AND next_attempt_at <= ? AND id IN (${placeholders})
      ORDER BY id ASC
    `).all(nowIso, ...options.ids);
  } else {
    rows = await db.prepare(`
      SELECT * FROM webhook_outbox
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY id ASC
      LIMIT ?
    `).all(nowIso, limit);
  }

  const summary = { delivered: 0, failed: 0, dead: 0, skipped: null };
  for (const row of rows || []) {
    const attempt = await claimAttempt(db, row, now);
    if (!attempt) continue;
    try {
      const result = await postWebhook(row, config, fetchImpl, now);
      if (result.ok) {
        await markDelivered(db, row.id, now);
        summary.delivered += 1;
      } else {
        const state = await markRetry(db, row.id, attempt, result.error || 'delivery failed', now);
        if (state === 'dead') summary.dead += 1;
        else summary.failed += 1;
      }
    } catch (error) {
      const state = await markRetry(db, row.id, attempt, String(error.message || error).slice(0, 300), now);
      if (state === 'dead') summary.dead += 1;
      else summary.failed += 1;
    }
  }
  return summary;
}

export async function listWebhookOutbox(db, { status = 'all', limit = 100 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const allowed = ['pending', 'delivered', 'dead'];
  if (status && status !== 'all') {
    if (!allowed.includes(status)) {
      const error = new Error('status must be pending, delivered, dead, or all');
      error.statusCode = 400;
      throw error;
    }
    const rows = await db.prepare(`
      SELECT * FROM webhook_outbox WHERE status = ? ORDER BY id DESC LIMIT ?
    `).all(status, cap);
    return (rows || []).map(publicOutboxRow);
  }
  const rows = await db.prepare(`
    SELECT * FROM webhook_outbox ORDER BY id DESC LIMIT ?
  `).all(cap);
  return (rows || []).map(publicOutboxRow);
}

export async function replayWebhook(db, id, actor, options = {}) {
  const rowId = Number(id);
  if (!Number.isInteger(rowId) || rowId <= 0) {
    const error = new Error('Invalid outbox id');
    error.statusCode = 400;
    throw error;
  }
  const existing = await db.prepare(`SELECT * FROM webhook_outbox WHERE id = ?`).get(rowId);
  if (!existing) {
    const error = new Error('Outbox event not found');
    error.statusCode = 404;
    throw error;
  }
  const now = options.now instanceof Date ? options.now : new Date();
  await db.prepare(`
    UPDATE webhook_outbox
    SET status = 'pending',
        attempt_count = 0,
        next_attempt_at = ?,
        last_error = NULL,
        dead_at = NULL,
        delivered_at = NULL
    WHERE id = ?
  `).run(now.toISOString(), rowId);
  if (actor) {
    await appendComplianceEvent(db, {
      actor_user_id: Number(actor.id),
      actor_name: actor.name,
      actor_role: actor.role || null,
      action: 'WEBHOOK_REPLAYED',
      entity_type: 'webhook_outbox',
      entity_id: rowId,
      details: JSON.stringify({ event_type: existing.event_type, previous_status: existing.status }),
      created_at: utcTimestamp(now)
    });
  }
  const delivery = await dispatchWebhookOutbox(db, { ...options, now, ids: [rowId] });
  const updated = await db.prepare(`SELECT * FROM webhook_outbox WHERE id = ?`).get(rowId);
  return { event: publicOutboxRow(updated), delivery };
}

let dispatcherTimer = null;

export function startLocalWebhookDispatcher({ intervalMs = 30_000 } = {}) {
  if (process.env.VERCEL || dispatcherTimer) return;
  dispatcherTimer = setInterval(() => {
    const config = loadIntegrationConfig();
    if (!config.ready) return;
    getDb()
      .then((db) => dispatchWebhookOutbox(db, { config }))
      .catch((error) => {
        console.error('webhook dispatcher:', error.message);
      });
  }, intervalMs);
  if (typeof dispatcherTimer.unref === 'function') dispatcherTimer.unref();
}
