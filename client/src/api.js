// API client for ProcureFlow

import { t } from './i18n';

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
      jsonOk(r, t('errors.authConfig'))
    ),
  getMe: async () => {
    const r = await apiFetch(`${API_BASE}/auth/me`, { credentials: 'include' });
    if (r.status === 401) return { user: null };
    return jsonOk(r, t('errors.session'));
  },
  login: async (email, password) => {
    const r = await apiFetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    return jsonOk(r, t('errors.login'));
  },
  logout: async () => {
    const r = await apiFetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      credentials: 'include'
    });
    return jsonOk(r, t('errors.logout'));
  },
  bootstrapAdmin: async (data) => {
    const r = await apiFetch(`${API_BASE}/auth/bootstrap`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.bootstrap'));
  },

  // Users & Roles
  getUsers: (status = '') => {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    const qs = params.toString();
    return apiFetch(`${API_BASE}/users${qs ? `?${qs}` : ''}`, { credentials: 'include' }).then((r) =>
      jsonOk(r, t('errors.users'))
    );
  },
  createUser: async (data) => {
    const r = await apiFetch(`${API_BASE}/users`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.createUser'));
  },
  updateUser: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/users/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.updateUser'));
  },
  updateUserStatus: async (id, status) => {
    const r = await apiFetch(`${API_BASE}/users/${id}/status`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    return jsonOk(r, t('errors.userStatus'));
  },
  setUserPassword: async (id, password) => {
    const r = await apiFetch(`${API_BASE}/users/${id}/password`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    return jsonOk(r, t('errors.password'));
  },
  getDepartments: () => apiFetch(`${API_BASE}/departments`).then(r => r.json()),
  getEligibleApprovers: () => apiFetch(`${API_BASE}/departments/eligible-approvers`).then(r => r.json()),
  setDepartmentApprover: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/departments/${id}/approver`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.departmentApprover'));
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
    return jsonOk(r, t('errors.catalogCreate'));
  },
  updateCatalogItem: async (id, item) => {
    const r = await apiFetch(`${API_BASE}/catalog/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
    return jsonOk(r, t('errors.catalogUpdate'));
  },
  updateCatalogItemStatus: async (id, status) => {
    const r = await apiFetch(`${API_BASE}/catalog/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    return jsonOk(r, t('errors.catalogStatus'));
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
    return jsonOk(r, t('errors.supplierCreate'));
  },
  updateSupplier: async (id, supplier) => {
    const r = await apiFetch(`${API_BASE}/suppliers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(supplier)
    });
    return jsonOk(r, t('errors.supplierUpdate'));
  },
  updateSupplierStatus: async (id, status) => {
    const r = await apiFetch(`${API_BASE}/suppliers/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    return jsonOk(r, t('errors.supplierStatus'));
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
    return jsonOk(r, t('errors.contractCreate'));
  },
  renewContractPr: async (contractId, data = {}) => {
    const r = await apiFetch(`${API_BASE}/contracts/${contractId}/renew-pr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.contractRenew'));
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
    return jsonOk(r, t('errors.contractPreview'));
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
    return jsonOk(r, t('errors.requisitionCreate'));
  },
  submitRequisition: async (id, data = {}) => {
    const r = await apiFetch(`${API_BASE}/requisitions/${id}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.requisitionSubmit'));
  },
  updateRequisitionContract: async (id, data = {}) => {
    const r = await apiFetch(`${API_BASE}/requisitions/${id}/contract`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.contractLink'));
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
    return jsonOk(r, t('errors.approval'));
  },

  getDelegations: ({ user_id, delegator_user_id, delegate_user_id, active } = {}) => {
    const params = new URLSearchParams();
    if (user_id) params.append('user_id', user_id);
    if (delegator_user_id) params.append('delegator_user_id', delegator_user_id);
    if (delegate_user_id) params.append('delegate_user_id', delegate_user_id);
    if (active !== undefined && active !== null && active !== '') params.append('active', active);
    const qs = params.toString();
    return apiFetch(`${API_BASE}/approval-delegations${qs ? `?${qs}` : ''}`).then((r) =>
      jsonOk(r, t('errors.delegations'))
    );
  },
  createDelegation: async (data) => {
    const r = await apiFetch(`${API_BASE}/approval-delegations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.delegationCreate'));
  },
  revokeDelegation: async (id, data = {}) => {
    const r = await apiFetch(`${API_BASE}/approval-delegations/${id}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.delegationRevoke'));
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
    let data = null;
    try {
      data = await r.json();
    } catch {
      throw new Error(t('errors.poCreate'));
    }
    if (!r.ok) throw new Error(data.code || data.error || t('errors.poCreate'));
    return data;
  },
  updatePOStatus: async (id, status, notes) => {
    const r = await apiFetch(`${API_BASE}/purchase-orders/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, notes })
    });
    return jsonOk(r, t('errors.poStatus'));
  },
  getChangeOrders: (id) =>
    apiFetch(`${API_BASE}/purchase-orders/${id}/change-orders`).then((r) =>
      jsonOk(r, t('errors.changeOrders'))
    ),
  createChangeOrder: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/purchase-orders/${id}/change-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.changeOrder'));
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
    return jsonOk(r, t('errors.grn'));
  },

  // Consignment stock (supplier-owned). Separate from GRN.
  getConsignment: () => apiFetch(`${API_BASE}/consignment`).then((r) => jsonOk(r, t('errors.consignment'))),
  receiveConsignment: async (data) => {
    const r = await apiFetch(`${API_BASE}/consignment/receipts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.consignmentReceipt'));
  },
  issueConsignment: async (data) => {
    const r = await apiFetch(`${API_BASE}/consignment/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.consignmentIssue'));
  },

  getUtilities: () => apiFetch(`${API_BASE}/utilities`).then((r) => jsonOk(r, t('errors.utilities'))),
  openUtilityArrangement: async (data) => {
    const r = await apiFetch(`${API_BASE}/utilities/arrangements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.utilityOpen'));
  },
  recordUtilityConsumption: async (data) => {
    const r = await apiFetch(`${API_BASE}/utilities/consumptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.utilityUse'));
  },

  getBulkVessels: () => apiFetch(`${API_BASE}/bulk-vessels`).then((r) => jsonOk(r, t('errors.bulk'))),
  registerBulkVessel: async (data) => {
    const r = await apiFetch(`${API_BASE}/bulk-vessels/containers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.vessel'));
  },
  fillBulkVessel: async (data) => {
    const r = await apiFetch(`${API_BASE}/bulk-vessels/fills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.vesselFill'));
  },
  drawBulkVessel: async (data) => {
    const r = await apiFetch(`${API_BASE}/bulk-vessels/draws`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.vesselDraw'));
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
    return jsonOk(r, t('errors.sesCreate'));
  },
  submitServiceEntrySheet: async (id, data = {}) => {
    const r = await apiFetch(`${API_BASE}/service-entry-sheets/${id}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.sesSubmit'));
  },
  acceptServiceEntrySheet: async (id, data = {}) => {
    const r = await apiFetch(`${API_BASE}/service-entry-sheets/${id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.sesAccept'));
  },
  rejectServiceEntrySheet: async (id, data = {}) => {
    const r = await apiFetch(`${API_BASE}/service-entry-sheets/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.sesReject'));
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
    return jsonOk(r, t('errors.invoiceCreate'));
  },
  approveInvoicePayment: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/invoices/${id}/approve-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.invoiceApprove'));
  },
  markInvoicePaid: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/invoices/${id}/mark-paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.invoicePaid'));
  },

  getApAging: ({ bucket = 'all', days = 7, today } = {}) => {
    const params = new URLSearchParams();
    if (bucket) params.append('bucket', bucket);
    if (days != null && days !== '') params.append('days', String(days));
    if (today) params.append('today', today);
    return apiFetch(`${API_BASE}/ap-aging?${params.toString()}`).then((r) =>
      jsonOk(r, t('errors.aging'))
    );
  },

  getPaymentRuns: (status = '') => {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    const qs = params.toString();
    return apiFetch(`${API_BASE}/payment-runs${qs ? `?${qs}` : ''}`).then((r) =>
      jsonOk(r, t('errors.paymentRuns'))
    );
  },
  getPaymentRunDetail: (id) =>
    apiFetch(`${API_BASE}/payment-runs/${id}`).then((r) => jsonOk(r, t('errors.paymentRun'))),
  getEligiblePaymentRunInvoices: () =>
    apiFetch(`${API_BASE}/payment-runs/eligible-invoices`).then((r) =>
      jsonOk(r, t('errors.eligibleInvoices'))
    ),
  createPaymentRun: async (data) => {
    const r = await apiFetch(`${API_BASE}/payment-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.paymentRunCreate'));
  },
  executePaymentRun: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/payment-runs/${id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.paymentRunExecute'));
  },
  cancelPaymentRun: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/payment-runs/${id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.paymentRunCancel'));
  },

  getInvoiceExceptions: (queue = 'open') => {
    const params = new URLSearchParams();
    if (queue) params.append('queue', queue);
    return apiFetch(`${API_BASE}/invoice-exceptions?${params.toString()}`).then((r) => jsonOk(r, t('errors.exceptions')));
  },
  getInvoiceExceptionDetail: (id) =>
    apiFetch(`${API_BASE}/invoice-exceptions/${id}`).then((r) => jsonOk(r, t('errors.exception'))),
  resolveInvoiceException: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/invoice-exceptions/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.exceptionResolve'));
  },
  getInvoiceDuplicates: (queue = 'open') => {
    const params = new URLSearchParams();
    if (queue) params.append('queue', queue);
    return apiFetch(`${API_BASE}/invoice-duplicates?${params.toString()}`).then((r) =>
      jsonOk(r, t('errors.duplicates'))
    );
  },
  getInvoiceDuplicateDetail: (id) =>
    apiFetch(`${API_BASE}/invoice-duplicates/${id}`).then((r) => jsonOk(r, t('errors.duplicate'))),
  resolveInvoiceDuplicate: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/invoice-duplicates/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.duplicateResolve'));
  },

  getBuyerInbox: ({ requester_id, department_id } = {}) => {
    const params = new URLSearchParams();
    if (requester_id) params.append('requester_id', requester_id);
    if (department_id) params.append('department_id', department_id);
    return apiFetch(`${API_BASE}/invoice-exceptions/buyer-inbox?${params.toString()}`).then((r) =>
      jsonOk(r, t('errors.buyerInbox'))
    );
  },
  respondBuyerInbox: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/invoice-exceptions/${id}/buyer-respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.buyerResponse'));
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
    return jsonOk(r, t('errors.trail'));
  },

  getComplianceReport: async (report, params = {}) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') search.append(key, value);
    });
    const qs = search.toString();
    const r = await apiFetch(`${API_BASE}/compliance/${report}${qs ? `?${qs}` : ''}`);
    return jsonOk(r, t('errors.compliance'));
  },
  exportComplianceCsv: async (report, params = {}) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') search.append(key, value);
    });
    search.set('format', 'csv');
    const r = await apiFetch(`${API_BASE}/compliance/${report}?${search.toString()}`);
    if (!r.ok) {
      let message = t('errors.exportFailed');
      try {
        const data = await r.json();
        message = data.error || message;
      } catch {
        // CSV error bodies are JSON from the API.
      }
      throw new Error(message);
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${report}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },

  getIntegrationConfig: () =>
    apiFetch(`${API_BASE}/integrations/config`).then((r) => jsonOk(r, t('errors.integrationConfig'))),
  getApiKeys: () =>
    apiFetch(`${API_BASE}/integrations/keys`).then((r) => jsonOk(r, t('errors.apiKeys'))),
  createApiKey: async (data) => {
    const r = await apiFetch(`${API_BASE}/integrations/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return jsonOk(r, t('errors.apiKeyCreate'));
  },
  revokeApiKey: async (id) => {
    const r = await apiFetch(`${API_BASE}/integrations/keys/${id}/revoke`, { method: 'POST' });
    return jsonOk(r, t('errors.apiKeyRevoke'));
  },
  getWebhookOutbox: (status = 'all') =>
    apiFetch(`${API_BASE}/integrations/outbox?status=${encodeURIComponent(status)}`).then((r) =>
      jsonOk(r, t('errors.outbox'))
    ),
  replayWebhook: async (id) => {
    const r = await apiFetch(`${API_BASE}/integrations/outbox/${id}/replay`, { method: 'POST' });
    return jsonOk(r, t('errors.replay'));
  },
  dispatchWebhooks: async () => {
    const r = await apiFetch(`${API_BASE}/integrations/outbox/dispatch`, { method: 'POST' });
    return jsonOk(r, t('errors.dispatch'));
  },

  getInvoiceProposalConfig: () =>
    apiFetch(`${API_BASE}/invoice-proposals/config`).then((r) => proposalJson(r, t('errors.proposalLoad'))),
  getInvoiceProposalOptions: () =>
    apiFetch(`${API_BASE}/invoice-proposals/options`).then((r) => proposalJson(r, t('errors.proposalLoad'))),
  listInvoiceProposals: (status = 'proposed', { limit = 50, offset = 0 } = {}) =>
    apiFetch(
      `${API_BASE}/invoice-proposals?status=${encodeURIComponent(status)}&limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`
    ).then((r) => proposalJson(r, t('errors.proposalLoad'))),
  uploadInvoiceProposal: async (file) => {
    const original = file.name || 'invoice.pdf';
    const ascii = original.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'invoice.pdf';
    const r = await apiFetch(`${API_BASE}/invoice-proposals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(original)}`,
        'X-Filename': ascii
      },
      body: await file.arrayBuffer()
    });
    return proposalJson(r, t('errors.proposalUpload'));
  },
  previewInvoiceProposal: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/invoice-proposals/${id}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return proposalJson(r, t('errors.proposalPreview'));
  },
  approveInvoiceProposal: async (id, overrideReason) => {
    const r = await apiFetch(`${API_BASE}/invoice-proposals/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(overrideReason ? { override_reason: overrideReason } : {})
    });
    return proposalJson(r, t('errors.proposalPost'));
  },
  postInvoiceProposal: async (id, data) => {
    const r = await apiFetch(`${API_BASE}/invoice-proposals/${id}/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return proposalJson(r, t('errors.proposalPost'));
  },
  rejectInvoiceProposal: async (id, reason) => {
    const r = await apiFetch(`${API_BASE}/invoice-proposals/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    return proposalJson(r, t('errors.proposalReject'));
  },

  getSourcingAccess: async () => {
    const r = await apiFetch(`${API_BASE}/sourcing/me`);
    if (!r.ok) return { canSee: false, canWrite: false, enabled: false, attention_count: 0 };
    return r.json();
  },
  listSourcingEvents: (query = {}) => {
    const params = new URLSearchParams();
    if (query.status && query.status !== 'all') params.set('status', query.status);
    if (query.source_requisition_id) params.set('source_requisition_id', String(query.source_requisition_id));
    const qs = params.toString();
    return apiFetch(`${API_BASE}/sourcing/events${qs ? `?${qs}` : ''}`).then((r) => proposalJson(r, t('errors.sourcing')));
  },
  getSourcingEvent: (id) =>
    apiFetch(`${API_BASE}/sourcing/events/${id}`).then((r) => proposalJson(r, t('errors.sourcing'))),
  createSourcingEvent: (data) =>
    apiFetch(`${API_BASE}/sourcing/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then((r) => proposalJson(r, t('errors.sourcingSave'))),
  createSourcingEventFromRequisition: (data) =>
    apiFetch(`${API_BASE}/sourcing/events/from-requisition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then((r) => proposalJson(r, t('errors.sourcingSave'))),
  updateSourcingEvent: (id, data) =>
    apiFetch(`${API_BASE}/sourcing/events/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then((r) => proposalJson(r, t('errors.sourcingSave'))),
  cancelSourcingEvent: (id, reason) =>
    apiFetch(`${API_BASE}/sourcing/events/${id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    }).then((r) => proposalJson(r, t('errors.sourcingSave'))),
  uploadSourcingFile: (eventId, file) =>
    apiFetch(`${API_BASE}/sourcing/events/${eventId}/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-Filename': file.name || 'bijlage.pdf'
      },
      body: file
    }).then((r) => proposalJson(r, t('errors.sourcingFile'))),
  removeSourcingFile: (eventId, fileId) =>
    apiFetch(`${API_BASE}/sourcing/events/${eventId}/files/${fileId}/remove`, {
      method: 'POST'
    }).then((r) => proposalJson(r, t('errors.sourcingFile'))),
  sourcingFileUrl: (eventId, fileId) => `${API_BASE}/sourcing/events/${eventId}/files/${fileId}`
};

async function proposalJson(response, fallbackMessage) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    throw new Error(fallbackMessage);
  }
  if (!response.ok) throw new Error(data.code || data.error || fallbackMessage);
  return data;
}
