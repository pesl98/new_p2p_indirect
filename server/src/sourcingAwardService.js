/**
 * RFQ award (Sprint 8c). An award becomes an ordinary requisition so the
 * existing approval chain, delegations, budget commitment, inbox and
 * compliance report apply unchanged. Approval hooks live in
 * sourcingApprovalHooks.js; POs come from the existing convert.
 */

import { actorFromSession, appendComplianceEvent, utcTimestamp } from './complianceAudit.js';
import { nextDocumentNumber } from './docNumbers.js';
import { normalizeLineType, resolveServiceBasis } from './lineType.js';
import { isUniqueConstraint } from './masterData.js';
import { formatMoney, lineTotalCents } from './money.js';
import { buildApprovalSteps } from './approvalPolicy.js';
import { withBusyRetry } from './busyRetry.js';
import { issueAwardPurchaseOrders } from './purchaseOrdersService.js';
import { awardExclusions } from './sourcingApprovalHooks.js';
import { loadBuyerComparison } from './sourcingBidReadModel.js';
import { utcIso } from './sourcingConfig.js';
import { buildMatrix } from './sourcingEvaluationService.js';
import { awardOutcomeMessage, runMailAfterCommit, sendSourcingMails } from './sourcingMail.js';
import { assertOwner, assertWriter, closeDueEvents, fail, loadEventRow, writeAudit } from './sourcingService.js';

const SQL_VARIABLE_BUDGET = 900;

/** Multi-row INSERT, chunked under SQLite's historical 999-variable limit. */
async function insertRows(db, table, columns, rows) {
  if (!rows.length) return;
  const chunkSize = Math.max(1, Math.floor(SQL_VARIABLE_BUDGET / columns.length));
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const tuples = chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
    await db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples}`).run(...chunk.flat());
  }
}

function validityExpired(validityUntil, nowDate) {
  if (!validityUntil) return false;
  const text = String(validityUntil);
  const parsed = Date.parse(text.length === 10 ? `${text}T23:59:59Z` : text);
  return Number.isFinite(parsed) && parsed < nowDate.getTime();
}

function parseAssignments(input, matrixLines) {
  const type = input.award_type;
  if (type !== 'full' && type !== 'split') fail('award_type must be full or split.', 400, 'invalid_award');
  let assignments;
  if (type === 'full' && input.bid_id != null && !Array.isArray(input.lines)) {
    const bidId = Number(input.bid_id);
    assignments = matrixLines.map((line) => ({ event_line_id: Number(line.id), bid_id: bidId }));
  } else if (Array.isArray(input.lines)) {
    assignments = input.lines.map((item) => ({
      event_line_id: Number(item?.event_line_id),
      bid_id: Number(item?.bid_id)
    }));
  } else {
    fail('lines must be a list of { event_line_id, bid_id }.', 400, 'invalid_award');
  }
  const wanted = new Set(matrixLines.map((line) => Number(line.id)));
  const seen = new Set();
  for (const item of assignments) {
    if (!wanted.has(item.event_line_id) || !Number.isInteger(item.bid_id) || item.bid_id <= 0 || seen.has(item.event_line_id)) {
      fail('Each RFQ line must be awarded exactly once.', 400, 'invalid_award');
    }
    seen.add(item.event_line_id);
  }
  if (seen.size !== wanted.size) fail('Every RFQ line must be awarded.', 400, 'award_incomplete');
  return { type, assignments };
}

export async function proposeAward(db, actor, id, input = {}, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  await closeDueEvents(db, nowDate, { eventId: id });
  const event = await loadEventRow(db, id);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  assertOwner(actor, event);
  if (event.status !== 'evaluated') fail('Only an evaluated RFQ can be awarded.', 409, 'event_state_changed');

  const owner = await db.prepare(`
    SELECT coi_status FROM sourcing_evaluators WHERE event_id = ? AND user_id = ?
  `).get(event.id, event.owner_user_id);
  if (owner?.coi_status === 'conflict_declared') {
    fail('The RFQ owner declared a conflict of interest. An admin must reassign the owner.', 403, 'owner_conflict');
  }
  if (owner?.coi_status !== 'none_declared') {
    fail('The RFQ owner must declare no conflict of interest before proposing an award.', 409, 'owner_coi_required');
  }
  const existing = await db.prepare(`
    SELECT id FROM sourcing_awards WHERE event_id = ? AND status IN ('pending_approval', 'approved')
  `).get(event.id);
  if (existing) fail('This RFQ already has an open award.', 409, 'award_already_open');

  const comparison = await loadBuyerComparison(db, event, actor, nowDate);
  if (comparison.sealed) fail('Bid prices are not visible to you.', 403, 'prices_hidden');
  const matrix = await buildMatrix(db, event, comparison);
  const { type, assignments } = parseAssignments(input, matrix.lines);
  const bidById = new Map(matrix.bids.map((bid) => [Number(bid.bid_id), bid]));
  const lineById = new Map(matrix.lines.map((line) => [Number(line.id), line]));

  const awardLines = [];
  for (const item of assignments) {
    const bid = bidById.get(item.bid_id);
    if (!bid || bid.status !== 'submitted') fail('A line is awarded to a bid that is not available.', 400, 'invalid_award');
    const quote = bid.lines.find((row) => Number(row.event_line_id) === item.event_line_id && row.quoted);
    if (!quote) fail('A line is awarded to a supplier that did not quote it.', 400, 'invalid_award');
    const line = lineById.get(item.event_line_id);
    awardLines.push({
      line,
      bid,
      unit_price_cents: quote.unit_price_cents,
      line_total_cents: lineTotalCents(line.quantity, quote.unit_price_cents),
      is_line_lowest: quote.is_line_lowest ? 1 : 0
    });
  }
  const distinctBids = new Set(awardLines.map((row) => Number(row.bid.bid_id)));
  if (type === 'full' && (distinctBids.size !== 1 || !awardLines[0].bid.complete)) {
    fail('A full award goes to one supplier that quoted every line.', 400, 'award_type_mismatch');
  }
  if (type === 'split' && distinctBids.size < 2) {
    fail('A split award needs at least two suppliers.', 400, 'award_type_mismatch');
  }
  for (const supplierId of new Set(awardLines.map((row) => Number(row.bid.supplier_id)))) {
    const supplier = await db.prepare(`SELECT name, status FROM suppliers WHERE id = ?`).get(supplierId);
    if (!supplier || (supplier.status && supplier.status !== 'active')) {
      fail(`Supplier ${supplier?.name || supplierId} is not active.`, 409, 'supplier_inactive');
    }
  }

  const totalCents = awardLines.reduce((sum, row) => sum + row.line_total_cents, 0);
  const lowestTotal = type === 'full'
    ? matrix.lowest_complete_total_cents
    : matrix.lines.reduce((sum, line) => sum + lineTotalCents(line.quantity, matrix.lowest_per_line[line.id] ?? 0), 0);
  const isLowest = type === 'full'
    ? awardLines[0].bid.complete && awardLines[0].bid.total_cents === matrix.lowest_complete_total_cents
    : awardLines.every((row) => row.is_line_lowest === 1);
  const hasExpired = [...distinctBids].some((bidId) => validityExpired(bidById.get(bidId).validity_until, nowDate));
  const reason = input.reason == null ? '' : String(input.reason).trim();
  if ((!isLowest || hasExpired) && reason.length < 10) {
    fail(
      hasExpired && isLowest
        ? 'A bid validity has expired. Give a reason of at least 10 characters.'
        : 'This is not the lowest bid. Give a reason of at least 10 characters.',
      400,
      'award_reason_required'
    );
  }

  const excludeUserIds = await awardExclusions(db, event.id, event.owner_user_id, actor.id);
  const now = utcIso(nowDate);
  const snapshot = {
    event_number: event.event_number,
    computed_at: now,
    owner_user_id: Number(event.owner_user_id),
    proposed_by_user_id: Number(actor.id),
    weights: { price: event.weight_price, lead_time: event.weight_lead_time, quality: event.weight_quality },
    matrix,
    award: {
      type,
      total_cents: totalCents,
      lowest_total_cents: lowestTotal,
      is_lowest: isLowest,
      has_expired_validity: hasExpired,
      reason: reason || null,
      lines: awardLines.map((row) => ({
        event_line_id: row.line.id,
        bid_id: row.bid.bid_id,
        supplier_name: row.bid.supplier_name,
        unit_price_cents: row.unit_price_cents,
        line_total_cents: row.line_total_cents,
        is_line_lowest: row.is_line_lowest === 1
      }))
    }
  };

  // Everything that only reads is done before the write transaction, so the
  // transaction itself stays inside the Turso statement budget (plan §6.1):
  // the chain is resolved here and inserted as one multi-row statement.
  let created;
  try {
    const steps = await buildApprovalSteps({
      totalAmount: totalCents,
      departmentId: event.department_id,
      db,
      excludeUserIds
    });
    const justification = `Gunning ${event.event_number} (${type === 'full' ? 'volledig' : 'gesplitst'}): ${reason || 'laagste bieding'}`;
    const neededBy = new Date(nowDate.getTime() + 14 * 86400000).toISOString().split('T')[0];
    const itemRows = awardLines.map((row) => {
      const lineType = normalizeLineType(row.line.line_type, row.line.category);
      return [
        row.line.catalog_item_id || null,
        row.line.description,
        row.line.category,
        row.line.quantity,
        row.unit_price_cents,
        row.line_total_cents,
        row.bid.supplier_id,
        lineType,
        resolveServiceBasis(row.line.service_basis, lineType)
      ];
    });
    created = await withBusyRetry(() => db.immediateTransaction(async () => {
      // One read for both guards. The unique index on open awards backs the insert.
      const guard = await db.prepare(`
        SELECT e.status, e.owner_user_id, e.department_id, e.row_version,
               (SELECT COUNT(*) FROM sourcing_awards a
                 WHERE a.event_id = e.id AND a.status IN ('pending_approval', 'approved')) AS open_awards
        FROM sourcing_events e WHERE e.id = ?
      `).get(event.id);
      if (Number(guard?.open_awards || 0) > 0) fail('This RFQ already has an open award.', 409, 'award_already_open');
      if (guard?.status !== 'evaluated') fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
      // The chain above was built for this owner and department. If either moved in the gap
      // (an admin reassigned the owner), the award would be stranded on the wrong chain.
      if (
        Number(guard.owner_user_id) !== Number(event.owner_user_id)
        || Number(guard.department_id) !== Number(event.department_id)
        || Number(guard.row_version) !== Number(event.row_version)
      ) {
        fail('The RFQ changed while it was being saved.', 409, 'event_state_changed');
      }

      const prNumber = await nextDocumentNumber(db, 'pr', nowDate.getFullYear());
      const pr = await db.prepare(`
        INSERT INTO purchase_requisitions (pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date, priority, source_contract_id, contract_use_status)
        VALUES (?, ?, ?, 'pending_approval', ?, ?, ?, 'Medium', NULL, 'none')
      `).run(prNumber, event.owner_user_id, event.department_id, totalCents, justification, neededBy);
      // Turso may omit last_insert_rowid; read the row back only then (never persist id 0).
      let prId = Number(pr.lastInsertRowid);
      if (!prId) prId = Number((await db.prepare(`SELECT id FROM purchase_requisitions WHERE pr_number = ?`).get(prNumber))?.id || 0);
      if (!prId) fail('The award requisition could not be stored.', 500, 'sourcing_error');
      await insertRows(db, 'requisition_items', [
        'requisition_id', 'catalog_item_id', 'item_description', 'category', 'quantity',
        'unit_price', 'total_price', 'estimated_supplier_id', 'line_type', 'service_basis'
      ], itemRows.map((row) => [prId, ...row]));
      await insertRows(db, 'approval_requests', ['requisition_id', 'approver_id', 'step_order', 'status'],
        steps.map((step) => [prId, step.approver_id, step.step_order, Number(step.step_order) === 1 ? 'pending' : 'waiting']));

      const award = await db.prepare(`
        INSERT INTO sourcing_awards (
          event_id, award_type, status, award_requisition_id, total_cents, lowest_total_cents,
          is_lowest, has_expired_validity, reason, comparison_snapshot_json, proposed_by_user_id, owner_user_id, proposed_at
        ) VALUES (?, ?, 'pending_approval', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id, type, prId, totalCents, lowestTotal, isLowest ? 1 : 0, hasExpired ? 1 : 0,
        reason || null, JSON.stringify(snapshot), actor.id, event.owner_user_id, now
      );
      let awardId = Number(award.lastInsertRowid);
      if (!awardId) awardId = Number((await db.prepare(`SELECT id FROM sourcing_awards WHERE award_requisition_id = ?`).get(prId))?.id || 0);
      if (!awardId) fail('The award could not be stored.', 500, 'sourcing_error');
      await insertRows(db, 'sourcing_award_lines', [
        'award_id', 'event_line_id', 'bid_id', 'bid_revision', 'supplier_id', 'quantity',
        'unit_price_cents', 'line_total_cents', 'is_line_lowest'
      ], awardLines.map((row) => [
        awardId, row.line.id, row.bid.bid_id, row.bid.revision, row.bid.supplier_id,
        row.line.quantity, row.unit_price_cents, row.line_total_cents, row.is_line_lowest
      ]));
      // Three history rows in one statement: requisition created, submitted, award proposed.
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('requisition', ?, 'CREATED', ?, ?),
               ('requisition', ?, 'SUBMITTED', ?, 'Submitted for multi-tier approval routing'),
               ('sourcing_event', ?, 'AWARD_PROPOSED', ?, ?)
      `).run(
        prId, actor.name, `Award requisition ${prNumber} for ${event.event_number} created for ${formatMoney(totalCents)}`,
        prId, actor.name,
        event.id, actor.name, `Award ${type} proposed for ${event.event_number}: ${prNumber}, ${formatMoney(totalCents)}`
      );
      await appendComplianceEvent(db, {
        ...actorFromSession(actor),
        action: 'SOURCING_AWARD_PROPOSED',
        entity_type: 'sourcing_award',
        entity_id: awardId,
        details: JSON.stringify({
          type, total_cents: totalCents, is_lowest: isLowest, reason: reason || null, award_pr_number: prNumber
        }),
        created_at: utcTimestamp(nowDate)
      });
      return { awardId, prNumber };
    }));
  } catch (error) {
    if (isUniqueConstraint?.(error)) fail('This RFQ already has an open award.', 409, 'award_already_open');
    if (error?.code === 'sod_no_alternate_approver') {
      fail(error.message, 422, 'sod_no_alternate_approver');
    }
    throw error;
  }
  return getAward(db, actor, event.id, { awardId: created.awardId });
}


/** What a user without price access sees of the frozen comparison: weights and the date only. */
function redactedSnapshot(snapshot) {
  return {
    computed_at: snapshot?.computed_at ?? null,
    weights: snapshot?.weights ?? null,
    redacted: true
  };
}

/**
 * Same rule as the comparison screen, plus the approval chain: admin and finance, the
 * RFQ owner (at proposal time or now), evaluators who declared no conflict, and the people
 * who must approve the award. A declared conflict always wins. A procurement user who is
 * none of these (a colleague buyer) sees no prices.
 */
async function mayViewAwardPrices(db, actor, event, award) {
  if (!actor) return false;
  const evaluator = await db.prepare(`
    SELECT coi_status FROM sourcing_evaluators WHERE event_id = ? AND user_id = ?
  `).get(event.id, actor.id);
  if (evaluator?.coi_status === 'conflict_declared') return false;
  if (actor.role === 'admin' || actor.role === 'finance') return true;
  if ([event.owner_user_id, award.owner_user_id, award.proposed_by_user_id].map(Number).includes(Number(actor.id))) return true;
  if (evaluator?.coi_status === 'none_declared') return true;
  if (!award.award_requisition_id) return false;
  const step = await db.prepare(`SELECT id FROM approval_requests WHERE requisition_id = ? AND approver_id = ?`)
    .get(award.award_requisition_id, actor.id);
  if (step) return true;
  const delegated = await db.prepare(`
    SELECT ad.id FROM approval_delegations ad
    JOIN approval_requests ar ON ar.approver_id = ad.delegator_user_id AND ar.requisition_id = ?
    WHERE ad.delegate_user_id = ? AND ad.active = 1
  `).get(award.award_requisition_id, actor.id);
  return Boolean(delegated);
}

export async function getAward(db, actor, eventId, { awardId = null } = {}) {
  const event = await loadEventRow(db, eventId);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  const award = awardId
    ? await db.prepare(`SELECT * FROM sourcing_awards WHERE id = ? AND event_id = ?`).get(awardId, event.id)
    : await db.prepare(`SELECT * FROM sourcing_awards WHERE event_id = ? ORDER BY id DESC LIMIT 1`).get(event.id);
  if (!award) return { award: null, event_status: event.status };
  const lines = await db.prepare(`
    SELECT al.event_line_id, al.bid_id, al.bid_revision, al.supplier_id, al.quantity,
           al.unit_price_cents, al.line_total_cents, al.is_line_lowest,
           s.name AS supplier_name, l.line_no, l.description
    FROM sourcing_award_lines al
    JOIN suppliers s ON s.id = al.supplier_id
    JOIN sourcing_event_lines l ON l.id = al.event_line_id
    WHERE al.award_id = ? ORDER BY l.line_no ASC
  `).all(award.id);
  const pr = award.award_requisition_id
    ? await db.prepare(`SELECT id, pr_number, status FROM purchase_requisitions WHERE id = ?`).get(award.award_requisition_id)
    : null;
  const approvals = pr
    ? await db.prepare(`
        SELECT ar.step_order, ar.status, ar.approver_id, u.name AS approver_name
        FROM approval_requests ar JOIN users u ON u.id = ar.approver_id
        WHERE ar.requisition_id = ? ORDER BY ar.step_order ASC
      `).all(pr.id)
    : [];
  const purchaseOrders = pr
    ? await db.prepare(`
        SELECT po.id, po.po_number, po.supplier_id, po.total_amount, po.award_id, s.name AS supplier_name
        FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.award_id = ? ORDER BY po.id ASC
      `).all(award.id)
    : [];
  const { comparison_snapshot_json: snapshotJson, ...rest } = award;
  const canSeePrices = await mayViewAwardPrices(db, actor, event, award);
  const view = {
    ...rest,
    is_lowest: Number(award.is_lowest) === 1,
    has_expired_validity: Number(award.has_expired_validity) === 1,
    snapshot: JSON.parse(snapshotJson),
    lines,
    requisition: pr,
    approvals,
    purchase_orders: purchaseOrders
  };
  if (!canSeePrices) {
    // Bid prices stay hidden from conflicted users and colleague buyers: no amounts, no
    // supplier names tied to prices, no snapshot matrix.
    view.prices_hidden = true;
    view.snapshot = redactedSnapshot(view.snapshot);
    view.total_cents = null;
    view.lowest_total_cents = null;
    view.lines = lines.map((line) => ({
      event_line_id: line.event_line_id,
      line_no: line.line_no,
      description: line.description,
      quantity: line.quantity
    }));
    view.purchase_orders = purchaseOrders.map((po) => ({ id: po.id, po_number: po.po_number, award_id: po.award_id }));
  }
  return { award: view, event_status: event.status };
}

/** "Bestelling(en) aanmaken": the existing convert, one PO per awarded supplier. */
export async function createAwardPurchaseOrders(db, actor, id, options = {}) {
  assertWriter(actor);
  const event = await loadEventRow(db, id);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  if (event.status !== 'awarded') fail('The award must be approved first.', 409, 'award_not_approved');
  const award = await db.prepare(`
    SELECT id, award_requisition_id FROM sourcing_awards WHERE event_id = ? AND status = 'approved'
  `).get(event.id);
  if (!award?.award_requisition_id) fail('The award must be approved first.', 409, 'award_not_approved');
  // Only this path converts an award requisition. It takes no supplier_mappings:
  // the suppliers and prices are the awarded ones. A repeat call is a replay (200).
  const issued = await issueAwardPurchaseOrders(db, {
    requisitionId: award.award_requisition_id,
    createdBy: actor.id,
    actor,
    eventId: event.id,
    eventNumber: event.event_number,
    awardId: award.id,
    timeBudgetMs: options.timeBudgetMs,
    clock: options.clock
  });
  return {
    replayed: issued.replayed,
    done: issued.done,
    remaining: issued.remaining,
    purchase_orders: issued.purchase_orders,
    split: issued.purchase_orders.length > 1
  };
}

/** Frozen snapshot for approvers. Visible to the chain, procurement, finance and admin. */
export async function awardSnapshotForRequisition(db, actor, requisitionId) {
  const award = await db.prepare(`
    SELECT a.id, a.event_id, a.status, a.award_type, a.total_cents, a.is_lowest, a.reason, a.comparison_snapshot_json,
           e.event_number
    FROM sourcing_awards a JOIN sourcing_events e ON e.id = a.event_id
    WHERE a.award_requisition_id = ?
  `).get(requisitionId);
  if (!award) fail('This requisition is not an RFQ award.', 404, 'award_not_found');
  const privileged = ['procurement', 'finance', 'admin'].includes(actor.role);
  if (!privileged) {
    const step = await db.prepare(`SELECT id FROM approval_requests WHERE requisition_id = ? AND approver_id = ?`)
      .get(requisitionId, actor.id);
    const delegated = step ? null : await db.prepare(`
      SELECT ad.id FROM approval_delegations ad
      JOIN approval_requests ar ON ar.approver_id = ad.delegator_user_id AND ar.requisition_id = ?
      WHERE ad.delegate_user_id = ? AND ad.active = 1
    `).get(requisitionId, actor.id);
    if (!step && !delegated) fail('You are not part of this approval.', 403, 'not_in_chain');
  }
  const { comparison_snapshot_json: snapshotJson, ...rest } = award;
  const event = await loadEventRow(db, award.event_id);
  const full = await db.prepare(`SELECT * FROM sourcing_awards WHERE id = ?`).get(award.id);
  const view = { ...rest, is_lowest: Number(award.is_lowest) === 1, snapshot: JSON.parse(snapshotJson) };
  if (!(await mayViewAwardPrices(db, actor, event, full))) {
    view.prices_hidden = true;
    view.snapshot = redactedSnapshot(view.snapshot);
    view.total_cents = null;
  }
  return view;
}

/**
 * "Uitkomst delen": the buyer decides when suppliers learn the outcome (losing-bidder notices
 * stay a buyer decision). It sets outcome_published_at, which opens the portal outcome page, and
 * sends one notice per supplier who bid: awarded or not awarded. Repeating it changes nothing.
 */
export async function publishOutcome(db, actor, id, options = {}) {
  const nowDate = options.now instanceof Date ? options.now : new Date();
  const event = await loadEventRow(db, id);
  if (!event) fail('RFQ was not found.', 404, 'event_not_found');
  assertOwner(actor, event);
  if (event.status !== 'awarded') fail('The award must be approved first.', 409, 'award_not_approved');
  if (event.outcome_published_at) {
    return { replayed: true, published_at: event.outcome_published_at, notified: 0 };
  }
  const now = utcIso(nowDate);
  const changed = await withBusyRetry(() => db.immediateTransaction(async () => {
    const result = await db.prepare(`
      UPDATE sourcing_events
      SET outcome_published_at = ?, row_version = row_version + 1, updated_at = ?
      WHERE id = ? AND status = 'awarded' AND outcome_published_at IS NULL
    `).run(now, now, event.id);
    if (!result.changes) return 0;
    await writeAudit(db, 'sourcing_event', event.id, 'OUTCOME_PUBLISHED', actor.name,
      `Outcome of ${event.event_number} shared with the suppliers`);
    await appendComplianceEvent(db, {
      ...actorFromSession(actor),
      action: 'SOURCING_OUTCOME_PUBLISHED',
      entity_type: 'sourcing_event',
      entity_id: event.id,
      details: JSON.stringify({ event_number: event.event_number }),
      created_at: utcTimestamp(nowDate)
    });
    return 1;
  }));
  if (!changed) {
    const again = await loadEventRow(db, id);
    return { replayed: true, published_at: again?.outcome_published_at || null, notified: 0 };
  }
  const sent = await runMailAfterCommit(async () => {
    const bidders = await db.prepare(`
      SELECT i.id, i.supplier_id, i.contact_email,
             EXISTS (
               SELECT 1 FROM sourcing_award_lines al
               JOIN sourcing_awards a ON a.id = al.award_id AND a.status = 'approved'
               WHERE a.event_id = i.event_id AND al.supplier_id = i.supplier_id
             ) AS awarded
      FROM sourcing_invitations i
      JOIN sourcing_bids b ON b.invitation_id = i.id
      WHERE i.event_id = ? AND i.revoked_at IS NULL
      ORDER BY i.id ASC
    `).all(event.id);
    const messages = bidders.map((row) => ({
      invitation_id: row.id,
      kind: 'award_outcome',
      to: row.contact_email,
      ...awardOutcomeMessage(event, Number(row.awarded) === 1)
    }));
    return sendSourcingMails(db, event.id, messages, { ...options, now: nowDate });
  }, options);
  return { replayed: false, published_at: now, notified: Array.isArray(sent) ? sent.length : null };
}
