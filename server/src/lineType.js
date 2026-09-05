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
