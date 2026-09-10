import { formatCents } from './money.js';
import { resolveDecisionActor } from './delegationsService.js';

export class ApprovalDecisionError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ApprovalDecisionError';
    this.statusCode = statusCode;
  }
}

const FISCAL_YEAR = 2026;

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
        u.name as requester_name,
        u.email as requester_email,
        approver.name as assigned_approver_name,
        d.name as department_name,
        d.code as department_code,
        b.total_budget,
        b.committed_amount,
        b.actual_spent,
        (b.total_budget - b.committed_amount - b.actual_spent) as available_budget,
        (SELECT COUNT(*) FROM requisition_items WHERE requisition_id = pr.id) as item_count
      FROM approval_requests ar
      JOIN purchase_requisitions pr ON ar.requisition_id = pr.id
      JOIN users u ON pr.requester_id = u.id
      JOIN users approver ON ar.approver_id = approver.id
      JOIN departments d ON pr.department_id = d.id
      LEFT JOIN budgets b ON d.id = b.department_id AND b.fiscal_year = 2026
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
  return rows.map((row) => decorateInboxRow(row, approver_id));
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
export async function decideApprovalStep(db, { approvalId, decision, comments, approver_id, approver_name, override_budget }) {
  if (!['approved', 'rejected'].includes(decision)) {
    throw new ApprovalDecisionError('Decision must be approved or rejected');
  }
  if (approver_id == null || approver_id === '') {
    throw new ApprovalDecisionError('approver_id is required');
  }

  return db.transaction(async () => {
    const approval = await db.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(approvalId);
    if (!approval) {
      throw new ApprovalDecisionError('Approval request not found', 404);
    }

    if (approval.status !== 'pending') {
      throw new ApprovalDecisionError('Only the current pending approval step can be decided');
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

      return { outcome: 'rejected', budgetCommitted: false, ...delegateMeta };
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
      return { outcome: 'step_approved', budgetCommitted: false, nextApprovalId: nextWaiting.id, ...delegateMeta };
    }

    const budget = await db.prepare(
      `SELECT * FROM budgets WHERE department_id = ? AND fiscal_year = ?`
    ).get(pr.department_id, FISCAL_YEAR);
    if (!budget) {
      throw new ApprovalDecisionError(
        `No department budget found for fiscal year ${FISCAL_YEAR}`
      );
    }

    const remaining = remainingBudgetCents(budget);
    const allowBudgetOverride = isExplicitTrue(override_budget);
    if (remaining < pr.total_amount && !allowBudgetOverride) {
      throw new ApprovalDecisionError(
        `Insufficient remaining budget to commit this requisition. ` +
        `PR total $${formatCents(pr.total_amount)} exceeds remaining $${formatCents(remaining)} ` +
        `(total $${formatCents(budget.total_budget)} − committed $${formatCents(budget.committed_amount)} − actual $${formatCents(budget.actual_spent)}).`
      );
    }

    await db.prepare(
      `UPDATE purchase_requisitions SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(pr.id);

    await db.prepare(`
      UPDATE budgets
      SET committed_amount = committed_amount + ?
      WHERE department_id = ? AND fiscal_year = ?
    `).run(pr.total_amount, pr.department_id, FISCAL_YEAR);

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('requisition', ?, 'APPROVED', ?, ?)
    `).run(pr.id, actor, `Fully approved for $${formatCents(pr.total_amount)}.${viaNote} Committed budget allocated.`);

    if (remaining < pr.total_amount && allowBudgetOverride) {
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('requisition', ?, 'BUDGET_OVERRIDE', ?, ?)
      `).run(
        pr.id,
        actor,
        `Final approval overrode insufficient remaining budget ($${formatCents(remaining)}) to commit $${formatCents(pr.total_amount)}.`
      );
    }

    return { outcome: 'approved', budgetCommitted: true, ...delegateMeta };
  });
}
