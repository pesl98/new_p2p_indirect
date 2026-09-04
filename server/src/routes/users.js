import express from 'express';
import db from '../db.js';

const router = express.Router();

// List all users (with department details)
router.get('/', (req, res) => {
  try {
    const users = db.prepare(`
      SELECT u.*, d.name as department_name, d.code as department_code
      FROM users u
      LEFT JOIN departments d ON u.department_id = d.id
      ORDER BY u.id ASC
    `).all();
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List departments with budget summary
router.get('/departments', (req, res) => {
  try {
    const depts = db.prepare(`
      SELECT d.*, b.total_budget, b.committed_amount, b.actual_spent,
             (b.total_budget - b.committed_amount - b.actual_spent) as remaining_budget
      FROM departments d
      LEFT JOIN budgets b ON d.id = b.department_id AND b.fiscal_year = 2026
      ORDER BY d.id ASC
    `).all();
    res.json(depts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
