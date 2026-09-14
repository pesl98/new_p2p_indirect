import express from 'express';
import {
  cancelPaymentRun,
  createPaymentRun,
  executePaymentRun,
  getPaymentRunDetail,
  listEligiblePaymentRunInvoices,
  listPaymentRuns
} from '../paymentRunsService.js';

const router = express.Router();

function httpError(res, error) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(error);
  return res.status(status).json({ error: error.message });
}

// AP payment proposal / batch ACH. Demo-open (no JWT), same as AP Aging.

router.get('/', async (req, res) => {
  try {
    const runs = await listPaymentRuns(req.db, { status: req.query.status });
    res.json(runs);
  } catch (error) {
    httpError(res, error);
  }
});

router.get('/eligible-invoices', async (req, res) => {
  try {
    const invoices = await listEligiblePaymentRunInvoices(req.db);
    res.json(invoices);
  } catch (error) {
    httpError(res, error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const detail = await getPaymentRunDetail(req.db, req.params.id);
    res.json(detail);
  } catch (error) {
    httpError(res, error);
  }
});

router.post('/', async (req, res) => {
  try {
    const created = await createPaymentRun(req.db, req.body);
    res.status(201).json(created);
  } catch (error) {
    httpError(res, error);
  }
});

router.post('/:id/execute', async (req, res) => {
  try {
    const executed = await executePaymentRun(req.db, req.params.id, req.body);
    res.json(executed);
  } catch (error) {
    httpError(res, error);
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const cancelled = await cancelPaymentRun(req.db, req.params.id, req.body);
    res.json(cancelled);
  } catch (error) {
    httpError(res, error);
  }
});

export default router;
