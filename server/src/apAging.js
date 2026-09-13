/**
 * AP Payment Aging — bucket classification.
 *
 * Basis: UTC calendar date (`YYYY-MM-DD`) of `due_date` vs `today` (UTC).
 * Time-of-day is ignored. Default due-soon window is 7 calendar days inclusive.
 *
 *   overdue   — due_date < today
 *   due_soon  — today <= due_date <= today + N days
 *   later     — due_date > today + N days
 */

export const DEFAULT_DUE_SOON_DAYS = 7;
export const OPEN_PAYABLE_STATUS = 'approved_for_payment';
export const READY_TO_APPROVE_STATUS = 'matched';
export const PAID_STATUS = 'paid';

export const AGING_BUCKETS = Object.freeze(['overdue', 'due_soon', 'later']);
export const LIST_BUCKETS = Object.freeze([
  'overdue',
  'due_soon',
  'later',
  'all',
  'paid',
  'ready_to_approve'
]);

export class ApAgingError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ApAgingError';
    this.statusCode = statusCode;
  }
}

export function utcTodayYmd(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function parseUtcYmd(value) {
  const ymd = String(value ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return ymd;
}

/** Whole UTC calendar days from `fromYmd` to `toYmd` (to − from). */
export function calendarDaysUtc(fromYmd, toYmd) {
  const from = parseUtcYmd(fromYmd);
  const to = parseUtcYmd(toYmd);
  if (!from || !to) return null;
  const fromMs = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10))
  );
  const toMs = Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10))
  );
  return Math.round((toMs - fromMs) / 86400000);
}

export function classifyAgingBucket(dueDate, { today, days = DEFAULT_DUE_SOON_DAYS } = {}) {
  const due = parseUtcYmd(dueDate);
  const asOf = parseUtcYmd(today) || utcTodayYmd();
  if (!due) return null;
  const until = calendarDaysUtc(asOf, due);
  if (until == null) return null;
  if (until < 0) return 'overdue';
  if (until <= days) return 'due_soon';
  return 'later';
}

export function agingDayCounts(dueDate, { today } = {}) {
  const due = parseUtcYmd(dueDate);
  const asOf = parseUtcYmd(today) || utcTodayYmd();
  if (!due) return { days_past_due: null, days_until_due: null };
  const until = calendarDaysUtc(asOf, due);
  if (until == null) return { days_past_due: null, days_until_due: null };
  if (until < 0) return { days_past_due: -until, days_until_due: 0 };
  return { days_past_due: 0, days_until_due: until };
}

export function parseDueSoonDays(raw) {
  if (raw == null || raw === '') return DEFAULT_DUE_SOON_DAYS;
  if (typeof raw === 'boolean') {
    throw new ApAgingError('days must be an integer ≥ 0.');
  }
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new ApAgingError('days must be an integer ≥ 0.');
  }
  return Number(text);
}

export function parseAgingBucket(raw) {
  const bucket = raw == null || raw === '' ? 'all' : String(raw);
  if (!LIST_BUCKETS.includes(bucket)) {
    throw new ApAgingError(`bucket must be ${LIST_BUCKETS.join('|')}.`);
  }
  return bucket;
}
