/**
 * Line type (goods vs service) for catalog / PR / PO items.
 *
 * Rule (category-derived; explicit `line_type` wins when present):
 *   service — Consulting & Professional Services, Software & Cloud,
 *             Marketing & Events, Travel & Subscriptions
 *   goods   — IT Hardware, Office Supplies, Facilities & MRO, and anything else
 *
 * Stored on the line so match / GRN / SES do not re-derive at control time.
 */

export const SERVICE_CATEGORIES = [
  'Consulting & Professional Services',
  'Software & Cloud',
  'Marketing & Events',
  'Travel & Subscriptions'
];

export function lineTypeFromCategory(category) {
  return SERVICE_CATEGORIES.includes(category) ? 'service' : 'goods';
}

export function normalizeLineType(value, category) {
  if (value === 'service' || value === 'goods') return value;
  return lineTypeFromCategory(category);
}

export function isServiceLine(item) {
  if (!item) return false;
  if (item.line_type === 'service') return true;
  if (item.line_type === 'goods') return false;
  return lineTypeFromCategory(item.category) === 'service';
}

/** Supplier-owned discrete draw-down. Match and fulfillment use quantity_consumed, not GRN. */
export function isConsignmentLine(item) {
  return item?.receipt_basis === 'consignment';
}

/**
 * Metered utility or vendor-managed bulk payable.
 * Quantity columns are milli-units (quantity_scale 1000). Not discrete consignment.
 */
export function isMeasuredSettlement(item) {
  return item?.settlement_kind === 'utility' || item?.settlement_kind === 'bulk';
}

/**
 * How a service line is quantified. Goods lines never store a basis.
 * Omitted basis on a service keeps legacy unit quantity (seats, licenses).
 *   lump_sum — fixed fee per occurrence; quantity is a whole number of occurrences
 *   hours    — quantity is whole hours; unit_price is the hourly rate in cents
 *   days     — quantity is whole days; unit_price is the daily rate in cents
 * Line total is always quantity × unit_price in integer cents.
 */
export const SERVICE_BASES = ['lump_sum', 'hours', 'days'];

export class LineTypeError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'LineTypeError';
    this.statusCode = statusCode;
  }
}

export function resolveServiceBasis(value, lineType) {
  if (lineType !== 'service') return null;
  if (value === undefined || value === null || value === '') return null;
  const basis = String(value).trim();
  if (basis === 'lump_sum' || basis === 'hours' || basis === 'days') return basis;
  throw new LineTypeError(
    `service_basis must be lump_sum, hours, or days (received ${basis}).`
  );
}

export function serviceBasisLabel(basis) {
  if (basis === 'lump_sum') return 'Lump sum';
  if (basis === 'hours') return 'Hours';
  if (basis === 'days') return 'Days';
  return null;
}

/** Phrase used in match and acceptance text. Null basis keeps the legacy "N units" wording. */
export function quantityPhrase(basis, qty) {
  const n = Number(qty) || 0;
  if (basis === 'hours') return n === 1 ? '1 hour' : `${n} hours`;
  if (basis === 'days') return n === 1 ? '1 day' : `${n} days`;
  if (basis === 'lump_sum') return n === 1 ? '1 lump sum' : `${n} lump sums`;
  return `${n} units`;
}
