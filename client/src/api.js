// API client for ProcureFlow

const API_BASE = '/api';

async function jsonOk(response, fallbackMessage) {
  let data;
  try {
    data = await response.json();
  } catch {
    if (!response.ok) throw new Error(fallbackMessage);
    throw new Error(fallbackMessage);
  }
  if (!response.ok) {
    throw new Error(data.error || fallbackMessage);
  }
  return data;
}

export const api = {
  // Users & Roles
  getUsers: () => fetch(`${API_BASE}/users`).then(r => r.json()),
  getDepartments: () => fetch(`${API_BASE}/users/departments`).then(r => r.json()),

  // Dashboard & Analytics
  getHealth: () => fetch(`${API_BASE}/health`).then(r => r.json()),
  getAnalytics: () => fetch(`${API_BASE}/analytics`).then(r => r.json()),

  // Catalog & Suppliers
  getCatalog: (category = '', search = '') => {
    const params = new URLSearchParams();
    if (category) params.append('category', category);
    if (search) params.append('search', search);
    return fetch(`${API_BASE}/catalog?${params.toString()}`).then(r => r.json());
  },
  createCatalogItem: async (item) => {
    const r = await fetch(`${API_BASE}/catalog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return jsonOk(r, 'Failed to create catalog item');
  },

  getSuppliers: () => fetch(`${API_BASE}/suppliers`).then(r => r.json()),
  createSupplier: async (supplier) => {
    const r = await fetch(`${API_BASE}/suppliers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(supplier)
    });
    return jsonOk(r, 'Failed to create supplier');
  },

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
  createRequisition: async (prData) => {
    const r = await fetch(`${API_BASE}/requisitions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prData)
    });
    return jsonOk(r, 'Failed to create requisition');
  },
  submitRequisition: async (id) => {
    const r = await fetch(`${API_BASE}/requisitions/${id}/submit`, {
      method: 'POST'
    });
    return jsonOk(r, 'Failed to submit requisition');
  },

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
    return jsonOk(r, 'Failed to record approval decision');
  },

  // Purchase Orders
  getPurchaseOrders: (status = '') => {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    return fetch(`${API_BASE}/purchase-orders?${params.toString()}`).then(r => r.json());
  },
  getPurchaseOrderDetail: (id) => fetch(`${API_BASE}/purchase-orders/${id}`).then(r => r.json()),
  createPOFromRequisition: async (poData) => {
    const r = await fetch(`${API_BASE}/purchase-orders/from-requisition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(poData)
    });
    return jsonOk(r, 'Failed to generate purchase order');
  },
  updatePOStatus: async (id, status, notes) => {
    const r = await fetch(`${API_BASE}/purchase-orders/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, notes })
    });
    return jsonOk(r, 'Failed to update purchase order status');
  },

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
    return jsonOk(r, 'Failed to record goods receipt');
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
    return jsonOk(r, 'Failed to create service entry sheet');
  },
  submitServiceEntrySheet: async (id, data = {}) => {
    const r = await fetch(`${API_BASE}/service-entry-sheets/${id}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to submit service entry sheet');
  },
  acceptServiceEntrySheet: async (id, data = {}) => {
    const r = await fetch(`${API_BASE}/service-entry-sheets/${id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to accept service entry sheet');
  },
  rejectServiceEntrySheet: async (id, data = {}) => {
    const r = await fetch(`${API_BASE}/service-entry-sheets/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to reject service entry sheet');
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
    return jsonOk(r, 'Failed to create invoice');
  },
  approveInvoicePayment: async (id, data) => {
    const r = await fetch(`${API_BASE}/invoices/${id}/approve-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to approve invoice payment');
  },
  markInvoicePaid: async (id, data) => {
    const r = await fetch(`${API_BASE}/invoices/${id}/mark-paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to mark invoice paid');
  },

  // Document trail (PR → approvals → PO(s) → GRN/SES → invoice → AP)
  searchDocumentTrail: (q = '') => {
    const params = new URLSearchParams();
    if (q) params.append('q', q);
    return fetch(`${API_BASE}/document-trail/search?${params.toString()}`).then(r => r.json());
  },
  getDocumentTrail: async (params = {}) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        search.append(key, value);
      }
    });
    const r = await fetch(`${API_BASE}/document-trail?${search.toString()}`);
    return jsonOk(r, 'Document trail not found');
  }
};
