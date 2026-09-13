import { asCents } from './money.js';
import { invoicePayableCents } from './invoiceExceptionsService.js';
import {
  AGING_BUCKETS,
  ApAgingError,
  DEFAULT_DUE_SOON_DAYS,
  OPEN_PAYABLE_STATUS,
  PAID_STATUS,
  READY_TO_APPROVE_STATUS,
  agingDayCounts,
  classifyAgingBucket,
  parseAgingBucket,
  parseDueSoonDays,
  parseUtcYmd,
  utcTodayYmd
} from './apAging.js';

export {
  AGING_BUCKETS,
  ApAgingError,
  DEFAULT_DUE_SOON_DAYS,
  OPEN_PAYABLE_STATUS,
  PAID_STATUS,
  READY_TO_APPROVE_STATUS,
  classifyAgingBucket,
  parseAgingBucket,
  parseDueSoonDays,
  utcTodayYmd
};

const LIST_SQL = `
  SELECT
    inv.id,
    inv.invoice_number,
    inv.invoice_date,
    inv.due_date,
    inv.total_amount,
    inv.payable_total_cents,
    inv.status,
    inv.match_status,
    inv.payment_reference,
    inv.notes,
    inv.created_at,
    po.id as po_id,
    po.po_number,
    s.id as supplier_id,
    s.name as supplier_name,
    s.code as supplier_code,
    pr.id as requisition_id,
    pr.pr_number,
    u.id as requester_id,
    u.name as requester_name
  FROM invoices inv
  JOIN purchase_orders po ON inv.po_id = po.id
  JOIN suppliers s ON inv.supplier_id = s.id
  LEFT JOIN purchase_requisitions pr ON po.requisition_id = pr.id
  LEFT JOIN users u ON pr.requester_id = u.id
  WHERE inv.status = ?
  ORDER BY inv.due_date ASC, inv.id ASC
`;

function attachAgingFields(row, { today, days }) {
  const billed = asCents(row.total_amount);
  const payableStored = row.payable_total_cents == null || row.payable_total_cents === ''
    ? null
    : asCents(row.payable_total_cents);
  const dayCounts = agingDayCounts(row.due_date, { today });
  return {
    ...row,
    billed_total_cents: billed,
    payable_total_cents: payableStored,
    effective_payable_cents: invoicePayableCents(row),
    has_short_pay: payableStored != null,
    aging_bucket: classifyAgingBucket(row.due_date, { today, days }),
    days_past_due: dayCounts.days_past_due,
    days_until_due: dayCounts.days_until_due,
    as_of: today
  };
}

function sortPayableRows(rows) {
  const rank = { overdue: 0, due_soon: 1, later: 2 };
  return [...rows].sort((a, b) => {
    const ra = rank[a.aging_bucket] ?? 9;
    const rb = rank[b.aging_bucket] ?? 9;
    if (ra !== rb) return ra - rb;
    if (a.aging_bucket === 'overdue') {
      return (b.days_past_due || 0) - (a.days_past_due || 0) || a.id - b.id;
    }
    return (a.days_until_due || 0) - (b.days_until_due || 0) || a.id - b.id;
  });
}

function emptyCounts() {
  return {
    overdue: 0,
    due_soon: 0,
    later: 0,
    open_payable: 0,
    paid: 0,
    ready_to_approve: 0
  };
}

/**
 * Payables / AP aging queue.
 *
 * Default (`bucket=all`): invoices in `approved_for_payment` only.
 * Matched-but-not-approved invoices are a separate optional `ready_to_approve`
 * section (not the pay queue). Paid rows are opt-in via `bucket=paid`.
 *
 * Mark-paid is the existing `POST /api/invoices/:id/mark-paid` — this service
 * does not invent a second payment path.
 */
export async function listApAging(db, {
  bucket: rawBucket,
  days: rawDays,
  today: rawToday
} = {}) {
  const bucket = parseAgingBucket(rawBucket);
  const days = parseDueSoonDays(rawDays);
  const today = parseUtcYmd(rawToday) || utcTodayYmd();

  const [openRows, matchedRows, paidRows] = await Promise.all([
    db.prepare(LIST_SQL).all(OPEN_PAYABLE_STATUS),
    db.prepare(LIST_SQL).all(READY_TO_APPROVE_STATUS),
    db.prepare(LIST_SQL).all(PAID_STATUS)
  ]);

  const open = sortPayableRows(openRows.map((row) => attachAgingFields(row, { today, days })));
  const readyToApprove = matchedRows.map((row) => attachAgingFields(row, { today, days }));
  const paid = paidRows.map((row) => attachAgingFields(row, { today, days }));

  const counts = emptyCounts();
  for (const row of open) {
    counts.open_payable += 1;
    if (AGING_BUCKETS.includes(row.aging_bucket)) counts[row.aging_bucket] += 1;
  }
  counts.paid = paid.length;
  counts.ready_to_approve = readyToApprove.length;

  let invoices;
  if (bucket === 'all') invoices = open;
  else if (bucket === 'overdue' || bucket === 'due_soon' || bucket === 'later') {
    invoices = open.filter((row) => row.aging_bucket === bucket);
  } else if (bucket === 'paid') invoices = paid;
  else invoices = readyToApprove;

  return {
    as_of: today,
    date_basis: 'utc_calendar_date',
    days,
    bucket,
    counts,
    invoices,
    ready_to_approve: readyToApprove
  };
}
