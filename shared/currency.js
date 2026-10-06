/**
 * One money formatter for ProcureFlow (client and server).
 *
 * Amounts are integer minor units (cents). This module only formats them.
 * It does not convert between currencies and it does not rescale storage.
 *
 * Display locale is nl-NL: euro sign, `.` thousands, `,` decimals
 * (`€ 1.295,00`). UI strings stay English until Sprint 6.
 * The space after the symbol is the locale's non-breaking space (U+00A0).
 */

export const CURRENCY_ALLOWLIST = Object.freeze(['EUR', 'USD']);
export const DEFAULT_CURRENCY = 'EUR';
export const DISPLAY_LOCALE = 'nl-NL';

const formatterCache = new Map();

function formatter(locale, currency) {
  const key = `${locale}\0${currency}`;
  let format = formatterCache.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'symbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    formatterCache.set(key, format);
  }
  return format;
}

const groupingCache = new Map();

function groupingFormatter(locale) {
  let format = groupingCache.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale, {
      maximumFractionDigits: 0,
      useGrouping: true
    });
    groupingCache.set(locale, format);
  }
  return format;
}

/**
 * Nearest cent, half away from zero.
 * 1.5 → 2, -1.5 → -2. Non-finite values become 0.
 */
export function roundCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(n));
}

/**
 * Uppercase allowlist match, or null when the value is not a deployment currency.
 * Blank is not valid here — callers treat a missing env var as the default.
 */
export function normalizeCurrencyCode(value) {
  if (value == null) return null;
  const code = String(value).trim().toUpperCase();
  if (!code) return null;
  return CURRENCY_ALLOWLIST.includes(code) ? code : null;
}

/**
 * Format integer cents (or a value rounded to cents) in the deployment currency.
 * @param {number|string|null|undefined} cents
 * @param {{ currency?: string, locale?: string }} [options]
 */
export function formatMoneyAmount(cents, options = {}) {
  const currency = options.currency || DEFAULT_CURRENCY;
  const locale = options.locale || DISPLAY_LOCALE;
  const rounded = roundCents(cents);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  const major = Math.trunc(abs / 100);
  const minor = String(abs % 100).padStart(2, '0');
  const grouped = groupingFormatter(locale).format(major);
  const parts = formatter(locale, currency).formatToParts(negative ? -1 : 1);
  let usedInteger = false;
  let out = '';
  for (const part of parts) {
    if (part.type === 'integer' || part.type === 'group') {
      if (!usedInteger) {
        out += grouped;
        usedInteger = true;
      }
      continue;
    }
    if (part.type === 'fraction') {
      out += minor;
      continue;
    }
    out += part.value;
  }
  return out;
}
