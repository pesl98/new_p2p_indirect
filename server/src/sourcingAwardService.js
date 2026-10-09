/**
 * Comparison scoring is applied here only through the bid read model.
 * Award and purchase-order creation are idempotent: one open award per event,
 * and one PO per awarded supplier.
 */

import { createHash } from 'node:crypto';
import { actorFromSession, appendComplianceEvent, utcTimestamp } from './complianceAudit.js';
import { buildApprovalSteps } from './approvalPolicy.js';
import { APPROVAL_TIER3_CENTS } from './money.js';
import { issueAwardPurchaseOrders } from './purchaseOrdersService.js';
import { insertAwardRequisition } from './requisitionsService.js';
import { loadAwardBidSheet } from './sourcingBidReadModel.js';
import { awardSodThresholdCents } from './sourcingApprovalHooks.js';
import { scoreComparison } from './sourcingScore.js';
import {
  SourcingError,
  closeDueEvents,
  getEvent,
  withBusyRetry
} from './sourcingService.js';
import { assertTransition } from './sourcingStatus.js';
import { enqueueWebhook, kickWebhookDispatch, WEBHOOK_EVENTS } from './webhookOutbox.js';

const SQL_VARIABLE_BUDGET = 900;

function fail(message, statusCode, code) {
  throw new SourcingError(message, statusCode, code);
}

function staff(actor) {
  return actor?.role === 'procurement' || actor?.role === 'admin' || actor?.role === 'finance';
}

function writer(actor) {
  return actor?.role === 'procurement' || actor?.role === 'admin';
}

function isOwner(actor, event) {
  return actor?.role === 'admin' || Number(event.owner_user_id) === Number(actor?.id);
}

async function loadEvent(db, id) {
  const eventId = Number(id);
  if (!Number.isInteger(eventId) || eventId <= 0) return null;
  return db.prepare(`SELECT * FROM sourcing_events WHERE id = ?`).get(eventId);
}

async function assertVisible(db, actor, event) {
  if (staff(actor)) return;
  const row = await db.prepare(`
    SELECT 1 AS ok FROM sourcing_evaluators WHERE event_id = ? AND user_id = ?
  `).get(event.id, actor.id);
  if (!row) fail('Insufficient role for this action', 403, 'read_only');
}

function requireVersion(input, event) {
  if (input.row_version == null || input.row_version === '') {
    fail('row_version is required.', 400, 'row_version_required');
  }
  const version = Number(input.row_version);
  if (!Number.isInteger(version) || version !== Number(event.row_version)) {
    fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
  }
  return version;
}

function todayUtc(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
}

function validityExpired(value, now) {
  if (value == null || String(value).trim() === '') return false;
  return String(value).slice(0, 10) < todayUtc(now);
}

function selectionDigest(awardType, lines) {
  const canonical = {
    award_type: awardType,
    lines: lines
      .map((line) => ({
        event_line_id: Number(line.event_line_id),
        bid_id: Number(line.bid_id),
        supplier_id: Number(line.supplier_id),
        unit_price_cents: Number(line.unit_price_cents)
      }))
      .sort((a, b) => a.event_line_id - b.event_line_id)
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function insertRows(db, table, columns, rows) {
  if (!rows.length) return;
  const chunkSize = Math.max(1, Math.floor(SQL_VARIABLE_BUDGET / columns.length));
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const tuples = chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
    await db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples}`).run(...chunk.flat());
  }
}

async function readOpenAward(db, eventId) {
  return db.prepare(`
    SELECT a.*, pr.pr_number
    FROM sourcing_awards a
    LEFT JOIN purchase_requisitions pr ON pr.id = a.award_requisition_id
    WHERE a.event_id = ? AND a.status IN ('pending_approval', 'approved')
    LIMIT 1
  `).get(eventId);
}

function digestOf(award) {
  if (!award?.comparison_snapshot_json) return null;
  try {
    return JSON.parse(award.comparison_snapshot_json).selection_sha256 || null;
  } catch {
    return null;
  }
}

function presentAward(award, extra = {}) {
  return {
    id: Number(award.id),
    event_id: Number(award.event_id),
    award_type: award.award_type,
    status: award.status,
    total_cents: Number(award.total_cents),
    is_lowest: Number(award.is_lowest) === 1,
    has_expired_validity: Number(award.has_expired_validity) === 1,
    reason: award.reason,
    award_requisition_id: award.award_requisition_id == null ? null : Number(award.award_requisition_id),
    pr_number: award.pr_number || extra.pr_number || null,
    proposed_at: award.proposed_at,
    replayed: Boolean(extra.replayed),
    warnings: extra.warnings || []
  };
}

function buildChoice(sheet, input, now) {
  const awardType = input.award_type === 'split' ? 'split' : input.award_type === 'full' ? 'full' : null;
  if (!awardType) fail('Choose a full award or a split award.', 400, 'award_type_invalid');
  const bids = new Map(sheet.bids.map((bid) => [Number(bid.bid_id), bid]));
  const lines = [];
  if (awardType === 'full') {
    const bid = bids.get(Number(input.bid_id));
    if (!bid || bid.status === 'withdrawn') fail('The selected bid cannot be awarded.', 400, 'bid_not_awardable');
    for (const eventLine of sheet.eventLines) {
      const quoted = (bid.lines || []).find((line) => Number(line.event_line_id) === Number(eventLine.id) && line.quoted);
      if (!quoted) fail('A full award needs a quote for every line.', 400, 'bid_not_quoted');
      lines.push({ eventLine, bid, quoted });
    }
  } else {
    const requested = Array.isArray(input.lines) ? input.lines : [];
    if (requested.length !== sheet.eventLines.length) {
      fail('A split award assigns every line once.', 400, 'award_incomplete');
    }
    const seen = new Set();
    for (const row of requested) {
      const eventLine = sheet.eventLines.find((line) => Number(line.id) === Number(row.event_line_id));
      const bid = bids.get(Number(row.bid_id));
      if (!eventLine || !bid || bid.status === 'withdrawn') {
        fail('Each awarded line needs a live bid.', 400, 'bid_not_awardable');
      }
      if (seen.has(eventLine.id)) fail('Each line can be awarded once.', 400, 'award_incomplete');
      seen.add(eventLine.id);
      const quoted = (bid.lines || []).find((line) => Number(line.event_line_id) === Number(eventLine.id) && line.quoted);
      if (!quoted) fail('That bid did not quote the line.', 400, 'bid_not_quoted');
      lines.push({ eventLine, bid, quoted });
    }
  }
  for (const row of lines) {
    if (row.bid.supplier_status && row.bid.supplier_status !== 'active') {
      fail(`Supplier ${row.bid.supplier_name} is not active.`, 400, 'supplier_inactive');
    }
  }
  const scored = scoreComparison({
    lines: sheet.eventLines,
    bids: sheet.bids,
    weights: {
      price: Number(sheet.event?.weight_price || 0),
      lead: Number(sheet.event?.weight_lead_time || 0),
      quality: Number(sheet.event?.weight_quality || 0)
    },
    qualityByBid: new Map()
  });
  const scoredByLine = new Map();
  for (const bid of scored.bids) {
    if (bid.withdrawn) continue;
    for (const line of bid.lines) {
      if (line.is_lowest) {
        const key = Number(line.event_line_id);
        if (!scoredByLine.has(key)) scoredByLine.set(key, new Set());
        scoredByLine.get(key).add(bid.bid_id);
      }
    }
  }
  const lowestComplete = scored.lowest_complete_total_cents;
  const awarded = lines.map((row) => {
    const lineLowest = scoredByLine.get(Number(row.eventLine.id));
    return {
      event_line_id: Number(row.eventLine.id),
      bid_id: Number(row.bid.bid_id),
      bid_revision: Number(row.bid.revision),
      supplier_id: Number(row.bid.supplier_id),
      supplier_name: row.bid.supplier_name,
      quantity: Number(row.eventLine.quantity),
      unit_price_cents: Number(row.quoted.unit_price_cents),
      line_total_cents: Number(row.quoted.line_total_cents),
      is_line_lowest: lineLowest?.has(Number(row.bid.bid_id)) ? 1 : 0,
      description: row.eventLine.description,
      category: row.eventLine.category,
      line_type: row.eventLine.line_type,
      service_basis: row.eventLine.service_basis,
      catalog_item_id: row.eventLine.catalog_item_id,
      validity_until: row.bid.validity_until,
      complete: row.bid.status !== 'withdrawn' && (row.bid.lines || []).filter((line) => line.quoted).length === sheet.eventLines.length
    };
  });
  const total = awarded.reduce((sum, line) => sum + line.line_total_cents, 0);
  let isLowest = 0;
  if (awardType === 'full') {
    const winner = lines[0]?.bid;
    const complete = winner && (winner.lines || []).filter((line) => line.quoted).length === sheet.eventLines.length;
    isLowest = complete && lowestComplete != null && Number(winner.total_cents) === Number(lowestComplete) ? 1 : 0;
  } else {
    isLowest = awarded.length > 0 && awarded.every((line) => line.is_line_lowest === 1) ? 1 : 0;
  }
  const expired = awarded.some((line) => validityExpired(line.validity_until, now)) ? 1 : 0;
  return { awardType, awarded, total, isLowest, expired, lowestComplete, scored };
}

export async function declareCoi(db, actor, eventId, input = {}, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  await closeDueEvents(db, nowDate, { eventId });
  const event = await loadEvent(db, eventId);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  await assertVisible(db, actor, event);
  const status = input.status === 'conflict_declared' || input.status === 'none_declared' ? input.status : null;
  if (!status) fail('Declare no conflict or a possible conflict.', 400, 'coi_invalid');
  const note = input.note == null ? null : String(input.note).trim();
  if (status === 'conflict_declared' && (!note || note.length < 3)) {
    fail('A conflict declaration needs a note.', 400, 'coi_note_required');
  }
  if (note && note.length > 2000) fail('Text is too long.', 400, 'text_too_long');
  const now = nowDate.toISOString();
  const changed = await db.prepare(`
    UPDATE sourcing_evaluators
    SET coi_status = ?, coi_declared_at = ?, coi_note = ?
    WHERE event_id = ? AND user_id = ?
  `).run(status, now, note, event.id, actor.id);
  if (!changed.changes) {
    if (Number(event.owner_user_id) !== Number(actor.id) && actor.role !== 'admin') {
      fail('Only a named evaluator can declare a conflict of interest.', 403, 'not_evaluator');
    }
    await db.prepare(`
      INSERT INTO sourcing_evaluators (
        event_id, user_id, coi_status, coi_declared_at, coi_note, added_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(event.id, actor.id, status, now, note, actor.id, now);
  }
  await appendComplianceEvent(db, {
    ...actorFromSession(actor),
    action: 'SOURCING_COI_DECLARED',
    entity_type: 'sourcing_event',
    entity_id: event.id,
    details: JSON.stringify({ status, note }),
    created_at: utcTimestamp(nowDate)
  });
  return { user_id: Number(actor.id), coi_status: status, coi_note: note };
}

export async function recordScores(db, actor, eventId, input = {}, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  await closeDueEvents(db, nowDate, { eventId });
  const event = await loadEvent(db, eventId);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  const evaluator = await db.prepare(`
    SELECT coi_status FROM sourcing_evaluators WHERE event_id = ? AND user_id = ?
  `).get(event.id, actor.id);
  if (!evaluator || evaluator.coi_status !== 'none_declared') {
    fail('Declare that you have no conflict before scoring.', 403, 'coi_required');
  }
  if (!['closed', 'evaluated'].includes(event.status)) {
    fail('Scores are recorded after the RFQ closes.', 409, 'event_state_changed');
  }
  const scores = Array.isArray(input.scores) ? input.scores : [];
  if (!scores.length) fail('Send at least one score.', 400, 'scores_invalid');
  let sheet;
  try {
    sheet = await loadAwardBidSheet(db, event, nowDate);
  } catch (error) {
    if (error.code === 'bids_sealed') fail(error.message, 409, 'bids_sealed');
    throw error;
  }
  const live = new Map(sheet.bids.map((bid) => [Number(bid.bid_id), bid.status]));
  const now = nowDate.toISOString();
  const rows = [];
  const seen = new Set();
  for (const score of scores) {
    const bidId = Number(score.bid_id);
    const value = Number(score.quality_score);
    if (!live.has(bidId) || live.get(bidId) === 'withdrawn' || seen.has(bidId)) {
      fail('Score each live bid once.', 400, 'scores_invalid');
    }
    if (!Number.isInteger(value) || value < 0 || value > 10) {
      fail('Quality scores are integers from 0 to 10.', 400, 'scores_invalid');
    }
    seen.add(bidId);
    const comment = score.comment == null || String(score.comment).trim() === ''
      ? null
      : String(score.comment).trim();
    if (comment && comment.length > 2000) fail('Text is too long.', 400, 'text_too_long');
    rows.push([event.id, bidId, actor.id, value, comment, now, now]);
  }
  await withBusyRetry(() => db.immediateTransaction(async () => {
    const columns = [
      'event_id', 'bid_id', 'evaluator_user_id', 'quality_score', 'comment', 'created_at', 'updated_at'
    ];
    const tuples = rows.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
    await db.prepare(`
      INSERT INTO sourcing_scores (${columns.join(', ')}) VALUES ${tuples}
      ON CONFLICT(event_id, bid_id, evaluator_user_id) DO UPDATE SET
        quality_score = excluded.quality_score,
        comment = excluded.comment,
        updated_at = excluded.updated_at
    `).run(...rows.flat());
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('sourcing_event', ?, 'SCORES_RECORDED', ?, ?)
    `).run(event.id, actor.name, `Recorded ${rows.length} quality score(s) on ${event.event_number}`);
    await appendComplianceEvent(db, {
      ...actorFromSession(actor),
      action: 'SOURCING_SCORES_RECORDED',
      entity_type: 'sourcing_event',
      entity_id: event.id,
      details: JSON.stringify({ bid_ids: rows.map((row) => row[1]), count: rows.length }),
      created_at: utcTimestamp(nowDate)
    });
  }));
  return { count: rows.length };
}

function qualityMap(sheet) {
  const eligible = new Set(
    sheet.evaluators.filter((row) => row.coi_status === 'none_declared').map((row) => Number(row.user_id))
  );
  const map = new Map();
  for (const row of sheet.scores) {
    if (!eligible.has(Number(row.evaluator_user_id))) continue;
    const key = Number(row.bid_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(Number(row.quality_score));
  }
  return map;
}

export async function evaluateEvent(db, actor, eventId, input = {}, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  await closeDueEvents(db, nowDate, { eventId });
  const event = await loadEvent(db, eventId);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  if (!writer(actor) || (actor.role !== 'admin' && Number(event.owner_user_id) !== Number(actor.id))) {
    fail('Only the RFQ owner or an admin can finish the evaluation.', 403, 'not_owner');
  }
  if (event.status !== 'closed') fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
  const version = requireVersion(input, event);
  let sheet;
  try {
    sheet = await loadAwardBidSheet(db, { ...event, weight_price: event.weight_price }, nowDate);
  } catch (error) {
    if (error.code === 'bids_sealed') fail(error.message, 409, 'bids_sealed');
    throw error;
  }
  const liveBids = sheet.bids.filter((bid) => bid.status !== 'withdrawn');
  if (!liveBids.length) fail('There is no bid to evaluate.', 409, 'no_bids');
  const pending = sheet.evaluators.filter((row) => row.coi_status === 'pending');
  const scoringEvaluators = sheet.evaluators.filter((row) => row.coi_status === 'none_declared');
  let missingScore = false;
  if (Number(event.weight_quality) > 0) {
    const byBid = new Map();
    for (const row of sheet.scores) {
      const key = `${row.evaluator_user_id}:${row.bid_id}`;
      byBid.set(key, true);
    }
    if (!scoringEvaluators.length) missingScore = true;
    for (const evaluator of scoringEvaluators) {
      for (const bid of liveBids) {
        if (!byBid.has(`${evaluator.user_id}:${bid.bid_id}`)) missingScore = true;
      }
    }
  }
  const needsOverride = Number(event.weight_quality) > 0 && (pending.length > 0 || missingScore);
  const override = input.override_reason == null ? '' : String(input.override_reason).trim();
  if (needsOverride && override.length < 10) {
    fail('Finish the scores, or give an override reason of at least 10 characters.', 400, 'evaluation_incomplete');
  }
  assertTransition('closed', 'evaluated');
  const now = nowDate.toISOString();
  const changed = await withBusyRetry(() => db.immediateTransaction(async () => {
    const result = await db.prepare(`
      UPDATE sourcing_events
      SET status = 'evaluated', evaluated_at = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ? AND status = 'closed' AND row_version = ?
    `).run(now, now, event.id, version);
    if (!result.changes) return 0;
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('sourcing_event', ?, 'EVALUATED', ?, ?)
    `).run(
      event.id,
      actor.name,
      override
        ? `Evaluation of ${event.event_number} finished with an override: ${override}`
        : `Evaluation of ${event.event_number} finished`
    );
    await appendComplianceEvent(db, {
      ...actorFromSession(actor),
      action: 'SOURCING_EVENT_EVALUATED',
      entity_type: 'sourcing_event',
      entity_id: event.id,
      details: JSON.stringify({
        override_reason: override || null,
        quote_count: liveBids.length
      }),
      created_at: utcTimestamp(nowDate)
    });
    await enqueueWebhook(db, {
      eventType: WEBHOOK_EVENTS.SOURCING_EVENT_EVALUATED,
      entityType: 'sourcing_event',
      entityId: event.id,
      data: {
        event_number: event.event_number,
        status: 'evaluated',
        quote_count: liveBids.length,
        override: Boolean(override)
      },
      now: nowDate
    });
    return result.changes;
  }));
  if (!changed) fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
  kickWebhookDispatch(db);
  return getEvent(db, event.id, nowDate);
}

function snapshotFor(event, sheet, choice, digest, idempotencyKey, warnings) {
  const scored = scoreComparison({
    lines: sheet.eventLines,
    bids: sheet.bids,
    weights: {
      price: Number(event.weight_price),
      lead: Number(event.weight_lead_time),
      quality: Number(event.weight_quality)
    },
    qualityByBid: qualityMap(sheet)
  });
  const names = new Map(sheet.bids.map((bid) => [bid.bid_id, bid]));
  return {
    selection_sha256: digest,
    idempotency_key: idempotencyKey || null,
    captured_at: new Date().toISOString(),
    weights: {
      price: Number(event.weight_price),
      lead_time: Number(event.weight_lead_time),
      quality: Number(event.weight_quality)
    },
    lowest_complete_total_cents: scored.lowest_complete_total_cents,
    warnings,
    lines: choice.awarded.map((line) => ({
      event_line_id: line.event_line_id,
      bid_id: line.bid_id,
      supplier_id: line.supplier_id,
      unit_price_cents: line.unit_price_cents,
      line_total_cents: line.line_total_cents,
      is_line_lowest: line.is_line_lowest === 1
    })),
    matrix: scored.bids.map((bid) => {
      const source = names.get(bid.bid_id);
      return {
        ...bid,
        supplier_name: source?.supplier_name || null,
        supplier_code: source?.supplier_code || null
      };
    })
  };
}

export async function proposeAward(db, actor, eventId, input = {}, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  await closeDueEvents(db, nowDate, { eventId });
  const event = await loadEvent(db, eventId);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  if (!writer(actor) || (actor.role !== 'admin' && Number(event.owner_user_id) !== Number(actor.id))) {
    fail('Only the RFQ owner or an admin can propose an award.', 403, 'not_owner');
  }
  const ownerCoi = await db.prepare(`
    SELECT coi_status FROM sourcing_evaluators WHERE event_id = ? AND user_id = ?
  `).get(event.id, event.owner_user_id);
  if (ownerCoi?.coi_status === 'conflict_declared') {
    fail('The owner declared a conflict and cannot propose the award. Reassign the owner.', 403, 'owner_conflict');
  }
  let sheet;
  try {
    sheet = await loadAwardBidSheet(db, event, nowDate);
  } catch (error) {
    if (error.code === 'bids_sealed') fail(error.message, 409, 'bids_sealed');
    throw error;
  }
  sheet.event = event;
  const choice = buildChoice(sheet, input, nowDate);
  const digest = selectionDigest(choice.awardType, choice.awarded);
  const open = await readOpenAward(db, event.id);
  if (open && digestOf(open) === digest) {
    return { replayed: true, award: presentAward(open), event: await getEvent(db, event.id, nowDate) };
  }
  if (open) fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
  if (event.status !== 'evaluated') fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
  const version = requireVersion(input, event);
  const reason = input.reason == null ? '' : String(input.reason).trim();
  if ((choice.isLowest !== 1 || choice.expired === 1) && reason.length < 10) {
    fail('A reason of at least 10 characters is required when the award is not the lowest or a quote has expired.', 400, 'award_reason_required');
  }
  if (reason.length > 2000) fail('Text is too long.', 400, 'text_too_long');
  const quoteCount = sheet.bids.filter((bid) => bid.status !== 'withdrawn').length;
  const warnings = choice.total > APPROVAL_TIER3_CENTS && quoteCount < 3 ? ['few_quotes'] : [];
  const threshold = awardSodThresholdCents(options.env);
  const excludeUserIds = choice.total > threshold
    ? [
      Number(event.owner_user_id),
      ...sheet.evaluators.filter((row) => row.coi_status === 'conflict_declared').map((row) => Number(row.user_id))
    ]
    : [];
  const steps = await buildApprovalSteps({
    totalAmount: choice.total,
    departmentId: event.department_id,
    db,
    excludeUserIds
  });
  const idempotencyKey = options.idempotencyKey ? String(options.idempotencyKey).slice(0, 200) : null;
  const snapshot = snapshotFor(event, sheet, choice, digest, idempotencyKey, warnings);
  const justification = `Gunning ${event.event_number} (${choice.awardType === 'full' ? 'volledig' : 'gesplitst'}): ${reason || 'laagste bieding'}`;
  const items = choice.awarded.map((line) => ({
    catalog_item_id: line.catalog_item_id,
    item_description: line.description,
    category: line.category,
    quantity: line.quantity,
    unit_price: line.unit_price_cents,
    total_price: line.line_total_cents,
    estimated_supplier_id: line.supplier_id,
    line_type: line.line_type,
    service_basis: line.service_basis
  }));
  const now = nowDate.toISOString();
  const created = await withBusyRetry(() => db.immediateTransaction(async () => {
    const again = await readOpenAward(db, event.id);
    if (again && digestOf(again) === digest) return { replayed: true, award: again };
    if (again) fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
    const bumped = await db.prepare(`
      UPDATE sourcing_events
      SET row_version = row_version + 1, updated_at = ?
      WHERE id = ? AND status = 'evaluated' AND row_version = ?
    `).run(now, event.id, version);
    if (!bumped.changes) {
      const raced = await readOpenAward(db, event.id);
      if (raced && digestOf(raced) === digest) return { replayed: true, award: raced };
      fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
    }
    const awardInsert = await db.prepare(`
      INSERT INTO sourcing_awards (
        event_id, award_type, status, total_cents, lowest_total_cents, is_lowest,
        has_expired_validity, reason, comparison_snapshot_json, proposed_by_user_id, proposed_at
      )
      SELECT ?, ?, 'pending_approval', ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM sourcing_awards
        WHERE event_id = ? AND status IN ('pending_approval', 'approved')
      )
    `).run(
      event.id,
      choice.awardType,
      choice.total,
      choice.lowestComplete,
      choice.isLowest,
      choice.expired,
      reason || null,
      JSON.stringify(snapshot),
      actor.id,
      now,
      event.id
    );
    if (!awardInsert.changes) {
      const raced = await readOpenAward(db, event.id);
      if (raced && digestOf(raced) === digest) return { replayed: true, award: raced };
      fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
    }
    let awardId = Number(awardInsert.lastInsertRowid);
    if (!awardId) {
      const row = await db.prepare(`
        SELECT id FROM sourcing_awards
        WHERE event_id = ? AND status = 'pending_approval'
        ORDER BY id DESC LIMIT 1
      `).get(event.id);
      awardId = Number(row?.id || 0);
    }
    if (!awardId) fail('The award could not be stored.', 500, 'sourcing_error');
    await insertRows(db, 'sourcing_award_lines', [
      'award_id', 'event_line_id', 'bid_id', 'bid_revision', 'supplier_id',
      'quantity', 'unit_price_cents', 'line_total_cents', 'is_line_lowest'
    ], choice.awarded.map((line) => [
      awardId,
      line.event_line_id,
      line.bid_id,
      line.bid_revision,
      line.supplier_id,
      line.quantity,
      line.unit_price_cents,
      line.line_total_cents,
      line.is_line_lowest
    ]));
    const requisition = await insertAwardRequisition(db, {
      requesterId: event.owner_user_id,
      departmentId: event.department_id,
      justification,
      items,
      actorName: actor.name,
      steps,
      neededBy: event.deadline_at ? String(event.deadline_at).slice(0, 10) : null
    });
    await db.prepare(`
      UPDATE sourcing_awards SET award_requisition_id = ? WHERE id = ?
    `).run(requisition.prId, awardId);
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('sourcing_award', ?, 'PROPOSED', ?, ?)
    `).run(
      awardId,
      actor.name,
      `Award proposed for ${event.event_number} (${choice.awardType}) as ${requisition.prNumber}${warnings.length ? ' Warning: fewer than 3 quotes above € 10.000,00.' : ''}`
    );
    await appendComplianceEvent(db, {
      ...actorFromSession(actor),
      action: 'SOURCING_AWARD_PROPOSED',
      entity_type: 'sourcing_award',
      entity_id: awardId,
      details: JSON.stringify({
        award_type: choice.awardType,
        total_cents: choice.total,
        is_lowest: choice.isLowest === 1,
        reason: reason || null,
        award_requisition_number: requisition.prNumber,
        few_quotes: warnings.includes('few_quotes'),
        idempotency_key: idempotencyKey
      }),
      created_at: utcTimestamp(nowDate)
    });
    return {
      replayed: false,
      award: {
        id: awardId,
        event_id: event.id,
        award_type: choice.awardType,
        status: 'pending_approval',
        total_cents: choice.total,
        is_lowest: choice.isLowest,
        has_expired_validity: choice.expired,
        reason: reason || null,
        award_requisition_id: requisition.prId,
        pr_number: requisition.prNumber,
        proposed_at: now
      }
    };
  }));
  if (created.replayed) {
    return { replayed: true, award: presentAward(created.award), event: await getEvent(db, event.id, nowDate) };
  }
  return {
    replayed: false,
    award: presentAward(created.award, { warnings }),
    event: await getEvent(db, event.id, nowDate)
  };
}

export async function createAwardPurchaseOrders(db, actor, eventId, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  await closeDueEvents(db, nowDate, { eventId });
  const event = await loadEvent(db, eventId);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  if (!writer(actor)) fail('Only procurement or an admin can create purchase orders from an award.', 403, 'award_po_role');
  if (event.status !== 'awarded') fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
  const award = await db.prepare(`
    SELECT * FROM sourcing_awards
    WHERE event_id = ? AND status = 'approved'
    LIMIT 1
  `).get(event.id);
  if (!award?.award_requisition_id) fail('The award is not approved.', 409, 'award_not_approved');
  const issued = await issueAwardPurchaseOrders(db, {
    requisitionId: award.award_requisition_id,
    createdBy: actor.id,
    actor,
    eventId: event.id,
    eventNumber: event.event_number,
    awardId: award.id
  });
  return {
    replayed: issued.replayed,
    purchase_orders: issued.purchase_orders,
    event: await getEvent(db, event.id, nowDate)
  };
}

export async function reassignOwner(db, actor, eventId, input = {}, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  await closeDueEvents(db, nowDate, { eventId });
  const event = await loadEvent(db, eventId);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  if (actor?.role !== 'admin') fail('Only an admin can reassign the owner.', 403, 'read_only');
  if (['awarded', 'cancelled'].includes(event.status)) {
    fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
  }
  const version = requireVersion(input, event);
  const userId = Number(input.user_id);
  const user = await db.prepare(`SELECT id, name, role, status FROM users WHERE id = ?`).get(userId);
  if (!user || user.status === 'inactive') fail('User was not found.', 400, 'user_not_found');
  if (user.role !== 'procurement' && user.role !== 'admin') {
    fail('The new owner must be procurement or an admin.', 400, 'user_not_found');
  }
  const now = nowDate.toISOString();
  const changed = await withBusyRetry(() => db.immediateTransaction(async () => {
    const result = await db.prepare(`
      UPDATE sourcing_events
      SET owner_user_id = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ? AND row_version = ? AND status NOT IN ('awarded', 'cancelled')
    `).run(user.id, now, event.id, version);
    if (!result.changes) return 0;
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('sourcing_event', ?, 'OWNER_REASSIGNED', ?, ?)
    `).run(event.id, actor.name, `Owner of ${event.event_number} changed from user ${event.owner_user_id} to ${user.name}`);
    await appendComplianceEvent(db, {
      ...actorFromSession(actor),
      action: 'SOURCING_OWNER_REASSIGNED',
      entity_type: 'sourcing_event',
      entity_id: event.id,
      details: JSON.stringify({ from_user_id: Number(event.owner_user_id), to_user_id: Number(user.id) }),
      created_at: utcTimestamp(nowDate)
    });
    return result.changes;
  }));
  if (!changed) fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
  return getEvent(db, event.id, nowDate);
}

export { selectionDigest };

