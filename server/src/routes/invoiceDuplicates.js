import express from 'express';
import {
  getInvoiceDuplicateDetail,
  listInvoiceDuplicates,
  resolveInvoiceDuplicate
} from '../invoiceDuplicatesService.js';
import { AP_ROLES, requireRole, withSessionActor } from '../requestActor.js';

const router = express.Router();
router.use(requireRole(...AP_ROLES));

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
    const body = withSessionActor(req, req.body, { names: ['actor_name'] });
    const result = await resolveInvoiceDuplicate(req.db, req.params.id, body);
    res.json(result);
  } catch (error) {
    httpError(res, error);
  }
});

export default router;
