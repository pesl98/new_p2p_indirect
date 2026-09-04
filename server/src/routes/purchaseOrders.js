import express from 'express';
import db from '../db.js';
import { nextDocumentNumber } from '../docNumbers.js';

const router = express.Router();

// List all purchase orders
router.get('/', (req, res) => {
  try {
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
        (SELECT COUNT(*) FROM goods_receipts WHERE po_id = po.id) as receipts_count,
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
    const pos = db.prepare(query).all(...params);
    res.json(pos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get PO detail by ID
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const po = db.prepare(`
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
    const items = db.prepare(`
      SELECT * FROM po_items WHERE po_id = ? ORDER BY id ASC
    `).all(id);

    // Get associated Goods Receipts
    const receipts = db.prepare(`
      SELECT gr.*, u.name as received_by_name,
        (SELECT COUNT(*) FROM goods_receipt_items WHERE goods_receipt_id = gr.id) as items_count
      FROM goods_receipts gr
      JOIN users u ON gr.received_by = u.id
      WHERE gr.po_id = ?
      ORDER BY gr.receipt_date DESC
    `).all(id);

    // Get associated Invoices
    const invoices = db.prepare(`
      SELECT inv.*,
        (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = inv.id) as items_count
      FROM invoices inv
      WHERE inv.po_id = ?
      ORDER BY inv.invoice_date DESC
    `).all(id);

    res.json({
      ...po,
      items,
      receipts,
      invoices
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create PO from Approved Requisition
router.post('/from-requisition', (req, res) => {
  try {
    const { requisition_id, supplier_id, created_by, shipping_address, notes, payment_terms } = req.body;

    const pr = db.prepare(`SELECT * FROM purchase_requisitions WHERE id = ?`).get(requisition_id);
    if (!pr) {
      return res.status(404).json({ error: 'Requisition not found' });
    }
    if (pr.status !== 'approved') {
      return res.status(400).json({ error: 'Requisition must be in "approved" state to generate a Purchase Order.' });
    }

    const prItems = db.prepare(`SELECT * FROM requisition_items WHERE requisition_id = ?`).all(requisition_id);
    if (prItems.length === 0) {
      return res.status(400).json({ error: 'Requisition has no items.' });
    }

    const targetSupplierId = supplier_id || prItems[0].estimated_supplier_id || 1;
    const supplier = db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(targetSupplierId);

    const convertTransaction = db.transaction(() => {
      const currentYear = new Date().getFullYear();
      const poNumber = nextDocumentNumber(db, 'po', currentYear);
      const issueDate = new Date().toISOString().split('T')[0];
      const deliveryDate = pr.needed_by_date || new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0];

      const insertPO = db.prepare(`
        INSERT INTO purchase_orders (po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date, expected_delivery_date, payment_terms, shipping_address, notes)
        VALUES (?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?)
      `);

      const poResult = insertPO.run(
        poNumber,
        requisition_id,
        targetSupplierId,
        created_by || 3, // Default to Carol Zhang (Procurement)
        pr.total_amount,
        issueDate,
        deliveryDate,
        payment_terms || (supplier ? supplier.payment_terms : 'Net 30'),
        shipping_address || 'Acme HQ - Receiving Bay 2, 450 Tech Blvd, Austin, TX 78701',
        notes || `Generated automatically from approved requisition ${pr.pr_number}`
      );

      const poId = poResult.lastInsertRowid;

      // Copy PR items to PO items
      const insertPOItem = db.prepare(`
        INSERT INTO po_items (po_id, requisition_item_id, item_description, category, quantity, unit_price, total_price, quantity_received, quantity_invoiced)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
      `);

      for (const item of prItems) {
        insertPOItem.run(
          poId,
          item.id,
          item.item_description,
          item.category,
          item.quantity,
          item.unit_price,
          item.total_price
        );
      }

      // Mark PR as converted_to_po
      db.prepare(`UPDATE purchase_requisitions SET status = 'converted_to_po', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(requisition_id);

      // Audit logs
      db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('purchase_order', ?, 'ISSUED', 'Procurement Officer', ?)
      `).run(poId, `PO ${poNumber} issued from PR ${pr.pr_number} to ${supplier ? supplier.name : 'Supplier'}`);

      db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('requisition', ?, 'CONVERTED_TO_PO', 'Procurement Officer', ?)
      `).run(requisition_id, `Converted to Purchase Order ${poNumber}`);

      return { poId, poNumber };
    });

    const result = convertTransaction();
    res.status(201).json({ poId: result.poId, poNumber: result.poNumber, message: 'Purchase Order generated successfully' });
  } catch (error) {
    console.error('Error generating PO:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update PO status
router.patch('/:id/status', (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    db.prepare(`UPDATE purchase_orders SET status = ?, notes = COALESCE(?, notes) WHERE id = ?`).run(status, notes || null, id);
    res.json({ message: 'PO status updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
