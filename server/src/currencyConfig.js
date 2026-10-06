/**
 * Per-deployment currency. One code for the whole install (one customer,
 * one database). Unset or blank is EUR. Any other value that is not on the
 * allowlist refuses to boot — it does not silently format as EUR, and it
 * does not convert stored cents.
 */

import {
  CURRENCY_ALLOWLIST,
  DEFAULT_CURRENCY,
  DISPLAY_LOCALE,
  normalizeCurrencyCode
} from '../../shared/currency.js';

export { CURRENCY_ALLOWLIST, DEFAULT_CURRENCY, DISPLAY_LOCALE };

export class CurrencyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CurrencyConfigError';
    this.code = 'currency_misconfigured';
    this.statusCode = 503;
  }
}

export function loadCurrencyConfig(env = process.env) {
  const raw = env?.CURRENCY;
  if (raw == null || String(raw).trim() === '') {
    return { currency: DEFAULT_CURRENCY, locale: DISPLAY_LOCALE };
  }
  const currency = normalizeCurrencyCode(raw);
  if (!currency) {
    throw new CurrencyConfigError(
      `CURRENCY must be one of ${CURRENCY_ALLOWLIST.join(', ')} ` +
      `(received ${JSON.stringify(String(raw).trim())}). ` +
      `Leave it unset to use ${DEFAULT_CURRENCY}. ` +
      `Stored amounts stay integer cents; this setting does not convert them.`
    );
  }
  return { currency, locale: DISPLAY_LOCALE };
}

export function deploymentCurrency(env = process.env) {
  return loadCurrencyConfig(env).currency;
}

/** Attach the deployment currency without removing existing fields. */
export function withDeploymentCurrency(data, env = process.env) {
  const currency = deploymentCurrency(env);
  if (data && Object.prototype.hasOwnProperty.call(data, 'currency') && data.currency) {
    return data;
  }
  return { ...(data || {}), currency };
}
