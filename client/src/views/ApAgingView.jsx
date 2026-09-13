import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CreditCard,
  FileSpreadsheet,
  GitBranch,
  ShieldAlert,
  Wallet,
  X
} from 'lucide-react';
import { api } from '../api';
import { formatMoney } from '../money';

const BUCKET_CHIPS = [
  { id: 'all', label: 'Open payable' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'due_soon', label: 'Due soon' },
  { id: 'later', label: 'Later' },
  { id: 'ready_to_approve', label: 'Ready to approve' },
  { id: 'paid', label: 'Recently paid' }
];

function matchBadge(matchStatus) {
  switch (matchStatus) {
    case 'perfect_match':
      return (
        <span className="bg-emerald-100 text-emerald-800 text-xs px-2.5 py-1 rounded-full font-bold inline-flex items-center">
          <CheckCircle2 className="w-3.5 h-3.5 mr-1" />Exact Match
        </span>
      );
    case 'tolerated_match':
      return (
        <span className="bg-amber-100 text-amber-800 text-xs px-2.5 py-1 rounded-full font-bold inline-flex items-center">
          <AlertTriangle className="w-3.5 h-3.5 mr-1" />Tolerated Variance
        </span>
      );
    case 'price_variance':
      return (
        <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-bold inline-flex items-center">
          Price variance
        </span>
      );
    case 'quantity_variance':
      return (
        <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-bold inline-flex items-center">
          Quantity variance
        </span>
      );
    case 'total_variance':
      return (
        <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-bold inline-flex items-center">
          <ShieldAlert className="w-3.5 h-3.5 mr-1" />Multiple Variances
        </span>
      );
    default:
      return <span className="bg-slate-100 text-slate-700 text-xs px-2 py-0.5 rounded">{matchStatus}</span>;
  }
}

function statusBadge(status) {
  switch (status) {
    case 'approved_for_payment':
      return <span className="bg-indigo-100 text-indigo-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Approved for Payment</span>;
    case 'paid':
      return <span className="bg-emerald-100 text-emerald-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Paid</span>;
    case 'matched':
      return <span className="bg-emerald-50 text-emerald-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Ready to approve</span>;
    default:
      return <span className="bg-slate-100 text-slate-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">{status}</span>;
  }
}

function agingBadge(row) {
  if (row.aging_bucket === 'overdue') {
    return (
      <span className="bg-rose-100 text-rose-800 text-[11px] font-bold px-2 py-0.5 rounded-full">
        {row.days_past_due}d overdue
      </span>
    );
  }
  if (row.aging_bucket === 'due_soon') {
    return (
      <span className="bg-amber-100 text-amber-900 text-[11px] font-bold px-2 py-0.5 rounded-full">
        {row.days_until_due === 0 ? 'Due today' : `Due in ${row.days_until_due}d`}
      </span>
    );
  }
  if (row.aging_bucket === 'later') {
    return (
      <span className="bg-slate-100 text-slate-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">
        Due in {row.days_until_due}d
      </span>
    );
  }
  return null;
}

export default function ApAgingView({ currentUser, onDataChanged, onNavigate, focusId }) {
  const [bucket, setBucket] = useState('all');
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(null);
  const [paymentReference, setPaymentReference] = useState('');
  const [processing, setProcessing] = useState(false);

  const loadQueue = async (nextBucket = bucket) => {
    setLoading(true);
    try {
      const data = await api.getApAging({ bucket: nextBucket, days: 7 });
      setPayload(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadQueue();
  }, []);

  useEffect(() => {
    if (!focusId || !payload?.invoices) return;
    const row = payload.invoices.find((inv) => inv.id === focusId)
      || payload.ready_to_approve?.find((inv) => inv.id === focusId);
    if (row) openPay(row);
  }, [focusId]);

  const counts = payload?.counts || {};
  const invoices = payload?.invoices || [];

  const chipCount = (id) => {
    if (id === 'all') return counts.open_payable ?? 0;
    if (id === 'ready_to_approve') return counts.ready_to_approve ?? 0;
    if (id === 'paid') return counts.paid ?? 0;
    return counts[id] ?? 0;
  };

  const openPay = (row) => {
    setPaying(row);
    setPaymentReference(`ACH-PAY-${Math.floor(100000 + Math.random() * 900000)}`);
  };

  const handleMarkPaid = async () => {
    if (!paying) return;
    if (!paymentReference.trim()) {
      alert('A payment reference is required.');
      return;
    }
    setProcessing(true);
    try {
      await api.markInvoicePaid(paying.id, {
        payment_reference: paymentReference.trim(),
        payer_name: currentUser?.name || 'David Miller',
        actor_name: currentUser?.name || 'David Miller'
      });
      setPaying(null);
      await loadQueue();
      if (onDataChanged) onDataChanged();
    } catch (err) {
      alert(err.message);
    } finally {
      setProcessing(false);
    }
  };

  const subtitle = useMemo(() => {
    const asOf = payload?.as_of ? `As of ${payload.as_of} UTC` : 'UTC calendar date';
    return `${asOf}. Due soon = due today through +${payload?.days ?? 7} days. Pay queue is approved-for-payment only.`;
  }, [payload]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">AP Aging / Payables</h2>
          <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">{subtitle}</p>
        </div>
        <div className="text-[11px] font-semibold text-slate-500 bg-slate-100 rounded-lg px-3 py-1.5 inline-flex items-center space-x-1.5">
          <CalendarClock className="w-3.5 h-3.5" />
          <span>{counts.open_payable || 0} open payable</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {BUCKET_CHIPS.map((chip) => {
          const active = bucket === chip.id;
          return (
            <button
              key={chip.id}
              onClick={() => {
                setBucket(chip.id);
                loadQueue(chip.id);
              }}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${
                active
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
              }`}
            >
              {chip.label}
              <span className={`ml-1.5 ${active ? 'text-slate-200' : 'text-slate-400'}`}>
                {chipCount(chip.id)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">Invoice #</th>
                <th className="py-3 px-4">Supplier</th>
                <th className="py-3 px-4">PO / Requester</th>
                <th className="py-3 px-4">Dates</th>
                <th className="py-3 px-4">Billed / Payable</th>
                <th className="py-3 px-4">Aging</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">Loading payables queue...</td>
                </tr>
              ) : invoices.length === 0 ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">
                    {bucket === 'ready_to_approve'
                      ? 'No matched invoices waiting to approve. Approve from Invoices & Matching.'
                      : bucket === 'paid'
                        ? 'No paid invoices with due-date context.'
                        : 'No approved invoices in this aging bucket.'}
                  </td>
                </tr>
              ) : (
                invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-slate-900">{inv.invoice_number}</td>
                    <td className="py-3 px-4 font-medium text-slate-900">{inv.supplier_name}</td>
                    <td className="py-3 px-4">
                      <div className="font-mono text-indigo-700 font-semibold">{inv.po_number}</div>
                      {inv.pr_number && (
                        <div className="text-[10px] text-slate-500 mt-0.5">
                          {inv.pr_number}
                          {inv.requester_name ? ` · ${inv.requester_name}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-500">
                      <div>Inv {inv.invoice_date}</div>
                      <div className="font-semibold text-slate-700">Due {inv.due_date}</div>
                    </td>
                    <td className="py-3 px-4 font-bold text-slate-900">
                      <div>${formatMoney(inv.total_amount)}</div>
                      {inv.payable_total_cents != null && (
                        <div className="text-[10px] font-semibold text-amber-800 mt-0.5">
                          Pay ${formatMoney(inv.payable_total_cents)}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4">{agingBadge(inv)}</td>
                    <td className="py-3 px-4 space-y-1">
                      {statusBadge(inv.status)}
                      <div>{matchBadge(inv.match_status)}</div>
                    </td>
                    <td className="py-3 px-4 text-right space-x-1 whitespace-nowrap">
                      <button
                        onClick={() => onNavigate?.('invoices', { focusId: inv.id })}
                        className="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded font-semibold text-[11px] inline-flex items-center space-x-1"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        <span>Invoice</span>
                      </button>
                      {(inv.pr_number || inv.po_number) && (
                        <button
                          onClick={() => onNavigate?.('document_trail', { q: inv.pr_number || inv.po_number })}
                          className="px-2 py-1 border border-slate-300 text-slate-700 rounded font-semibold text-[11px] inline-flex items-center space-x-1"
                        >
                          <GitBranch className="w-3.5 h-3.5" />
                          <span>Trail</span>
                        </button>
                      )}
                      {inv.status === 'matched' && (
                        <button
                          onClick={() => onNavigate?.('invoices', { focusId: inv.id })}
                          className="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-semibold text-[11px]"
                        >
                          Approve
                        </button>
                      )}
                      {inv.status === 'approved_for_payment' && (
                        <button
                          onClick={() => openPay(inv)}
                          className="px-2 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-semibold text-[11px] inline-flex items-center space-x-1"
                        >
                          <CreditCard className="w-3.5 h-3.5" />
                          <span>Mark paid</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {paying && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div>
                <h3 className="text-base font-bold text-slate-900">Mark paid</h3>
                <p className="text-xs text-slate-500 mt-0.5 font-mono">{paying.invoice_number}</p>
              </div>
              <button onClick={() => setPaying(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="py-4 space-y-3 text-xs">
              <p className="text-slate-600">
                Uses the same mark-paid API as Invoices & Matching. Invoice must already be
                <code className="mx-1 font-mono">approved_for_payment</code>.
              </p>
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                <div className="text-slate-500">Billed</div>
                <div className="font-bold text-slate-900 text-sm">${formatMoney(paying.total_amount)}</div>
                {paying.payable_total_cents != null && (
                  <div className="text-amber-800 font-semibold mt-1">
                    Pay ${formatMoney(paying.payable_total_cents)} (short pay)
                  </div>
                )}
              </div>
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Payment reference</label>
                <input
                  type="text"
                  value={paymentReference}
                  onChange={(e) => setPaymentReference(e.target.value)}
                  className="w-full p-2.5 border border-slate-300 rounded-lg text-xs font-mono font-bold"
                />
              </div>
            </div>
            <div className="flex justify-end space-x-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setPaying(null)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                disabled={processing}
                onClick={handleMarkPaid}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold inline-flex items-center space-x-1.5"
              >
                <Wallet className="w-4 h-4" />
                <span>{processing ? 'Posting…' : 'Confirm payment'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
