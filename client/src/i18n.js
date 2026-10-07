/**
 * ProcureFlow UI strings. Default locale is nl-NL.
 * Add a catalog under ./i18n and register it in CATALOGS to extend later.
 * There is no language picker: one deployment speaks Dutch.
 */

import { nlNL } from './i18n/nl-NL.js';

export const DEFAULT_LOCALE = 'nl-NL';

const CATALOGS = Object.freeze({
  'nl-NL': nlNL
});

const listeners = new Set();
let locale = DEFAULT_LOCALE;

export function getLocale() {
  return locale;
}

export function subscribeLocale(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Future picker. Unknown locales fall back to nl-NL. */
export function setLocale(next) {
  const resolved = CATALOGS[next] ? next : DEFAULT_LOCALE;
  if (resolved === locale) return resolved;
  locale = resolved;
  listeners.forEach((listener) => listener(locale));
  return locale;
}

function lookup(key, active = locale) {
  const catalog = CATALOGS[active] || CATALOGS[DEFAULT_LOCALE];
  if (Object.prototype.hasOwnProperty.call(catalog, key)) return catalog[key];
  if (active !== DEFAULT_LOCALE && Object.prototype.hasOwnProperty.call(CATALOGS[DEFAULT_LOCALE], key)) {
    return CATALOGS[DEFAULT_LOCALE][key];
  }
  return undefined;
}

export function t(key, vars) {
  const template = lookup(key);
  const text = template == null ? key : template;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_, name) => (vars[name] == null ? '' : String(vars[name])));
}

export function hasMessage(key) {
  return lookup(key, DEFAULT_LOCALE) != null;
}

const STATUS = {
  draft: 'status.draft',
  submitted: 'status.submitted',
  pending: 'status.pending',
  pending_approval: 'status.pendingApproval',
  approved: 'status.approved',
  rejected: 'status.rejected',
  active: 'status.active',
  inactive: 'status.inactive',
  under_review: 'status.underReview',
  open: 'status.open',
  closed: 'status.closed',
  resolved: 'status.resolved',
  paid: 'status.paid',
  approved_for_payment: 'status.approvedForPayment',
  issued: 'status.issued',
  partially_received: 'status.partiallyReceived',
  received: 'status.received',
  accepted: 'status.accepted',
  converted_to_po: 'status.convertedToPo',
  complete: 'status.complete',
  current: 'status.current',
  not_started: 'status.notStarted',
  waiting: 'status.waiting',
  not_applicable: 'status.notApplicable',
  perfect_match: 'status.perfectMatch',
  matched: 'status.matched',
  tolerated_match: 'status.toleratedMatch',
  variance_flagged: 'status.varianceFlagged',
  quantity_variance: 'status.quantityVariance',
  price_variance: 'status.priceVariance',
  total_variance: 'status.totalVariance',
  applied: 'status.applied',
  expired: 'status.expired',
  expiring_soon: 'status.expiringSoon',
  cancelled: 'status.cancelled',
  canceled: 'status.cancelled',
  executed: 'status.executed',
  delivered: 'status.delivered',
  dead: 'status.dead',
  all: 'status.all',
  good: 'status.good',
  damaged: 'status.damaged',
  partial: 'status.partial',
  incorrect_item: 'status.incorrectItem',
  none: 'status.none',
  skipped: 'status.skipped',
  proposed: 'status.proposed',
  allowed: 'status.allowed',
  refused: 'status.refused',
  cleared: 'status.cleared',
  clear: 'status.clear',
  confirmed_unique: 'status.confirmedUnique',
  confirmed_duplicate: 'status.confirmedDuplicate',
  suspect: 'status.suspect',
  return_to_buyer: 'status.returnToBuyer',
  short_pay: 'status.shortPay',
  accept: 'status.accept',
  override: 'status.override'
};

const ROLES = {
  requester: 'role.requester',
  approver: 'role.approver',
  procurement: 'role.procurement',
  finance: 'role.finance',
  admin: 'role.admin'
};

const ROLE_BADGES = {
  requester: 'role.badge.requester',
  approver: 'role.badge.approver',
  procurement: 'role.badge.procurement',
  finance: 'role.badge.finance',
  admin: 'role.badge.admin'
};

const CATEGORIES = {
  'IT Hardware': 'category.itHardware',
  'Software & Cloud': 'category.software',
  'Office Supplies': 'category.office',
  'Facilities & MRO': 'category.facilities',
  'Consulting & Professional Services': 'category.consulting',
  'Marketing & Events': 'category.marketing',
  'Travel & Subscriptions': 'category.travel'
};

const PRIORITY = {
  Low: 'priority.low',
  Medium: 'priority.medium',
  High: 'priority.high',
  Urgent: 'priority.urgent'
};

const PAYMENT_TERMS = {
  'Net 15': 'terms.net15',
  'Net 30': 'terms.net30',
  'Net 45': 'terms.net45',
  'Net 60': 'terms.net60'
};

function named(map, value, fallback) {
  if (value == null || value === '') return fallback == null ? '' : fallback;
  const key = map[value];
  return key ? t(key) : fallback == null ? String(value) : fallback;
}

export function statusLabel(status) {
  return named(STATUS, status, status ? String(status).replace(/_/g, ' ') : '—');
}

export function roleLabel(role) {
  return named(ROLES, role, role || '');
}

export function roleBadgeLabel(role) {
  return named(ROLE_BADGES, role, t('role.badge.user'));
}

export function categoryLabel(category) {
  if (category == null || category === '' || category === 'All') {
    return category === 'All' ? t('category.all') : '';
  }
  return named(CATEGORIES, category);
}

export function priorityLabel(priority) {
  return named(PRIORITY, priority);
}

export function paymentTermLabel(term) {
  return named(PAYMENT_TERMS, term);
}

export function formatDate(value) {
  if (!value) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?![\s\S])/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(DEFAULT_LOCALE);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(DEFAULT_LOCALE);
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(DEFAULT_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

const API_EXACT = {
  'Invalid email or password': 'api.invalidCredentials',
  'Email and password are required': 'api.emailPasswordRequired',
  'This account is inactive': 'api.accountInactive',
  'Authentication required': 'api.authRequired',
  'Password sign-in is disabled for this customer': 'api.localLoginDisabled',
  'This tenant already has users. Sign in as an admin to create more.': 'api.tenantHasUsers',
  'Password is required to create the first admin': 'api.passwordRequired',
  'Email is required': 'api.emailRequired',
  'Email is invalid': 'api.emailInvalid',
  'Name is required': 'api.nameRequired',
  'A user with that email already exists': 'api.emailTaken',
  'Insufficient role for this action': 'api.insufficientRole',
  'Admin role required': 'api.adminRequired',
  'Requisition not found': 'api.requisitionNotFound',
  'Requisition must have at least one line item.': 'api.requisitionNeedsLine',
  'Only draft requisitions can be submitted': 'api.onlyDraftSubmit',
  'Purchase Order not found': 'api.poNotFound',
  'Purchase Order not found.': 'api.poNotFound',
  'Purchase order not found': 'api.poNotFound',
  'Invoice not found': 'api.invoiceNotFound',
  'Invoice not found.': 'api.invoiceNotFound',
  'Invoice must contain at least one line item.': 'api.invoiceNeedsLine',
  'invoice_number is required.': 'api.invoiceNumberRequired',
  'Goods receipt not found': 'api.grnNotFound',
  'Service entry sheet not found': 'api.sesNotFound',
  'No document trail found for that search': 'api.trailNotFound',
  'Unknown compliance report': 'api.unknownReport',
  'Department not found': 'api.departmentNotFound',
  'Approver user not found': 'api.approverNotFound',
  'User not found': 'api.userNotFound',
  'Cannot deactivate the last active admin': 'api.lastAdmin',
  'You cannot deactivate your own account': 'api.cannotDeactivateSelf',
  'Cannot remove admin role from the last active admin': 'api.lastAdminRole',
  'Decision must be approved or rejected': 'api.decisionRequired',
  'Only the current pending approval step can be decided': 'api.onlyCurrentStep',
  'Supplier not found.': 'api.supplierNotFound',
  'Catalog item not found.': 'api.catalogNotFound',
  'Invoice is already paid.': 'api.invoicePaid',
  'Invoice is already approved for payment.': 'api.invoiceAlreadyApproved',
  'Invoice was rejected and cannot be marked paid.': 'api.invoiceRejectedPaid',
  'Invoice was already rejected.': 'api.invoiceAlreadyRejected',
  'Select at least one approved invoice for the payment run.': 'api.paymentRunNeedsInvoice',
  'Payment run not found.': 'api.paymentRunNotFound',
  'Delegation not found': 'api.delegationNotFound',
  'Cannot delegate to yourself': 'api.cannotDelegateSelf',
  'Delegation is not active': 'api.delegationInactive',
  'Contract not found': 'api.contractNotFound',
  'Contract title is required': 'api.contractTitleRequired',
  'Please provide a contract title.': 'api.contractTitleRequired',
  'Outbox event not found': 'api.outboxNotFound',
  'Invalid outbox id': 'api.invalidOutbox',
  'Method not allowed': 'api.methodNotAllowed'
};

const API_PATTERNS = [
  [/^Supplier (.+) is not active\.(?![\s\S])/, 'api.supplierInactive'],
  [/^Catalog item (.+) is not active\.(?![\s\S])/, 'api.catalogInactive'],
  [/^This utility arrangement is inactive\.(?![\s\S])/, 'api.utilityInactive'],
  [/^This vessel is inactive\.(?![\s\S])/, 'api.vesselInactive'],
  [/^This consignment balance is inactive\.(?![\s\S])/, 'api.consignmentInactive'],
  [/^Consignment balance for (.+) at (.+) is inactive\.(?![\s\S])/, 'api.consignmentBalanceInactive'],
  [/^(.+) already has a vessel named (.+)\.(?![\s\S])/, 'api.vesselNameTaken'],
  [/^Password must be at least (\d+) characters\.(?![\s\S])/, 'api.passwordLength']
];

export function translateApiMessage(message) {
  if (!message) return null;
  const exact = API_EXACT[message];
  if (exact) return t(exact);
  const codeKey = `code.${message}`;
  if (hasMessage(codeKey)) return t(codeKey);
  for (const [pattern, key] of API_PATTERNS) {
    const match = String(message).match(pattern);
    if (!match) continue;
    const vars = {};
    match.slice(1).forEach((value, index) => {
      vars[`p${index + 1}`] = value;
    });
    return t(key, vars);
  }
  return null;
}

const DUTCH_VALUES = new Set(Object.values(nlNL));

/**
 * Message shown in the UI for a failed request.
 * Known API sentences and machine codes map to Dutch.
 * Anything else uses the Dutch fallback so the screen does not stay in English.
 */
export function presentError(error, fallbackKey = 'errors.requestRejected') {
  const message = (typeof error === 'string' ? error : error?.message || '').trim();
  if (!message) return t(fallbackKey);
  const mapped = translateApiMessage(message);
  if (mapped) return mapped;
  if (DUTCH_VALUES.has(message)) return message;
  return t(fallbackKey);
}

const RECEIPT_BASIS_NL = [
  ['accepted on SES', 'geaccepteerd op de SES'],
  ['measured on the utility reading', 'gemeten op de meterstand'],
  ['drawn from the vendor-managed vessel', 'afgenomen uit het leveranciersvat'],
  ['drawn from consignment', 'afgenomen uit consignatie'],
  ['physically received on GRN', 'fysiek ontvangen op de GRN']
];

function receiptBasisNl(phrase) {
  return RECEIPT_BASIS_NL.find(([en]) => en === phrase)?.[1] || phrase;
}

/**
 * Dutch for a success or match sentence the server stored in English.
 * Unknown text uses the Dutch fallback so the screen does not stay in English.
 */
export function presentNotice(message, fallbackKey = 'notice.saved') {
  const text = String(message || '').trim();
  if (!text) return t(fallbackKey);
  const mapped = translateNotice(text);
  if (mapped) return mapped;
  if (DUTCH_VALUES.has(text)) return text;
  return t(fallbackKey);
}

function dutchQtyWords(text) {
  return text
    .replace(/\b1 hour\b/g, '1 uur')
    .replace(/\b(\d+) hours\b/g, (_, n) => `${n} uur`)
    .replace(/\b1 day\b/g, '1 dag')
    .replace(/\b(\d+) days\b/g, (_, n) => `${n} dagen`)
    .replace(/\b1 lump sum\b/g, '1 vast bedrag')
    .replace(/\b(\d+) lump sums\b/g, (_, n) => `${n} vaste bedragen`)
    .replace(/\bunits\b/g, 'eenheden');
}

function translateNotice(text) {
  const rules = [
    [/^Utility arrangement (.+) is open\./, 'notice.utilityOpen'],
    [/^Recorded (.+) \((.+)\)\. Payable (.+) is ready/, 'notice.measuredPayable'],
    [/^Consignment receipt (.+) recorded\. On hand is now (\d+)\./, 'notice.consignmentReceipt'],
    [/^Issued (\d+) from consignment \((.+)\)\. Payable (.+) is ready/, 'notice.consignmentIssue'],
    [/^(?:Silo|Container) (.+) is empty and supplier-owned\./, 'notice.vesselOpen'],
    [/^Fill (.+) recorded\. Level is now (.+)\./, 'notice.vesselFill'],
    [/^Drew (.+) \((.+)\)\. Payable (.+) is ready/, 'notice.measuredPayable'],
    [/^Goods receipt recorded successfully(?![\s\S])/, 'notice.grn'],
    [/^Service entry sheet created successfully(?![\s\S])/, 'notice.sesCreated'],
    [/^Service entry sheet submitted for acceptance(?![\s\S])/, 'notice.sesSubmitted'],
    [/^Service entry sheet accepted(?![\s\S])/, 'notice.sesAccepted'],
    [/^Service entry sheet rejected(?![\s\S])/, 'notice.sesRejected'],
    [/^Requisition created successfully(?![\s\S])/, 'notice.prCreated'],
    [/^Requisition submitted for approval(?![\s\S])/, 'notice.prSubmitted'],
    [/^Quantity variance: Cumulative invoiced (.+) \(prior (.+) \+ this claim (.+)\) exceeds (.+) (accepted on SES|measured on the utility reading|drawn from the vendor-managed vessel|drawn from consignment|physically received on GRN)\.(?![\s\S])/, 'notice.qtyVsReceipt'],
    [/^Quantity variance: Cumulative invoiced (.+) exceeds ordered quantity (.+)\.(?![\s\S])/, 'notice.qtyVsOrdered'],
    [/^Partial billing: (.+) of (.+) billed\.(?![\s\S])/, 'notice.partialBilling'],
    [/^Minor price deviation within 1% tolerance: (.+) vs PO (.+) \((.+)%; (.+)¢ of (.+)¢ allowed\)\.(?![\s\S])/, 'notice.priceTolerance'],
    [/^Price discrepancy: Billed at (.+) vs authorized PO price (.+) \((.+)%\)\.(?![\s\S])/, 'notice.priceDiscrepancy'],
    [/^Exact SES-backed match: (.+) at (.+) matches PO & accepted service entry sheet\.(?![\s\S])/, 'notice.exactSes'],
    [/^Exact measured match: (.+) at (.+) matches the utility consumption\. No GRN was posted\.(?![\s\S])/, 'notice.exactUtility'],
    [/^Exact measured match: (.+) at (.+) matches the bulk draw-down\. No GRN was posted\.(?![\s\S])/, 'notice.exactBulk'],
    [/^Exact consignment match: (.+) at (.+) matches the draw-down PO\. Supplier-owned stock was issued; no GRN was posted\.(?![\s\S])/, 'notice.exactConsignment'],
    [/^Exact match: (.+) at (.+) matches PO & physical receipts\.(?![\s\S])/, 'notice.exactGrn']
  ];
  for (const [pattern, key] of rules) {
    const match = text.match(pattern);
    if (!match) continue;
    const vars = {};
    match.slice(1).forEach((value, index) => {
      vars[`p${index + 1}`] = key === 'notice.qtyVsReceipt' && index === 4
        ? receiptBasisNl(value)
        : value;
    });
    return dutchQtyWords(t(key, vars));
  }
  const pieces = text.split(/(?<=\.)\s+/).filter(Boolean);
  if (pieces.length > 1 && pieces.every((piece) => translateNotice(piece))) {
    return pieces.map((piece) => translateNotice(piece)).join(' ');
  }
  return null;
}

export function messageKeys() {
  return Object.keys(nlNL);
}
