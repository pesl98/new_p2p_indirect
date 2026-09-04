import express from 'express';
import db from '../db.js';

const router = express.Router();

// Get budgets by department with utilization
router.get('/', (req, res) => {
  try {
    const budgets = db.prepare(`
      SELECT 
        b.id,
        b.department_id,
        b.fiscal_year,
        b.total_budget,
        b.committed_amount,
        b.actual_spent,
        d.name as department_name,
        d.code as department_code,
        (b.total_budget - b.committed_amount - b.actual_spent) as available_budget,
        -- Display % only: multiply before divide so SQLite integer cents do not truncate to 0.
        ROUND(((b.committed_amount + b.actual_spent) * 100.0) / NULLIF(b.total_budget, 0), 1) as utilization_pct
      FROM budgets b
      JOIN departments d ON b.department_id = d.id
      WHERE b.fiscal_year = 2026
      ORDER BY b.department_id ASC
    `).all();
    res.json(budgets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
