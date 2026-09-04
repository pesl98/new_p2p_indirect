import express from 'express';
import db from '../db.js';

const router = express.Router();

// List all suppliers
router.get('/', (req, res) => {
  try {
    const suppliers = db.prepare(`
      SELECT s.*, 
        (SELECT COUNT(*) FROM purchase_orders WHERE supplier_id = s.id) as total_pos,
        (SELECT COALESCE(SUM(total_amount), 0) FROM purchase_orders WHERE supplier_id = s.id) as total_spend
      FROM suppliers s
      ORDER BY s.name ASC
    `).all();
    res.json(suppliers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create supplier
router.post('/', (req, res) => {
  try {
    const { name, code, contact_person, email, phone, address, payment_terms } = req.body;
    const stmt = db.prepare(`
      INSERT INTO suppliers (name, code, contact_person, email, phone, address, payment_terms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(name, code, contact_person, email, phone, address, payment_terms || 'Net 30');
    const created = db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json(created);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
