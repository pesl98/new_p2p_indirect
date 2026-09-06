import express from 'express';
import { createGoodsReceipt } from '../goodsReceiptsService.js';

const router = express.Router();

// List all goods receipts
router.get('/', async (req, res) => {
  try {
    const db = req.db;
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
    const receipts = await db.prepare(query).all(...params);
    res.json(receipts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single receipt with item details
router.get('/:id', async (req, res) => {
  try {
    const db = req.db;
    const { id } = req.params;
    const gr = await db.prepare(`
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

    const items = await db.prepare(`
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
router.post('/', async (req, res) => {
  try {
    const db = req.db;
    const result = await createGoodsReceipt(db, req.body);
    res.status(201).json({
      receiptId: result.grId,
      grnNumber: result.grnNumber,
      poStatus: result.newPOStatus,
      message: 'Goods receipt recorded successfully'
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('Error creating goods receipt:', error);
    res.status(status).json({ error: error.message });
  }
});

export default router;
