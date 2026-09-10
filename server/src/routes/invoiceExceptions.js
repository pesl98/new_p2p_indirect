import express from 'express';
import {
  getInvoiceExceptionDetail,
  listBuyerInbox,
  listInvoiceExceptions,
  resolveInvoiceException,
  respondBuyerInbox
} from '../invoiceExceptionsService.js';

const router = express.Router();

function httpError(res, error) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(error);
  return res.status(status).json({ error: error.message });
}

// AP exception queue. Default queue=open (variance_flagged only).
router.get('/', async (req, res) => {
  try {
    const invoices = await listInvoiceExceptions(req.db, { queue: req.query.queue || 'open' });
    res.json(invoices);
  } catch (error) {
    httpError(res, error);
  }
});

// Buyer inbox for return_to_buyer parks. Must be registered before /:id.
router.get('/buyer-inbox', async (req, res) => {
  try {
    const invoices = await listBuyerInbox(req.db, {
      requester_id: req.query.requester_id,
      department_id: req.query.department_id
    });
    res.json(invoices);
  } catch (error) {
    httpError(res, error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const detail = await getInvoiceExceptionDetail(req.db, req.params.id);
    res.json(detail);
  } catch (error) {
    httpError(res, error);
  }
});

router.post('/:id/resolve', async (req, res) => {
  try {
    const result = await resolveInvoiceException(req.db, req.params.id, req.body);
    res.json(result);
  } catch (error) {
    httpError(res, error);
  }
});

router.post('/:id/buyer-respond', async (req, res) => {
  try {
    const result = await respondBuyerInbox(req.db, req.params.id, req.body);
    res.json(result);
  } catch (error) {
    httpError(res, error);
  }
});

export default router;
