import express from 'express';
import db from '../db.js';

const router = express.Router();

// Get pending approval requests
router.get('/', (req, res) => {
  try {
    const { approver_id, status } = req.query;
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
      JOIN departments d ON pr.department_id = d.id
      LEFT JOIN budgets b ON d.id = b.department_id AND b.fiscal_year = 2026
      WHERE 1=1
    `;
    const params = [];

    if (approver_id) {
      query += ` AND ar.approver_id = ?`;
      params.push(approver_id);
    }
    if (status) {
      query += ` AND ar.status = ?`;
      params.push(status);
    } else {
      query += ` AND ar.status = 'pending'`;
    }

    query += ` ORDER BY ar.created_at DESC`;
    const approvals = db.prepare(query).all(...params);
    res.json(approvals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approve or reject a requisition step
router.post('/:id/decide', (req, res) => {
  try {
    const { id } = req.params;
    const { decision, comments, approver_name } = req.body; // decision: 'approved' | 'rejected'

    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'Decision must be approved or rejected' });
    }

    const approval = db.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(id);
    if (!approval) {
      return res.status(404).json({ error: 'Approval request not found' });
    }

    const pr = db.prepare(`SELECT * FROM purchase_requisitions WHERE id = ?`).get(approval.requisition_id);
    if (!pr) {
      return res.status(404).json({ error: 'Associated requisition not found' });
    }

    const processDecision = db.transaction(() => {
      // 1. Update this approval record
      db.prepare(`
        UPDATE approval_requests
        SET status = ?, comments = ?, decided_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(decision, comments || null, id);

      const actor = approver_name || 'Approver';

      if (decision === 'rejected') {
        // Mark PR as rejected
        db.prepare(`UPDATE purchase_requisitions SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(pr.id);
        // Cancel other pending approvals for this PR
        db.prepare(`UPDATE approval_requests SET status = 'skipped' WHERE requisition_id = ? AND status = 'pending'`).run(pr.id);

        db.prepare(`
          INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
          VALUES ('requisition', ?, 'REJECTED', ?, ?)
        `).run(pr.id, actor, `Rejected by ${actor}. Reason: ${comments || 'No reason specified'}`);
      } else {
        // Check if there are still other pending approvals for this PR
        const remaining = db.prepare(`
          SELECT COUNT(*) as count FROM approval_requests
          WHERE requisition_id = ? AND status = 'pending'
        `).get(pr.id);

        if (remaining.count === 0) {
          // All steps completed! PR is fully approved
          db.prepare(`UPDATE purchase_requisitions SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(pr.id);

          // Update committed budget for department
          db.prepare(`
            UPDATE budgets
            SET committed_amount = committed_amount + ?
            WHERE department_id = ? AND fiscal_year = 2026
          `).run(pr.total_amount, pr.department_id);

          db.prepare(`
            INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
            VALUES ('requisition', ?, 'APPROVED', ?, ?)
          `).run(pr.id, actor, `Fully approved for $${pr.total_amount.toFixed(2)}. Committed budget allocated.`);
        } else {
          db.prepare(`
            INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
            VALUES ('requisition', ?, 'STEP_APPROVED', ?, ?)
          `).run(pr.id, actor, `Step approved by ${actor}. Forwarded to next approver tier.`);
        }
      }
    });

    processDecision();
    res.json({ message: `Requisition ${decision} successfully` });
  } catch (error) {
    console.error('Error deciding approval:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
