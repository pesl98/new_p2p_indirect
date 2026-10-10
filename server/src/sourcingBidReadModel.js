/**
 * The only buyer-side reader of bid prices, bid lines, and bid files.
 * Portal code reads the caller's own bid. Every other module stays out
 * of sourcing_bid_lines, sourcing_bid_revisions, and owner_kind = 'bid'.
 *
 * Prices are visible only when now >= deadline_at and the event was not
 * cancelled before that deadline. Sealing is enforced here, not by the database.
 */

import { actorFromSession, appendComplianceEvent, utcTimestamp } from './complianceAudit.js';

function missingFile() {
  const error = new Error('File was not found.');
  error.statusCode = 404;
  error.code = 'file_not_found';
  throw error;
}

export function bidPricesVisible(event, now = new Date()) {
  if (!event || event.status === 'draft') return false;
  const deadline = event.deadline_at ? Date.parse(event.deadline_at) : NaN;
  const instant = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(deadline) || !Number.isFinite(instant) || instant < deadline) return false;
  if (event.status === 'cancelled' && Number(event.cancelled_before_deadline) === 1) return false;
  return true;
}

export function actorMaySeeBidPrices(actor, event, evaluators = []) {
  if (!actor) return false;
  const row = evaluators.find((item) => Number(item.user_id) === Number(actor.id));
  // A declared conflict always wins, for finance and admin too (same rule as the award view).
  if (row?.coi_status === 'conflict_declared') return false;
  if (actor.role === 'admin' || actor.role === 'finance') return true;
  if (Number(event?.owner_user_id) === Number(actor.id)) return true;
  return row?.coi_status === 'none_declared';
}

export async function buyerInvitationActivity(db, eventId) {
  const bids = await db.prepare(`
    SELECT invitation_id, status, first_submitted_at, last_submitted_at, current_revision, withdrawn_at
    FROM sourcing_bids
    WHERE event_id = ?
  `).all(eventId);
  const files = await db.prepare(`
    SELECT invitation_id, COUNT(*) AS n
    FROM sourcing_files
    WHERE event_id = ? AND owner_kind = 'bid' AND removed_at IS NULL
    GROUP BY invitation_id
  `).all(eventId);
  const byInvite = new Map(bids.map((row) => [Number(row.invitation_id), row]));
  const fileCount = new Map(files.map((row) => [Number(row.invitation_id), Number(row.n)]));
  return { byInvite, fileCount };
}

function invitationPortalStatus(invitation, bid, now) {
  if (invitation.revoked_at) return 'revoked';
  if (invitation.declined_at) return 'declined';
  if (bid?.status === 'withdrawn') return 'withdrawn';
  if (bid?.status === 'submitted') return 'submitted';
  const expires = invitation.expires_at ? Date.parse(invitation.expires_at) : NaN;
  const instant = now instanceof Date ? now.getTime() : Date.parse(now);
  if (Number.isFinite(expires) && expires <= instant) return 'expired';
  if (invitation.first_opened_at) return 'opened';
  return 'invited';
}

export function presentInvitationActivity(invitation, activity, now) {
  const bid = activity.byInvite.get(Number(invitation.id));
  return {
    portal_status: invitationPortalStatus(invitation, bid, now),
    submitted_at: bid?.first_submitted_at || null,
    revision_count: bid ? Number(bid.current_revision) : 0,
    attachment_count: activity.fileCount.get(Number(invitation.id)) || 0
  };
}

async function recordBidsOpened(db, actor, event, now) {
  const existing = await db.prepare(`
    SELECT id FROM compliance_audit_events
    WHERE action = 'SOURCING_BIDS_OPENED'
      AND entity_type = 'sourcing_event'
      AND entity_id = ?
      AND actor_user_id = ?
    LIMIT 1
  `).get(event.id, actor.id);
  if (existing) return;
  await appendComplianceEvent(db, {
    ...actorFromSession(actor),
    action: 'SOURCING_BIDS_OPENED',
    entity_type: 'sourcing_event',
    entity_id: event.id,
    details: JSON.stringify({ event_number: event.event_number }),
    created_at: utcTimestamp(now)
  });
}

export async function loadBuyerComparison(db, event, actor, now = new Date()) {
  const evaluators = await db.prepare(`
    SELECT user_id, coi_status FROM sourcing_evaluators WHERE event_id = ?
  `).all(event.id);
  const activity = await buyerInvitationActivity(db, event.id);
  const invitations = await db.prepare(`
    SELECT i.id, i.supplier_id, i.contact_name, i.contact_email, i.delivery_status, i.token_prefix,
           i.expires_at, i.revoked_at, i.declined_at, i.first_opened_at,
           s.name AS supplier_name, s.code AS supplier_code
    FROM sourcing_invitations i
    JOIN suppliers s ON s.id = i.supplier_id
    WHERE i.event_id = ?
    ORDER BY i.id ASC
  `).all(event.id);
  const rows = invitations.map((invitation) => ({
    id: invitation.id,
    supplier_id: invitation.supplier_id,
    supplier_name: invitation.supplier_name,
    supplier_code: invitation.supplier_code,
    contact_name: invitation.contact_name,
    contact_email: invitation.contact_email,
    delivery_status: invitation.delivery_status,
    token_prefix: invitation.token_prefix,
    ...presentInvitationActivity(invitation, activity, now)
  }));
  const visible = bidPricesVisible(event, now);
  if (!visible) {
    return {
      sealed: true,
      deadline_at: event.deadline_at,
      server_now: now.toISOString(),
      invitations: rows
    };
  }
  if (!actorMaySeeBidPrices(actor, event, evaluators)) {
    return {
      sealed: true,
      prices_hidden: true,
      deadline_at: event.deadline_at,
      server_now: now.toISOString(),
      invitations: rows
    };
  }
  await recordBidsOpened(db, actor, event, now);
  const revisions = await db.prepare(`
    SELECT b.id AS bid_id, b.invitation_id, b.status AS bid_status,
           r.revision, r.total_cents, r.quoted_line_count, r.validity_until,
           r.default_lead_time_days, r.supplier_note, r.content_sha256, r.submitted_at
    FROM sourcing_bids b
    JOIN sourcing_bid_revisions r ON r.bid_id = b.id AND r.revision = b.current_revision
    WHERE b.event_id = ?
  `).all(event.id);
  const lines = await db.prepare(`
    SELECT l.bid_id, l.revision, l.event_line_id, l.quoted, l.unit_price_cents,
           l.line_total_cents, l.lead_time_days, l.comment
    FROM sourcing_bid_lines l
    JOIN sourcing_bids b ON b.id = l.bid_id AND b.current_revision = l.revision
    WHERE b.event_id = ?
  `).all(event.id);
  const files = await db.prepare(`
    SELECT id, invitation_id, filename, size_bytes, sha256, created_at
    FROM sourcing_files
    WHERE event_id = ? AND owner_kind = 'bid' AND removed_at IS NULL
    ORDER BY id ASC
  `).all(event.id);
  const linesByBid = new Map();
  for (const line of lines) {
    const key = Number(line.bid_id);
    if (!linesByBid.has(key)) linesByBid.set(key, []);
    linesByBid.get(key).push({
      event_line_id: line.event_line_id,
      quoted: Number(line.quoted) === 1,
      unit_price_cents: line.unit_price_cents,
      line_total_cents: line.line_total_cents,
      lead_time_days: line.lead_time_days,
      comment: line.comment
    });
  }
  return {
    sealed: false,
    deadline_at: event.deadline_at,
    server_now: now.toISOString(),
    invitations: rows,
    bids: revisions.map((revision) => ({
      bid_id: revision.bid_id,
      invitation_id: revision.invitation_id,
      status: revision.bid_status,
      revision: revision.revision,
      total_cents: revision.total_cents,
      quoted_line_count: revision.quoted_line_count,
      validity_until: revision.validity_until,
      default_lead_time_days: revision.default_lead_time_days,
      supplier_note: revision.supplier_note,
      content_sha256: revision.content_sha256,
      submitted_at: revision.submitted_at,
      lines: linesByBid.get(Number(revision.bid_id)) || [],
      files: files.filter((file) => Number(file.invitation_id) === Number(revision.invitation_id))
    }))
  };
}

export async function readBuyerBidFile(db, event, actor, fileId, now = new Date()) {
  if (!bidPricesVisible(event, now)) missingFile();
  const evaluators = await db.prepare(`
    SELECT user_id, coi_status FROM sourcing_evaluators WHERE event_id = ?
  `).all(event.id);
  if (!actorMaySeeBidPrices(actor, event, evaluators)) missingFile();
  const meta = await db.prepare(`
    SELECT id, filename, content_type, size_bytes
    FROM sourcing_files
    WHERE id = ? AND event_id = ? AND owner_kind = 'bid' AND removed_at IS NULL
  `).get(fileId, event.id);
  if (!meta) missingFile();
  const blob = await db.prepare(`
    SELECT bytes FROM sourcing_file_blobs WHERE file_id = ?
  `).get(meta.id);
  if (!blob?.bytes) missingFile();
  await recordBidsOpened(db, actor, event, now);
  return { ...meta, bytes: blob.bytes };
}
