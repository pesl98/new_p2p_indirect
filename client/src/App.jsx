import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import DashboardView from './views/DashboardView';
import RequisitionsView from './views/RequisitionsView';
import ApprovalsView from './views/ApprovalsView';
import PurchaseOrdersView from './views/PurchaseOrdersView';
import GoodsReceiptView from './views/GoodsReceiptView';
import ServiceEntrySheetsView from './views/ServiceEntrySheetsView';
import InvoicesMatchingView from './views/InvoicesMatchingView';
import ExceptionWorkbenchView from './views/ExceptionWorkbenchView';
import BuyerInboxView from './views/BuyerInboxView';
import ApAgingView from './views/ApAgingView';
import PaymentRunsView from './views/PaymentRunsView';
import DuplicateSuspectsView from './views/DuplicateSuspectsView';
import BudgetsView from './views/BudgetsView';
import ContractsView from './views/ContractsView';
import VendorsCatalogView from './views/VendorsCatalogView';
import DocumentTrailView from './views/DocumentTrailView';
import AdminDepartmentsView from './views/AdminDepartmentsView';
import AdminUsersView from './views/AdminUsersView';
import LoginView from './views/LoginView';
import DelegationsView, { DELEGATION_ROLES } from './views/DelegationsView';
import { api } from './api';

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [navFocus, setNavFocus] = useState(null);
  const [users, setUsers] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [sessionUser, setSessionUser] = useState(null);
  const [authConfig, setAuthConfig] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [buyerInboxCount, setBuyerInboxCount] = useState(0);
  const [apAgingOverdueCount, setApAgingOverdueCount] = useState(0);
  const [paymentRunDraftCount, setPaymentRunDraftCount] = useState(0);
  const [duplicateSuspectCount, setDuplicateSuspectCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const demoSwitcher = Boolean(authConfig?.demoPersonaSwitcher);
  const bootstrapNeeded = Boolean(authConfig?.bootstrapNeeded) && !sessionUser;
  const needsLogin = Boolean(authConfig) && !sessionUser && !demoSwitcher;

  const fetchCoreData = async ({ preferUser } = {}) => {
    try {
      const [uList, metrics] = await Promise.all([
        api.getUsers('all').catch(() => []),
        api.getAnalytics().catch(() => null)
      ]);
      const list = Array.isArray(uList) ? uList : [];
      setUsers(list);
      if (preferUser) {
        setCurrentUser(preferUser);
      } else if (sessionUser) {
        const fresh = list.find((u) => u.id === sessionUser.id) || sessionUser;
        setCurrentUser(fresh);
      } else if (demoSwitcher && list.length > 0) {
        setCurrentUser((prev) => prev || list.find((u) => u.status !== 'inactive') || list[0]);
      }
      if (metrics) setAnalytics(metrics);
    } catch (err) {
      console.error('Failed to load initial data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfg, me] = await Promise.all([
          api.getAuthConfig(),
          api.getMe()
        ]);
        if (cancelled) return;
        setAuthConfig(cfg);
        if (me?.user) {
          setSessionUser(me.user);
          setCurrentUser(me.user);
        }
      } catch (err) {
        console.error('Failed to load auth config:', err);
        if (!cancelled) setAuthConfig({ demoPersonaSwitcher: false, bootstrapNeeded: false });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!authConfig) return;
    if (!sessionUser && !demoSwitcher) {
      setLoading(false);
      return;
    }
    fetchCoreData({ preferUser: sessionUser || undefined });
  }, [authConfig, sessionUser, demoSwitcher]);

  useEffect(() => {
    if (!['finance', 'admin'].includes(currentUser?.role)) {
      setApAgingOverdueCount(0);
      setDuplicateSuspectCount(0);
      setPaymentRunDraftCount(0);
      return;
    }
    let cancelled = false;
    api.getApAging({ bucket: 'overdue', days: 7 })
      .then((data) => {
        if (!cancelled) setApAgingOverdueCount(data?.counts?.overdue || 0);
      })
      .catch(() => {
        if (!cancelled) setApAgingOverdueCount(0);
      });
    api.getInvoiceDuplicates('open')
      .then((rows) => {
        if (!cancelled) setDuplicateSuspectCount(Array.isArray(rows) ? rows.length : 0);
      })
      .catch(() => {
        if (!cancelled) setDuplicateSuspectCount(0);
      });
    api.getPaymentRuns('draft')
      .then((rows) => {
        if (!cancelled) setPaymentRunDraftCount(Array.isArray(rows) ? rows.length : 0);
      })
      .catch(() => {
        if (!cancelled) setPaymentRunDraftCount(0);
      });
    return () => { cancelled = true; };
  }, [currentUser, analytics]);

  useEffect(() => {
    if (currentUser?.role !== 'requester' || !currentUser?.id) {
      setBuyerInboxCount(0);
      return;
    }
    let cancelled = false;
    api.getBuyerInbox({ requester_id: currentUser.id })
      .then((rows) => {
        if (!cancelled) setBuyerInboxCount(Array.isArray(rows) ? rows.length : 0);
      })
      .catch(() => {
        if (!cancelled) setBuyerInboxCount(0);
      });
    return () => { cancelled = true; };
  }, [currentUser, analytics]);

  const handleSelectUser = (user) => {
    setCurrentUser(user);
    if (user?.role !== 'admin' && (activeTab === 'org_admin' || activeTab === 'user_admin')) {
      setActiveTab('dashboard');
    }
    if (user?.role !== 'requester' && activeTab === 'buyer_inbox') {
      setActiveTab('dashboard');
    }
    if (!DELEGATION_ROLES.includes(user?.role) && activeTab === 'delegations') {
      setActiveTab('dashboard');
    }
    if (!['finance', 'admin'].includes(user?.role) && activeTab === 'ap_aging') {
      setActiveTab('dashboard');
    }
    if (!['finance', 'admin'].includes(user?.role) && activeTab === 'payment_runs') {
      setActiveTab('dashboard');
    }
    if (!['finance', 'admin'].includes(user?.role) && activeTab === 'duplicate_suspects') {
      setActiveTab('dashboard');
    }
  };

  const handleNavigate = (tab, focus = null) => {
    setActiveTab(tab);
    setNavFocus(focus);
  };

  const handleAuthenticated = (user) => {
    setSessionUser(user);
    setCurrentUser(user);
    setAuthConfig((prev) => prev ? { ...prev, bootstrapNeeded: false } : prev);
    setLoading(true);
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      // still clear local session
    }
    setSessionUser(null);
    if (!demoSwitcher) {
      setCurrentUser(null);
      setUsers([]);
      setActiveTab('dashboard');
    }
  };

  if (!authConfig || (loading && !needsLogin && !bootstrapNeeded && !currentUser)) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">
        Loading ProcureFlow…
      </div>
    );
  }

  if (bootstrapNeeded || needsLogin) {
    return (
      <LoginView
        bootstrapNeeded={bootstrapNeeded}
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Top Navbar with Persona Bar */}
      <Header
        users={users.filter((u) => u.status !== 'inactive')}
        currentUser={currentUser}
        sessionUser={sessionUser}
        demoPersonaSwitcher={demoSwitcher}
        onSelectUser={handleSelectUser}
        onRefreshData={fetchCoreData}
        onLogout={handleLogout}
      />

      {/* Main Layout: Sidebar + Viewport */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          pendingApprovalsCount={analytics?.kpi?.pendingApprovals || 0}
          varianceInvoicesCount={analytics?.kpi?.invoiceVariances || 0}
          buyerInboxCount={buyerInboxCount}
          apAgingOverdueCount={apAgingOverdueCount}
          paymentRunDraftCount={paymentRunDraftCount}
          duplicateSuspectCount={duplicateSuspectCount}
          currentUser={currentUser}
        />

        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full">
          {activeTab === 'dashboard' && (
            <DashboardView
              analytics={analytics}
              onNavigate={handleNavigate}
              currentUser={currentUser}
            />
          )}

          {activeTab === 'document_trail' && (
            <DocumentTrailView onNavigate={handleNavigate} lookupQ={navFocus?.q} />
          )}

          {activeTab === 'requisitions' && (
            <RequisitionsView
              currentUser={currentUser}
              onNavigate={handleNavigate}
              focusId={navFocus?.focusId}
            />
          )}

          {activeTab === 'approvals' && (
            <ApprovalsView
              currentUser={currentUser}
              onNavigate={handleNavigate}
              onDataChanged={fetchCoreData}
            />
          )}

          {activeTab === 'delegations' && (
            <DelegationsView currentUser={currentUser} />
          )}

          {activeTab === 'purchase_orders' && (
            <PurchaseOrdersView
              currentUser={currentUser}
              onNavigate={handleNavigate}
              focusId={navFocus?.focusId}
              convertRequisitionId={navFocus?.convertRequisitionId}
            />
          )}

          {activeTab === 'goods_receipt' && (
            <GoodsReceiptView
              currentUser={currentUser}
              onDataChanged={fetchCoreData}
              focusId={navFocus?.focusId}
            />
          )}

          {activeTab === 'service_entry' && (
            <ServiceEntrySheetsView
              currentUser={currentUser}
              onDataChanged={fetchCoreData}
              focusId={navFocus?.focusId}
            />
          )}

          {activeTab === 'invoices' && (
            <InvoicesMatchingView
              currentUser={currentUser}
              onDataChanged={fetchCoreData}
              onNavigate={handleNavigate}
              focusId={navFocus?.focusId}
            />
          )}

          {activeTab === 'exception_workbench' && (
            <ExceptionWorkbenchView
              currentUser={currentUser}
              onDataChanged={fetchCoreData}
              onNavigate={handleNavigate}
              focusId={navFocus?.focusId}
            />
          )}

          {activeTab === 'buyer_inbox' && (
            <BuyerInboxView
              currentUser={currentUser}
              onDataChanged={fetchCoreData}
              onNavigate={handleNavigate}
              focusId={navFocus?.focusId}
            />
          )}

          {activeTab === 'duplicate_suspects' && (
            <DuplicateSuspectsView
              currentUser={currentUser}
              onDataChanged={fetchCoreData}
              onNavigate={handleNavigate}
              focusId={navFocus?.focusId}
            />
          )}

          {activeTab === 'ap_aging' && (
            <ApAgingView
              currentUser={currentUser}
              onDataChanged={fetchCoreData}
              onNavigate={handleNavigate}
              focusId={navFocus?.focusId}
            />
          )}

          {activeTab === 'payment_runs' && (
            <PaymentRunsView
              currentUser={currentUser}
              onDataChanged={fetchCoreData}
              onNavigate={handleNavigate}
              focusId={navFocus?.focusId}
              createInvoiceIds={navFocus?.invoiceIds}
            />
          )}

          {activeTab === 'budgets' && (
            <BudgetsView />
          )}

          {activeTab === 'contracts' && (
            <ContractsView
              currentUser={currentUser}
              onNavigate={handleNavigate}
              onDataChanged={fetchCoreData}
            />
          )}

          {activeTab === 'catalog' && (
            <VendorsCatalogView />
          )}

          {activeTab === 'org_admin' && (
            <AdminDepartmentsView currentUser={currentUser} />
          )}

          {activeTab === 'user_admin' && (
            <AdminUsersView currentUser={currentUser} sessionUser={sessionUser} />
          )}
        </main>
      </div>
    </div>
  );
}
