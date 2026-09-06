import express from 'express';

const router = express.Router();

// Get executive dashboard metrics
router.get('/', async (req, res) => {
  try {
    const db = req.db;
    // 1. KPI Counts
    const openPRs = (await db.prepare(`SELECT COUNT(*) as count FROM purchase_requisitions WHERE status IN ('draft', 'submitted', 'pending_approval')`).get()).count;
    const pendingApprovals = (await db.prepare(`SELECT COUNT(*) as count FROM approval_requests WHERE status = 'pending'`).get()).count;
    const activePOs = (await db.prepare(`SELECT COUNT(*) as count FROM purchase_orders WHERE status IN ('issued', 'acknowledged', 'partially_received')`).get()).count;
    const invoiceVariances = (await db.prepare(`SELECT COUNT(*) as count FROM invoices WHERE status = 'variance_flagged'`).get()).count;
    const totalCommitted = (await db.prepare(`SELECT COALESCE(SUM(committed_amount), 0) as total FROM budgets WHERE fiscal_year = 2026`).get()).total;
    const totalSpent = (await db.prepare(`SELECT COALESCE(SUM(actual_spent), 0) as total FROM budgets WHERE fiscal_year = 2026`).get()).total;
    const totalBudget = (await db.prepare(`SELECT COALESCE(SUM(total_budget), 0) as total FROM budgets WHERE fiscal_year = 2026`).get()).total;

    // 2. Spend by Category (from PO items)
    const spendByCategory = await db.prepare(`
      SELECT 
        category,
        SUM(total_price) as total_spend,
        COUNT(*) as item_count
      FROM po_items
      GROUP BY category
      ORDER BY total_spend DESC
    `).all();

    // 3. Spend by Supplier
    const spendBySupplier = await db.prepare(`
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
    const departmentBudgets = await db.prepare(`
      SELECT 
        d.id,
        d.name as department_name,
        d.code as department_code,
        b.total_budget,
        b.committed_amount,
        b.actual_spent,
        (b.total_budget - b.committed_amount - b.actual_spent) as available_budget,
        ROUND(((b.committed_amount + b.actual_spent) * 100.0) / NULLIF(b.total_budget, 0), 1) as utilization_pct
      FROM departments d
      LEFT JOIN budgets b ON d.id = b.department_id AND b.fiscal_year = 2026
      ORDER BY utilization_pct DESC
    `).all();

    // 5. Recent Activity Logs
    const recentActivity = await db.prepare(`
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
