import React, { useState, useEffect } from 'react';
import { Landmark, TrendingUp, DollarSign, PieChart, ShieldAlert } from 'lucide-react';
import { api } from '../api';
import { formatMoney } from '../money';

export default function BudgetsView() {
  const [budgets, setBudgets] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadBudgets = async () => {
    setLoading(true);
    try {
      const data = await api.getBudgets();
      setBudgets(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBudgets();
  }, []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <h2 className="text-xl font-bold text-slate-900 tracking-tight">Department Budgets & Cost Centers</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Real-time tracking of indirect spend: Allocated Budgets, Committed (final PR approval), and Actual Invoiced Spend.
        </p>
      </div>

      {/* Budget Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {loading ? (
          <div className="col-span-full py-12 text-center text-slate-400 text-xs">Loading departmental budgets...</div>
        ) : (
          budgets.map((b) => {
            const spentPct = ((b.actual_spent / b.total_budget) * 100).toFixed(1);
            const committedPct = ((b.committed_amount / b.total_budget) * 100).toFixed(1);
            const isCritical = b.utilization_pct >= 85;

            return (
              <div 
                key={b.id} 
                className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-sm space-y-4 hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">{b.department_name}</h3>
                    <span className="text-[11px] font-mono text-slate-400">Cost Center: {b.department_code}</span>
                  </div>
                  <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                    isCritical ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-700'
                  }`}>
                    {b.utilization_pct}% consumed
                  </span>
                </div>

                {/* Progress Bar */}
                <div>
                  <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden flex shadow-inner">
                    <div 
                      style={{ width: `${spentPct}%` }}
                      className="bg-emerald-600 h-full"
                      title={`Actual Paid: ${spentPct}%`}
                    />
                    <div 
                      style={{ width: `${committedPct}%` }}
                      className="bg-amber-400 h-full"
                      title={`Committed: ${committedPct}%`}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-slate-400 mt-1">
                    <span>Paid: {spentPct}%</span>
                    <span>Committed: {committedPct}%</span>
                  </div>
                </div>

                {/* Budget Breakdown Stats */}
                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100 text-xs">
                  <div>
                    <span className="text-[11px] text-slate-400">Allocated Budget:</span>
                    <div className="font-bold text-slate-900">${formatMoney(b.total_budget)}</div>
                  </div>
                  <div>
                    <span className="text-[11px] text-slate-400">Available Funds:</span>
                    <div className="font-bold text-emerald-700">${formatMoney(b.available_budget)}</div>
                  </div>
                  <div>
                    <span className="text-[11px] text-slate-400">Actual Spent:</span>
                    <div className="font-semibold text-slate-800">${formatMoney(b.actual_spent)}</div>
                  </div>
                  <div>
                    <span className="text-[11px] text-slate-400">Committed (PR approve):</span>
                    <div className="font-semibold text-amber-700">${formatMoney(b.committed_amount)}</div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
