// API client for ProcureFlow

const API_BASE = '/api';

export const api = {
  // Users & Roles
  getUsers: () => fetch(`${API_BASE}/users`).then(r => r.json()),
  getDepartments: () => fetch(`${API_BASE}/users/departments`).then(r => r.json()),

  // Dashboard & Analytics
  getAnalytics: () => fetch(`${API_BASE}/analytics`).then(r => r.json()),

  // Catalog & Suppliers
  getCatalog: (category = '', search = '') => {
    const params = new URLSearchParams();
    if (category) params.append('category', category);
    if (search) params.append('search', search);
    return fetch(`${API_BASE}/catalog?${params.toString()}`).then(r => r.json());
  },
  createCatalogItem: (item) => fetch(`${API_BASE}/catalog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item)
  }).then(r => r.json()),

  getSuppliers: () => fetch(`${API_BASE}/suppliers`).then(r => r.json()),
  createSupplier: (supplier) => fetch(`${API_BASE}/suppliers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(supplier)
  }).then(r => r.json()),

  // Budgets
  getBudgets: () => fetch(`${API_BASE}/budgets`).then(r => r.json()),

  // Requisitions
  getRequisitions: (status = '', department_id = '') => {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    if (department_id) params.append('department_id', department_id);
    return fetch(`${API_BASE}/requisitions?${params.toString()}`).then(r => r.json());
  },
  getRequisitionDetail: (id) => fetch(`${API_BASE}/requisitions/${id}`).then(r => r.json()),
  createRequisition: (prData) => fetch(`${API_BASE}/requisitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prData)
  }).then(r => r.json()),
  submitRequisition: (id) => fetch(`${API_BASE}/requisitions/${id}/submit`, {
    method: 'POST'
  }).then(r => r.json()),

  // Approvals
  getApprovals: (approver_id = '') => {
    const params = new URLSearchParams();
    if (approver_id) params.append('approver_id', approver_id);
    return fetch(`${API_BASE}/approvals?${params.toString()}`).then(r => r.json());
  },
  decideApproval: async (id, decisionData) => {
    const r = await fetch(`${API_BASE}/approvals/${id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(decisionData)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to record approval decision');
    return data;
  },

  // Purchase Orders
  getPurchaseOrders: (status = '') => {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    return fetch(`${API_BASE}/purchase-orders?${params.toString()}`).then(r => r.json());
  },
  getPurchaseOrderDetail: (id) => fetch(`${API_BASE}/purchase-orders/${id}`).then(r => r.json()),
  createPOFromRequisition: (poData) => fetch(`${API_BASE}/purchase-orders/from-requisition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(poData)
  }).then(r => r.json()),
  updatePOStatus: (id, status, notes) => fetch(`${API_BASE}/purchase-orders/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, notes })
  }).then(r => r.json()),

  // Goods Receipts
  getGoodsReceipts: (po_id = '') => {
    const params = new URLSearchParams();
    if (po_id) params.append('po_id', po_id);
    return fetch(`${API_BASE}/goods-receipts?${params.toString()}`).then(r => r.json());
  },
  getGoodsReceiptDetail: (id) => fetch(`${API_BASE}/goods-receipts/${id}`).then(r => r.json()),
  createGoodsReceipt: async (receiptData) => {
    const r = await fetch(`${API_BASE}/goods-receipts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(receiptData)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to record goods receipt');
    return data;
  },

  // Service Entry Sheets
  getServiceEntrySheets: (po_id = '') => {
    const params = new URLSearchParams();
    if (po_id) params.append('po_id', po_id);
    return fetch(`${API_BASE}/service-entry-sheets?${params.toString()}`).then(r => r.json());
  },
  getServiceEntrySheetDetail: (id) => fetch(`${API_BASE}/service-entry-sheets/${id}`).then(r => r.json()),
  createServiceEntrySheet: async (sesData) => {
    const r = await fetch(`${API_BASE}/service-entry-sheets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sesData)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to create service entry sheet');
    return data;
  },
  submitServiceEntrySheet: async (id, data = {}) => {
    const r = await fetch(`${API_BASE}/service-entry-sheets/${id}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await r.json();
    if (!r.ok) throw new Error(result.error || 'Failed to submit service entry sheet');
    return result;
  },
  acceptServiceEntrySheet: async (id, data = {}) => {
    const r = await fetch(`${API_BASE}/service-entry-sheets/${id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await r.json();
    if (!r.ok) throw new Error(result.error || 'Failed to accept service entry sheet');
    return result;
  },
  rejectServiceEntrySheet: async (id, data = {}) => {
    const r = await fetch(`${API_BASE}/service-entry-sheets/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await r.json();
    if (!r.ok) throw new Error(result.error || 'Failed to reject service entry sheet');
    return result;
  },

  // Invoices & Matching
  getInvoices: (status = '') => {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    return fetch(`${API_BASE}/invoices?${params.toString()}`).then(r => r.json());
  },
  getInvoiceDetail: (id) => fetch(`${API_BASE}/invoices/${id}`).then(r => r.json()),
  createInvoice: async (invoiceData) => {
    const r = await fetch(`${API_BASE}/invoices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invoiceData)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to create invoice');
    return data;
  },
  approveInvoicePayment: (id, data) => fetch(`${API_BASE}/invoices/${id}/approve-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }).then(r => r.json()),
  markInvoicePaid: (id, data) => fetch(`${API_BASE}/invoices/${id}/mark-paid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }).then(r => r.json())
};
