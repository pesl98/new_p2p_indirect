import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { 
  LayoutDashboard, 
  FileText, 
  CheckSquare, 
  ShoppingCart, 
  PackageCheck,
  Warehouse,
  Gauge,
  Cylinder,
  ClipboardCheck,
  FileSpreadsheet, 
  Landmark, 
  Store,
  GitBranch,
  ShieldAlert,
  Inbox,
  CalendarClock,
  Copy,
  Banknote,
  UserCog,
  UserCheck,
  FileCheck,
  Users,
  ScrollText,
  KeyRound
} from 'lucide-react';

function dbModeLabel(mode) {
  if (mode === 'turso-http') return t('shell.dbTurso');
  if (mode === 'sqlite') return t('shell.dbSqlite');
  return t('shell.dbConnected');
}

export default function Sidebar({ activeTab, onTabChange, pendingApprovalsCount, varianceInvoicesCount, buyerInboxCount, apAgingOverdueCount, paymentRunDraftCount, duplicateSuspectCount, currentUser }) {
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
      label: t('shell.nav.dashboard'),
      icon: LayoutDashboard,
      desc: t('shell.nav.dashboardDesc')
    },
    {
      id: 'requisitions',
      label: t('shell.nav.requisitions'),
      icon: FileText,
      desc: t('shell.nav.requisitionsDesc')
    },
    {
      id: 'approvals',
      label: t('shell.nav.approvals'),
      icon: CheckSquare,
      badge: pendingApprovalsCount > 0 ? pendingApprovalsCount : null,
      badgeColor: 'bg-amber-500 text-white',
      desc: t('shell.nav.approvalsDesc')
    },
    ...(['approver', 'procurement', 'finance', 'admin'].includes(currentUser?.role)
      ? [{
          id: 'delegations',
          label: t('shell.nav.delegations'),
          icon: UserCheck,
          desc: t('shell.nav.delegationsDesc')
        }]
      : []),
    {
      id: 'purchase_orders',
      label: t('shell.nav.purchaseOrders'),
      icon: ShoppingCart,
      desc: t('shell.nav.purchaseOrdersDesc')
    },
    {
      id: 'goods_receipt',
      label: t('shell.nav.goodsReceipt'),
      icon: PackageCheck,
      desc: t('shell.nav.goodsReceiptDesc')
    },
    {
      id: 'consignment',
      label: t('shell.nav.consignment'),
      icon: Warehouse,
      desc: t('shell.nav.consignmentDesc')
    },
    {
      id: 'utilities',
      label: t('shell.nav.utilities'),
      icon: Gauge,
      desc: t('shell.nav.utilitiesDesc')
    },
    {
      id: 'bulk',
      label: t('shell.nav.bulk'),
      icon: Cylinder,
      desc: t('shell.nav.bulkDesc')
    },
    {
      id: 'service_entry',
      label: t('shell.nav.serviceEntry'),
      icon: ClipboardCheck,
      desc: t('shell.nav.serviceEntryDesc')
    },
    {
      id: 'invoices',
      label: t('shell.nav.invoices'),
      icon: FileSpreadsheet,
      badge: varianceInvoicesCount > 0
        ? t(varianceInvoicesCount === 1 ? 'shell.alertBadge' : 'shell.alertBadgeMany', { count: varianceInvoicesCount })
        : null,
      badgeColor: 'bg-rose-500 text-white',
      desc: t('shell.nav.invoicesDesc')
    },
    {
      id: 'exception_workbench',
      label: t('shell.nav.exceptions'),
      icon: ShieldAlert,
      badge: varianceInvoicesCount > 0 ? varianceInvoicesCount : null,
      badgeColor: 'bg-rose-500 text-white',
      desc: t('shell.nav.exceptionsDesc')
    },
    ...(['finance', 'admin'].includes(currentUser?.role)
      ? [{
          id: 'duplicate_suspects',
          label: t('shell.nav.duplicates'),
          icon: Copy,
          badge: duplicateSuspectCount > 0 ? duplicateSuspectCount : null,
          badgeColor: 'bg-amber-500 text-white',
          desc: t('shell.nav.duplicatesDesc')
        }]
      : []),
    ...(currentUser?.role === 'requester'
      ? [{
          id: 'buyer_inbox',
          label: t('shell.nav.buyerInbox'),
          icon: Inbox,
          badge: buyerInboxCount > 0 ? buyerInboxCount : null,
          badgeColor: 'bg-amber-500 text-white',
          desc: t('shell.nav.buyerInboxDesc')
        }]
      : []),
    ...(['finance', 'admin'].includes(currentUser?.role)
      ? [{
          id: 'ap_aging',
          label: t('shell.nav.apAging'),
          icon: CalendarClock,
          badge: apAgingOverdueCount > 0 ? apAgingOverdueCount : null,
          badgeColor: 'bg-rose-500 text-white',
          desc: t('shell.nav.apAgingDesc')
        }, {
          id: 'payment_runs',
          label: t('shell.nav.paymentRuns'),
          icon: Banknote,
          badge: paymentRunDraftCount > 0 ? paymentRunDraftCount : null,
          badgeColor: 'bg-indigo-500 text-white',
          desc: t('shell.nav.paymentRunsDesc')
        }, {
          id: 'compliance',
          label: t('shell.nav.compliance'),
          icon: ScrollText,
          desc: t('shell.nav.complianceDesc')
        }]
      : []),
    {
      id: 'document_trail',
      label: t('shell.nav.trail'),
      icon: GitBranch,
      desc: t('shell.nav.trailDesc')
    },
    {
      id: 'budgets',
      label: t('shell.nav.budgets'),
      icon: Landmark,
      desc: t('shell.nav.budgetsDesc')
    },
    {
      id: 'contracts',
      label: t('shell.nav.contracts'),
      icon: FileCheck,
      desc: t('shell.nav.contractsDesc')
    },
    {
      id: 'catalog',
      label: t('shell.nav.catalog'),
      icon: Store,
      desc: t('shell.nav.catalogDesc')
    },
  ];

  const adminItems = currentUser?.role === 'admin'
    ? [{
        id: 'org_admin',
        label: t('shell.nav.deptApprovers'),
        icon: UserCog,
        desc: t('shell.nav.deptApproversDesc')
      }, {
        id: 'user_admin',
        label: t('shell.nav.users'),
        icon: Users,
        desc: t('shell.nav.usersDesc')
      }, {
        id: 'integrations',
        label: t('shell.nav.integrations'),
        icon: KeyRound,
        desc: t('shell.nav.integrationsDesc')
      }]
    : [];

  return (
    <aside className="w-64 bg-slate-900 text-slate-300 flex flex-col flex-shrink-0 min-h-[calc(100vh-4rem)] border-r border-slate-800">
      {/* Workflow Navigation */}
      <div className="p-4">
        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider px-3 mb-2">
          {t('shell.navPurchasing')}
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
            {t('shell.navAdmin')}
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
            <span>{t('shell.flowTitle')}</span>
            <span className="text-[10px] text-emerald-400 font-mono">{t('shell.flowTraceable')}</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed mb-2.5">
            {t('shell.flowSteps')}
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
