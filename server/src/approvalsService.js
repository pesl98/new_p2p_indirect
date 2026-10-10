import { formatMoney } from './money.js';
import { currentFiscalYear } from './fiscalYear.js';
import { buildApprovalSteps } from './approvalPolicy.js';
import { withBusyRetry } from './busyRetry.js';
import { resolveDecisionActor } from './delegationsService.js';
import {
  guardAwardDecision,
  onAwardApproved,
  onAwardRejected,
  releaseSourceCommitment
} from './sourcingApprovalHooks.js';
import { kickWebhookDispatch } from './webhookOutbox.js';
import {
  CONTRACT_USE_ALLOWED,
  CONTRACT_USE_PROPOSED,
  CONTRACT_USE_REFUSED,
  nestSourceContract,
  parseAllowContractUse,
  SOURCE_CONTRACT_JOIN_SQL,
  SOURCE_CONTRACT_SELECT_SQL
} from './contractAssignment.js';

export class ApprovalDecisionError extends Error {
  constructor(message, statusCode = 400, code) {
    super(message);
    this.name = 'ApprovalDecisionError';
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

// The fiscal year is read when it is used, never frozen at start-up (a long-lived
// process crosses 1 January, and FISCAL_YEAR can be changed without a restart).
const BUDGET_OVERRIDE_ROLES = ['finance', 'admin'];

function isExplicitTrue(value) {
  return value === true || value === 1 || value === 'true' || value === '1';
}

/** Remaining = total_budget - committed_amount - actual_spent (integer cents). */
export function remainingBudgetCents(budget) {
  if (!budget) return 0;
  return (budget.total_budget || 0) - (budget.committed_amount || 0) - (budget.actual_spent || 0);
}

function decorateInboxRow(row, viewerId) {
  const assignedId = Number(row.approver_id);
  const via = viewerId != null && viewerId !== '' && Number(viewerId) !== assignedId;
  return {
    ...row,
    via_delegation: via ? 1 : 0,
    delegated_from_user_id: via ? assignedId : null,
    delegated_from_name: via ? (row.assigned_approver_name || null) : null
  };
}

/**
 * Approver inbox. Defaults to pending steps. When approver_id is set,
 * includes pending steps assigned to that user plus pending steps whose
 * mapped approver has an active delegation covering now to that user.
 * Waiting steps never appear. Stored approver_id is not rewritten.
 */
export async function listApprovalInbox(db, { approver_id, status } = {}) {
  const effectiveStatus = status || 'pending';
  const nowIso = new Date().toISOString();
  let query = `
      SELECT
        ar.id as approval_id,
        ar.requisition_id,
        ar.approver_id,
        ar.step_order,
        ar.status as approval_status,
        ar.comments as approval_comments,
        ar.created_at as request_date,
        pr.pr_number,
        pr.total_amount,
        pr.justification,
        pr.priority,
        pr.needed_by_date,
        pr.source_contract_id,
        pr.contract_use_status,
        u.name as requester_name,
        u.email as requester_email,
        approver.name as assigned_approver_name,
        d.name as department_name,
        d.code as department_code,
        b.total_budget,
        b.committed_amount,
        b.actual_spent,
        (b.total_budget - b.committed_amount - b.actual_spent) as available_budget,
        (SELECT COUNT(*) FROM requisition_items WHERE requisition_id = pr.id) as item_count,
        (SELECT e.event_number FROM sourcing_awards sa JOIN sourcing_events e ON e.id = sa.event_id
          WHERE sa.award_requisition_id = pr.id) as rfq_number,
        ${SOURCE_CONTRACT_SELECT_SQL}
      FROM approval_requests ar
      JOIN purchase_requisitions pr ON ar.requisition_id = pr.id
      JOIN users u ON pr.requester_id = u.id
      JOIN users approver ON ar.approver_id = approver.id
      JOIN departments d ON pr.department_id = d.id
      LEFT JOIN budgets b ON d.id = b.department_id AND b.fiscal_year = ${currentFiscalYear()}
      ${SOURCE_CONTRACT_JOIN_SQL}
      WHERE ar.status = ?
    `;
  const params = [effectiveStatus];

  if (approver_id != null && approver_id !== '') {
    if (effectiveStatus === 'pending') {
      query += `
        AND (
          ar.approver_id = ?
          OR EXISTS (
            SELECT 1 FROM approval_delegations ad
            WHERE ad.delegator_user_id = ar.approver_id
              AND ad.delegate_user_id = ?
              AND ad.active = 1
              AND (ad.starts_at IS NULL OR ad.starts_at <= ?)
              AND (ad.ends_at IS NULL OR ad.ends_at >= ?)
          )
        )
      `;
      params.push(approver_id, approver_id, nowIso, nowIso);
    } else {
      query += ` AND ar.approver_id = ?`;
      params.push(approver_id);
    }
  }

  query += ` ORDER BY ar.created_at DESC`;
  const rows = await db.prepare(query).all(...params);
  return rows.map((row) => decorateInboxRow(nestSourceContract(row), approver_id));
}

function delegationAuditNote(delegation) {
  if (!delegation) return '';
  return ` Delegated from ${delegation.delegator_name} (id=${delegation.delegator_user_id}, delegation_id=${delegation.id}).`;
}

/**
 * Apply an approve/reject decision to one approval row.
 * Sequential: only `pending` steps may be decided; on approve the next `waiting`
 * step is promoted; budget commits only when the final step is approved.
 * Final approve fails closed if remaining department budget is insufficient
 * unless `override_budget` is true.
 * Actor may be the mapped step approver or an active delegate covering now.
 */
/** Re-resolve one pending step without the requester and write the new approver on the row. */
async function rerouteAroundRequester(db, pr, approval) {
  const steps = await buildApprovalSteps({
    totalAmount: pr.total_amount,
    departmentId: pr.department_id,
    db,
    excludeUserIds: [pr.requester_id]
  });
  const planned = steps.find((step) => Number(step.step_order) === Number(approval.step_order));
  if (!planned || Number(planned.approver_id) === Number(pr.requester_id)) {
    throw new ApprovalDecisionError('No other approver is available for this step.', 422, 'sod_no_alternate_approver');
  }
  const user = await db.prepare(`SELECT id, name FROM users WHERE id = ?`).get(planned.approver_id);
  await db.prepare(`UPDATE approval_requests SET approver_id = ? WHERE id = ?`).run(planned.approver_id, approval.id);
  await db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
    VALUES ('requisition', ?, 'APPROVAL_REROUTED', 'System', ?)
  `).run(pr.id, `Step ${approval.step_order} was assigned to the requester and moved to ${user?.name || planned.approver_id}.`);
  return { id: Number(planned.approver_id), name: user?.name || null };
}

export async function decideApprovalStep(db, { approvalId, decision, comments, approver_id, approver_name, override_budget, allow_contract_use }) {
  if (!['approved', 'rejected'].includes(decision)) {
    throw new ApprovalDecisionError('Decision must be approved or rejected');
  }
  if (approver_id == null || approver_id === '') {
    throw new ApprovalDecisionError('approver_id is required');
  }

  // BEGIN IMMEDIATE takes the write lock before the first read, so two decisions on the
  // same step serialise (the second sees a decided step: 409), and a busy lock is retried.
  const decided = await withBusyRetry(() => db.immediateTransaction(async () => {
    const approval = await db.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(approvalId);
    if (!approval) {
      throw new ApprovalDecisionError('Approval request not found', 404);
    }

    if (approval.status !== 'pending') {
      const alreadyDecided = ['approved', 'rejected', 'skipped'].includes(approval.status);
      throw new ApprovalDecisionError(
        'Only the current pending approval step can be decided',
        alreadyDecided ? 409 : 400,
        alreadyDecided ? 'approval_already_decided' : undefined
      );
    }

    const actorCheck = await resolveDecisionActor(db, approval.approver_id, approver_id);
    if (!actorCheck.authorized) {
      throw new ApprovalDecisionError(
        'approver_id does not match the current pending step',
        403
      );
    }

    const pr = await db.prepare(`SELECT * FROM purchase_requisitions WHERE id = ?`).get(approval.requisition_id);
    if (!pr) {
      throw new ApprovalDecisionError('Associated requisition not found', 404);
    }

    const award = await guardAwardDecision(db, pr, {
      approverId: approver_id,
      actorCheck,
      stepApproverId: approval.approver_id,
      makeError: (message, status, code) => new ApprovalDecisionError(message, status, code)
    });

    // A step that was assigned to the requester themselves (a department head who raised the
    // requisition, a chain built before requesters were excluded) is not a dead end: it is
    // re-routed to the next eligible approver and the requester is told, instead of a 403.
    if (!award && Number(approval.approver_id) === Number(pr.requester_id)) {
      const replacement = await rerouteAroundRequester(db, pr, approval);
      return {
        outcome: 'rerouted',
        budgetCommitted: false,
        rerouted_to: replacement,
        message: `This step was assigned to the requester. It now goes to ${replacement.name}.`,
        contract_use_status: pr.contract_use_status
      };
    }

    if (Number(pr.requester_id) === Number(approver_id)) {
      throw new ApprovalDecisionError('You cannot decide your own requisition', 403);
    }

    let contractUseDecision = null;
    if (decision === 'approved' && pr.contract_use_status === CONTRACT_USE_PROPOSED) {
      const allowUse = parseAllowContractUse(allow_contract_use);
      if (allowUse === undefined) {
        throw new ApprovalDecisionError(
          'allow_contract_use is required when a contract is proposed (true = allow, false = refuse; refusing does not reject the requisition)'
        );
      }
      contractUseDecision = allowUse ? CONTRACT_USE_ALLOWED : CONTRACT_USE_REFUSED;
      await db.prepare(`
        UPDATE purchase_requisitions
        SET contract_use_status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(contractUseDecision, pr.id);
    }

    await db.prepare(`
      UPDATE approval_requests
      SET status = ?, comments = ?, decided_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(decision, comments || null, approvalId);

    const actor = approver_name || 'Approver';
    const viaNote = delegationAuditNote(actorCheck.delegation);
    const delegateMeta = actorCheck.viaDelegation
      ? {
          decidedAsDelegate: true,
          delegated_from_user_id: actorCheck.delegation.delegator_user_id,
          delegated_from_name: actorCheck.delegation.delegator_name,
          delegation_id: actorCheck.delegation.id
        }
      : { decidedAsDelegate: false };

    if (contractUseDecision === CONTRACT_USE_ALLOWED) {
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('requisition', ?, 'CONTRACT_USE_ALLOWED', ?, ?)
      `).run(
        pr.id,
        actor,
        `Allowed use of contract id=${pr.source_contract_id}.${viaNote}`.trim()
      );
    } else if (contractUseDecision === CONTRACT_USE_REFUSED) {
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('requisition', ?, 'CONTRACT_USE_REFUSED', ?, ?)
      `).run(
        pr.id,
        actor,
        `Refused use of contract id=${pr.source_contract_id}; requisition continues as ad-hoc.${viaNote}`.trim()
      );
    }

    if (decision === 'rejected') {
      await db.prepare(
        `UPDATE purchase_requisitions SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(pr.id);
      await db.prepare(`
        UPDATE approval_requests
        SET status = 'skipped'
        WHERE requisition_id = ? AND status IN ('pending', 'waiting')
      `).run(pr.id);

      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('requisition', ?, 'REJECTED', ?, ?)
      `).run(pr.id, actor, `Rejected by ${actor}.${viaNote} Reason: ${comments || 'No reason specified'}`);

      if (award) await onAwardRejected(db, award, pr, { userId: approver_id, actorName: actor });

      return { outcome: 'rejected', budgetCommitted: false, contract_use_status: pr.contract_use_status, ...delegateMeta };
    }

    const nextWaiting = await db.prepare(`
      SELECT * FROM approval_requests
      WHERE requisition_id = ? AND status = 'waiting'
      ORDER BY step_order ASC
      LIMIT 1
    `).get(pr.id);

    if (nextWaiting) {
      await db.prepare(`UPDATE approval_requests SET status = 'pending' WHERE id = ?`).run(nextWaiting.id);
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('requisition', ?, 'STEP_APPROVED', ?, ?)
      `).run(pr.id, actor, `Step approved by ${actor}.${viaNote} Forwarded to next approver tier.`);
      return {
        outcome: 'step_approved',
        budgetCommitted: false,
        nextApprovalId: nextWaiting.id,
        contract_use_status: contractUseDecision || pr.contract_use_status,
        ...delegateMeta
      };
    }

    // Award PR: free the source PR's commitment first so the department is
    // charged the awarded amount, not estimate + award.
    if (award) await releaseSourceCommitment(db, award, { userId: approver_id, actorName: actor });

    const budget = await db.prepare(
      `SELECT * FROM budgets WHERE department_id = ? AND fiscal_year = ?`
    ).get(pr.department_id, currentFiscalYear());
    if (!budget) {
      throw new ApprovalDecisionError(
        `No department budget found for fiscal year ${currentFiscalYear()}`
      );
    }

    const remaining = remainingBudgetCents(budget);
    const allowBudgetOverride = isExplicitTrue(override_budget);
    if (allowBudgetOverride) {
      const actorRow = await db.prepare(`SELECT role FROM users WHERE id = ?`).get(approver_id);
      if (!BUDGET_OVERRIDE_ROLES.includes(actorRow?.role)) {
        throw new ApprovalDecisionError('Only finance or admin may override the department budget', 403);
      }
    }
    if (remaining < pr.total_amount && !allowBudgetOverride) {
      throw new ApprovalDecisionError(
        `Insufficient remaining budget to commit this requisition. ` +
        `PR total ${formatMoney(pr.total_amount)} exceeds remaining ${formatMoney(remaining)} ` +
        `(total ${formatMoney(budget.total_budget)} − committed ${formatMoney(budget.committed_amount)} − actual ${formatMoney(budget.actual_spent)}).`
      );
    }

    await db.prepare(
      `UPDATE purchase_requisitions SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(pr.id);

    await db.prepare(`
      UPDATE budgets
      SET committed_amount = committed_amount + ?
      WHERE department_id = ? AND fiscal_year = ?
    `).run(pr.total_amount, pr.department_id, currentFiscalYear());

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('requisition', ?, 'APPROVED', ?, ?)
    `).run(pr.id, actor, `Fully approved for ${formatMoney(pr.total_amount)}.${viaNote} Committed budget allocated.`);

    if (remaining < pr.total_amount && allowBudgetOverride) {
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('requisition', ?, 'BUDGET_OVERRIDE', ?, ?)
      `).run(
        pr.id,
        actor,
        `Final approval overrode insufficient remaining budget (${formatMoney(remaining)}) to commit ${formatMoney(pr.total_amount)}.`
      );
    }

    if (award) await onAwardApproved(db, award, pr, { userId: approver_id, actorName: actor });

    return {
      outcome: 'approved',
      budgetCommitted: true,
      sourcing_event_id: award ? award.event_id : undefined,
      contract_use_status: contractUseDecision || pr.contract_use_status,
      ...delegateMeta
    };
  }));
  if (decided.sourcing_event_id) kickWebhookDispatch(db);
  return decided;
}
