import express from 'express';
import {
  DelegationError,
  createDelegation,
  listDelegations,
  loadDelegation,
  revokeDelegation
} from '../delegationsService.js';
import { MasterDataError } from '../masterData.js';

const router = express.Router();

function sendError(res, error) {
  const status = error.statusCode
    || ((error instanceof DelegationError || error instanceof MasterDataError) ? error.statusCode : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message });
}

// Demo-open like supplier/catalog/department-head APIs (no JWT).
router.get('/', async (req, res) => {
  try {
    const { user_id, delegator_user_id, delegate_user_id, active } = req.query;
    res.json(await listDelegations(req.db, {
      user_id,
      delegator_user_id,
      delegate_user_id,
      active
    }));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await loadDelegation(req.db, req.params.id));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/', async (req, res) => {
  try {
    const created = await createDelegation(req.db, req.body || {});
    res.status(201).json(created);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/:id/revoke', async (req, res) => {
  try {
    res.json(await revokeDelegation(req.db, req.params.id, req.body || {}));
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/:id', (_req, res) => {
  res.status(405).json({
    error: 'Hard delete is not allowed. Soft-revoke the delegation instead (POST /api/approval-delegations/:id/revoke).'
  });
});

export default router;
