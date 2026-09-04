import express from 'express';
import db from '../db.js';

const router = express.Router();

// List all goods receipts
router.get('/', (req, res) => {
  try {
    const { po_id } = req.query;
    let query = `
      SELECT 
        gr.*,
        po.po_number,
        s.name as supplier_name,
        u.name as received_by_name,
        (SELECT COUNT(*) FROM goods_receipt_items WHERE goods_receipt_id = gr.id) as items_count,
        (SELECT COALESCE(SUM(quantity_received), 0) FROM goods_receipt_items WHERE goods_receipt_id = gr.id) as total_qty_received
      FROM goods_receipts gr
      JOIN purchase_orders po ON gr.po_id = po.id
      JOIN suppliers s ON po.supplier_id = s.id
      JOIN users u ON gr.received_by = u.id
      WHERE 1=1
    `;
    const params = [];

    if (po_id) {
      query += ` AND gr.po_id = ?`;
      params.push(po_id);
    }

    query += ` ORDER BY gr.id DESC`;
    const receipts = db.prepare(query).all(...params);
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single receipt with item details
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const gr = db.prepare(`
      SELECT 
        gr.*,
        po.po_number,
        po.total_amount as po_total_amount,
        s.name as supplier_name,
        u.name as received_by_name
      FROM goods_receipts gr
      JOIN purchase_orders po ON gr.po_id = po.id
      JOIN suppliers s ON po.supplier_id = s.id
      JOIN users u ON gr.received_by = u.id
      WHERE gr.id = ?
    `).get(id);

    if (!gr) return res.status(404).json({ error: 'Goods receipt not found' });

    const items = db.prepare(`
      SELECT gri.*, poi.item_description, poi.quantity as ordered_quantity, poi.unit_price
      FROM goods_receipt_items gri
      JOIN po_items poi ON gri.po_item_id = poi.id
      WHERE gri.goods_receipt_id = ?
    `).all(id);

    res.json({ ...gr, items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Receive goods/services against a PO
router.post('/', (req, res) => {
  try {
    const { po_id, received_by, receipt_date, carrier_tracking, delivery_note_number, notes, items } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Receipt must include at least one received item.' });
    }

    const po = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(po_id);
    if (!po) return res.status(404).json({ error: 'Purchase Order not found' });

    const createGRTransaction = db.transaction(() => {
      const currentYear = new Date().getFullYear();
      const countResult = db.prepare(`SELECT COUNT(*) as cnt FROM goods_receipts`).get();
      const grnNumber = `GRN-${currentYear}-${String(countResult.cnt + 1).padStart(3, '0')}`;

      const insertGR = db.prepare(`
        INSERT INTO goods_receipts (grn_number, po_id, received_by, receipt_date, carrier_tracking, delivery_note_number, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const grResult = insertGR.run(
        grnNumber,
        po_id,
        received_by || 3, // Carol (Procurement/Receiving)
        receipt_date || new Date().toISOString().split('T')[0],
        carrier_tracking || null,
        delivery_note_number || null,
        notes || null
      );

      const grId = grResult.lastInsertRowid;

      const insertGRItem = db.prepare(`
        INSERT INTO goods_receipt_items (goods_receipt_id, po_item_id, quantity_received, condition, comments)
        VALUES (?, ?, ?, ?, ?)
      `);

      const updatePOItem = db.prepare(`
        UPDATE po_items
        SET quantity_received = quantity_received + ?
        WHERE id = ?
      `);

      let totalReceivedInThisGRN = 0;
      for (const item of items) {
        const qty = Number(item.quantity_received) || 0;
        if (qty > 0) {
          insertGRItem.run(grId, item.po_item_id, qty, item.condition || 'good', item.comments || null);
          updatePOItem.run(qty, item.po_item_id);
          totalReceivedInThisGRN += qty;
        }
      }

      // Check overall PO receipt status
      const allPOItems = db.prepare(`SELECT quantity, quantity_received FROM po_items WHERE po_id = ?`).all(po_id);
      const isFullyReceived = allPOItems.every(i => i.quantity_received >= i.quantity);
      const isPartiallyReceived = allPOItems.some(i => i.quantity_received > 0);

      const newPOStatus = isFullyReceived ? 'received' : (isPartiallyReceived ? 'partially_received' : po.status);
      db.prepare(`UPDATE purchase_orders SET status = ? WHERE id = ?`).run(newPOStatus, po_id);

      // Audit log
      db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('goods_receipt', ?, 'RECEIVED', 'Procurement Officer', ?)
      `).run(grId, `Created receipt ${grnNumber} for PO ${po.po_number} (${totalReceivedInThisGRN} units)`);

      return { grId, grnNumber, newPOStatus };
    });

    const result = createGRTransaction();
    res.status(201).json({
      receiptId: result.grId,
      grnNumber: result.grnNumber,
      poStatus: result.newPOStatus,
      message: 'Goods receipt recorded successfully'
    });
  } catch (error) {
    console.error('Error creating goods receipt:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
