import express from 'express';
import db from '../db.js';
import { asCents } from '../money.js';
import { normalizeLineType } from '../lineType.js';

const router = express.Router();

// List catalog items with category/search filter
router.get('/', (req, res) => {
  try {
    const { category, search } = req.query;
    let query = `
      SELECT c.*, s.name as preferred_supplier_name, s.payment_terms
      FROM catalog_items c
      LEFT JOIN suppliers s ON c.preferred_supplier_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (category && category !== 'All') {
      query += ` AND c.category = ?`;
      params.push(category);
    }

    if (search) {
      query += ` AND (c.name LIKE ? OR c.description LIKE ? OR c.sku LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY c.category ASC, c.name ASC`;
    const items = db.prepare(query).all(...params);
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add catalog item
router.post('/', (req, res) => {
  try {
    const { sku, name, description, category, unit, unit_price, preferred_supplier_id, lead_time_days, image_url, line_type } = req.body;
    const resolvedType = normalizeLineType(line_type, category);
    const stmt = db.prepare(`
      INSERT INTO catalog_items (sku, name, description, category, unit, unit_price, preferred_supplier_id, lead_time_days, image_url, line_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(sku, name, description, category, unit || 'each', asCents(unit_price), preferred_supplier_id, lead_time_days || 3, image_url || '📦', resolvedType);
    const created = db.prepare(`SELECT * FROM catalog_items WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(created);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
