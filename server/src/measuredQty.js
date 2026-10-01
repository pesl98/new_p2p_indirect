/**
 * Measured quantities for metered utilities and vendor-managed bulk.
 *
 * Stored as integer milli-units (scale 1000): 12.450 m³ is 12450.
 * Money stays integer cents. Line amount is round(milli × unit price / 1000).
 * Discrete goods, services, and consignment stock stay whole units (`toQty`).
 */

export const MEASURED_SCALE = 1000;

export const UTILITY_TYPES = ['water', 'electricity', 'gas'];

export const UTILITY_UNITS = {
  water: ['m3', 'gal', 'kgal', 'ccf'],
  electricity: ['kWh', 'MWh'],
  gas: ['therm', 'm3', 'ccf']
};

export const BULK_UNITS = ['L', 'm3', 'kg', 'lb', 'gal'];

export class MeasuredFlowError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'MeasuredFlowError';
    this.statusCode = statusCode;
  }
}

/**
 * Parse a human measured quantity (up to 3 decimal places) into milli-units.
 * `allowZero` is for meter readings. Billed and drawn quantities must be > 0.
 */
export function parseMeasuredMilli(value, field = 'quantity', { allowZero = false } = {}) {
  if (value === undefined || value === null || value === '' || typeof value === 'boolean') {
    throw new MeasuredFlowError(
      `${field} is required and must be a measured quantity with up to 3 decimal places.`
    );
  }
  const text = typeof value === 'number' ? String(value) : String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new MeasuredFlowError(
      `${field} must be a measured quantity with up to 3 decimal places.`
    );
  }
  const [whole, frac = ''] = text.split('.');
  if (frac.length > 3) {
    throw new MeasuredFlowError(`${field} supports up to 3 decimal places.`);
  }
  const milli = (Number(whole) * MEASURED_SCALE) + Number(frac.padEnd(3, '0'));
  if (!Number.isSafeInteger(milli)) {
    throw new MeasuredFlowError(`${field} is too large.`);
  }
  if (milli === 0 && !allowZero) {
    throw new MeasuredFlowError(`${field} must be greater than 0.`);
  }
  return milli;
}

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

/** Integer cents for a measured line. `unitPriceCents` is the price of 1.000 of the UoM. */
export function measuredAmountCents(quantityMilli, unitPriceCents) {
  const milli = Math.trunc(Number(quantityMilli) || 0);
  const price = Math.trunc(Number(unitPriceCents) || 0);
  return Math.round((milli * price) / MEASURED_SCALE);
}

export function assertUtilityUnit(utilityType, unitOfMeasure) {
  const type = String(utilityType || '').trim();
  const allowed = UTILITY_UNITS[type];
  if (!allowed) {
    throw new MeasuredFlowError('utility_type must be water, electricity, or gas.');
  }
  const unit = String(unitOfMeasure || '').trim();
  if (!allowed.includes(unit)) {
    throw new MeasuredFlowError(`${type} is measured in ${allowed.join(', ')}.`);
  }
  return { utilityType: type, unitOfMeasure: unit };
}

export function assertBulkUnit(unitOfMeasure) {
  const unit = String(unitOfMeasure || '').trim();
  if (!BULK_UNITS.includes(unit)) {
    throw new MeasuredFlowError(`Bulk quantity is measured in ${BULK_UNITS.join(', ')}.`);
  }
  return unit;
}
