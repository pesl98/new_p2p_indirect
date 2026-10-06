import express from 'express';
import {
  DelegationError,
  createDelegation,
  listDelegations,
  loadDelegation,
  revokeDelegation
} from '../delegationsService.js';
import { MasterDataError } from '../masterData.js';
import {
  assertSelfOrAdmin,
  assertSessionId,
  sessionActor,
  withSessionActor
} from '../requestActor.js';

const router = express.Router();

function sendError(res, error) {
  const status = error.statusCode
    || ((error instanceof DelegationError || error instanceof MasterDataError) ? error.statusCode : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message });
}

// Session required. Non-admins only see rows where they are delegator or delegate.
router.get('/', async (req, res) => {
  try {
    const actor = sessionActor(req);
    let { user_id, delegator_user_id, delegate_user_id, active } = req.query;
    if (actor.role !== 'admin') {
      assertSessionId(actor, user_id, 'user_id');
      assertSessionId(actor, delegator_user_id, 'delegator_user_id');
      user_id = actor.id;
    }
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
    const actor = sessionActor(req);
    const row = await loadDelegation(req.db, req.params.id);
    if (actor.role !== 'admin'
      && Number(row.delegator_user_id) !== actor.id
      && Number(row.delegate_user_id) !== actor.id) {
      return res.status(403).json({ error: 'This delegation is not visible to the signed-in user.' });
    }
    res.json(row);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/', async (req, res) => {
  try {
    const actor = sessionActor(req);
    const body = withSessionActor(req, req.body || {}, {
      ids: ['actor_user_id', 'created_by_user_id'],
      names: ['actor_name', 'created_by_name']
    });
    if (actor.role !== 'admin') {
      assertSessionId(actor, body.delegator_user_id, 'delegator_user_id');
      body.delegator_user_id = actor.id;
    }
    const created = await createDelegation(req.db, body);
    res.status(201).json(created);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/:id/revoke', async (req, res) => {
  try {
    const current = await loadDelegation(req.db, req.params.id);
    assertSelfOrAdmin(
      sessionActor(req),
      current.delegator_user_id,
      'Only the delegator or an admin can revoke this delegation.'
    );
    const body = withSessionActor(req, req.body || {}, {
      ids: ['actor_user_id', 'revoked_by_user_id'],
      names: ['actor_name', 'revoked_by_name']
    });
    res.json(await revokeDelegation(req.db, req.params.id, body));
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
