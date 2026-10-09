/**
 * Supplier portal. Every query is scoped to the invitation resolved from
 * the bearer token. The buyer session is ignored. Bid rows for this
 * invitation are the only bid rows this module reads.
 */

import { createHash } from 'node:crypto';
import { appendComplianceEvent, utcTimestamp } from './complianceAudit.js';
import { lineTotalCents } from './money.js';
import { enqueueWebhook, externalIdFor, kickWebhookDispatch, WEBHOOK_EVENTS } from './webhookOutbox.js';
import {
  MAX_EVENT_FILES,
  MAX_EVENT_FILE_BYTES,
  isPdfBuffer,
  safePdfFilename,
  sha256Pdf,
  sourcingEnabled,
  utcIso
} from './sourcingConfig.js';
import {
  hashPortalToken,
  portalHashesEqual,
  portalTokenSecret,
  verifyPortalTokenMac
} from './sourcingPortalTokens.js';
import {
  BUYER_UPLOADS_PER_MINUTE,
  PORTAL_FAILED_LOOKUP_WINDOW_MS,
  PORTAL_FAILED_LOOKUPS_PER_WINDOW,
  PORTAL_REQUESTS_PER_MINUTE,
  PORTAL_SUBMITS_PER_MINUTE,
  PORTAL_UPLOADS_PER_MINUTE,
  clientIpHash,
  consumeRateWindow
} from './sourcingRates.js';
import { SourcingError, closeDueEvents } from './sourcingService.js';

const PORTAL_INVALID = 'Deze link is ongeldig of verlopen. Neem contact op met de inkoper.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export { BUYER_UPLOADS_PER_MINUTE };

function fail(message, statusCode, code, extra) {
  const error = new SourcingError(message, statusCode, code);
  if (extra?.retryAfterSeconds) error.retryAfterSeconds = extra.retryAfterSeconds;
  throw error;
}

function invalidLink() {
  fail(PORTAL_INVALID, 401, 'portal_link_invalid');
}

async function rateOrFail(db, scopeKey, limit, now, windowMs) {
  const result = await consumeRateWindow(db, scopeKey, limit, now, windowMs);
  if (result.limited) fail('Too many requests.', 429, 'rate_limited', { retryAfterSeconds: result.retryAfterSeconds });
}

function supplierActor(ctx) {
  return {
    actor_user_id: null,
    actor_name: `${ctx.supplier_code} (${ctx.contact_email})`,
    actor_role: 'supplier'
  };
}

async function writeSupplierCompliance(db, ctx, action, details, now) {
  await appendComplianceEvent(db, {
    ...supplierActor(ctx),
    action,
    entity_type: 'sourcing_invitation',
    entity_id: ctx.invitation_id,
    details: JSON.stringify({ invitation_id: ctx.invitation_id, ...details }),
    created_at: utcTimestamp(now)
  });
}

export async function resolvePortalToken(db, token, req, now = new Date()) {
  if (!sourcingEnabled()) fail('Sourcing is not enabled for this deployment.', 503, 'sourcing_disabled');
  const secret = portalTokenSecret();
  if (!secret) fail('Portal links are not configured.', 503, 'portal_not_configured');
  const hash = verifyPortalTokenMac(token, secret);
  if (!hash) invalidLink();

  const row = await db.prepare(`
    SELECT
      i.id AS invitation_id, i.event_id, i.supplier_id, i.contact_name, i.contact_email,
      i.token_hash, i.expires_at, i.revoked_at, i.declined_at, i.first_opened_at,
      s.code AS supplier_code, s.name AS supplier_name,
      e.event_number, e.title, e.status AS event_status, e.deadline_at, e.currency,
      e.cancelled_before_deadline
    FROM sourcing_invitations i
    JOIN sourcing_events e ON e.id = i.event_id
    JOIN suppliers s ON s.id = i.supplier_id
    WHERE i.token_hash = ?
  `).get(hash);

  const hashOk = row ? portalHashesEqual(row.token_hash, hash) : portalHashesEqual(null, hash);
  if (!row || !hashOk) {
    await noteFailedLookup(db, req, secret, now, null, 'unknown');
    invalidLink();
  }

  const instant = now.getTime();
  const expires = row.expires_at ? Date.parse(row.expires_at) : NaN;
  let reason = null;
  if (row.revoked_at) reason = 'revoked';
  else if (!Number.isFinite(expires) || expires <= instant) reason = 'expired';
  else if (row.event_status === 'draft') reason = 'draft';
  if (reason) {
    await noteFailedLookup(db, req, secret, now, row, reason);
    invalidLink();
  }

  await rateOrFail(db, `inv:${row.invitation_id}`, PORTAL_REQUESTS_PER_MINUTE, now, 60000);
  return {
    invitation_id: Number(row.invitation_id),
    event_id: Number(row.event_id),
    supplier_id: Number(row.supplier_id),
    supplier_code: row.supplier_code,
    supplier_name: row.supplier_name,
    contact_name: row.contact_name,
    contact_email: row.contact_email,
    event_number: row.event_number,
    title: row.title,
    event_status: row.event_status,
    deadline_at: row.deadline_at,
    currency: row.currency,
    declined_at: row.declined_at
  };
}

async function noteFailedLookup(db, req, secret, now, row, reason) {
  const ip = clientIpHash(req, secret);
  const result = await consumeRateWindow(
    db,
    `ip:${ip}`,
    PORTAL_FAILED_LOOKUPS_PER_WINDOW,
    now,
    PORTAL_FAILED_LOOKUP_WINDOW_MS
  );
  if (row && (reason === 'revoked' || reason === 'expired')) {
    try {
      await writeSupplierCompliance(db, {
        invitation_id: row.invitation_id,
        supplier_code: row.supplier_code,
        contact_email: row.contact_email
      }, reason === 'revoked' ? 'SOURCING_LINK_REJECTED_REVOKED' : 'SOURCING_LINK_REJECTED_EXPIRED', {
        reason
      }, now);
    } catch (error) {
      console.error('portal lookup audit failed', error?.code || error?.name || 'audit');
    }
  }
  if (result.limited) {
    fail('Too many requests.', 429, 'rate_limited', { retryAfterSeconds: result.retryAfterSeconds });
  }
}

function publicLines(lines) {
  return lines.map((line) => ({
    id: line.id,
    line_no: line.line_no,
    description: line.description,
    quantity: line.quantity,
    unit_of_measure: line.unit_of_measure,
    line_type: line.line_type,
    service_basis: line.service_basis
  }));
}

function publicFiles(files) {
  return files.map((file) => ({
    id: file.id,
    filename: file.filename,
    size_bytes: file.size_bytes
  }));
}

async function markOpened(db, ctx, now) {
  const stamp = utcIso(now);
  const opened = await db.prepare(`
    UPDATE sourcing_invitations
    SET first_opened_at = ?
    WHERE id = ? AND first_opened_at IS NULL
  `).run(stamp, ctx.invitation_id);
  await db.prepare(`
    UPDATE sourcing_invitations SET last_seen_at = ? WHERE id = ?
  `).run(stamp, ctx.invitation_id);
  if (opened.changes) {
    await writeSupplierCompliance(db, ctx, 'SOURCING_INVITATION_OPENED', {}, now);
  }
}

export async function loadPortalView(db, ctx, now = new Date()) {
  await closeDueEvents(db, now, { limit: 20 });
  await markOpened(db, ctx, now);
  const event = await db.prepare(`
    SELECT event_number, title, description, deadline_at, status, currency,
           qa_enabled, qa_deadline_at, cancelled_at, cancel_reason
    FROM sourcing_events WHERE id = ?
  `).get(ctx.event_id);
  const lines = await db.prepare(`
    SELECT id, line_no, description, quantity, unit_of_measure, line_type, service_basis
    FROM sourcing_event_lines WHERE event_id = ? ORDER BY line_no ASC
  `).all(ctx.event_id);
  const files = await db.prepare(`
    SELECT id, filename, size_bytes
    FROM sourcing_files
    WHERE event_id = ? AND owner_kind = 'event' AND removed_at IS NULL
    ORDER BY id ASC
  `).all(ctx.event_id);
  const invitation = await db.prepare(`
    SELECT contact_name, declined_at, decline_reason, expires_at, first_opened_at
    FROM sourcing_invitations WHERE id = ?
  `).get(ctx.invitation_id);
  const bid = await ownBid(db, ctx.invitation_id);
  const questions = await listOwnQuestions(db, ctx);
  return {
    server_now: now.toISOString(),
    customer_name: String(process.env.APP_NAME || 'ProcureFlow'),
    event: {
      event_number: event.event_number,
      title: event.title,
      description: event.description,
      deadline_at: event.deadline_at,
      status: event.status,
      currency: event.currency,
      qa_enabled: Number(event.qa_enabled) === 1,
      qa_deadline_at: event.qa_deadline_at,
      cancelled_at: event.cancelled_at,
      cancel_reason: event.status === 'cancelled' ? event.cancel_reason : null,
      lines: publicLines(lines),
      files: publicFiles(files)
    },
    invitation: {
      contact_name: invitation.contact_name,
      expires_at: invitation.expires_at,
      declined_at: invitation.declined_at,
      decline_reason: invitation.decline_reason
    },
    bid,
    questions
  };
}

async function ownBid(db, invitationId) {
  const bid = await db.prepare(`
    SELECT id, status, current_revision, first_submitted_at, last_submitted_at, withdrawn_at
    FROM sourcing_bids WHERE invitation_id = ?
  `).get(invitationId);
  if (!bid) return null;
  const revision = await db.prepare(`
    SELECT revision, total_cents, quoted_line_count, validity_until, default_lead_time_days,
           supplier_note, content_sha256, submitted_at
    FROM sourcing_bid_revisions
    WHERE bid_id = ? AND revision = ?
  `).get(bid.id, bid.current_revision);
  const lines = await db.prepare(`
    SELECT event_line_id, quoted, unit_price_cents, line_total_cents, lead_time_days, comment
    FROM sourcing_bid_lines
    WHERE bid_id = ? AND revision = ?
    ORDER BY event_line_id ASC
  `).all(bid.id, bid.current_revision);
  const files = await db.prepare(`
    SELECT id, filename, size_bytes
    FROM sourcing_files
    WHERE invitation_id = ? AND owner_kind = 'bid' AND removed_at IS NULL
    ORDER BY id ASC
  `).all(invitationId);
  return {
    status: bid.status,
    revision: Number(bid.current_revision),
    submitted_at: bid.first_submitted_at,
    last_submitted_at: bid.last_submitted_at,
    withdrawn_at: bid.withdrawn_at,
    total_cents: revision?.total_cents ?? null,
    validity_until: revision?.validity_until ?? null,
    default_lead_time_days: revision?.default_lead_time_days ?? null,
    supplier_note: revision?.supplier_note ?? null,
    content_sha256: revision?.content_sha256 ?? null,
    lines: lines.map((line) => ({
      event_line_id: line.event_line_id,
      quoted: Number(line.quoted) === 1,
      unit_price_cents: line.unit_price_cents,
      line_total_cents: line.line_total_cents,
      lead_time_days: line.lead_time_days,
      comment: line.comment
    })),
    files: publicFiles(files)
  };
}

function assertOpenForWrite(ctx, now) {
  if (ctx.event_status === 'cancelled') fail('Deze offerteaanvraag is geannuleerd.', 409, 'event_cancelled');
  if (ctx.declined_at) fail('U hebt afgezien van deelname.', 409, 'invitation_declined');
  const deadline = Date.parse(ctx.deadline_at);
  if (!Number.isFinite(deadline) || deadline <= now.getTime() || ctx.event_status !== 'published') {
    fail(`De inschrijftermijn is gesloten om ${ctx.deadline_at}.`, 409, 'deadline_passed');
  }
}

function readSubmission(input, eventLines) {
  const submissionId = String(input?.submission_id || '').trim();
  if (!UUID_RE.test(submissionId)) fail('submission_id must be a UUID.', 400, 'submission_id_required');
  const rawLines = Array.isArray(input?.lines) ? input.lines : null;
  if (!rawLines) fail('Each event line needs an offer or "niet aangeboden".', 400, 'bid_lines_required');
  const byId = new Map();
  for (const raw of rawLines) {
    const id = Number(raw?.event_line_id);
    if (!Number.isInteger(id) || byId.has(id)) fail('Each event line needs an offer or "niet aangeboden".', 400, 'bid_lines_required');
    byId.set(id, raw);
  }
  const lines = [];
  for (const eventLine of eventLines) {
    const raw = byId.get(Number(eventLine.id));
    if (!raw) fail('Each event line needs an offer or "niet aangeboden".', 400, 'bid_lines_required');
    const quoted = raw.quoted === false || raw.quoted === 0 || raw.not_offered === true ? 0 : 1;
    let unit = null;
    let total = null;
    let lead = null;
    if (quoted) {
      unit = Number(raw.unit_price_cents);
      if (!Number.isInteger(unit) || unit <= 0) fail('A quoted line needs a unit price in cents.', 400, 'invalid_amount');
      total = lineTotalCents(eventLine.quantity, unit);
      if (raw.lead_time_days != null && raw.lead_time_days !== '') {
        lead = Number(raw.lead_time_days);
        if (!Number.isInteger(lead) || lead < 0 || lead > 730) fail('Lead time must be between 0 and 730 days.', 400, 'invalid_lead_time');
      }
    }
    const comment = raw.comment == null || raw.comment === '' ? null : String(raw.comment);
    if (comment && comment.length > 2000) fail('A line comment is too long.', 400, 'text_too_long');
    lines.push({
      event_line_id: Number(eventLine.id),
      quoted,
      unit_price_cents: unit,
      line_total_cents: total,
      lead_time_days: lead,
      comment
    });
  }
  if (byId.size !== eventLines.length) fail('Each event line needs an offer or "niet aangeboden".', 400, 'bid_lines_required');
  let defaultLead = null;
  if (input.default_lead_time_days != null && input.default_lead_time_days !== '') {
    defaultLead = Number(input.default_lead_time_days);
    if (!Number.isInteger(defaultLead) || defaultLead < 0 || defaultLead > 730) {
      fail('Lead time must be between 0 and 730 days.', 400, 'invalid_lead_time');
    }
  }
  let validity = null;
  if (input.validity_until != null && String(input.validity_until).trim() !== '') {
    const text = String(input.validity_until).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail('validity_until must be YYYY-MM-DD.', 400, 'invalid_deadline');
    validity = text;
  }
  const note = input.supplier_note == null || input.supplier_note === '' ? null : String(input.supplier_note);
  if (note && note.length > 8000) fail('The note is too long.', 400, 'text_too_long');
  const totalCents = lines.reduce((sum, line) => sum + (line.quoted ? line.line_total_cents : 0), 0);
  const quotedCount = lines.filter((line) => line.quoted).length;
  return {
    submission_id: submissionId,
    lines,
    total_cents: totalCents,
    quoted_line_count: quotedCount,
    validity_until: validity,
    default_lead_time_days: defaultLead,
    supplier_note: note
  };
}

function contentHash(submission, fileDigests) {
  const canonical = JSON.stringify({
    lines: submission.lines.map((line) => ({
      event_line_id: line.event_line_id,
      quoted: line.quoted,
      unit_price_cents: line.unit_price_cents,
      line_total_cents: line.line_total_cents,
      lead_time_days: line.lead_time_days,
      comment: line.comment
    })),
    validity_until: submission.validity_until,
    default_lead_time_days: submission.default_lead_time_days,
    supplier_note: submission.supplier_note,
    files: [...fileDigests].sort()
  });
  return createHash('sha256').update(canonical).digest('hex');
}

async function existingReceipt(db, invitationId, submissionId) {
  const row = await db.prepare(`
    SELECT r.revision, r.content_sha256, r.submitted_at, r.total_cents
    FROM sourcing_bid_revisions r
    JOIN sourcing_bids b ON b.id = r.bid_id
    WHERE b.invitation_id = ? AND r.submission_id = ?
  `).get(invitationId, submissionId);
  if (!row) return null;
  return {
    replayed: true,
    revision: Number(row.revision),
    content_sha256: row.content_sha256,
    submitted_at: row.submitted_at,
    total_cents: row.total_cents
  };
}

export async function submitPortalBid(db, ctx, input, now = new Date()) {
  await closeDueEvents(db, now, { limit: 20 });
  const fresh = await reloadCtx(db, ctx.invitation_id);
  if (fresh.event_status === 'cancelled') fail('Deze offerteaanvraag is geannuleerd.', 409, 'event_cancelled');
  if (fresh.declined_at) fail('U hebt afgezien van deelname.', 409, 'invitation_declined');
  const deadlineMs = Date.parse(fresh.deadline_at);
  const closed = !Number.isFinite(deadlineMs) || deadlineMs <= now.getTime() || fresh.event_status !== 'published';
  if (closed) {
    await writeSupplierCompliance(db, fresh, 'SOURCING_BID_REJECTED_LATE', {
      submission_id: String(input?.submission_id || '')
    }, now);
    fail(`De inschrijftermijn is gesloten om ${fresh.deadline_at}.`, 409, 'deadline_passed');
  }
  const eventLines = await db.prepare(`
    SELECT id, quantity FROM sourcing_event_lines WHERE event_id = ? ORDER BY line_no ASC
  `).all(fresh.event_id);
  const submission = readSubmission(input, eventLines);
  const replay = await existingReceipt(db, fresh.invitation_id, submission.submission_id);
  if (replay) return replay;
  await rateOrFail(db, `inv:${fresh.invitation_id}:submit`, PORTAL_SUBMITS_PER_MINUTE, now, 60000);

  const files = await db.prepare(`
    SELECT sha256 FROM sourcing_files
    WHERE invitation_id = ? AND owner_kind = 'bid' AND removed_at IS NULL
  `).all(fresh.invitation_id);
  const digest = contentHash(submission, files.map((file) => file.sha256));
  const stamp = utcIso(now);
  const supplierExternalId = await externalIdFor(db, 'supplier', fresh.supplier_id);

  let outcome;
  try {
    outcome = await db.immediateTransaction(async () => {
      const bidRow = await db.prepare(`
        INSERT INTO sourcing_bids (
          event_id, invitation_id, supplier_id, status, current_revision,
          first_submitted_at, last_submitted_at
        )
        SELECT e.id, i.id, i.supplier_id, 'submitted', 0, ?, ?
        FROM sourcing_events e
        JOIN sourcing_invitations i ON i.event_id = e.id
        WHERE i.id = ? AND i.revoked_at IS NULL AND i.declined_at IS NULL
          AND e.status = 'published' AND e.deadline_at > ?
        ON CONFLICT(invitation_id) DO UPDATE SET
          status = 'submitted',
          last_submitted_at = excluded.last_submitted_at,
          withdrawn_at = NULL
        RETURNING id, current_revision
      `).get(stamp, stamp, fresh.invitation_id, stamp);
      if (!bidRow?.id) {
        await writeSupplierCompliance(db, fresh, 'SOURCING_BID_REJECTED_LATE', { submission_id: submission.submission_id }, now);
        return { late: true };
      }
      const nextRevision = Number(bidRow.current_revision) + 1;
      const revision = await db.prepare(`
        INSERT INTO sourcing_bid_revisions (
          bid_id, revision, submission_id, total_cents, quoted_line_count, validity_until,
          default_lead_time_days, supplier_note, content_sha256, submitted_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM sourcing_bids b
        JOIN sourcing_events e ON e.id = b.event_id
        WHERE b.id = ? AND e.status = 'published' AND e.deadline_at > ?
      `).run(
        bidRow.id,
        nextRevision,
        submission.submission_id,
        submission.total_cents,
        submission.quoted_line_count,
        submission.validity_until,
        submission.default_lead_time_days,
        submission.supplier_note,
        digest,
        stamp,
        bidRow.id,
        stamp
      );
      if (!revision.changes) {
        await writeSupplierCompliance(db, fresh, 'SOURCING_BID_REJECTED_LATE', { submission_id: submission.submission_id }, now);
        return { late: true };
      }
      const columns = [
        'bid_id', 'revision', 'event_line_id', 'quoted', 'unit_price_cents',
        'line_total_cents', 'lead_time_days', 'comment'
      ];
      const values = submission.lines.map((line) => [
        bidRow.id,
        nextRevision,
        line.event_line_id,
        line.quoted,
        line.unit_price_cents,
        line.line_total_cents,
        line.lead_time_days,
        line.comment
      ]);
      const tuples = values.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
      await db.prepare(
        `INSERT INTO sourcing_bid_lines (${columns.join(', ')}) VALUES ${tuples}`
      ).run(...values.flat());
      await db.prepare(`
        UPDATE sourcing_bids
        SET current_revision = ?, status = 'submitted', last_submitted_at = ?, withdrawn_at = NULL
        WHERE id = ?
      `).run(nextRevision, stamp, bidRow.id);
      const action = nextRevision === 1 ? 'SOURCING_BID_SUBMITTED' : 'SOURCING_BID_REVISED';
      await writeSupplierCompliance(db, fresh, action, {
        revision: nextRevision,
        content_sha256: digest,
        submission_id: submission.submission_id
      }, now);
      await enqueueWebhook(db, {
        eventType: WEBHOOK_EVENTS.SOURCING_BID_SUBMITTED,
        entityType: 'sourcing_bid',
        entityId: Number(bidRow.id),
        data: {
          event_number: fresh.event_number,
          supplier_code: fresh.supplier_code,
          supplier_external_id: supplierExternalId,
          revision: nextRevision,
          submitted_at: stamp,
          content_sha256: digest
        },
        now
      });
      return {
        late: false,
        revision: nextRevision,
        content_sha256: digest,
        submitted_at: stamp,
        total_cents: submission.total_cents,
        replayed: false
      };
    })();
  } catch (error) {
    if (/UNIQUE/i.test(String(error?.message || '')) && /submission_id/i.test(String(error?.message || ''))) {
      const again = await existingReceipt(db, fresh.invitation_id, submission.submission_id);
      if (again) return again;
    }
    throw error;
  }
  kickWebhookDispatch(db);
  if (outcome.late) fail(`De inschrijftermijn is gesloten om ${fresh.deadline_at}.`, 409, 'deadline_passed');
  return outcome;
}

async function reloadCtx(db, invitationId) {
  const row = await db.prepare(`
    SELECT
      i.id AS invitation_id, i.event_id, i.supplier_id, i.contact_email, i.declined_at,
      s.code AS supplier_code,
      e.event_number, e.status AS event_status, e.deadline_at
    FROM sourcing_invitations i
    JOIN sourcing_events e ON e.id = i.event_id
    JOIN suppliers s ON s.id = i.supplier_id
    WHERE i.id = ?
  `).get(invitationId);
  return {
    invitation_id: Number(row.invitation_id),
    event_id: Number(row.event_id),
    supplier_id: Number(row.supplier_id),
    supplier_code: row.supplier_code,
    contact_email: row.contact_email,
    event_number: row.event_number,
    event_status: row.event_status,
    deadline_at: row.deadline_at,
    declined_at: row.declined_at
  };
}

export async function withdrawPortalBid(db, ctx, now = new Date()) {
  await closeDueEvents(db, now, { limit: 20 });
  const fresh = await reloadCtx(db, ctx.invitation_id);
  assertOpenForWrite(fresh, now);
  const stamp = utcIso(now);
  const changed = await db.immediateTransaction(async () => {
    const result = await db.prepare(`
      UPDATE sourcing_bids
      SET status = 'withdrawn', withdrawn_at = ?
      WHERE invitation_id = ? AND status = 'submitted'
        AND EXISTS (
          SELECT 1 FROM sourcing_events e
          WHERE e.id = sourcing_bids.event_id AND e.status = 'published' AND e.deadline_at > ?
        )
    `).run(stamp, fresh.invitation_id, stamp);
    if (!result.changes) return 0;
    await writeSupplierCompliance(db, fresh, 'SOURCING_BID_WITHDRAWN', {}, now);
    return result.changes;
  })();
  if (!changed) fail('There is no submitted bid to withdraw.', 409, 'bid_not_submitted');
  return ownBid(db, fresh.invitation_id);
}

export async function declinePortalInvitation(db, ctx, input = {}, now = new Date()) {
  await closeDueEvents(db, now, { limit: 20 });
  const fresh = await reloadCtx(db, ctx.invitation_id);
  assertOpenForWrite(fresh, now);
  const reason = input.reason == null ? null : String(input.reason).trim();
  if (reason && reason.length > 2000) fail('The reason is too long.', 400, 'text_too_long');
  const stamp = utcIso(now);
  const changed = await db.prepare(`
    UPDATE sourcing_invitations
    SET declined_at = ?, decline_reason = ?
    WHERE id = ? AND declined_at IS NULL AND revoked_at IS NULL
      AND EXISTS (
        SELECT 1 FROM sourcing_events e
        WHERE e.id = sourcing_invitations.event_id AND e.status = 'published' AND e.deadline_at > ?
      )
  `).run(stamp, reason || null, fresh.invitation_id, stamp);
  if (!changed.changes) fail(`De inschrijftermijn is gesloten om ${fresh.deadline_at}.`, 409, 'deadline_passed');
  await writeSupplierCompliance(db, fresh, 'SOURCING_INVITATION_DECLINED', { reason: reason || null }, now);
  return { declined_at: stamp };
}

export async function addPortalFile(db, ctx, { buffer, filename } = {}, now = new Date()) {
  await closeDueEvents(db, now, { limit: 20 });
  const fresh = await reloadCtx(db, ctx.invitation_id);
  assertOpenForWrite(fresh, now);
  if (!isPdfBuffer(buffer)) fail('The file is not a PDF.', 400, 'not_a_pdf');
  const activeFiles = await db.prepare(`
    SELECT COUNT(*) AS n FROM sourcing_files
    WHERE invitation_id = ? AND owner_kind = 'bid' AND removed_at IS NULL
  `).get(fresh.invitation_id);
  if (Number(activeFiles?.n || 0) >= MAX_EVENT_FILES) {
    fail(`A bid can have at most ${MAX_EVENT_FILES} files.`, 400, 'too_many_files');
  }
  const usedBytes = await db.prepare(`
    SELECT COALESCE(SUM(size_bytes), 0) AS n FROM sourcing_files
    WHERE invitation_id = ? AND owner_kind = 'bid'
  `).get(fresh.invitation_id);
  if (Number(usedBytes?.n || 0) + buffer.length > MAX_EVENT_FILE_BYTES) {
    fail('The bid attachments exceed 40 MB.', 400, 'event_files_too_large');
  }
  await rateOrFail(db, `inv:${fresh.invitation_id}:upload`, PORTAL_UPLOADS_PER_MINUTE, now, 60000);
  const safeName = safePdfFilename(filename);
  const digest = sha256Pdf(buffer);
  const stamp = utcIso(now);
  const fileId = await db.immediateTransaction(async () => {
    const count = await db.prepare(`
      SELECT COUNT(*) AS n FROM sourcing_files
      WHERE invitation_id = ? AND owner_kind = 'bid' AND removed_at IS NULL
    `).get(fresh.invitation_id);
    if (Number(count?.n || 0) >= MAX_EVENT_FILES) {
      fail(`A bid can have at most ${MAX_EVENT_FILES} files.`, 400, 'too_many_files');
    }
    const used = await db.prepare(`
      SELECT COALESCE(SUM(size_bytes), 0) AS n FROM sourcing_files
      WHERE invitation_id = ? AND owner_kind = 'bid'
    `).get(fresh.invitation_id);
    if (Number(used?.n || 0) + buffer.length > MAX_EVENT_FILE_BYTES) {
      fail('The bid attachments exceed 40 MB.', 400, 'event_files_too_large');
    }
    const open = await db.prepare(`
      SELECT 1 AS ok FROM sourcing_events
      WHERE id = ? AND status = 'published' AND deadline_at > ?
    `).get(fresh.event_id, stamp);
    if (!open) fail(`De inschrijftermijn is gesloten om ${fresh.deadline_at}.`, 409, 'deadline_passed');
    const result = await db.prepare(`
      INSERT INTO sourcing_files (
        event_id, owner_kind, invitation_id, filename, content_type, size_bytes, sha256, created_at
      ) VALUES (?, 'bid', ?, ?, 'application/pdf', ?, ?, ?)
    `).run(fresh.event_id, fresh.invitation_id, safeName, buffer.length, digest, stamp);
    const createdId = Number(result.lastInsertRowid);
    if (!createdId) fail('Failed to store the PDF.', 500, 'sourcing_error');
    await db.prepare(`INSERT INTO sourcing_file_blobs (file_id, bytes) VALUES (?, ?)`).run(createdId, buffer);
    await writeSupplierCompliance(db, fresh, 'SOURCING_BID_FILE_UPLOADED', { file_id: createdId, sha256: digest }, now);
    return createdId;
  })();
  return db.prepare(`
    SELECT id, filename, size_bytes FROM sourcing_files WHERE id = ?
  `).get(fileId);
}

export async function removePortalFile(db, ctx, fileId, now = new Date()) {
  const fresh = await reloadCtx(db, ctx.invitation_id);
  assertOpenForWrite(fresh, now);
  const stamp = utcIso(now);
  const changed = await db.prepare(`
    UPDATE sourcing_files
    SET removed_at = ?
    WHERE id = ? AND invitation_id = ? AND owner_kind = 'bid' AND removed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM sourcing_events e
        WHERE e.id = sourcing_files.event_id AND e.status = 'published' AND e.deadline_at > ?
      )
  `).run(stamp, fileId, fresh.invitation_id, stamp);
  if (!changed.changes) fail('File was not found.', 404, 'file_not_found');
  return { id: Number(fileId), removed_at: stamp };
}

export async function readPortalFile(db, ctx, fileId) {
  const id = Number(fileId);
  const meta = await db.prepare(`
    SELECT id, filename, content_type, size_bytes, owner_kind, invitation_id, event_id, removed_at
    FROM sourcing_files
    WHERE id = ? AND event_id = ? AND removed_at IS NULL
      AND (
        (owner_kind = 'event' AND invitation_id IS NULL)
        OR (owner_kind = 'bid' AND invitation_id = ?)
      )
  `).get(id, ctx.event_id, ctx.invitation_id);
  if (!meta) fail('File was not found.', 404, 'file_not_found');
  const blob = await db.prepare(`SELECT bytes FROM sourcing_file_blobs WHERE file_id = ?`).get(meta.id);
  if (!blob?.bytes) fail('File was not found.', 404, 'file_not_found');
  return meta.bytes ? { ...meta, bytes: blob.bytes } : { ...meta, bytes: blob.bytes };
}

async function listOwnQuestions(db, ctx) {
  const rows = await db.prepare(`
    SELECT id, question, asked_at, answer, answered_at, visibility, invitation_id
    FROM sourcing_questions
    WHERE event_id = ? AND (invitation_id = ? OR (visibility = 'all' AND answer IS NOT NULL))
    ORDER BY id ASC
  `).all(ctx.event_id, ctx.invitation_id);
  return rows.map((row) => ({
    id: row.id,
    question: Number(row.invitation_id) === Number(ctx.invitation_id) || row.visibility === 'all' ? row.question : null,
    asked_at: row.asked_at,
    answer: row.answer,
    answered_at: row.answered_at,
    visibility: row.visibility,
    own: Number(row.invitation_id) === Number(ctx.invitation_id)
  })).map((row) => {
    if (!row.own && row.visibility === 'all') {
      return {
        id: row.id,
        question: row.question,
        asked_at: row.asked_at,
        answer: row.answer,
        answered_at: row.answered_at,
        visibility: 'all',
        own: false
      };
    }
    return row;
  });
}

export async function askPortalQuestion(db, ctx, input, now = new Date()) {
  const fresh = await reloadCtx(db, ctx.invitation_id);
  const event = await db.prepare(`
    SELECT qa_enabled, qa_deadline_at, status, deadline_at FROM sourcing_events WHERE id = ?
  `).get(fresh.event_id);
  if (Number(event?.qa_enabled) !== 1) fail('Questions are not open on this RFQ.', 409, 'qa_closed');
  assertOpenForWrite(fresh, now);
  const qaDeadline = event.qa_deadline_at ? Date.parse(event.qa_deadline_at) : Date.parse(event.deadline_at);
  if (Number.isFinite(qaDeadline) && qaDeadline <= now.getTime()) fail('The question deadline has passed.', 409, 'qa_closed');
  const question = String(input?.question || '').trim();
  if (!question || question.length > 4000) fail('A question is required.', 400, 'question_required');
  const stamp = utcIso(now);
  const result = await db.prepare(`
    INSERT INTO sourcing_questions (event_id, invitation_id, question, asked_at)
    SELECT ?, ?, ?, ?
    FROM sourcing_events e
    WHERE e.id = ? AND e.status = 'published' AND e.qa_enabled = 1
  `).run(fresh.event_id, fresh.invitation_id, question, stamp, fresh.event_id);
  if (!result.changes) fail('Questions are not open on this RFQ.', 409, 'qa_closed');
  return { id: Number(result.lastInsertRowid), question, asked_at: stamp };
}

export function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const match = /^Bearer\s+(\S+)$/i.exec(String(header));
  return match ? match[1] : null;
}

export { hashPortalToken };
