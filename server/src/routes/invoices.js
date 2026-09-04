import express from 'express';
import db from '../db.js';
import { createVendorInvoice, approveInvoicePayment } from '../invoicesService.js';

const router = express.Router();

function httpError(res, error) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(error);
  return res.status(status).json({ error: error.message });
}

// List all invoices
router.get('/', (req, res) => {
  try {
    const { status, po_id, supplier_id } = req.query;
    let query = `
      SELECT 
        inv.*,
        po.po_number,
        po.total_amount as po_total_amount,
        s.name as supplier_name,
        s.code as supplier_code,
        (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = inv.id) as items_count,
        (SELECT COUNT(*) FROM match_results WHERE invoice_id = inv.id AND status = 'fail') as fail_variances_count
      FROM invoices inv
      JOIN purchase_orders po ON inv.po_id = po.id
      JOIN suppliers s ON inv.supplier_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (status && status !== 'all') {
      query += ` AND inv.status = ?`;
      params.push(status);
    }
    if (po_id) {
      query += ` AND inv.po_id = ?`;
      params.push(po_id);
    }
    if (supplier_id) {
      query += ` AND inv.supplier_id = ?`;
      params.push(supplier_id);
    }

    query += ` ORDER BY inv.id DESC`;
    const invoices = db.prepare(query).all(...params);
    res.json(invoices);
  } catch (error) {
    httpError(res, error);
  }
});

// Get invoice detail with full 3-way match audit results
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const invoice = db.prepare(`
      SELECT 
        inv.*,
        po.po_number,
        po.total_amount as po_total_amount,
        po.issue_date as po_issue_date,
        po.status as po_status,
        s.name as supplier_name,
        s.code as supplier_code,
        s.payment_terms as supplier_terms,
        d.id as department_id,
        d.name as department_name,
        pr.pr_number
      FROM invoices inv
      JOIN purchase_orders po ON inv.po_id = po.id
      JOIN suppliers s ON inv.supplier_id = s.id
      LEFT JOIN purchase_requisitions pr ON po.requisition_id = pr.id
      LEFT JOIN departments d ON pr.department_id = d.id
      WHERE inv.id = ?
    `).get(id);

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const items = db.prepare(`
      SELECT 
        ii.*,
        poi.quantity as po_quantity,
        poi.unit_price as po_unit_price,
        poi.total_price as po_total_price,
        poi.quantity_received as po_quantity_received,
        poi.item_description as po_description
      FROM invoice_items ii
      JOIN po_items poi ON ii.po_item_id = poi.id
      WHERE ii.invoice_id = ?
    `).all(id);

    const matchResults = db.prepare(`
      SELECT mr.*, poi.item_description
      FROM match_results mr
      LEFT JOIN po_items poi ON mr.po_item_id = poi.id
      WHERE mr.invoice_id = ?
    `).all(id);

    const receipts = db.prepare(`
      SELECT gr.*, u.name as received_by_name
      FROM goods_receipts gr
      JOIN users u ON gr.received_by = u.id
      WHERE gr.po_id = ?
      ORDER BY gr.receipt_date DESC
    `).all(invoice.po_id);

    res.json({
      ...invoice,
      items,
      match_results: matchResults,
      receipts
    });
  } catch (error) {
    httpError(res, error);
  }
});

// Create vendor invoice and execute automated 3-Way Match
router.post('/', (req, res) => {
  try {
    const result = createVendorInvoice(db, req.body);
    res.status(201).json({
      invoiceId: result.invoiceId,
      matchStatus: result.matchOutcome.overallMatchStatus,
      status: result.matchOutcome.invoiceStatus,
      message: 'Invoice created and 3-way matched successfully.'
    });
  } catch (error) {
    httpError(res, error);
  }
});

// Approve invoice for payment (Finance / Accounts Payable)
router.post('/:id/approve-payment', (req, res) => {
  try {
    const result = approveInvoicePayment(db, req.params.id, req.body);
    res.json(result);
  } catch (error) {
    httpError(res, error);
  }
});

// Mark invoice as Paid
router.post('/:id/mark-paid', (req, res) => {
  try {
    const { id } = req.params;
    const { payment_reference, payer_name } = req.body;
    const ref = payment_reference || `ACH-${Date.now().toString().slice(-6)}`;

    db.prepare(`
      UPDATE invoices
      SET status = 'paid', payment_reference = ?
      WHERE id = ?
    `).run(ref, id);

    db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('invoice', ?, 'PAID', ?, ?)
    `).run(id, payer_name || 'Finance Lead', `Marked as paid with reference ${ref}`);

    res.json({ message: 'Invoice marked as paid.', payment_reference: ref });
  } catch (error) {
    httpError(res, error);
  }
});

export default router;
