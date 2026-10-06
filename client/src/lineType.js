export const SERVICE_CATEGORIES = [
  'Consulting & Professional Services',
  'Software & Cloud',
  'Marketing & Events',
  'Travel & Subscriptions'
];

export function lineTypeFromCategory(category) {
  return SERVICE_CATEGORIES.includes(category) ? 'service' : 'goods';
}

export function lineTypeOf(item) {
  if (item?.line_type === 'service' || item?.line_type === 'goods') return item.line_type;
  return lineTypeFromCategory(item?.category);
}

export function isServiceLine(item) {
  return lineTypeOf(item) === 'service';
}

export function isConsignmentLine(item) {
  return item?.receipt_basis === 'consignment';
}

export function isMeasuredSettlement(item) {
  return item?.settlement_kind === 'utility' || item?.settlement_kind === 'bulk';
}

/** Short receipt-basis label for match and invoice lines. */
export function receiptBasisLabel(item) {
  if (!item) return 'GRN';
  if (item.line_type === 'service' || item.po_line_type === 'service') return 'SES';
  if (item.settlement_kind === 'utility') return 'utility';
  if (item.settlement_kind === 'bulk') return 'bulk';
  if (item.receipt_basis === 'consignment') return 'consignment';
  return 'GRN';
}

export function lineTypeLabel(itemOrType) {
  const type = typeof itemOrType === 'string' ? itemOrType : lineTypeOf(itemOrType);
  return type === 'service' ? 'Service' : 'Goods';
}

export const SERVICE_BASES = ['lump_sum', 'hours', 'days'];

export function serviceBasisLabel(basis) {
  if (basis === 'lump_sum') return 'Lump sum';
  if (basis === 'hours') return 'Hours';
  if (basis === 'days') return 'Days';
  return null;
}

export function lineTypeWithBasisLabel(item) {
  if (item?.settlement_kind === 'utility') return 'Utility';
  if (item?.settlement_kind === 'bulk') return 'Bulk';
  const type = lineTypeLabel(item);
  const basis = serviceBasisLabel(item?.service_basis);
  return basis ? `${type} · ${basis}` : type;
}

/** Display quantity for a PR/PO/SES line. Goods and unset service basis stay a plain number. */
export function formatLineQuantity(item) {
  if (Number(item?.quantity_scale) === 1000) {
    const qty = item?.quantity ?? item?.quantity_accepted ?? item?.ordered_qty ?? 0;
    const n = Math.trunc(Number(qty) || 0);
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    const text = `${sign}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, '0')}`;
    return item?.unit_of_measure ? `${text} ${item.unit_of_measure}` : text;
  }
  const qty = item?.quantity ?? item?.quantity_accepted ?? item?.ordered_qty;
  const n = Number(qty);
  const basis = item?.service_basis;
  if (basis === 'hours') return n === 1 ? '1 hour' : `${n} hours`;
  if (basis === 'days') return n === 1 ? '1 day' : `${n} days`;
  if (basis === 'lump_sum') return n === 1 ? '1 lump sum' : `${n} lump sums`;
  return String(qty ?? '');
}

export function serviceRateLabel(basis) {
  if (basis === 'hours') return 'per hour';
  if (basis === 'days') return 'per day';
  if (basis === 'lump_sum') return 'lump sum';
  return null;
}
