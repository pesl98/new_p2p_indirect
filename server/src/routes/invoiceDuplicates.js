import express from 'express';
import {
  getInvoiceDuplicateDetail,
  listInvoiceDuplicates,
  resolveInvoiceDuplicate
} from '../invoiceDuplicatesService.js';

const router = express.Router();

function httpError(res, error) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(error);
  return res.status(status).json({ error: error.message });
}

// AP likely-duplicate queue. Default queue=open (duplicate_status=suspect).
router.get('/', async (req, res) => {
  try {
    const invoices = await listInvoiceDuplicates(req.db, { queue: req.query.queue || 'open' });
    res.json(invoices);
  } catch (error) {
    httpError(res, error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const detail = await getInvoiceDuplicateDetail(req.db, req.params.id);
    res.json(detail);
  } catch (error) {
    httpError(res, error);
  }
});

router.post('/:id/resolve', async (req, res) => {
  try {
    const result = await resolveInvoiceDuplicate(req.db, req.params.id, req.body);
    res.json(result);
  } catch (error) {
    httpError(res, error);
  }
});

export default router;
