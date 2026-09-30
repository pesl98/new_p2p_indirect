import express from 'express';
import {
  ConsignmentError,
  getConsignmentOverview,
  issueConsignment,
  receiveConsignment
} from '../consignmentService.js';

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
    const result = await receiveConsignment(req.db, req.body || {});
    res.status(201).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/issues', async (req, res) => {
  try {
    const result = await issueConsignment(req.db, req.body || {});
    res.status(201).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
