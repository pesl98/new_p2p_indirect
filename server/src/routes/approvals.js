import express from 'express';
import { decideApprovalStep, listApprovalInbox } from '../approvalsService.js';

const router = express.Router();

// Get pending approval requests (includes steps visible via active delegation)
router.get('/', async (req, res) => {
  try {
    const { approver_id, status } = req.query;
    const approvals = await listApprovalInbox(req.db, { approver_id, status });
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
