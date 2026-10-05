// API client for ProcureFlow

const API_BASE = '/api';

function apiFetch(url, options = {}) {
  return fetch(url, { credentials: 'include', ...options });
}

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
  // Auth (httpOnly session cookie; credentials included so the cookie is sent)
  getAuthConfig: () =>
    apiFetch(`${API_BASE}/auth/config`, { credentials: 'include' }).then((r) =>
      jsonOk(r, 'Failed to load auth config')
    ),
  getMe: async () => {
    const r = await apiFetch(`${API_BASE}/auth/me`, { credentials: 'include' });
    if (r.status === 401) return { user: null };
    return jsonOk(r, 'Failed to load session');
  },
  login: async (email, password) => {
    const r = await apiFetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    return jsonOk(r, 'Login failed');
  },
  logout: async () => {
    const r = await apiFetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      credentials: 'include'
    });
    return jsonOk(r, 'Logout failed');
  },
  bootstrapAdmin: async (data) => {
    const r = await apiFetch(`${API_BASE}/auth/bootstrap`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to create the first admin');
  },

  // Users & Roles
  getUsers: (status = '') => {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    const qs = params.toString();
    return apiFetch(`${API_BASE}/users${qs ? `?${qs}` : ''}`, { credentials: 'include' }).then((r) =>
      jsonOk(r, 'Failed to load users')
    );
  },
  createUser: async (data) => {
    const r = await apiFetch(`${API_BASE}/users`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to create user');
  },
  updateUser: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/users/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to update user');
  },
  updateUserStatus: async (id, status) => {
    const r = await apiFetch(`${API_BASE}/users/${id}/status`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    return jsonOk(r, 'Failed to update user status');
  },
  setUserPassword: async (id, password) => {
    const r = await apiFetch(`${API_BASE}/users/${id}/password`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    return jsonOk(r, 'Failed to set password');
  },
  getDepartments: () => apiFetch(`${API_BASE}/departments`).then(r => r.json()),
  getEligibleApprovers: () => apiFetch(`${API_BASE}/departments/eligible-approvers`).then(r => r.json()),
  setDepartmentApprover: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/departments/${id}/approver`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to update department approver');
  },

  // Dashboard & Analytics
  getHealth: () => apiFetch(`${API_BASE}/health`).then(r => r.json()),
  getAnalytics: () => apiFetch(`${API_BASE}/analytics`).then(r => r.json()),

  // Catalog & Suppliers
  getCatalog: (category = '', search = '', options = {}) => {
    const params = new URLSearchParams();
    if (category) params.append('category', category);
    if (search) params.append('search', search);
    if (options.status) params.append('status', options.status);
    if (options.include_inactive) params.append('include_inactive', '1');
    return apiFetch(`${API_BASE}/catalog?${params.toString()}`).then(r => r.json());
  },
  createCatalogItem: async (item) => {
    const r = await apiFetch(`${API_BASE}/catalog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return jsonOk(r, 'Failed to create catalog item');
  },
  updateCatalogItem: async (id, item) => {
    const r = await apiFetch(`${API_BASE}/catalog/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return jsonOk(r, 'Failed to update catalog item');
  },
  updateCatalogItemStatus: async (id, status) => {
    const r = await apiFetch(`${API_BASE}/catalog/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    return jsonOk(r, 'Failed to update catalog item status');
  },

  getSuppliers: (status = '') => {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    return apiFetch(`${API_BASE}/suppliers?${params.toString()}`).then(r => r.json());
  },
  createSupplier: async (supplier) => {
    const r = await apiFetch(`${API_BASE}/suppliers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(supplier)
    });
    return jsonOk(r, 'Failed to create supplier');
  },
  updateSupplier: async (id, supplier) => {
    const r = await apiFetch(`${API_BASE}/suppliers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(supplier)
    });
    return jsonOk(r, 'Failed to update supplier');
  },
  updateSupplierStatus: async (id, status) => {
    const r = await apiFetch(`${API_BASE}/suppliers/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    return jsonOk(r, 'Failed to update supplier status');
  },

  // Budgets
  getBudgets: () => apiFetch(`${API_BASE}/budgets`).then(r => r.json()),

  // Contracts & Renewals
  getContracts: (category = '', status = '', search = '') => {
    const params = new URLSearchParams();
    if (category) params.append('category', category);
    if (status) params.append('status', status);
    if (search) params.append('search', search);
    return apiFetch(`${API_BASE}/contracts?${params.toString()}`).then(r => r.json());
  },
  getContractDetail: (id) => apiFetch(`${API_BASE}/contracts/${id}`).then(r => r.json()),
  createContract: async (contractData) => {
    const r = await apiFetch(`${API_BASE}/contracts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contractData)
    });
    return jsonOk(r, 'Failed to create contract');
  },
  renewContractPr: async (contractId, data = {}) => {
    const r = await apiFetch(`${API_BASE}/contracts/${contractId}/renew-pr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to generate renewal requisition');
  },
  // Alias used by ContractsView (same path).
  renewContractPR(contractId, data = {}) {
    return this.renewContractPr(contractId, data);
  },
  previewContractMatch: async (data = {}) => {
    const r = await apiFetch(`${API_BASE}/contracts/match-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to preview contract match');
  },

  // Requisitions
  getRequisitions: (status = '', department_id = '') => {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    if (department_id) params.append('department_id', department_id);
    return apiFetch(`${API_BASE}/requisitions?${params.toString()}`).then(r => r.json());
  },
  getRequisitionDetail: (id) => apiFetch(`${API_BASE}/requisitions/${id}`).then(r => r.json()),
  createRequisition: async (prData) => {
    const r = await apiFetch(`${API_BASE}/requisitions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prData)
    });
    return jsonOk(r, 'Failed to create requisition');
  },
  submitRequisition: async (id, data = {}) => {
    const r = await apiFetch(`${API_BASE}/requisitions/${id}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to submit requisition');
  },
  updateRequisitionContract: async (id, data = {}) => {
    const r = await apiFetch(`${API_BASE}/requisitions/${id}/contract`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to update contract link');
  },

  // Approvals
  getApprovals: (approver_id = '') => {
    const params = new URLSearchParams();
    if (approver_id) params.append('approver_id', approver_id);
    return apiFetch(`${API_BASE}/approvals?${params.toString()}`).then(r => r.json());
  },
  decideApproval: async (id, decisionData) => {
    const r = await apiFetch(`${API_BASE}/approvals/${id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(decisionData)
    });
    return jsonOk(r, 'Failed to record approval decision');
  },

  getDelegations: ({ user_id, delegator_user_id, delegate_user_id, active } = {}) => {
    const params = new URLSearchParams();
    if (user_id) params.append('user_id', user_id);
    if (delegator_user_id) params.append('delegator_user_id', delegator_user_id);
    if (delegate_user_id) params.append('delegate_user_id', delegate_user_id);
    if (active !== undefined && active !== null && active !== '') params.append('active', active);
    const qs = params.toString();
    return apiFetch(`${API_BASE}/approval-delegations${qs ? `?${qs}` : ''}`).then((r) =>
      jsonOk(r, 'Failed to load delegations')
    );
  },
  createDelegation: async (data) => {
    const r = await apiFetch(`${API_BASE}/approval-delegations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to create delegation');
  },
  revokeDelegation: async (id, data = {}) => {
    const r = await apiFetch(`${API_BASE}/approval-delegations/${id}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to revoke delegation');
  },

  // Purchase Orders
  getPurchaseOrders: (status = '') => {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    return apiFetch(`${API_BASE}/purchase-orders?${params.toString()}`).then(r => r.json());
  },
  getPurchaseOrderDetail: (id) => apiFetch(`${API_BASE}/purchase-orders/${id}`).then(r => r.json()),
  createPOFromRequisition: async (poData) => {
    const r = await apiFetch(`${API_BASE}/purchase-orders/from-requisition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(poData)
    });
    return jsonOk(r, 'Failed to generate purchase order');
  },
  updatePOStatus: async (id, status, notes) => {
    const r = await apiFetch(`${API_BASE}/purchase-orders/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, notes })
    });
    return jsonOk(r, 'Failed to update purchase order status');
  },
  getChangeOrders: (id) =>
    apiFetch(`${API_BASE}/purchase-orders/${id}/change-orders`).then((r) =>
      jsonOk(r, 'Failed to load change orders')
    ),
  createChangeOrder: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/purchase-orders/${id}/change-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to apply change order');
  },

  // Goods Receipts
  getGoodsReceipts: (po_id = '') => {
    const params = new URLSearchParams();
    if (po_id) params.append('po_id', po_id);
    return apiFetch(`${API_BASE}/goods-receipts?${params.toString()}`).then(r => r.json());
  },
  getGoodsReceiptDetail: (id) => apiFetch(`${API_BASE}/goods-receipts/${id}`).then(r => r.json()),
  createGoodsReceipt: async (receiptData) => {
    const r = await apiFetch(`${API_BASE}/goods-receipts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(receiptData)
    });
    return jsonOk(r, 'Failed to record goods receipt');
  },

  // Consignment stock (supplier-owned). Separate from GRN.
  getConsignment: () => apiFetch(`${API_BASE}/consignment`).then((r) => jsonOk(r, 'Failed to load consignment stock')),
  receiveConsignment: async (data) => {
    const r = await apiFetch(`${API_BASE}/consignment/receipts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to record consignment receipt');
  },
  issueConsignment: async (data) => {
    const r = await apiFetch(`${API_BASE}/consignment/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to issue consignment stock');
  },

  getUtilities: () => apiFetch(`${API_BASE}/utilities`).then((r) => jsonOk(r, 'Failed to load utility arrangements')),
  openUtilityArrangement: async (data) => {
    const r = await apiFetch(`${API_BASE}/utilities/arrangements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to open utility arrangement');
  },
  recordUtilityConsumption: async (data) => {
    const r = await apiFetch(`${API_BASE}/utilities/consumptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to record utility consumption');
  },

  getBulkVessels: () => apiFetch(`${API_BASE}/bulk-vessels`).then((r) => jsonOk(r, 'Failed to load vendor-managed bulk')),
  registerBulkVessel: async (data) => {
    const r = await apiFetch(`${API_BASE}/bulk-vessels/containers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to register vessel');
  },
  fillBulkVessel: async (data) => {
    const r = await apiFetch(`${API_BASE}/bulk-vessels/fills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to fill vessel');
  },
  drawBulkVessel: async (data) => {
    const r = await apiFetch(`${API_BASE}/bulk-vessels/draws`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to draw from vessel');
  },

  // Service Entry Sheets
  getServiceEntrySheets: (po_id = '') => {
    const params = new URLSearchParams();
    if (po_id) params.append('po_id', po_id);
    return apiFetch(`${API_BASE}/service-entry-sheets?${params.toString()}`).then(r => r.json());
  },
  getServiceEntrySheetDetail: (id) => apiFetch(`${API_BASE}/service-entry-sheets/${id}`).then(r => r.json()),
  createServiceEntrySheet: async (sesData) => {
    const r = await apiFetch(`${API_BASE}/service-entry-sheets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sesData)
    });
    return jsonOk(r, 'Failed to create service entry sheet');
  },
  submitServiceEntrySheet: async (id, data = {}) => {
    const r = await apiFetch(`${API_BASE}/service-entry-sheets/${id}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to submit service entry sheet');
  },
  acceptServiceEntrySheet: async (id, data = {}) => {
    const r = await apiFetch(`${API_BASE}/service-entry-sheets/${id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to accept service entry sheet');
  },
  rejectServiceEntrySheet: async (id, data = {}) => {
    const r = await apiFetch(`${API_BASE}/service-entry-sheets/${id}/reject`, {
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
    return apiFetch(`${API_BASE}/invoices?${params.toString()}`).then(r => r.json());
  },
  getInvoiceDetail: (id) => apiFetch(`${API_BASE}/invoices/${id}`).then(r => r.json()),
  createInvoice: async (invoiceData) => {
    const r = await apiFetch(`${API_BASE}/invoices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invoiceData)
    });
    return jsonOk(r, 'Failed to create invoice');
  },
  approveInvoicePayment: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/invoices/${id}/approve-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to approve invoice payment');
  },
  markInvoicePaid: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/invoices/${id}/mark-paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to mark invoice paid');
  },

  getApAging: ({ bucket = 'all', days = 7, today } = {}) => {
    const params = new URLSearchParams();
    if (bucket) params.append('bucket', bucket);
    if (days != null && days !== '') params.append('days', String(days));
    if (today) params.append('today', today);
    return apiFetch(`${API_BASE}/ap-aging?${params.toString()}`).then((r) =>
      jsonOk(r, 'Failed to load AP aging queue')
    );
  },

  getPaymentRuns: (status = '') => {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    const qs = params.toString();
    return apiFetch(`${API_BASE}/payment-runs${qs ? `?${qs}` : ''}`).then((r) =>
      jsonOk(r, 'Failed to load payment runs')
    );
  },
  getPaymentRunDetail: (id) =>
    apiFetch(`${API_BASE}/payment-runs/${id}`).then((r) => jsonOk(r, 'Failed to load payment run')),
  getEligiblePaymentRunInvoices: () =>
    apiFetch(`${API_BASE}/payment-runs/eligible-invoices`).then((r) =>
      jsonOk(r, 'Failed to load eligible invoices')
    ),
  createPaymentRun: async (data) => {
    const r = await apiFetch(`${API_BASE}/payment-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to create payment run');
  },
  executePaymentRun: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/payment-runs/${id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to execute payment run');
  },
  cancelPaymentRun: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/payment-runs/${id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to cancel payment run');
  },

  getInvoiceExceptions: (queue = 'open') => {
    const params = new URLSearchParams();
    if (queue) params.append('queue', queue);
    return apiFetch(`${API_BASE}/invoice-exceptions?${params.toString()}`).then((r) => jsonOk(r, 'Failed to load exception queue'));
  },
  getInvoiceExceptionDetail: (id) =>
    apiFetch(`${API_BASE}/invoice-exceptions/${id}`).then((r) => jsonOk(r, 'Failed to load exception detail')),
  resolveInvoiceException: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/invoice-exceptions/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to resolve invoice exception');
  },
  getInvoiceDuplicates: (queue = 'open') => {
    const params = new URLSearchParams();
    if (queue) params.append('queue', queue);
    return apiFetch(`${API_BASE}/invoice-duplicates?${params.toString()}`).then((r) =>
      jsonOk(r, 'Failed to load duplicate-suspect queue')
    );
  },
  getInvoiceDuplicateDetail: (id) =>
    apiFetch(`${API_BASE}/invoice-duplicates/${id}`).then((r) => jsonOk(r, 'Failed to load duplicate detail')),
  resolveInvoiceDuplicate: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/invoice-duplicates/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to resolve duplicate suspect');
  },

  getBuyerInbox: ({ requester_id, department_id } = {}) => {
    const params = new URLSearchParams();
    if (requester_id) params.append('requester_id', requester_id);
    if (department_id) params.append('department_id', department_id);
    return apiFetch(`${API_BASE}/invoice-exceptions/buyer-inbox?${params.toString()}`).then((r) =>
      jsonOk(r, 'Failed to load buyer inbox')
    );
  },
  respondBuyerInbox: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/invoice-exceptions/${id}/buyer-respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, 'Failed to record buyer response');
  },

  // Document trail (PR → approvals → PO(s) → GRN/SES → invoice → AP)
  searchDocumentTrail: (q = '') => {
    const params = new URLSearchParams();
    if (q) params.append('q', q);
    return apiFetch(`${API_BASE}/document-trail/search?${params.toString()}`).then(r => r.json());
  },
  getDocumentTrail: async (params = {}) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        search.append(key, value);
      }
    });
    const r = await apiFetch(`${API_BASE}/document-trail?${search.toString()}`);
    return jsonOk(r, 'Document trail not found');
  }
};
