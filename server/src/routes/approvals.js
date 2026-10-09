import express from 'express';
import { decideApprovalStep, listApprovalInbox } from '../approvalsService.js';
import { assertSessionId, sessionActor, withSessionActor } from '../requestActor.js';

const router = express.Router();

// Inbox is the signed-in user (plus steps delegated to them). Query approver_id
// cannot select another persona.
router.get('/', async (req, res) => {
  try {
    const actor = sessionActor(req);
    assertSessionId(actor, req.query.approver_id, 'approver_id');
    const approvals = await listApprovalInbox(req.db, {
      approver_id: actor.id,
      status: req.query.status
    });
    res.json(approvals);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Approve or reject a requisition step. Actor is the session user.
router.post('/:id/decide', async (req, res) => {
  try {
    const db = req.db;
    const { id } = req.params;
    const body = withSessionActor(req, req.body, {
      ids: ['approver_id'],
      names: ['approver_name']
    });

    const result = await decideApprovalStep(db, {
      approvalId: id,
      decision: body.decision,
      comments: body.comments,
      approver_id: body.approver_id,
      approver_name: body.approver_name,
      override_budget: body.override_budget,
      allow_contract_use: body.allow_contract_use
    });

    res.json({ message: `Requisition ${body.decision} successfully`, ...result });
  } catch (error) {
    console.error('Error deciding approval:', error);
    const body = { error: error.message };
    if (error.code) body.code = error.code;
    res.status(error.statusCode || 500).json(body);
  }
});

export default router;
