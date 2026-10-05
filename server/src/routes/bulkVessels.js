import express from 'express';
import {
  MeasuredFlowError,
  drawBulkContainer,
  fillBulkContainer,
  getBulkOverview,
  registerBulkContainer
} from '../bulkVesselService.js';
import { withSessionActor } from '../requestActor.js';

const router = express.Router();

function sendError(res, error) {
  const status = error.statusCode || (error instanceof MeasuredFlowError ? 400 : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message });
}

router.get('/', async (req, res) => {
  try {
    res.json(await getBulkOverview(req.db));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/containers', async (req, res) => {
  try {
    const body = withSessionActor(req, req.body || {}, {
      ids: ['registered_by'],
      names: ['actor_name']
    });
    const result = await registerBulkContainer(req.db, body);
    res.status(201).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/fills', async (req, res) => {
  try {
    const body = withSessionActor(req, req.body || {}, {
      ids: ['filled_by'],
      names: ['actor_name']
    });
    const result = await fillBulkContainer(req.db, body);
    res.status(201).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/draws', async (req, res) => {
  try {
    const body = withSessionActor(req, req.body || {}, {
      ids: ['drawn_by'],
      names: ['actor_name']
    });
    const result = await drawBulkContainer(req.db, body);
    res.status(201).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
