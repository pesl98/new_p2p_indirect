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

export function lineTypeLabel(itemOrType) {
  const type = typeof itemOrType === 'string' ? itemOrType : lineTypeOf(itemOrType);
  return type === 'service' ? 'Service' : 'Goods';
}
