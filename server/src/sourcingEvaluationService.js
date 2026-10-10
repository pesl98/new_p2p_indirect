/**
 * RFQ evaluation (Sprint 8c): comparison matrix with scores, conflict-of-interest
 * declarations, evaluator quality scores, and "Beoordeling afronden".
 * Bid prices are read through sourcingBidReadModel.js only.
 */

import { actorFromSession, appendComplianceEvent, utcTimestamp } from './complianceAudit.js';
import { loadBuyerComparison } from './sourcingBidReadModel.js';
import { utcIso } from './sourcingConfig.js';
import {
  assertOwner,
  closeDueEvents,
  fail,
  loadEventRow,
  writeAudit
} from './sourcingService.js';
import { round1, scoreBids } from './sourcingScoring.js';
import { assertTransition } from './sourcingStatus.js';

const COI_STATUSES = ['none_declared', 'conflict_declared'];

async function loadLines(db, eventId) {
  return db.prepare(`
    SELECT id, line_no, description, category, quantity, unit_of_measure, line_type,
           service_basis, catalog_item_id, target_unit_price_cents
    FROM sourcing_event_lines WHERE event_id = ? ORDER BY line_no ASC
  `).all(eventId);
}

async function qualityAverages(db, eventId) {
  const rows = await db.prepare(`
    SELECT s.bid_id, AVG(s.quality_score) AS average
    FROM sourcing_scores s
    JOIN sourcing_evaluators ev
      ON ev.event_id = s.event_id AND ev.user_id = s.evaluator_user_id AND ev.coi_status = 'none_declared'
    WHERE s.event_id = ?
    GROUP BY s.bid_id
  `).all(eventId);
  return new Map(rows.map((row) => [Number(row.bid_id), Number(row.average)]));
}

/** Matrix + scores from a comparison that is not sealed. */
export async function buildMatrix(db, event, comparison) {
  const lines = await loadLines(db, event.id);
  const quality = await qualityAverages(db, event.id);
  const supplierByInvitation = new Map(comparison.invitations.map((row) => [Number(row.id), row]));
  const bids = comparison.bids.map((bid) => ({
    ...bid,
    first_submitted_at: bid.submitted_at
  }));
  const firstSubmit = await db.prepare(`
    SELECT id, first_submitted_at FROM sourcing_bids WHERE event_id = ?
  `).all(event.id);
  const firstByBid = new Map(firstSubmit.map((row) => [Number(row.id), row.first_submitted_at]));
  const scored = scoreBids({
    event,
    lines,
    bids: bids.map((bid) => ({
      bid_id: bid.bid_id,
      status: bid.status,
      total_cents: bid.total_cents,
      default_lead_time_days: bid.default_lead_time_days,
      first_submitted_at: firstByBid.get(Number(bid.bid_id)) || bid.first_submitted_at,
      lines: bid.lines
    })),
    quality
  });
  const byBid = new Map(scored.bids.map((row) => [Number(row.bid_id), row]));
  return {
    lines,
    lowest_per_line: scored.lowest_per_line,
    lowest_complete_total_cents: scored.lowest_complete_total_cents,
    min_lead_time_days: scored.min_lead_time_days,
    bids: comparison.bids.map((bid) => {
      const row = byBid.get(Number(bid.bid_id));
      const invite = supplierByInvitation.get(Number(bid.invitation_id));
      return {
        bid_id: bid.bid_id,
        invitation_id: bid.invitation_id,
        supplier_id: invite?.supplier_id ?? null,
        supplier_name: invite?.supplier_name ?? null,
        supplier_code: invite?.supplier_code ?? null,
        status: bid.status,
        revision: bid.revision,
        total_cents: bid.total_cents,
        validity_until: bid.validity_until,
        complete: row?.complete ?? false,
        lead_time_days: row?.lead_time_days ?? null,
        is_lowest_complete_total: row?.is_lowest_complete_total ?? false,
        quality_average: row?.quality_average ?? null,
        price_score: row?.price_score == null ? null : round1(row.price_score),
        lead_score: row?.lead_score == null ? null : round1(row.lead_score),
        quality_score: row?.quality_score == null ? null : round1(row.quality_score),
        total_score: row?.total_score == null ? null : round1(row.total_score),
        rank: row?.rank ?? null,
        lines: bid.lines.map((line) => ({
          ...line,
          is_line_lowest: line.quoted && scored.lowest_per_line[line.event_line_id] === line.unit_price_cents
        }))
      };
    })
  };
}

export async function buyerEvaluation(db, actor, id, now = new Date()) {
  await closeDueEvents(db, now, { eventId: id });
  const event = await loadEventRow(db, id);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  const comparison = await loadBuyerComparison(db, event, actor, now);
  const evaluators = await db.prepare(`
    SELECT ev.user_id, ev.coi_status, ev.coi_declared_at, ev.coi_note, u.name AS user_name
    FROM sourcing_evaluators ev JOIN users u ON u.id = ev.user_id
    WHERE ev.event_id = ? ORDER BY ev.id ASC
  `).all(event.id);
  const view = {
    ...comparison,
    status: event.status,
    row_version: event.row_version,
    weights: {
      price: event.weight_price,
      lead_time: event.weight_lead_time,
      quality: event.weight_quality
    },
    owner_user_id: event.owner_user_id,
    evaluators,
    my_coi_status: evaluators.find((row) => Number(row.user_id) === Number(actor.id))?.coi_status || null
  };
  if (comparison.sealed) return view;
  view.matrix = await buildMatrix(db, event, comparison);
  view.my_scores = (await db.prepare(`
    SELECT bid_id, quality_score, comment FROM sourcing_scores
    WHERE event_id = ? AND evaluator_user_id = ?
  `).all(event.id, actor.id)).map((row) => ({ ...row }));
  return view;
}

export async function declareCoi(db, actor, id, input = {}, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  await closeDueEvents(db, nowDate, { eventId: id });
  const event = await loadEventRow(db, id);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  const status = String(input.status || '');
  if (!COI_STATUSES.includes(status)) {
    fail('status must be none_declared or conflict_declared.', 400, 'invalid_coi_status');
  }
  const note = input.note == null ? '' : String(input.note).trim();
  if (status === 'conflict_declared' && note.length < 5) {
    fail('A conflict declaration needs a note of at least 5 characters.', 400, 'coi_note_required');
  }
  if (note.length > 1000) fail('The note is too long.', 400, 'text_too_long');
  if (!['published', 'closed'].includes(event.status)) {
    fail('Conflict declarations are closed for this RFQ.', 409, 'event_state_changed');
  }
  const isOwner = Number(event.owner_user_id) === Number(actor.id);
  const existing = await db.prepare(`
    SELECT id FROM sourcing_evaluators WHERE event_id = ? AND user_id = ?
  `).get(event.id, actor.id);
  if (!existing && !isOwner) fail('You are not an evaluator on this RFQ.', 403, 'not_evaluator');
  const now = utcIso(nowDate);
  await db.immediateTransaction(async () => {
    if (existing) {
      await db.prepare(`
        UPDATE sourcing_evaluators SET coi_status = ?, coi_declared_at = ?, coi_note = ?
        WHERE id = ?
      `).run(status, now, note || null, existing.id);
    } else {
      await db.prepare(`
        INSERT INTO sourcing_evaluators (event_id, user_id, coi_status, coi_declared_at, coi_note, added_by_user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(event.id, actor.id, status, now, note || null, actor.id, now);
    }
    await writeAudit(db, 'sourcing_event', event.id, 'COI_DECLARED', actor.name,
      `${actor.name} declared ${status === 'none_declared' ? 'no conflict of interest' : 'a possible conflict of interest'} on ${event.event_number}`);
    await appendComplianceEvent(db, {
      ...actorFromSession(actor),
      action: 'SOURCING_COI_DECLARED',
      entity_type: 'sourcing_event',
      entity_id: event.id,
      details: JSON.stringify({ status, note: note || null, as_owner: isOwner }),
      created_at: utcTimestamp(nowDate)
    });
  })();
  return buyerEvaluation(db, actor, event.id, nowDate);
}

export async function recordScores(db, actor, id, input = {}, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  await closeDueEvents(db, nowDate, { eventId: id });
  const event = await loadEventRow(db, id);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  if (event.status !== 'closed') fail('Scores can only be recorded while the RFQ is closed.', 409, 'event_state_changed');
  const evaluator = await db.prepare(`
    SELECT coi_status FROM sourcing_evaluators WHERE event_id = ? AND user_id = ?
  `).get(event.id, actor.id);
  if (!evaluator || evaluator.coi_status !== 'none_declared') {
    fail('Only evaluators who declared no conflict can score.', 403, 'not_evaluator');
  }
  const items = Array.isArray(input.scores) ? input.scores : null;
  if (!items || items.length === 0 || items.length > 50) {
    fail('scores must be a list of 1 to 50 entries.', 400, 'invalid_scores');
  }
  const seen = new Set();
  const parsed = items.map((item) => {
    const bidId = Number(item?.bid_id);
    const score = Number(item?.quality_score);
    if (!Number.isInteger(bidId) || bidId <= 0 || seen.has(bidId)) fail('Each score needs a unique bid_id.', 400, 'invalid_scores');
    if (!Number.isInteger(score) || score < 0 || score > 10) fail('quality_score must be an integer from 0 to 10.', 400, 'invalid_scores');
    seen.add(bidId);
    const comment = item.comment == null ? null : String(item.comment).trim().slice(0, 1000) || null;
    return { bidId, score, comment };
  });
  const bids = await db.prepare(`SELECT id FROM sourcing_bids WHERE event_id = ? AND status = 'submitted'`).all(event.id);
  const valid = new Set(bids.map((row) => Number(row.id)));
  for (const item of parsed) {
    if (!valid.has(item.bidId)) fail('A score names a bid that is not part of this RFQ.', 400, 'invalid_scores');
  }
  const now = utcIso(nowDate);
  await db.immediateTransaction(async () => {
    for (const item of parsed) {
      await db.prepare(`
        INSERT INTO sourcing_scores (event_id, bid_id, evaluator_user_id, quality_score, comment, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (event_id, bid_id, evaluator_user_id)
        DO UPDATE SET quality_score = excluded.quality_score, comment = excluded.comment, updated_at = excluded.updated_at
      `).run(event.id, item.bidId, actor.id, item.score, item.comment, now, now);
    }
    await appendComplianceEvent(db, {
      ...actorFromSession(actor),
      action: 'SOURCING_SCORES_RECORDED',
      entity_type: 'sourcing_event',
      entity_id: event.id,
      details: JSON.stringify({ bid_ids: parsed.map((item) => item.bidId), count: parsed.length }),
      created_at: utcTimestamp(nowDate)
    });
  })();
  return buyerEvaluation(db, actor, event.id, nowDate);
}

/** "Beoordeling afronden": closed -> evaluated. */
export async function completeEvaluation(db, actor, id, input = {}, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  await closeDueEvents(db, nowDate, { eventId: id });
  const event = await loadEventRow(db, id);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  assertOwner(actor, event);
  if (event.status !== 'closed') fail('Only a closed RFQ can be evaluated.', 409, 'event_state_changed');
  assertTransition('closed', 'evaluated');

  const bids = await db.prepare(`
    SELECT id FROM sourcing_bids WHERE event_id = ? AND status = 'submitted'
  `).all(event.id);
  if (bids.length === 0) fail('There are no submitted bids to evaluate.', 409, 'no_bids');

  const blockers = [];
  const evaluators = await db.prepare(`SELECT user_id, coi_status FROM sourcing_evaluators WHERE event_id = ?`).all(event.id);
  const ownerRow = evaluators.find((row) => Number(row.user_id) === Number(event.owner_user_id));
  if (!ownerRow || ownerRow.coi_status === 'pending' || evaluators.some((row) => row.coi_status === 'pending')) {
    blockers.push('coi_pending');
  }
  if (Number(event.weight_quality) > 0) {
    const scored = await db.prepare(`
      SELECT COUNT(DISTINCT bid_id) AS n FROM sourcing_scores WHERE event_id = ?
    `).get(event.id);
    if (Number(scored?.n || 0) < bids.length) blockers.push('scores_missing');
  }
  const override = input.override_reason == null ? '' : String(input.override_reason).trim();
  if (blockers.length && override.length < 10) {
    const error = new Error('The evaluation cannot be completed yet. Provide an override reason of at least 10 characters.');
    error.statusCode = 409;
    error.code = blockers[0];
    error.blockers = blockers;
    throw error;
  }

  const now = utcIso(nowDate);
  await db.immediateTransaction(async () => {
    const result = await db.prepare(`
      UPDATE sourcing_events
      SET status = 'evaluated', evaluated_at = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ? AND status = 'closed'
    `).run(now, now, event.id);
    if (!result.changes) fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
    await writeAudit(db, 'sourcing_event', event.id, 'EVALUATED', actor.name,
      `RFQ ${event.event_number} evaluation completed${blockers.length ? ` (override: ${override})` : ''}`);
    await appendComplianceEvent(db, {
      ...actorFromSession(actor),
      action: 'SOURCING_EVENT_EVALUATED',
      entity_type: 'sourcing_event',
      entity_id: event.id,
      details: JSON.stringify({ override_reason: blockers.length ? override : null, blockers }),
      created_at: utcTimestamp(nowDate)
    });
  })();
  return buyerEvaluation(db, actor, event.id, nowDate);
}

/** Admin only. Used when the owner declared a conflict. */
export async function reassignOwner(db, actor, id, input = {}, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  if (actor?.role !== 'admin') fail('Only an admin can reassign the RFQ owner.', 403, 'admin_required');
  const event = await loadEventRow(db, id);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  if (['awarded', 'cancelled'].includes(event.status)) fail('This RFQ can no longer change owner.', 409, 'event_state_changed');
  const open = await db.prepare(`
    SELECT id FROM sourcing_awards WHERE event_id = ? AND status = 'pending_approval'
  `).get(event.id);
  if (open) fail('An award is waiting for approval.', 409, 'award_already_open');
  const userId = Number(input.user_id);
  const reason = String(input.reason || '').trim();
  if (reason.length < 10) fail('A reason of at least 10 characters is required.', 400, 'reason_required');
  const next = Number.isInteger(userId)
    ? await db.prepare(`SELECT id, name, role FROM users WHERE id = ? AND COALESCE(status, 'active') = 'active'`).get(userId)
    : null;
  if (!next || !['procurement', 'admin'].includes(next.role)) {
    fail('The new owner must be an active procurement or admin user.', 400, 'invalid_owner');
  }
  const now = utcIso(nowDate);
  await db.immediateTransaction(async () => {
    const result = await db.prepare(`
      UPDATE sourcing_events SET owner_user_id = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ? AND status NOT IN ('awarded', 'cancelled')
    `).run(next.id, now, event.id);
    if (!result.changes) fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
    await writeAudit(db, 'sourcing_event', event.id, 'OWNER_REASSIGNED', actor.name,
      `RFQ ${event.event_number} owner changed to ${next.name}: ${reason}`);
    await appendComplianceEvent(db, {
      ...actorFromSession(actor),
      action: 'SOURCING_OWNER_REASSIGNED',
      entity_type: 'sourcing_event',
      entity_id: event.id,
      details: JSON.stringify({ from_user_id: event.owner_user_id, to_user_id: next.id, reason }),
      created_at: utcTimestamp(nowDate)
    });
  })();
  return buyerEvaluation(db, actor, event.id, nowDate);
}
