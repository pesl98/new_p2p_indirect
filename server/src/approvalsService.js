import { formatCents } from './money.js';

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

/**
 * Apply an approve/reject decision to one approval row.
 * Sequential: only `pending` steps may be decided; on approve the next `waiting`
 * step is promoted; budget commits only when the final step is approved.
 * Final approve fails closed if remaining department budget is insufficient
 * unless `override_budget` is true.
 */
export function decideApprovalStep(db, { approvalId, decision, comments, approver_id, approver_name, override_budget }) {
  if (!['approved', 'rejected'].includes(decision)) {
    throw new ApprovalDecisionError('Decision must be approved or rejected');
  }
  if (approver_id == null || approver_id === '') {
    throw new ApprovalDecisionError('approver_id is required');
  }

  const processDecision = db.transaction(() => {
    const approval = db.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(approvalId);
    if (!approval) {
      throw new ApprovalDecisionError('Approval request not found', 404);
    }

    if (approval.status !== 'pending') {
      throw new ApprovalDecisionError('Only the current pending approval step can be decided');
    }

    if (Number(approver_id) !== Number(approval.approver_id)) {
      throw new ApprovalDecisionError(
        'approver_id does not match the current pending step',
        403
      );
    }

    const pr = db.prepare(`SELECT * FROM purchase_requisitions WHERE id = ?`).get(approval.requisition_id);
    if (!pr) {
      throw new ApprovalDecisionError('Associated requisition not found', 404);
    }

    db.prepare(`
      UPDATE approval_requests
      SET status = ?, comments = ?, decided_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(decision, comments || null, approvalId);

    const actor = approver_name || 'Approver';

    if (decision === 'rejected') {
      db.prepare(
        `UPDATE purchase_requisitions SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(pr.id);
      db.prepare(`
        UPDATE approval_requests
        SET status = 'skipped'
        WHERE requisition_id = ? AND status IN ('pending', 'waiting')
      `).run(pr.id);

      db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('requisition', ?, 'REJECTED', ?, ?)
      `).run(pr.id, actor, `Rejected by ${actor}. Reason: ${comments || 'No reason specified'}`);

      return { outcome: 'rejected', budgetCommitted: false };
    }

    const nextWaiting = db.prepare(`
      SELECT * FROM approval_requests
      WHERE requisition_id = ? AND status = 'waiting'
      ORDER BY step_order ASC
      LIMIT 1
    `).get(pr.id);

    if (nextWaiting) {
      db.prepare(`UPDATE approval_requests SET status = 'pending' WHERE id = ?`).run(nextWaiting.id);
      db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('requisition', ?, 'STEP_APPROVED', ?, ?)
      `).run(pr.id, actor, `Step approved by ${actor}. Forwarded to next approver tier.`);
      return { outcome: 'step_approved', budgetCommitted: false, nextApprovalId: nextWaiting.id };
    }

    const budget = db.prepare(
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

    db.prepare(
      `UPDATE purchase_requisitions SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(pr.id);

    db.prepare(`
      UPDATE budgets
      SET committed_amount = committed_amount + ?
      WHERE department_id = ? AND fiscal_year = ?
    `).run(pr.total_amount, pr.department_id, FISCAL_YEAR);

    db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('requisition', ?, 'APPROVED', ?, ?)
    `).run(pr.id, actor, `Fully approved for $${formatCents(pr.total_amount)}. Committed budget allocated.`);

    if (remaining < pr.total_amount && allowBudgetOverride) {
      db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('requisition', ?, 'BUDGET_OVERRIDE', ?, ?)
      `).run(
        pr.id,
        actor,
        `Final approval overrode insufficient remaining budget ($${formatCents(remaining)}) to commit $${formatCents(pr.total_amount)}.`
      );
    }

    return { outcome: 'approved', budgetCommitted: true };
  });

  return processDecision();
}
