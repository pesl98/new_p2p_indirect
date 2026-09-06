import express from 'express';
import { decideApprovalStep } from '../approvalsService.js';

const router = express.Router();

// Get pending approval requests
router.get('/', async (req, res) => {
  try {
    const db = req.db;
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
    const approvals = await db.prepare(query).all(...params);
    res.json(approvals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approve or reject a requisition step
router.post('/:id/decide', async (req, res) => {
  try {
    const db = req.db;
    const { id } = req.params;
    const { decision, comments, approver_name, approver_id, override_budget } = req.body; // decision: 'approved' | 'rejected'

    const result = await decideApprovalStep(db, {
      approvalId: id,
      decision,
      comments,
      approver_id,
      approver_name,
      override_budget
    });

    res.json({ message: `Requisition ${decision} successfully`, ...result });
  } catch (error) {
    console.error('Error deciding approval:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

export default router;
