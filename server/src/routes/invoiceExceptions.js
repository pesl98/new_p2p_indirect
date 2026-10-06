import express from 'express';
import {
  getInvoiceExceptionDetail,
  listBuyerInbox,
  listInvoiceExceptions,
  resolveInvoiceException,
  respondBuyerInbox
} from '../invoiceExceptionsService.js';
import { AP_ROLES, requireRole, sessionActor, withSessionActor, assertSessionId } from '../requestActor.js';

const router = express.Router();

function httpError(res, error) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(error);
  return res.status(status).json({ error: error.message });
}

// AP exception queue. Default queue=open (variance_flagged only). Finance or admin.
router.get('/', requireRole(...AP_ROLES), async (req, res) => {
  try {
    const invoices = await listInvoiceExceptions(req.db, { queue: req.query.queue || 'open' });
    res.json(invoices);
  } catch (error) {
    httpError(res, error);
  }
});

// Buyer inbox for return_to_buyer parks. Must be registered before /:id.
// Always scoped to the signed-in user (and that user's department). Unscoped lists are rejected.
router.get('/buyer-inbox', async (req, res) => {
  try {
    const actor = sessionActor(req);
    assertSessionId(actor, req.query.requester_id, 'requester_id');
    if (req.query.department_id != null && req.query.department_id !== ''
      && Number(req.query.department_id) !== actor.department_id) {
      return res.status(403).json({
        error: 'department_id does not match the signed-in user. Persona ids in the request are not accepted.'
      });
    }
    const invoices = await listBuyerInbox(req.db, { requester_id: actor.id });
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

router.post('/:id/resolve', requireRole(...AP_ROLES), async (req, res) => {
  try {
    const body = withSessionActor(req, req.body, { names: ['actor_name'] });
    const result = await resolveInvoiceException(req.db, req.params.id, body);
    res.json(result);
  } catch (error) {
    httpError(res, error);
  }
});

router.post('/:id/buyer-respond', async (req, res) => {
  try {
    const actor = sessionActor(req);
    const owner = await req.db.prepare(`
      SELECT pr.requester_id, pr.department_id
      FROM invoices inv
      JOIN purchase_orders po ON inv.po_id = po.id
      LEFT JOIN purchase_requisitions pr ON po.requisition_id = pr.id
      WHERE inv.id = ?
    `).get(req.params.id);
    if (!owner) return res.status(404).json({ error: 'Invoice not found.' });
    const sameUser = Number(owner.requester_id) === actor.id;
    const sameDept = owner.department_id != null && Number(owner.department_id) === actor.department_id;
    if (actor.role !== 'admin' && !sameUser && !sameDept) {
      return res.status(403).json({
        error: 'Buyer inbox responses use the signed-in requester, not a persona id.'
      });
    }
    const body = withSessionActor(req, req.body, { names: ['actor_name'] });
    const result = await respondBuyerInbox(req.db, req.params.id, body);
    res.json(result);
  } catch (error) {
    httpError(res, error);
  }
});

export default router;
