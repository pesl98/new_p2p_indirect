import express from 'express';
import { convertRequisitionToPurchaseOrders } from '../purchaseOrdersService.js';
import {
  applyPurchaseOrderChangeOrder,
  listPurchaseOrderChangeOrders
} from '../changeOrdersService.js';

const router = express.Router();

// List all purchase orders
router.get('/', async (req, res) => {
  try {
    const db = req.db;
    const { status, supplier_id } = req.query;
    let query = `
      SELECT 
        po.*,
        s.name as supplier_name,
        s.code as supplier_code,
        s.email as supplier_email,
        u.name as buyer_name,
        pr.pr_number,
        (SELECT COUNT(*) FROM po_items WHERE po_id = po.id) as item_count,
        (SELECT COALESCE(SUM(quantity), 0) FROM po_items WHERE po_id = po.id) as total_qty_ordered,
        (SELECT COALESCE(SUM(quantity_received), 0) FROM po_items WHERE po_id = po.id) as total_qty_received,
        (SELECT COALESCE(SUM(quantity_accepted), 0) FROM po_items WHERE po_id = po.id) as total_qty_accepted,
        (SELECT COALESCE(SUM(CASE WHEN line_type = 'service' THEN quantity_accepted ELSE quantity_received END), 0) FROM po_items WHERE po_id = po.id) as total_qty_fulfilled,
        (SELECT COUNT(*) FROM po_items WHERE po_id = po.id AND line_type = 'service') as service_line_count,
        (SELECT COUNT(*) FROM po_items WHERE po_id = po.id AND line_type = 'goods') as goods_line_count,
        (SELECT COUNT(*) FROM goods_receipts WHERE po_id = po.id) as receipts_count,
        (SELECT COUNT(*) FROM service_entry_sheets WHERE po_id = po.id) as ses_count,
        (SELECT COUNT(*) FROM invoices WHERE po_id = po.id) as invoices_count
      FROM purchase_orders po
      JOIN suppliers s ON po.supplier_id = s.id
      JOIN users u ON po.created_by = u.id
      LEFT JOIN purchase_requisitions pr ON po.requisition_id = pr.id
      WHERE 1=1
    `;
    const params = [];

    if (status && status !== 'all') {
      query += ` AND po.status = ?`;
      params.push(status);
    }
    if (supplier_id) {
      query += ` AND po.supplier_id = ?`;
      params.push(supplier_id);
    }

    query += ` ORDER BY po.id DESC`;
    const pos = await db.prepare(query).all(...params);
    res.json(pos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get PO detail by ID
router.get('/:id', async (req, res) => {
  try {
    const db = req.db;
    const { id } = req.params;
    const po = await db.prepare(`
      SELECT 
        po.*,
        s.name as supplier_name,
        s.code as supplier_code,
        s.contact_person as supplier_contact,
        s.email as supplier_email,
        s.phone as supplier_phone,
        s.address as supplier_address,
        u.name as buyer_name,
        u.email as buyer_email,
        pr.pr_number,
        pr.justification as pr_justification,
        d.name as department_name
      FROM purchase_orders po
      JOIN suppliers s ON po.supplier_id = s.id
      JOIN users u ON po.created_by = u.id
      LEFT JOIN purchase_requisitions pr ON po.requisition_id = pr.id
      LEFT JOIN departments d ON pr.department_id = d.id
      WHERE po.id = ?
    `).get(id);

    if (!po) {
      return res.status(404).json({ error: 'Purchase Order not found' });
    }

    // Get PO line items
    const items = await db.prepare(`
      SELECT * FROM po_items WHERE po_id = ? ORDER BY id ASC
    `).all(id);

    // Get associated Goods Receipts
    const receipts = await db.prepare(`
      SELECT gr.*, u.name as received_by_name,
        (SELECT COUNT(*) FROM goods_receipt_items WHERE goods_receipt_id = gr.id) as items_count
      FROM goods_receipts gr
      JOIN users u ON gr.received_by = u.id
      WHERE gr.po_id = ?
      ORDER BY gr.receipt_date DESC
    `).all(id);

    const serviceSheets = await db.prepare(`
      SELECT ses.*, u.name as created_by_name,
        (SELECT COUNT(*) FROM service_entry_sheet_items WHERE ses_id = ses.id) as items_count
      FROM service_entry_sheets ses
      JOIN users u ON ses.created_by = u.id
      WHERE ses.po_id = ?
      ORDER BY ses.id DESC
    `).all(id);

    // Get associated Invoices
    const invoices = await db.prepare(`
      SELECT inv.*,
        (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = inv.id) as items_count
      FROM invoices inv
      WHERE inv.po_id = ?
      ORDER BY inv.invoice_date DESC
    `).all(id);

    const changeOrders = (await listPurchaseOrderChangeOrders(db, id)).change_orders;

    res.json({
      ...po,
      items,
      receipts,
      service_entry_sheets: serviceSheets,
      invoices,
      change_orders: changeOrders
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create one issued PO per resolved supplier from an approved requisition
router.post('/from-requisition', async (req, res) => {
  try {
    const db = req.db;
    const purchaseOrders = await convertRequisitionToPurchaseOrders(db, req.body);
    const split = purchaseOrders.length > 1;
    res.status(201).json({
      purchase_orders: purchaseOrders,
      split,
      message: split
        ? `${purchaseOrders.length} purchase orders issued from the approved requisition`
        : 'Purchase Order generated successfully'
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('Error generating PO:', error);
    res.status(status).json({ error: error.message });
  }
});

// Change-order history for a PO (applied revisions)
router.get('/:id/change-orders', async (req, res) => {
  try {
    const payload = await listPurchaseOrderChangeOrders(req.db, req.params.id);
    res.json(payload);
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('Error listing change orders:', error);
    res.status(status).json({ error: error.message });
  }
});

// Create + apply a change order in one step (demo-open, like the rest of the API)
router.post('/:id/change-orders', async (req, res) => {
  try {
    const result = await applyPurchaseOrderChangeOrder(req.db, req.params.id, req.body);
    res.status(201).json({
      ...result,
      message: `Change order ${result.change_order.co_number} applied`
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('Error applying change order:', error);
    res.status(status).json({ error: error.message });
  }
});

// Update PO status
router.patch('/:id/status', async (req, res) => {
  try {
    const db = req.db;
    const { id } = req.params;
    const { status, notes } = req.body;
    await db.prepare(`UPDATE purchase_orders SET status = ?, notes = COALESCE(?, notes) WHERE id = ?`).run(status, notes || null, id);
    res.json({ message: 'PO status updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
