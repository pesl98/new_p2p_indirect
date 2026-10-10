/**
 * Sprint 8c: the award requisition goes through the normal approval chain.
 * decideApprovalStep calls these hooks inside its transaction, so the award
 * status, the budget release for the source PR, and the webhook commit or
 * roll back together with the approval.
 */

import { actorFromSession, appendComplianceEvent } from './complianceAudit.js';
import { currentFiscalYear } from './fiscalYear.js';
import { APPROVAL_TIER2_CENTS } from './money.js';
import { enqueueWebhook, WEBHOOK_EVENTS } from './webhookOutbox.js';

const SOD_CODE = 'sod_award_self_approval';

export function awardSodThresholdCents(env = process.env) {
  const raw = Number(String(env?.SOURCING_AWARD_SOD_THRESHOLD_CENTS ?? '').trim());
  return Number.isInteger(raw) && raw >= 0 ? raw : APPROVAL_TIER2_CENTS;
}

export async function loadAwardByRequisition(db, requisitionId) {
  return db.prepare(`
    SELECT a.id AS award_id, a.event_id, a.award_type, a.status AS award_status, a.total_cents,
           a.is_lowest, a.reason, a.award_requisition_id,
           a.proposed_by_user_id, a.owner_user_id AS award_owner_user_id,
           e.event_number, e.owner_user_id, e.source_requisition_id, e.currency, e.status AS event_status
    FROM sourcing_awards a
    JOIN sourcing_events e ON e.id = a.event_id
    WHERE a.award_requisition_id = ?
  `).get(requisitionId);
}

/**
 * Users who must not approve an award: the RFQ owner, the user who proposed it,
 * and every evaluator who declared a conflict. Applied to the chain when it is
 * built, and again by the compliance report, so the report raises no false
 * wrong_approver.
 */
export async function awardExclusions(db, eventId, ownerUserId, proposerUserId = null) {
  const rows = await db.prepare(`
    SELECT user_id FROM sourcing_evaluators WHERE event_id = ? AND coi_status = 'conflict_declared'
  `).all(eventId);
  const ids = new Set([Number(ownerUserId), ...rows.map((row) => Number(row.user_id))]);
  if (proposerUserId != null) ids.add(Number(proposerUserId));
  ids.delete(NaN);
  return [...ids];
}

/** Everyone an award decision must not involve (stored owner and proposer, current owner, conflicts). */
export async function restrictedAwardUsers(db, award) {
  const ids = await awardExclusions(
    db,
    award.event_id,
    award.award_owner_user_id ?? award.owner_user_id,
    award.proposed_by_user_id
  );
  const set = new Set(ids);
  set.add(Number(award.owner_user_id));
  set.delete(0);
  return set;
}

export async function awardExclusionsForRequisition(db, requisitionId) {
  const award = await loadAwardByRequisition(db, requisitionId);
  if (!award) return null;
  return {
    award,
    excludeUserIds: await awardExclusions(
      db,
      award.event_id,
      award.award_owner_user_id ?? award.owner_user_id,
      award.proposed_by_user_id
    )
  };
}

/**
 * 403 when anyone involved in the decision is restricted: the deciding user, the
 * step's assigned approver, either side of a delegation, or the user who
 * created that delegation. Covers direct decisions, delegates, delegators, and
 * an admin deciding through a delegation they set up for themselves.
 */
export async function guardAwardDecision(db, pr, { approverId, actorCheck, stepApproverId = null, makeError }) {
  const award = await loadAwardByRequisition(db, pr.id);
  if (!award) return null;
  if (award.award_status !== 'pending_approval') return award;
  const restricted = await restrictedAwardUsers(db, award);
  const delegation = actorCheck?.delegation || null;
  const involved = [
    Number(approverId),
    stepApproverId == null ? NaN : Number(stepApproverId),
    delegation ? Number(delegation.delegator_user_id) : NaN,
    delegation ? Number(delegation.delegate_user_id) : NaN,
    delegation && delegation.created_by_user_id != null ? Number(delegation.created_by_user_id) : NaN
  ];
  if (involved.some((id) => restricted.has(id))) {
    throw makeError(
      'The RFQ owner, the proposer, and users with a declared conflict cannot decide this award.',
      403,
      SOD_CODE
    );
  }
  return award;
}

async function actorFor(db, userId, fallbackName) {
  const user = await db.prepare(`SELECT id, name, role FROM users WHERE id = ?`).get(userId);
  return actorFromSession({ id: userId, name: user?.name || fallbackName || 'Approver', role: user?.role || null });
}

/**
 * Release the source PR's budget commitment before the award PR commits, so
 * the department is charged the awarded amount rather than estimate + award.
 */
export async function releaseSourceCommitment(db, award, { userId, actorName }) {
  if (!award?.source_requisition_id) return 0;
  const source = await db.prepare(`
    SELECT id, pr_number, department_id, total_amount, status FROM purchase_requisitions WHERE id = ?
  `).get(award.source_requisition_id);
  if (!source || source.status !== 'approved') return 0;
  const released = Number(source.total_amount) || 0;
  await db.prepare(`
    UPDATE budgets SET committed_amount = MAX(0, committed_amount - ?)
    WHERE department_id = ? AND fiscal_year = ?
  `).run(released, source.department_id, currentFiscalYear());
  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES ('requisition', ?, 'SOURCING_SOURCE_REQUISITION_SUPERSEDED', ?, ?)
  `).run(source.id, actorName, `Superseded by RFQ ${award.event_number}; released ${released} cents of committed budget.`);
  await appendComplianceEvent(db, {
    ...(await actorFor(db, userId, actorName)),
    action: 'SOURCING_SOURCE_REQUISITION_SUPERSEDED',
    entity_type: 'requisition',
    entity_id: source.id,
    details: JSON.stringify({ event_number: award.event_number, released_cents: released })
  });
  return released;
}

/** Called after the award PR's budget is committed. */
export async function onAwardApproved(db, award, pr, { userId, actorName, now = new Date() }) {
  const nowIso = now.toISOString();
  await db.prepare(`
    UPDATE sourcing_awards SET status = 'approved', decided_at = ? WHERE id = ? AND status = 'pending_approval'
  `).run(nowIso, award.award_id);
  const moved = await db.prepare(`
    UPDATE sourcing_events
    SET status = 'awarded', awarded_at = ?, row_version = row_version + 1, updated_at = ?
    WHERE id = ? AND status = 'evaluated'
  `).run(nowIso, nowIso, award.event_id);
  if (!moved.changes) {
    const error = new Error('The RFQ is no longer awaiting an award decision.');
    error.statusCode = 409;
    error.code = 'event_state_changed';
    throw error;
  }
  const perSupplier = await db.prepare(`
    SELECT supplier_id, SUM(line_total_cents) AS total_cents
    FROM sourcing_award_lines WHERE award_id = ? GROUP BY supplier_id ORDER BY supplier_id
  `).all(award.award_id);
  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES ('sourcing_event', ?, 'AWARDED', ?, ?)
  `).run(award.event_id, actorName, `RFQ ${award.event_number} awarded via ${pr.pr_number}`);
  await appendComplianceEvent(db, {
    ...(await actorFor(db, userId, actorName)),
    action: 'SOURCING_AWARD_APPROVED',
    entity_type: 'sourcing_award',
    entity_id: award.award_id,
    details: JSON.stringify({ award_pr_number: pr.pr_number, total_cents: award.total_cents })
  });
  await enqueueWebhook(db, {
    eventType: WEBHOOK_EVENTS.SOURCING_EVENT_AWARDED,
    entityType: 'sourcing_event',
    entityId: award.event_id,
    data: {
      event_number: award.event_number,
      status: 'awarded',
      award_pr_number: pr.pr_number,
      currency: award.currency,
      award_total_cents: award.total_cents,
      suppliers: perSupplier.map((row) => ({
        supplier_id: Number(row.supplier_id),
        total_cents: Number(row.total_cents)
      }))
    },
    now
  });
}

/** A rejected award leaves the event `evaluated` and creates no POs. */
export async function onAwardRejected(db, award, pr, { userId, actorName, now = new Date() }) {
  await db.prepare(`
    UPDATE sourcing_awards SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending_approval'
  `).run(now.toISOString(), award.award_id);
  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES ('sourcing_event', ?, 'AWARD_REJECTED', ?, ?)
  `).run(award.event_id, actorName, `Award ${pr.pr_number} for RFQ ${award.event_number} was rejected`);
  await appendComplianceEvent(db, {
    ...(await actorFor(db, userId, actorName)),
    action: 'SOURCING_AWARD_REJECTED',
    entity_type: 'sourcing_award',
    entity_id: award.award_id,
    details: JSON.stringify({ award_pr_number: pr.pr_number })
  });
}
