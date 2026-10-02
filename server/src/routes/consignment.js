import express from 'express';
import {
  ConsignmentError,
  getConsignmentOverview,
  issueConsignment,
  receiveConsignment
} from '../consignmentService.js';
import { withSessionActor } from '../requestActor.js';

const router = express.Router();

function sendError(res, error) {
  const status = error.statusCode || (error instanceof ConsignmentError ? 400 : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message });
}

router.get('/', async (req, res) => {
  try {
    res.json(await getConsignmentOverview(req.db));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/receipts', async (req, res) => {
  try {
    const body = withSessionActor(req, req.body || {}, {
      ids: ['received_by'],
      names: ['actor_name']
    });
    const result = await receiveConsignment(req.db, body);
    res.status(201).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/issues', async (req, res) => {
  try {
    const body = withSessionActor(req, req.body || {}, {
      ids: ['issued_by'],
      names: ['actor_name']
    });
    const result = await issueConsignment(req.db, body);
    res.status(201).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
