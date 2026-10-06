/**
 * Integer-cent money helpers for the ProcureFlow client.
 * API money fields are integer cents; convert only at display/input edges.
 * Display goes through the shared formatter (default EUR, locale nl-NL).
 * Numeric inputs stay dot-decimal major units; Dutch input parsing is Sprint 6.
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

export function toCents(amount) {
  if (amount == null || amount === '') return 0;
  const num = typeof amount === 'number' ? amount : Number(String(amount).trim());
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}

export function fromCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return 0;
  return n / 100;
}

export function formatMoney(cents) {
  return formatMoneyAmount(cents, { currency: displayCurrency });
}
