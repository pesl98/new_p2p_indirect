/**
 * The only buyer-side reader of bid prices, bid lines, and bid files.
 * Portal code reads the caller's own bid. Every other module stays out
 * of sourcing_bid_lines, sourcing_bid_revisions, and owner_kind = 'bid'.
 *
 * Prices are visible only when now >= deadline_at and the event was not
 * cancelled before that deadline. Sealing is enforced here, not by the database.
 */

import { actorFromSession, appendComplianceEvent, utcTimestamp } from './complianceAudit.js';
import { scoreComparison } from './sourcingScore.js';

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
  if (actor.role === 'admin' || actor.role === 'finance') return true;
  if (Number(event?.owner_user_id) === Number(actor.id)) return true;
  const row = evaluators.find((item) => Number(item.user_id) === Number(actor.id));
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

async function loadBidSheet(db, eventId) {
  const revisions = await db.prepare(`
    SELECT b.id AS bid_id, b.invitation_id, b.supplier_id, b.status AS bid_status,
           b.first_submitted_at,
           r.revision, r.total_cents, r.quoted_line_count, r.validity_until,
           r.default_lead_time_days, r.supplier_note, r.content_sha256, r.submitted_at,
           i.contact_email, s.name AS supplier_name, s.code AS supplier_code, s.status AS supplier_status
    FROM sourcing_bids b
    JOIN sourcing_bid_revisions r ON r.bid_id = b.id AND r.revision = b.current_revision
    JOIN sourcing_invitations i ON i.id = b.invitation_id
    JOIN suppliers s ON s.id = b.supplier_id
    WHERE b.event_id = ?
    ORDER BY b.id ASC
  `).all(eventId);
  const lines = await db.prepare(`
    SELECT l.bid_id, l.revision, l.event_line_id, l.quoted, l.unit_price_cents,
           l.line_total_cents, l.lead_time_days, l.comment
    FROM sourcing_bid_lines l
    JOIN sourcing_bids b ON b.id = l.bid_id AND b.current_revision = l.revision
    WHERE b.event_id = ?
  `).all(eventId);
  const linesByBid = new Map();
  for (const line of lines) {
    const key = Number(line.bid_id);
    if (!linesByBid.has(key)) linesByBid.set(key, []);
    linesByBid.get(key).push({
      event_line_id: Number(line.event_line_id),
      quoted: Number(line.quoted) === 1,
      unit_price_cents: line.unit_price_cents == null ? null : Number(line.unit_price_cents),
      line_total_cents: line.line_total_cents == null ? null : Number(line.line_total_cents),
      lead_time_days: line.lead_time_days == null ? null : Number(line.lead_time_days),
      comment: line.comment
    });
  }
  return revisions.map((revision) => ({
    bid_id: Number(revision.bid_id),
    invitation_id: Number(revision.invitation_id),
    supplier_id: Number(revision.supplier_id),
    supplier_name: revision.supplier_name,
    supplier_code: revision.supplier_code,
    supplier_status: revision.supplier_status,
    contact_email: revision.contact_email,
    status: revision.bid_status,
    revision: Number(revision.revision),
    total_cents: Number(revision.total_cents),
    quoted_line_count: Number(revision.quoted_line_count),
    validity_until: revision.validity_until,
    default_lead_time_days: revision.default_lead_time_days == null ? null : Number(revision.default_lead_time_days),
    supplier_note: revision.supplier_note,
    content_sha256: revision.content_sha256,
    submitted_at: revision.submitted_at,
    first_submitted_at: revision.first_submitted_at,
    lines: linesByBid.get(Number(revision.bid_id)) || []
  }));
}

async function loadQualityScores(db, eventId) {
  return db.prepare(`
    SELECT s.bid_id, s.evaluator_user_id, s.quality_score, s.comment, u.name AS evaluator_name
    FROM sourcing_scores s
    JOIN users u ON u.id = s.evaluator_user_id
    WHERE s.event_id = ?
    ORDER BY s.id ASC
  `).all(eventId);
}

export async function loadAwardBidSheet(db, event, now = new Date()) {
  if (!bidPricesVisible(event, now)) {
    const error = new Error('Bids are sealed.');
    error.statusCode = 409;
    error.code = 'bids_sealed';
    throw error;
  }
  const [eventLines, bids, scores, evaluators] = await Promise.all([
    db.prepare(`
      SELECT id, line_no, description, category, quantity, unit_of_measure, line_type, service_basis, catalog_item_id
      FROM sourcing_event_lines WHERE event_id = ? ORDER BY line_no ASC
    `).all(event.id),
    loadBidSheet(db, event.id),
    loadQualityScores(db, event.id),
    db.prepare(`
      SELECT ev.user_id, ev.coi_status, ev.coi_note, u.name AS user_name
      FROM sourcing_evaluators ev
      JOIN users u ON u.id = ev.user_id
      WHERE ev.event_id = ?
    `).all(event.id)
  ]);
  return { eventLines, bids, scores, evaluators };
}

export async function findLateBidRevisions(db) {
  return db.prepare(`
    SELECT r.id AS revision_id, b.event_id, e.event_number, r.submitted_at, e.deadline_at
    FROM sourcing_bid_revisions r
    JOIN sourcing_bids b ON b.id = r.bid_id
    JOIN sourcing_events e ON e.id = b.event_id
    WHERE r.submitted_at >= e.deadline_at
  `).all();
}

export async function loadBuyerComparison(db, event, actor, now = new Date()) {
  const evaluators = await db.prepare(`
    SELECT ev.user_id, ev.coi_status, ev.coi_note, u.name AS user_name
    FROM sourcing_evaluators ev
    JOIN users u ON u.id = ev.user_id
    WHERE ev.event_id = ?
  `).all(event.id);
  const activity = await buyerInvitationActivity(db, event.id);
  const invitations = await db.prepare(`
    SELECT i.id, i.contact_name, i.contact_email, i.delivery_status, i.token_prefix,
           i.expires_at, i.revoked_at, i.declined_at, i.first_opened_at,
           s.name AS supplier_name, s.code AS supplier_code
    FROM sourcing_invitations i
    JOIN suppliers s ON s.id = i.supplier_id
    WHERE i.event_id = ?
    ORDER BY i.id ASC
  `).all(event.id);
  const rows = invitations.map((invitation) => ({
    id: invitation.id,
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
  const sheet = await loadBidSheet(db, event.id);
  const eventLines = await db.prepare(`
    SELECT id, line_no, description, quantity, unit_of_measure
    FROM sourcing_event_lines WHERE event_id = ? ORDER BY line_no ASC
  `).all(event.id);
  const qualityRows = await loadQualityScores(db, event.id);
  const eligibleEvaluators = new Set(
    evaluators.filter((row) => row.coi_status === 'none_declared').map((row) => Number(row.user_id))
  );
  const qualityByBid = new Map();
  const notesByBid = new Map();
  for (const row of qualityRows) {
    if (!eligibleEvaluators.has(Number(row.evaluator_user_id))) continue;
    const key = Number(row.bid_id);
    if (!qualityByBid.has(key)) qualityByBid.set(key, []);
    qualityByBid.get(key).push(Number(row.quality_score));
    if (!notesByBid.has(key)) notesByBid.set(key, []);
    notesByBid.get(key).push({
      evaluator_user_id: Number(row.evaluator_user_id),
      evaluator_name: row.evaluator_name,
      quality_score: Number(row.quality_score),
      comment: row.comment
    });
  }
  const files = await db.prepare(`
    SELECT id, invitation_id, filename, size_bytes, sha256, created_at
    FROM sourcing_files
    WHERE event_id = ? AND owner_kind = 'bid' AND removed_at IS NULL
    ORDER BY id ASC
  `).all(event.id);
  const scored = scoreComparison({
    lines: eventLines,
    bids: sheet,
    weights: {
      price: Number(event.weight_price),
      lead: Number(event.weight_lead_time),
      quality: Number(event.weight_quality)
    },
    qualityByBid
  });
  const byBid = new Map(scored.bids.map((bid) => [bid.bid_id, bid]));
  const quoteCount = sheet.filter((bid) => bid.status !== 'withdrawn').length;
  const comparable = scored.lowest_complete_total_cents;
  const fewQuotes = quoteCount < 3 && (
    Number(event.target_total_cents || 0) > 1_000_000
    || (comparable != null && comparable > 1_000_000)
  );
  return {
    sealed: false,
    deadline_at: event.deadline_at,
    server_now: now.toISOString(),
    weights: {
      price: Number(event.weight_price),
      lead_time: Number(event.weight_lead_time),
      quality: Number(event.weight_quality)
    },
    invitations: rows,
    lines: eventLines,
    lowest_complete_total_cents: scored.lowest_complete_total_cents,
    quote_count: quoteCount,
    warnings: fewQuotes ? ['few_quotes'] : [],
    evaluators: evaluators.map((row) => ({
      user_id: Number(row.user_id),
      coi_status: row.coi_status,
      coi_note: row.coi_note || null,
      user_name: row.user_name || null
    })),
    matrix: sheet.map((bid) => {
      const score = byBid.get(bid.bid_id);
      return {
        ...score,
        supplier_name: bid.supplier_name,
        supplier_code: bid.supplier_code,
        supplier_note: bid.supplier_note,
        evaluator_notes: notesByBid.get(bid.bid_id) || []
      };
    }),
    bids: sheet.map((bid) => ({
      invitation_id: bid.invitation_id,
      bid_id: bid.bid_id,
      status: bid.status,
      revision: bid.revision,
      total_cents: bid.total_cents,
      quoted_line_count: bid.quoted_line_count,
      validity_until: bid.validity_until,
      default_lead_time_days: bid.default_lead_time_days,
      supplier_note: bid.supplier_note,
      content_sha256: bid.content_sha256,
      submitted_at: bid.submitted_at,
      lines: bid.lines,
      files: files.filter((file) => Number(file.invitation_id) === Number(bid.invitation_id)),
      rank: byBid.get(bid.bid_id)?.rank ?? null,
      scores: byBid.get(bid.bid_id)?.scores ?? null
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
