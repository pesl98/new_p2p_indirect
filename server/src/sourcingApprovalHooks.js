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

/**
 * One read for everything the approval hooks need: the award, its event, the source
 * requisition, the evaluators who declared a conflict, and the deciding user's role.
 * It exists to keep the final approval inside the Turso statement budget (plan §6.1).
 */
export async function loadAwardByRequisition(db, requisitionId, { deciderUserId = null } = {}) {
  return db.prepare(`
    SELECT a.id AS award_id, a.event_id, a.award_type, a.status AS award_status, a.total_cents,
           a.is_lowest, a.reason, a.award_requisition_id,
           a.proposed_by_user_id, a.owner_user_id AS award_owner_user_id,
           e.event_number, e.owner_user_id, e.source_requisition_id, e.currency, e.status AS event_status,
           src.pr_number AS src_pr_number, src.department_id AS src_department_id,
           src.total_amount AS src_total_amount, src.status AS src_status,
           (SELECT group_concat(ev.user_id) FROM sourcing_evaluators ev
             WHERE ev.event_id = a.event_id AND ev.coi_status = 'conflict_declared') AS conflict_user_ids,
           (SELECT u.role FROM users u WHERE u.id = ?) AS decider_role
    FROM sourcing_awards a
    JOIN sourcing_events e ON e.id = a.event_id
    LEFT JOIN purchase_requisitions src ON src.id = e.source_requisition_id
    WHERE a.award_requisition_id = ?
  `).get(deciderUserId, requisitionId);
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
  const set = new Set([
    Number(award.award_owner_user_id ?? award.owner_user_id),
    Number(award.proposed_by_user_id)
  ]);
  if (award.conflict_user_ids !== undefined) {
    // Already read together with the award (the approval path).
    for (const id of String(award.conflict_user_ids || '').split(',').filter(Boolean)) set.add(Number(id));
  } else {
    const rows = await db.prepare(`
      SELECT user_id FROM sourcing_evaluators WHERE event_id = ? AND coi_status = 'conflict_declared'
    `).all(award.event_id);
    for (const row of rows) set.add(Number(row.user_id));
  }
  set.delete(NaN);
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
  const award = await loadAwardByRequisition(db, pr.id, { deciderUserId: approverId });
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

function actorFor(award, userId, fallbackName) {
  return actorFromSession({ id: userId, name: fallbackName || 'Approver', role: award?.decider_role || null });
}

/**
 * Release the source PR's budget commitment before the award PR commits, so the
 * department is charged the awarded amount rather than estimate + award. One UPDATE;
 * the history is written with the award's own rows in onAwardApproved.
 */
export async function releaseSourceCommitment(db, award) {
  if (!award?.source_requisition_id || award.src_status !== 'approved') return null;
  const released = Number(award.src_total_amount) || 0;
  await db.prepare(`
    UPDATE budgets SET committed_amount = MAX(0, committed_amount - ?)
    WHERE department_id = ? AND fiscal_year = ?
  `).run(released, award.src_department_id, currentFiscalYear());
  return { source_requisition_id: Number(award.source_requisition_id), pr_number: award.src_pr_number, released_cents: released };
}

/**
 * Called after the award PR's budget is committed. History rows (the award and, when
 * there was one, the superseded source requisition) are one INSERT, and the release is
 * recorded in the single SOURCING_AWARD_APPROVED compliance row.
 */
export async function onAwardApproved(db, award, pr, { userId, actorName, now = new Date(), release = null }) {
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
  const history = [['sourcing_event', award.event_id, 'AWARDED', actorName, `RFQ ${award.event_number} awarded via ${pr.pr_number}`]];
  if (release) {
    history.push([
      'requisition', release.source_requisition_id, 'SOURCING_SOURCE_REQUISITION_SUPERSEDED', actorName,
      `Superseded by RFQ ${award.event_number}; released ${release.released_cents} cents of committed budget.`
    ]);
  }
  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES ${history.map(() => '(?, ?, ?, ?, ?)').join(', ')}
  `).run(...history.flat());
  await appendComplianceEvent(db, {
    ...actorFor(award, userId, actorName),
    action: 'SOURCING_AWARD_APPROVED',
    entity_type: 'sourcing_award',
    entity_id: award.award_id,
    details: JSON.stringify({
      award_pr_number: pr.pr_number,
      total_cents: award.total_cents,
      ...(release ? { source_requisition_superseded: release } : {})
    })
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
    ...actorFor(award, userId, actorName),
    action: 'SOURCING_AWARD_REJECTED',
    entity_type: 'sourcing_award',
    entity_id: award.award_id,
    details: JSON.stringify({ award_pr_number: pr.pr_number })
  });
}
