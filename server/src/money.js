/**
 * Integer-cent money helpers.
 *
 * Convention: SQLite, API request/response bodies, and all server arithmetic
 * store money as integer cents (USD minor units). Convert at display/input
 * edges only — never mix float dollars with cents in the same field.
 */

/** Convert a dollar amount (number or numeric string) to integer cents at an I/O edge. */
export function toCents(dollars) {
  if (dollars == null || dollars === '') return 0;
  const num = typeof dollars === 'number' ? dollars : Number(String(dollars).trim());
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}

/** Convert integer cents to a dollar number for display only. */
export function fromCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return 0;
  return n / 100;
}

/** Format cents as a fixed 2-decimal dollar string (no currency symbol). */
export function formatCents(cents) {
  return fromCents(cents).toFixed(2);
}

/** Integer line total: quantity × unit price in cents. */
export function lineTotalCents(quantity, unitPriceCents) {
  return toQty(quantity) * Math.trunc(Number(unitPriceCents) || 0);
}

/** Whole-unit quantity. Seeded catalog and match use integer units. */
export function toQty(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

/** Coerce an API/DB money field to integer cents (already-cents values). */
export function asCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

/** Existing approval routing thresholds, expressed in cents ($1,000 / $10,000). */
export const APPROVAL_TIER2_CENTS = 100_000;
export const APPROVAL_TIER3_CENTS = 1_000_000;
