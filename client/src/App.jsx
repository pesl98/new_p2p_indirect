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
import BudgetsView from './views/BudgetsView';
import VendorsCatalogView from './views/VendorsCatalogView';
import DocumentTrailView from './views/DocumentTrailView';
import AdminDepartmentsView from './views/AdminDepartmentsView';
import DelegationsView, { DELEGATION_ROLES } from './views/DelegationsView';
import { api } from './api';

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [navFocus, setNavFocus] = useState(null);
  const [users, setUsers] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [buyerInboxCount, setBuyerInboxCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const fetchCoreData = async () => {
    try {
      const [uList, metrics] = await Promise.all([
        api.getUsers(),
        api.getAnalytics()
      ]);
      setUsers(uList);
      if (!currentUser && uList.length > 0) {
        setCurrentUser(uList[0]); // Default to Alice Chen (Requester)
      }
      setAnalytics(metrics);
    } catch (err) {
      console.error('Failed to load initial data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCoreData();
  }, []);

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
    if (user?.role !== 'admin' && activeTab === 'org_admin') {
      setActiveTab('dashboard');
    }
    if (user?.role !== 'requester' && activeTab === 'buyer_inbox') {
      setActiveTab('dashboard');
    }
    if (!DELEGATION_ROLES.includes(user?.role) && activeTab === 'delegations') {
      setActiveTab('dashboard');
    }
  };

  const handleNavigate = (tab, focus = null) => {
    setActiveTab(tab);
    setNavFocus(focus);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Top Navbar with Persona Bar */}
      <Header
        users={users}
        currentUser={currentUser}
        onSelectUser={handleSelectUser}
        onRefreshData={fetchCoreData}
      />

      {/* Main Layout: Sidebar + Viewport */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          pendingApprovalsCount={analytics?.kpi?.pendingApprovals || 0}
          varianceInvoicesCount={analytics?.kpi?.invoiceVariances || 0}
          buyerInboxCount={buyerInboxCount}
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

          {activeTab === 'budgets' && (
            <BudgetsView />
          )}

          {activeTab === 'catalog' && (
            <VendorsCatalogView />
          )}

          {activeTab === 'org_admin' && (
            <AdminDepartmentsView currentUser={currentUser} />
          )}
        </main>
      </div>
    </div>
  );
}
