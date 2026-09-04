import React from 'react';
import { formatMoney } from '../money';
import { 
  DollarSign, 
  Clock, 
  CheckCircle2, 
  AlertTriangle, 
  ShoppingCart, 
  TrendingUp, 
  Layers, 
  ArrowUpRight,
  ShieldCheck,
  Building2
} from 'lucide-react';

export default function DashboardView({ analytics, onNavigate, currentUser }) {
  if (!analytics) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400">
        Loading procurement metrics...
      </div>
    );
  }

  const { kpi, spendByCategory = [], spendBySupplier = [], departmentBudgets = [], recentActivity = [] } = analytics;

  return (
    <div className="space-y-6">
      {/* Top Banner with Persona Context */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 rounded-2xl p-6 text-white shadow-lg border border-slate-700/50">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center space-x-2 text-emerald-400 text-xs font-semibold uppercase tracking-wider mb-1">
              <span>Indirect Procurement Control Center</span>
              <span>•</span>
              <span>FY 2026</span>
            </div>
            <h2 className="text-2xl font-bold tracking-tight">
              Welcome back, {currentUser?.name || 'User'}
            </h2>
            <p className="text-slate-300 text-sm mt-1 max-w-2xl">
              Complete non-production purchasing lifecycle management. Monitor requisitions, 
              expedite multi-tier approvals, issue purchase orders, and verify 3-way invoice matching.
            </p>
          </div>
          <div className="flex items-center space-x-3">
            <button
              onClick={() => onNavigate('requisitions')}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-4 py-2.5 rounded-xl shadow-md transition-all flex items-center space-x-2"
            >
              <span>+ New Requisition</span>
            </button>
            {currentUser?.role === 'finance' && (
              <button
                onClick={() => onNavigate('invoices')}
                className="bg-slate-700 hover:bg-slate-600 text-white text-xs font-semibold px-4 py-2.5 rounded-xl transition-all"
              >
                <span>Review 3-Way Matches</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* KPI Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Open PRs */}
        <div 
          onClick={() => onNavigate('requisitions')}
          className="bg-white rounded-xl p-5 border border-slate-200/80 shadow-sm hover:shadow-md transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Open Requisitions</span>
            <div className="p-2 rounded-lg bg-sky-50 text-sky-600 group-hover:bg-sky-600 group-hover:text-white transition-colors">
              <Clock className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline space-x-2">
            <span className="text-3xl font-extrabold text-slate-900">{kpi.openPRs}</span>
            <span className="text-xs text-slate-500">draft & submitted</span>
          </div>
          <div className="mt-2 text-xs text-sky-600 font-medium flex items-center">
            <span>View requisition pipeline</span>
            <ArrowUpRight className="w-3.5 h-3.5 ml-0.5" />
          </div>
        </div>

        {/* Pending Approvals */}
        <div 
          onClick={() => onNavigate('approvals')}
          className="bg-white rounded-xl p-5 border border-slate-200/80 shadow-sm hover:shadow-md transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Pending Approvals</span>
            <div className="p-2 rounded-lg bg-amber-50 text-amber-600 group-hover:bg-amber-600 group-hover:text-white transition-colors">
              <ShieldCheck className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline space-x-2">
            <span className="text-3xl font-extrabold text-amber-600">{kpi.pendingApprovals}</span>
            <span className="text-xs text-slate-500">awaiting decision</span>
          </div>
          <div className="mt-2 text-xs text-amber-600 font-medium flex items-center">
            <span>Review approval queue</span>
            <ArrowUpRight className="w-3.5 h-3.5 ml-0.5" />
          </div>
        </div>

        {/* Active POs */}
        <div 
          onClick={() => onNavigate('purchase_orders')}
          className="bg-white rounded-xl p-5 border border-slate-200/80 shadow-sm hover:shadow-md transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Active POs</span>
            <div className="p-2 rounded-lg bg-indigo-50 text-indigo-600 group-hover:bg-indigo-600 group-hover:text-white transition-colors">
              <ShoppingCart className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline space-x-2">
            <span className="text-3xl font-extrabold text-slate-900">{kpi.activePOs}</span>
            <span className="text-xs text-slate-500">in delivery / partial</span>
          </div>
          <div className="mt-2 text-xs text-indigo-600 font-medium flex items-center">
            <span>Track supplier deliveries</span>
            <ArrowUpRight className="w-3.5 h-3.5 ml-0.5" />
          </div>
        </div>

        {/* 3-Way Match Variances */}
        <div 
          onClick={() => onNavigate('invoices')}
          className="bg-white rounded-xl p-5 border border-slate-200/80 shadow-sm hover:shadow-md transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Invoice Alerts</span>
            <div className={`p-2 rounded-lg ${kpi.invoiceVariances > 0 ? 'bg-rose-50 text-rose-600 group-hover:bg-rose-600 group-hover:text-white' : 'bg-emerald-50 text-emerald-600'}`}>
              <AlertTriangle className="w-5 h-5" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline space-x-2">
            <span className={`text-3xl font-extrabold ${kpi.invoiceVariances > 0 ? 'text-rose-600' : 'text-slate-900'}`}>
              {kpi.invoiceVariances}
            </span>
            <span className="text-xs text-slate-500">3-way discrepancies</span>
          </div>
          <div className="mt-2 text-xs text-rose-600 font-medium flex items-center">
            <span>Reconcile invoice variances</span>
            <ArrowUpRight className="w-3.5 h-3.5 ml-0.5" />
          </div>
        </div>
      </div>

      {/* Financial Health Summary Banner */}
      <div className="bg-white rounded-xl p-6 border border-slate-200/80 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-base font-bold text-slate-900">Total Indirect Budget & Spend Position</h3>
            <p className="text-xs text-slate-500">Across all non-production departments (FY 2026)</p>
          </div>
          <div className="text-right">
            <span className="text-xs font-semibold text-slate-500 uppercase">Overall Utilization</span>
            <div className="text-lg font-bold text-slate-900">{kpi.overallUtilizationPct}%</div>
          </div>
        </div>

        {/* Multi-segmented Progress Bar */}
        <div className="w-full bg-slate-100 rounded-full h-3.5 overflow-hidden flex shadow-inner">
          <div 
            style={{ width: `${(kpi.totalSpent / (kpi.totalBudget || 1)) * 100}%` }}
            className="bg-emerald-600 h-full" 
            title={`Actual Invoiced & Paid: $${formatMoney(kpi.totalSpent)}`}
          />
          <div 
            style={{ width: `${(kpi.totalCommitted / (kpi.totalBudget || 1)) * 100}%` }}
            className="bg-amber-400 h-full" 
            title={`Committed (POs & Approved PRs): $${formatMoney(kpi.totalCommitted)}`}
          />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-5 pt-4 border-t border-slate-100">
          <div>
            <div className="text-xs text-slate-500 font-medium">Total Allocated Budget</div>
            <div className="text-lg font-bold text-slate-900 mt-0.5">${formatMoney(kpi.totalBudget)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 font-medium flex items-center space-x-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-600"></span>
              <span>Actual Paid Spend</span>
            </div>
            <div className="text-lg font-bold text-emerald-700 mt-0.5">${formatMoney(kpi.totalSpent)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 font-medium flex items-center space-x-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400"></span>
              <span>Committed POs</span>
            </div>
            <div className="text-lg font-bold text-amber-700 mt-0.5">${formatMoney(kpi.totalCommitted)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 font-medium flex items-center space-x-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-slate-300"></span>
              <span>Remaining Available</span>
            </div>
            <div className="text-lg font-bold text-slate-700 mt-0.5">${formatMoney(kpi.totalRemaining)}</div>
          </div>
        </div>
      </div>

      {/* Two Column Layout: Spend by Category & Department Budget Health */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Spend by Category */}
        <div className="bg-white rounded-xl p-6 border border-slate-200/80 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Spend by Category</h3>
            <span className="text-xs text-slate-500">Non-production classifications</span>
          </div>

          <div className="space-y-4">
            {spendByCategory.length === 0 ? (
              <p className="text-xs text-slate-400 py-4 text-center">No category spend recorded yet.</p>
            ) : (
              spendByCategory.map((cat, idx) => {
                const maxSpend = Math.max(...spendByCategory.map(c => c.total_spend)) || 1;
                const pct = ((cat.total_spend / maxSpend) * 100).toFixed(0);
                return (
                  <div key={idx} className="space-y-1">
                    <div className="flex justify-between text-xs font-medium">
                      <span className="text-slate-800">{cat.category}</span>
                      <span className="text-slate-900 font-bold">${formatMoney(cat.total_spend)}</span>
                    </div>
                    <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                      <div 
                        className="bg-indigo-600 h-full rounded-full transition-all duration-500" 
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-slate-400">{cat.item_count} purchased line items</div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Department Budget Status */}
        <div className="bg-white rounded-xl p-6 border border-slate-200/80 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">Department Cost Centers</h3>
            <button 
              onClick={() => onNavigate('budgets')}
              className="text-xs font-semibold text-emerald-600 hover:text-emerald-700"
            >
              View Full Budgets →
            </button>
          </div>

          <div className="space-y-3.5">
            {departmentBudgets.map((dept) => {
              const util = dept.utilization_pct || 0;
              const isHigh = util >= 80;
              return (
                <div key={dept.id} className="p-3 rounded-lg border border-slate-100 bg-slate-50/50">
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <div className="flex items-center space-x-2">
                      <span className="font-bold text-slate-900">{dept.department_name}</span>
                      <span className="text-[10px] text-slate-500 font-mono">[{dept.department_code}]</span>
                    </div>
                    <span className={`font-bold ${isHigh ? 'text-rose-600' : 'text-slate-700'}`}>
                      {util}% utilized
                    </span>
                  </div>

                  <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                    <div 
                      className={`h-full rounded-full ${isHigh ? 'bg-rose-500' : 'bg-emerald-500'}`}
                      style={{ width: `${Math.min(100, util)}%` }}
                    />
                  </div>

                  <div className="flex justify-between text-[11px] text-slate-500 mt-1">
                    <span>Budget: ${formatMoney(dept.total_budget)}</span>
                    <span>Remaining: ${formatMoney(dept.available_budget)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Recent System Activity / Audit Feed */}
      <div className="bg-white rounded-xl p-6 border border-slate-200/80 shadow-sm">
        <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-4">
          Audit Trail & Activity Log
        </h3>
        <div className="divide-y divide-slate-100">
          {recentActivity.map((log) => (
            <div key={log.id} className="py-2.5 flex items-center justify-between text-xs">
              <div className="flex items-center space-x-3">
                <span className="font-mono text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                  {log.action}
                </span>
                <span className="text-slate-800 font-medium">{log.details}</span>
              </div>
              <div className="flex items-center space-x-3 text-slate-400 text-[11px]">
                <span>by <strong className="text-slate-600">{log.actor_name}</strong></span>
                <span>•</span>
                <span>{new Date(log.created_at).toLocaleDateString()}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
