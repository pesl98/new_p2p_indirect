import express from 'express';
import db from '../db.js';

const router = express.Router();

// Get executive dashboard metrics
router.get('/', (req, res) => {
  try {
    // 1. KPI Counts
    const openPRs = db.prepare(`SELECT COUNT(*) as count FROM purchase_requisitions WHERE status IN ('draft', 'submitted', 'pending_approval')`).get().count;
    const pendingApprovals = db.prepare(`SELECT COUNT(*) as count FROM approval_requests WHERE status = 'pending'`).get().count;
    const activePOs = db.prepare(`SELECT COUNT(*) as count FROM purchase_orders WHERE status IN ('issued', 'acknowledged', 'partially_received')`).get().count;
    const invoiceVariances = db.prepare(`SELECT COUNT(*) as count FROM invoices WHERE status = 'variance_flagged'`).get().count;
    const totalCommitted = db.prepare(`SELECT COALESCE(SUM(committed_amount), 0) as total FROM budgets WHERE fiscal_year = 2026`).get().total;
    const totalSpent = db.prepare(`SELECT COALESCE(SUM(actual_spent), 0) as total FROM budgets WHERE fiscal_year = 2026`).get().total;
    const totalBudget = db.prepare(`SELECT COALESCE(SUM(total_budget), 0) as total FROM budgets WHERE fiscal_year = 2026`).get().total;

    // 2. Spend by Category (from PO items)
    const spendByCategory = db.prepare(`
      SELECT 
        category,
        SUM(total_price) as total_spend,
        COUNT(*) as item_count
      FROM po_items
      GROUP BY category
      ORDER BY total_spend DESC
    `).all();

    // 3. Spend by Supplier
    const spendBySupplier = db.prepare(`
      SELECT 
        s.id,
        s.name as supplier_name,
        SUM(po.total_amount) as total_spend,
        COUNT(po.id) as po_count
      FROM suppliers s
      JOIN purchase_orders po ON s.id = po.supplier_id
      GROUP BY s.id
      ORDER BY total_spend DESC
      LIMIT 6
    `).all();

    // 4. Budget Status by Department
    const departmentBudgets = db.prepare(`
      SELECT 
        d.id,
        d.name as department_name,
        d.code as department_code,
        b.total_budget,
        b.committed_amount,
        b.actual_spent,
        (b.total_budget - b.committed_amount - b.actual_spent) as available_budget,
        ROUND(((b.committed_amount + b.actual_spent) / b.total_budget) * 100, 1) as utilization_pct
      FROM departments d
      LEFT JOIN budgets b ON d.id = b.department_id AND b.fiscal_year = 2026
      ORDER BY utilization_pct DESC
    `).all();

    // 5. Recent Activity Logs
    const recentActivity = db.prepare(`
      SELECT * FROM audit_logs
      ORDER BY id DESC
      LIMIT 10
    `).all();

    res.json({
      kpi: {
        openPRs,
        pendingApprovals,
        activePOs,
        invoiceVariances,
        totalCommitted,
        totalSpent,
        totalBudget,
        totalRemaining: totalBudget - totalCommitted - totalSpent,
        overallUtilizationPct: Number((((totalCommitted + totalSpent) / (totalBudget || 1)) * 100).toFixed(1))
      },
      spendByCategory,
      spendBySupplier,
      departmentBudgets,
      recentActivity
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
