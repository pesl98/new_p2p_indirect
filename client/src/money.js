/**
 * Integer-cent money helpers for the ProcureFlow client.
 * API money fields are integer cents; convert only at display/input edges.
 * Display goes through the shared formatter (default EUR, locale nl-NL).
 * Amount inputs accept nl-NL major units: comma decimal, dot thousands.
 * Stored values stay integer cents. formatMoney is unchanged.
 */

import {
  DEFAULT_CURRENCY,
  formatMoneyAmount,
  normalizeCurrencyCode
} from '../../shared/currency.js';

let displayCurrency = DEFAULT_CURRENCY;

/** Fail closed to EUR when the server omits a code or sends one off the allowlist. */
export function setDisplayCurrency(code) {
  displayCurrency = normalizeCurrencyCode(code) || DEFAULT_CURRENCY;
}

export function getDisplayCurrency() {
  return displayCurrency;
}

function stripAmountNoise(raw) {
  return String(raw)
    .trim()
    .replace(/[\s\u00A0\u202f]/g, '')
    .replace(/€/g, '')
    .replace(/eur/ig, '');
}

/**
 * Parse a major-unit amount typed for nl-NL.
 * Comma is the decimal separator. Dot is the thousands separator
 * (`1.295,50`). A single dot with 1–2 fractional digits is still accepted
 * (`749.00`) so a pasted dot-decimal does not become zero. A single dot
 * with exactly three fractional digits is thousands (`1.295` → 1295),
 * except when the whole part is 0 (`0.500` stays a decimal).
 * Returns null when the text is empty or not an amount.
 * @param {number|string|null|undefined} input
 * @returns {number|null}
 */
export function parseMajorAmount(input) {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;

  let s = stripAmountNoise(input);
  if (!s) return null;

  let negative = false;
  if (s[0] === '-') {
    negative = true;
    s = s.slice(1);
  } else if (s[0] === '+') {
    s = s.slice(1);
  }
  if (!s) return null;

  const commaCount = (s.match(/,/g) || []).length;
  const dotCount = (s.match(/\./g) || []).length;
  if (commaCount > 1) return null;

  let normalized;
  if (commaCount === 1) {
    const [whole, frac] = s.split(',');
    if (frac.includes('.')) return null;
    if (whole.includes('.') && !/^\d{1,3}(\.\d{3})*(?![\s\S])/.test(whole)) return null;
    const wholeDigits = whole.replace(/\./g, '');
    if (!/^\d+(?![\s\S])/.test(wholeDigits) || !/^\d*(?![\s\S])/.test(frac)) return null;
    normalized = frac === '' ? wholeDigits : `${wholeDigits}.${frac}`;
  } else if (dotCount === 0) {
    if (!/^\d+(?![\s\S])/.test(s)) return null;
    normalized = s;
  } else if (dotCount === 1) {
    const [whole, frac] = s.split('.');
    if (!/^\d+(?![\s\S])/.test(whole) || !/^\d+(?![\s\S])/.test(frac)) return null;
    if (frac.length === 3 && whole !== '0') {
      normalized = whole + frac;
    } else {
      normalized = `${whole}.${frac}`;
    }
  } else if (/^\d{1,3}(\.\d{3})+(?![\s\S])/.test(s)) {
    normalized = s.replace(/\./g, '');
  } else {
    return null;
  }

  const num = Number(normalized);
  if (!Number.isFinite(num)) return null;
  return negative ? -num : num;
}

/** Major units → integer cents. Empty or unparseable text is 0, matching the previous edge. */
export function toCents(amount) {
  if (amount == null || amount === '') return 0;
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) return 0;
    return Math.round(amount * 100);
  }
  const parsed = parseMajorAmount(amount);
  if (parsed == null) return 0;
  return Math.round(parsed * 100);
}

export function fromCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return 0;
  return n / 100;
}

/** Editable nl-NL major-unit string (`1.295,50`) for amount fields. */
export function formatMajorInput(cents) {
  const n = Math.round(Number(cents));
  if (!Number.isFinite(n)) return '';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const major = Math.trunc(abs / 100);
  const minor = String(abs % 100).padStart(2, '0');
  const grouped = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${grouped},${minor}`;
}

export const moneyInputProps = {
  type: 'text',
  inputMode: 'decimal',
  autoComplete: 'off',
  lang: 'nl-NL',
  spellCheck: false
};

export function formatMoney(cents) {
  return formatMoneyAmount(cents, { currency: displayCurrency });
}
