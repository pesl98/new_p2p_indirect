import express from 'express';
import {
  MeasuredFlowError,
  getUtilityOverview,
  openUtilityArrangement,
  recordUtilityConsumption
} from '../utilityService.js';
import { withSessionActor } from '../requestActor.js';

const router = express.Router();

function sendError(res, error) {
  const status = error.statusCode || (error instanceof MeasuredFlowError ? 400 : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message });
}

router.get('/', async (req, res) => {
  try {
    res.json(await getUtilityOverview(req.db));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/arrangements', async (req, res) => {
  try {
    const body = withSessionActor(req, req.body || {}, {
      ids: ['opened_by'],
      names: ['actor_name']
    });
    const result = await openUtilityArrangement(req.db, body);
    res.status(201).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/consumptions', async (req, res) => {
  try {
    const body = withSessionActor(req, req.body || {}, {
      ids: ['recorded_by'],
      names: ['actor_name']
    });
    const result = await recordUtilityConsumption(req.db, body);
    res.status(201).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
