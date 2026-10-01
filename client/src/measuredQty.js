/** Display helpers for milli-unit utility and bulk quantities. Server stores scale 1000. */

export const MEASURED_SCALE = 1000;

export const UTILITY_UNITS = {
  water: ['m3', 'gal', 'kgal', 'ccf'],
  electricity: ['kWh', 'MWh'],
  gas: ['therm', 'm3', 'ccf']
};

export const BULK_UNITS = ['L', 'm3', 'kg', 'lb', 'gal'];

export function formatMeasured(quantityMilli, unitOfMeasure) {
  const n = Math.trunc(Number(quantityMilli) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / MEASURED_SCALE);
  const frac = String(abs % MEASURED_SCALE).padStart(3, '0');
  const text = `${sign}${whole}.${frac}`;
  const uom = unitOfMeasure ? String(unitOfMeasure).trim() : '';
  return uom ? `${text} ${uom}` : text;
}

export function isScaledQuantity(item) {
  return Number(item?.quantity_scale) === MEASURED_SCALE;
}

export function formatStoredQuantity(qty, item) {
  if (isScaledQuantity(item)) return formatMeasured(qty, item?.unit_of_measure);
  return String(qty ?? '');
}

/** Preview cents for a human measured quantity × unit price in cents. */
export function measuredLineTotalCents(quantityInput, unitPriceCents) {
  const milli = Math.round(Number(quantityInput) * MEASURED_SCALE);
  const price = Math.trunc(Number(unitPriceCents) || 0);
  if (!Number.isFinite(milli)) return 0;
  return Math.round((milli * price) / MEASURED_SCALE);
}
