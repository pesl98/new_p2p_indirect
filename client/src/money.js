/**
 * Integer-cent money helpers for the ProcureFlow client.
 * API money fields are integer cents; convert only at display/input edges.
 */

export function toCents(dollars) {
  if (dollars == null || dollars === '') return 0;
  const num = typeof dollars === 'number' ? dollars : Number(String(dollars).trim());
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}

export function fromCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return 0;
  return n / 100;
}

export function formatMoney(cents) {
  return fromCents(cents).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}
