/**
 * Award side effects inside decideApprovalStep's transaction.
 * This module does not import approvalsService (that import would cycle).
 * FISCAL_YEAR matches the hardcoded year in approvalsService.
 */

import { actorFromSession, appendComplianceEvents } from './complianceAudit.js';
import { APPROVAL_TIER2_CENTS, APPROVAL_TIER3_CENTS } from './money.js';
import { enqueueWebhook, WEBHOOK_EVENTS } from './webhookOutbox.js';

export const AWARD_FISCAL_YEAR = 2026;

/**
 * Awards strictly above this value are segregated. The env value is clamped to
 * € 10.000,00 (APPROVAL_TIER3_CENTS) so a typo cannot switch the control off.
 */
export function awardSodThresholdCents(env = process.env) {
  const raw = env.SOURCING_AWARD_SOD_THRESHOLD_CENTS;
  if (raw == null || String(raw).trim() === '') return APPROVAL_TIER2_CENTS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return APPROVAL_TIER2_CENTS;
  return Math.min(value, APPROVAL_TIER3_CENTS);
}

export class SourcingApprovalError extends Error {
  constructor(message, statusCode = 400, code = 'sourcing_error') {
    super(message);
    this.name = 'SourcingApprovalError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export async function loadAwardForRequisition(db, requisitionId) {
  return db.prepare(`
    SELECT
      a.id, a.event_id, a.status, a.total_cents, a.award_requisition_id,
      a.proposed_by_user_id, a.owner_user_id AS award_owner_user_id,
      e.event_number, e.owner_user_id, e.status AS event_status,
      e.source_requisition_id, e.currency, e.row_version
    FROM sourcing_awards a
    JOIN sourcing_events e ON e.id = a.event_id
    WHERE a.award_requisition_id = ?
    LIMIT 1
  `).get(requisitionId);
}

/**
 * Users who may not take part in approving an award above the threshold: the
 * RFQ owner (at proposal time and now), the user who proposed it, and every
 * evaluator who declared a conflict.
 */
export async function restrictedAwardUsers(db, award) {
  const ids = new Set([
    Number(award.award_owner_user_id),
    Number(award.owner_user_id),
    Number(award.proposed_by_user_id)
  ]);
  const conflicted = await db.prepare(`
    SELECT user_id FROM sourcing_evaluators WHERE event_id = ? AND coi_status = 'conflict_declared'
  `).all(award.event_id);
  for (const row of conflicted || []) ids.add(Number(row.user_id));
  ids.delete(0);
  ids.delete(NaN);
  return ids;
}

/**
 * Before the decision is written. Strictly above the threshold none of the
 * restricted users may decide: directly, as the delegate of a step, as the
 * delegator whose step a delegate decides, or when the step itself is
 * assigned to one of them. This holds for admins too. Returns the award row,
 * or null when this requisition is not an award.
 */
export async function guardAwardSelfApproval(db, {
  requisitionId,
  decidingUserId,
  delegation = null,
  stepApproverId = null,
  env = process.env
} = {}) {
  const award = await loadAwardForRequisition(db, requisitionId);
  if (!award || award.status !== 'pending_approval') return null;
  if (Number(award.total_cents) <= awardSodThresholdCents(env)) return award;
  const restricted = await restrictedAwardUsers(db, award);
  const involved = [
    Number(decidingUserId),
    stepApproverId == null ? NaN : Number(stepApproverId),
    delegation ? Number(delegation.delegator_user_id) : NaN,
    delegation ? Number(delegation.delegate_user_id) : NaN
  ];
  if (involved.some((id) => restricted.has(id))) {
    throw new SourcingApprovalError(
      'The RFQ owner, the proposer, and users with a declared conflict cannot approve this award.',
      403,
      'sod_award_self_approval'
    );
  }
  return award;
}

async function writeAudit(db, entityType, entityId, action, actorName, details) {
  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(entityType, entityId, action, actorName, details);
}

/**
 * After a final approve or a reject, still inside the same transaction.
 * step_approved does not change the award. The award row comes from the guard
 * so a non-award decision does not query twice.
 */
export async function applyAwardDecision(db, {
  award,
  requisition,
  outcome,
  actor,
  env = process.env
} = {}) {
  if (!award || outcome === 'step_approved') return null;
  if (award.status !== 'pending_approval') return null;
  const now = new Date().toISOString();
  const actorName = actor?.name || 'Approver';
  const sessionActor = actorFromSession({
    id: actor?.id,
    name: actorName,
    role: actor?.role || null
  });

  if (outcome === 'rejected') {
    const updated = await db.prepare(`
      UPDATE sourcing_awards
      SET status = 'rejected', decided_at = ?
      WHERE id = ? AND status = 'pending_approval'
    `).run(now, award.id);
    if (!updated.changes) return null;
    await writeAudit(
      db,
      'sourcing_award',
      award.id,
      'REJECTED',
      actorName,
      `Award for ${award.event_number} rejected. Requisition ${requisition.pr_number}.`
    );
    await appendComplianceEvents(db, [{
      ...sessionActor,
      action: 'SOURCING_AWARD_REJECTED',
      entity_type: 'sourcing_award',
      entity_id: award.id,
      details: JSON.stringify({
        award_requisition_number: requisition.pr_number,
        event_number: award.event_number
      }),
      created_at: now
    }]);
    await enqueueWebhook(db, {
      eventType: WEBHOOK_EVENTS.SOURCING_EVENT_AWARD_REJECTED,
      entityType: 'sourcing_event',
      entityId: award.event_id,
      data: {
        event_number: award.event_number,
        award_id: Number(award.id),
        pr_number: requisition.pr_number,
        status: 'rejected'
      },
      now: new Date(now)
    });
    return { award_id: Number(award.id), status: 'rejected' };
  }

  if (outcome !== 'approved') return null;

  const updated = await db.prepare(`
    UPDATE sourcing_awards
    SET status = 'approved', decided_at = ?
    WHERE id = ? AND status = 'pending_approval'
  `).run(now, award.id);
  if (!updated.changes) return null;
  const eventUpdate = await db.prepare(`
    UPDATE sourcing_events
    SET status = 'awarded', awarded_at = ?, row_version = row_version + 1, updated_at = ?
    WHERE id = ? AND status = 'evaluated'
  `).run(now, now, award.event_id);
  if (!eventUpdate.changes) {
    throw new SourcingApprovalError(
      'The RFQ changed while the award was approved.',
      409,
      'event_state_changed'
    );
  }

  const compliance = [{
    ...sessionActor,
    action: 'SOURCING_AWARD_APPROVED',
    entity_type: 'sourcing_award',
    entity_id: award.id,
    details: JSON.stringify({
      award_requisition_number: requisition.pr_number,
      event_number: award.event_number,
      total_cents: Number(award.total_cents)
    }),
    created_at: now
  }];

  if (award.source_requisition_id) {
    const source = await db.prepare(`
      SELECT id, pr_number, total_amount, department_id
      FROM purchase_requisitions WHERE id = ?
    `).get(award.source_requisition_id);
    if (source) {
      await db.prepare(`
        UPDATE budgets
        SET committed_amount = MAX(0, committed_amount - ?)
        WHERE department_id = ? AND fiscal_year = ?
      `).run(source.total_amount, source.department_id, AWARD_FISCAL_YEAR);
      await writeAudit(
        db,
        'requisition',
        source.id,
        'SOURCING_SOURCE_REQUISITION_SUPERSEDED',
        actorName,
        `Released ${source.total_amount} cents committed for ${source.pr_number} because ${award.event_number} was awarded on ${requisition.pr_number}.`
      );
      compliance.push({
        ...sessionActor,
        action: 'SOURCING_SOURCE_REQUISITION_SUPERSEDED',
        entity_type: 'requisition',
        entity_id: source.id,
        details: JSON.stringify({
          released_cents: Number(source.total_amount),
          pr_number: source.pr_number,
          event_number: award.event_number,
          award_requisition_number: requisition.pr_number
        }),
        created_at: now
      });
    }
  }

  const groups = await db.prepare(`
    SELECT supplier_id, SUM(line_total_cents) AS total_cents
    FROM sourcing_award_lines
    WHERE award_id = ?
    GROUP BY supplier_id
    ORDER BY supplier_id ASC
  `).all(award.id);

  await writeAudit(
    db,
    'sourcing_award',
    award.id,
    'APPROVED',
    actorName,
    `Award for ${award.event_number} approved. Requisition ${requisition.pr_number}.`
  );
  await appendComplianceEvents(db, compliance);
  await enqueueWebhook(db, {
    eventType: WEBHOOK_EVENTS.SOURCING_EVENT_AWARDED,
    entityType: 'sourcing_event',
    entityId: award.event_id,
    data: {
      event_number: award.event_number,
      award_id: Number(award.id),
      pr_number: requisition.pr_number,
      currency: award.currency || 'EUR',
      total_cents: Number(award.total_cents),
      suppliers: groups.map((row) => ({
        supplier_id: Number(row.supplier_id),
        total_cents: Number(row.total_cents)
      })),
      threshold_cents: awardSodThresholdCents(env)
    },
    now: new Date(now)
  });
  return { award_id: Number(award.id), status: 'approved' };
}
