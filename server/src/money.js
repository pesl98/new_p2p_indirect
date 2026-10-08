/**
 * Integer-cent money helpers.
 *
 * Convention: SQLite, API request/response bodies, and all server arithmetic
 * store money as integer cents (minor units of the deployment currency,
 * default EUR). The scale does not change between EUR and USD. Convert at
 * display/input edges only — never mix a major-unit float with cents in the
 * same field. Display goes through formatMoney (shared/currency.js).
 */

import { formatMoneyAmount, roundCents } from '../../shared/currency.js';
import { deploymentCurrency, loadCurrencyConfig } from './currencyConfig.js';

/** Convert a major-unit amount (number or numeric string) to integer cents at an I/O edge. */
export function toCents(dollars) {
  if (dollars == null || dollars === '') return 0;
  const num = typeof dollars === 'number' ? dollars : Number(String(dollars).trim());
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}

/** Convert integer cents to a major-unit number for input edges only. */
export function fromCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return 0;
  return n / 100;
}

/**
 * Format cents in the deployment currency (default EUR, locale nl-NL).
 * Pass `currency` only in tests. Application code uses the env setting.
 */
export function formatMoney(cents, currency = deploymentCurrency()) {
  return formatMoneyAmount(cents, {
    currency,
    locale: loadCurrencyConfig().locale
  });
}

/**
 * Invariant 2-decimal major-unit string (dot decimal, no symbol).
 * Not a currency format. Display and audit text use formatMoney.
 */
export function formatCents(cents) {
  const rounded = roundCents(cents);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  const major = Math.trunc(abs / 100);
  const minor = String(abs % 100).padStart(2, '0');
  return `${sign}${major}.${minor}`;
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

/**
 * Fail-closed parse of an already-cents API field.
 * Rejects missing, boolean, float, and non-integer strings (HTTP 400).
 */
export function requireIntegerCents(value, field = 'amount') {
  const err = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
  };
  if (value === undefined || value === null || value === '') {
    throw err(`${field} is required and must be an integer number of cents.`);
  }
  if (typeof value === 'boolean') {
    throw err(`${field} must be an integer number of cents.`);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw err(`${field} must be an integer number of cents.`);
    }
    return value;
  }
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) {
    throw err(`${field} must be an integer number of cents.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw err(`${field} must be an integer number of cents.`);
  }
  return parsed;
}

/** Existing approval routing thresholds, expressed in cents (1,000 / 10,000 major units). */
export const APPROVAL_TIER2_CENTS = 100_000;
export const APPROVAL_TIER3_CENTS = 1_000_000;

/**
 * Change-order net-increase gate. Increases strictly above this amount
 * require `confirm_increase: true` (not a second approval chain).
 */
export const CHANGE_ORDER_INCREASE_CONFIRM_CENTS = APPROVAL_TIER2_CENTS;
