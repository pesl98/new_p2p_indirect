import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { 
  LayoutDashboard, 
  FileText, 
  CheckSquare, 
  ShoppingCart, 
  PackageCheck,
  ClipboardCheck,
  FileSpreadsheet, 
  Landmark, 
  Store,
  GitBranch,
  ShieldAlert,
  Inbox,
  CalendarClock,
  UserCog,
  UserCheck
} from 'lucide-react';

function dbModeLabel(mode) {
  if (mode === 'turso-http') return 'Turso (HTTP) active';
  if (mode === 'sqlite') return 'SQLite (local) active';
  return 'Database connected';
}

export default function Sidebar({ activeTab, onTabChange, pendingApprovalsCount, varianceInvoicesCount, buyerInboxCount, apAgingOverdueCount, currentUser }) {
  const [dbMode, setDbMode] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.getHealth()
      .then((health) => {
        if (!cancelled && health?.db) setDbMode(health.db);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const navItems = [
    {
      id: 'dashboard',
      label: 'Dashboard & Spend',
      icon: LayoutDashboard,
      desc: 'KPIs, spend charts, budget health'
    },
    {
      id: 'requisitions',
      label: 'Requisitions (PR)',
      icon: FileText,
      desc: 'Catalog orders & custom requests'
    },
    {
      id: 'approvals',
      label: 'Approvals Inbox',
      icon: CheckSquare,
      badge: pendingApprovalsCount > 0 ? pendingApprovalsCount : null,
      badgeColor: 'bg-amber-500 text-white',
      desc: 'Multi-tier financial authorization'
    },
    ...(['approver', 'procurement', 'finance', 'admin'].includes(currentUser?.role)
      ? [{
          id: 'delegations',
          label: 'Delegations',
          icon: UserCheck,
          desc: 'Out-of-office substitute approvers'
        }]
      : []),
    {
      id: 'purchase_orders',
      label: 'Purchase Orders (PO)',
      icon: ShoppingCart,
      desc: 'Supplier orders & PDF view'
    },
    {
      id: 'goods_receipt',
      label: 'Goods Receipt (GRN)',
      icon: PackageCheck,
      desc: 'Physical receiving for goods lines'
    },
    {
      id: 'service_entry',
      label: 'Service Entry (SES)',
      icon: ClipboardCheck,
      desc: 'Accept services; SES-backed 2-way match'
    },
    {
      id: 'invoices',
      label: 'Invoices & Matching',
      icon: FileSpreadsheet,
      badge: varianceInvoicesCount > 0 ? `${varianceInvoicesCount} Alert` : null,
      badgeColor: 'bg-rose-500 text-white',
      desc: 'Automated 3-way reconciliation & AP'
    },
    {
      id: 'exception_workbench',
      label: 'Exception Workbench',
      icon: ShieldAlert,
      badge: varianceInvoicesCount > 0 ? varianceInvoicesCount : null,
      badgeColor: 'bg-rose-500 text-white',
      desc: 'AP triage for dual-match failures'
    },
    ...(currentUser?.role === 'requester'
      ? [{
          id: 'buyer_inbox',
          label: 'Buyer Inbox',
          icon: Inbox,
          badge: buyerInboxCount > 0 ? buyerInboxCount : null,
          badgeColor: 'bg-amber-500 text-white',
          desc: 'Invoices AP returned to the requester'
        }]
      : []),
    ...(['finance', 'admin'].includes(currentUser?.role)
      ? [{
          id: 'ap_aging',
          label: 'AP Aging',
          icon: CalendarClock,
          badge: apAgingOverdueCount > 0 ? apAgingOverdueCount : null,
          badgeColor: 'bg-rose-500 text-white',
          desc: 'Approved payables by due date'
        }]
      : []),
    {
      id: 'document_trail',
      label: 'Document trail',
      icon: GitBranch,
      desc: 'Full PR → PO → GRN/SES → invoice chain'
    },
    {
      id: 'budgets',
      label: 'Budgets & Cost Centers',
      icon: Landmark,
      desc: 'Department spend allocation'
    },
    {
      id: 'catalog',
      label: 'Suppliers & Catalog',
      icon: Store,
      desc: 'Approved vendor repository'
    },
  ];

  const adminItems = currentUser?.role === 'admin'
    ? [{
        id: 'org_admin',
        label: 'Department Approvers',
        icon: UserCog,
        desc: 'Assign step-1 department heads'
      }]
    : [];

  return (
    <aside className="w-64 bg-slate-900 text-slate-300 flex flex-col flex-shrink-0 min-h-[calc(100vh-4rem)] border-r border-slate-800">
      {/* Workflow Navigation */}
      <div className="p-4">
        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider px-3 mb-2">
          P2P Purchasing Process
        </div>
        <nav className="space-y-1">
          {navItems.map((item, index) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-all ${
                  isActive
                    ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/20'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/80'
                }`}
              >
                <div className="flex items-center space-x-3 truncate">
                  <Icon className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-white' : 'text-slate-400'}`} />
                  <span className="truncate">{item.label}</span>
                </div>

                {item.badge && (
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${item.badgeColor} ml-2`}>
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {adminItems.length > 0 && (
        <div className="px-4 pb-2">
          <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider px-3 mb-2">
            Administration
          </div>
          <nav className="space-y-1">
            {adminItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onTabChange(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-all ${
                    isActive
                      ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/20'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/80'
                  }`}
                >
                  <div className="flex items-center space-x-3 truncate">
                    <Icon className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-white' : 'text-slate-400'}`} />
                    <span className="truncate">{item.label}</span>
                  </div>
                </button>
              );
            })}
          </nav>
        </div>
      )}

      {/* Lifecycle Flow Indicator Card */}
      <div className="mt-auto p-4 border-t border-slate-800/80">
        <div className="bg-slate-800/60 rounded-xl p-3 border border-slate-700/60 text-xs">
          <div className="font-semibold text-slate-200 mb-1 flex items-center justify-between">
            <span>Procure-to-Pay Flow</span>
            <span className="text-[10px] text-emerald-400 font-mono">100% Traceable</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed mb-2.5">
            PR ➔ Approval ➔ PO ➔ GRN / SES ➔ Match ➔ Exception ➔ Aging ➔ Pay
          </p>
          <div className="flex items-center space-x-1 text-[10px] text-slate-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>{dbModeLabel(dbMode)}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
