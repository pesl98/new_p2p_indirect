/**
 * Fiscal year used for budget lookups. Defaults to the current UTC calendar
 * year; set FISCAL_YEAR to pin another year (must match budgets.fiscal_year).
 */
export function currentFiscalYear(env = process.env, now = new Date()) {
  const pinned = Number(String(env?.FISCAL_YEAR || '').trim());
  if (Number.isInteger(pinned) && pinned >= 2000 && pinned <= 2200) return pinned;
  return now.getUTCFullYear();
}
