import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  FileSpreadsheet,
  ShieldAlert,
  XCircle,
  X,
  RotateCcw,
  Eye,
  Banknote
} from 'lucide-react';
import { api } from '../api';
import { formatMoney, toCents } from '../money';
import { lineTypeLabel } from '../lineType';

const DISPOSITIONS = [
  {
    id: 'accept_variance',
    label: 'Accept variance',
    hint: 'Clear the block. Invoice can proceed to Approve for Payment at the billed cents.'
  },
  {
    id: 'short_pay',
    label: 'Short pay',
    hint: 'Clear the block and pay less than billed. Billed total stays on the invoice for audit.'
  },
  {
    id: 'reject_invoice',
    label: 'Reject invoice',
    hint: 'Permanently block approve and pay.'
  },
  {
    id: 'return_to_buyer',
    label: 'Return to buyer',
    hint: 'Park with an audit note. Appears in the requester Buyer Inbox until they respond. Hard exception stays open.'
  }
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
          <XCircle className="w-3.5 h-3.5 mr-1" />Price Discrepancy
        </span>
      );
    case 'quantity_variance':
      return (
        <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-bold inline-flex items-center">
          <XCircle className="w-3.5 h-3.5 mr-1" />Quantity Variance
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
    case 'variance_flagged':
      return <span className="bg-rose-100 text-rose-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">Needs disposition</span>;
    case 'rejected':
      return <span className="bg-slate-800 text-white text-[11px] font-semibold px-2 py-0.5 rounded-full">Rejected</span>;
    case 'matched':
      return <span className="bg-emerald-50 text-emerald-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Cleared for AP</span>;
    default:
      return <span className="bg-slate-100 text-slate-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">{status}</span>;
  }
}

function dispositionLabel(value) {
  if (value === 'buyer_response') return 'buyer response';
  return String(value || '').replace(/_/g, ' ');
}

function billedPayBadge(inv) {
  if (inv?.payable_total_cents == null) return null;
  return (
    <span className="bg-amber-100 text-amber-900 text-[11px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center">
      <Banknote className="w-3 h-3 mr-1" />
      Billed ${formatMoney(inv.total_amount)} → Pay ${formatMoney(inv.payable_total_cents)}
    </span>
  );
}

export default function ExceptionWorkbenchView({ currentUser, onDataChanged, onNavigate, focusId }) {
  const [queue, setQueue] = useState('open');
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [disposition, setDisposition] = useState('accept_variance');
  const [reason, setReason] = useState('');
  const [payableDollars, setPayableDollars] = useState('');
  const [processing, setProcessing] = useState(false);

  const loadQueue = async (nextQueue = queue) => {
    setLoading(true);
    try {
      const rows = await api.getInvoiceExceptions(nextQueue);
      setInvoices(rows);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadQueue(queue);
  }, [queue]);

  const openDetail = async (id) => {
    try {
      const detail = await api.getInvoiceExceptionDetail(id);
      setSelected(detail);
      setDisposition('accept_variance');
      setReason('');
      setPayableDollars('');
    } catch (err) {
      alert(err.message);
    }
  };

  useEffect(() => {
    if (focusId) openDetail(focusId);
  }, [focusId]);

  const handleResolve = async () => {
    if (!selected) return;
    if (!reason.trim()) {
      alert('A disposition reason is required.');
      return;
    }
    const payload = {
      disposition,
      reason: reason.trim(),
      actor_name: currentUser?.name || 'Finance Specialist'
    };
    if (disposition === 'short_pay') {
      const payableCents = toCents(payableDollars);
      if (!Number.isInteger(payableCents) || payableCents < 0 || payableCents >= selected.total_amount) {
        alert('Payable must be ≥ $0.00 and strictly less than the billed total.');
        return;
      }
      if (!window.confirm(
        `Short-pay billed $${formatMoney(selected.total_amount)} at payable $${formatMoney(payableCents)}? Billed total stays on the invoice.`
      )) {
        return;
      }
      payload.payable_total_cents = payableCents;
    }
    setProcessing(true);
    try {
      const result = await api.resolveInvoiceException(selected.id, payload);
      setSelected(result.invoice);
      setReason('');
      setPayableDollars('');
      await loadQueue(queue);
      if (onDataChanged) onDataChanged();
    } catch (err) {
      alert(err.message);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Invoice Exception Workbench</h2>
          <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">
            AP triage for hard dual-match failures (<code className="font-mono">variance_flagged</code>).
            Tolerated matches stay on Invoices &amp; Matching — they are already <code className="font-mono">matched</code> and are not in this queue.
          </p>
        </div>
        <div className="flex items-center bg-slate-100 rounded-lg p-1 text-xs font-semibold">
          {['open', 'resolved', 'all'].map((key) => (
            <button
              key={key}
              onClick={() => setQueue(key)}
              className={`px-3 py-1.5 rounded-md capitalize ${
                queue === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              {key}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">Invoice #</th>
                <th className="py-3 px-4">Supplier</th>
                <th className="py-3 px-4">PO</th>
                <th className="py-3 px-4">Billed</th>
                <th className="py-3 px-4">Match</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Latest disposition</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">Loading exception queue...</td>
                </tr>
              ) : invoices.length === 0 ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">
                    {queue === 'open' ? 'No open hard exceptions. Straight-through invoices stay on Invoices & Matching.' : 'No invoices in this filter.'}
                  </td>
                </tr>
              ) : (
                invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-slate-900">{inv.invoice_number}</td>
                    <td className="py-3 px-4 font-medium text-slate-900">{inv.supplier_name}</td>
                    <td className="py-3 px-4 font-mono text-indigo-700 font-semibold">{inv.po_number}</td>
                    <td className="py-3 px-4 font-bold text-slate-900">
                      <div>${formatMoney(inv.total_amount)}</div>
                      {inv.payable_total_cents != null && (
                        <div className="text-[10px] font-semibold text-amber-800 mt-0.5">
                          Pay ${formatMoney(inv.payable_total_cents)}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4">{matchBadge(inv.match_status)}</td>
                    <td className="py-3 px-4">{statusBadge(inv.status)}</td>
                    <td className="py-3 px-4 text-slate-600 capitalize">
                      {inv.exception ? dispositionLabel(inv.exception.disposition) : '—'}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => openDetail(inv.id)}
                        className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded font-semibold text-[11px] inline-flex items-center space-x-1 shadow-sm"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>Open matrix</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-5xl w-full p-6 shadow-2xl border border-slate-200 max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div>
                <div className="flex items-center space-x-3 flex-wrap gap-y-2">
                  <h3 className="text-lg font-mono font-bold text-slate-900">{selected.invoice_number}</h3>
                  {matchBadge(selected.match_status)}
                  {statusBadge(selected.status)}
                  {billedPayBadge(selected)}
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Vendor: <strong>{selected.supplier_name}</strong> • {selected.po_number}
                  {selected.pr_number ? ` • ${selected.pr_number}` : ''}
                </p>
              </div>
              <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 space-y-5 text-xs overflow-y-auto flex-1">
              <div className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100 border-b border-slate-200 text-slate-700 font-bold uppercase text-[10px]">
                    <tr>
                      <th className="py-2.5 px-3">Item</th>
                      <th className="py-2.5 px-3 text-center">Type</th>
                      <th className="py-2.5 px-3 text-center bg-blue-50/70">PO Qty / Price</th>
                      <th className="py-2.5 px-3 text-center bg-amber-50/70">Receipt basis</th>
                      <th className="py-2.5 px-3 text-center bg-purple-50/70">Invoiced</th>
                      <th className="py-2.5 px-3 text-center">Variance</th>
                      <th className="py-2.5 px-3 text-center">Line result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selected.match_results?.map((res) => (
                      <tr key={res.id} className={res.status === 'fail' ? 'bg-rose-50/40' : ''}>
                        <td className="py-2.5 px-3 font-medium text-slate-900">{res.item_description}</td>
                        <td className="py-2.5 px-3 text-center">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${res.line_type === 'service' ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-700'}`}>
                            {lineTypeLabel(res.line_type || 'goods')}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-center bg-blue-50/30">
                          {res.ordered_qty} @ ${formatMoney(res.po_unit_price)}
                        </td>
                        <td className="py-2.5 px-3 text-center bg-amber-50/30 font-semibold">
                          {res.received_qty} {res.line_type === 'service' ? 'SES' : 'GRN'}
                        </td>
                        <td className="py-2.5 px-3 text-center bg-purple-50/30 font-bold">
                          {res.invoiced_qty} @ ${formatMoney(res.invoice_unit_price)}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          qty {res.qty_variance} · {res.price_variance}¢
                        </td>
                        <td className="py-2.5 px-3 text-center capitalize font-semibold">{res.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selected.match_results?.some((r) => r.status !== 'pass') && (
                <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-rose-900 space-y-2">
                  <div className="font-bold flex items-center space-x-1.5 text-xs">
                    <AlertTriangle className="w-4 h-4 text-rose-600" />
                    <span>Match engine findings</span>
                  </div>
                  <ul className="list-disc list-inside text-[11px] space-y-1">
                    {selected.match_results.filter((r) => r.status !== 'pass').map((r, i) => (
                      <li key={i}>{r.message}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <div className="font-bold text-slate-700 uppercase tracking-wider text-[11px] mb-1">Receipt basis</div>
                  <div className="text-[11px] text-slate-600">
                    GRNs: {selected.receipts?.length
                      ? selected.receipts.map((grn) => `${grn.grn_number} (${grn.received_by_name})`).join(' · ')
                      : 'none'}
                  </div>
                  <div className="text-[11px] text-slate-600 mt-1">
                    SES: {selected.service_entry_sheets?.length
                      ? selected.service_entry_sheets.map((ses) => `${ses.ses_number} (${ses.status})`).join(' · ')
                      : 'none'}
                  </div>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <div className="font-bold text-slate-700 uppercase tracking-wider text-[11px] mb-1">Amounts (integer cents)</div>
                  <div className="text-[11px] text-slate-600">PO ${formatMoney(selected.po_total_amount)} · Billed ${formatMoney(selected.total_amount)}</div>
                  {selected.payable_total_cents != null && (
                    <div className="text-[11px] font-semibold text-amber-900 mt-1">
                      Payable ${formatMoney(selected.payable_total_cents)} (billed total unchanged)
                    </div>
                  )}
                  {selected.exception?.accepted_total_cents != null && (
                    <div className="text-[11px] text-slate-600 mt-1">
                      Last {selected.exception.disposition === 'short_pay' ? 'payable' : 'accepted'} total ${formatMoney(selected.exception.accepted_total_cents)}
                      {selected.exception.billed_total_cents != null
                        ? ` · billed ${formatMoney(selected.exception.billed_total_cents)}`
                        : ''}
                      {selected.exception.accepted_match_status
                        ? ` (${selected.exception.accepted_match_status})`
                        : ''}
                    </div>
                  )}
                </div>
              </div>

              {selected.exception?.disposition === 'buyer_response' && selected.status === 'variance_flagged' && (
                <div className="bg-sky-50 border border-sky-200 rounded-xl p-4 text-sky-950">
                  <div className="font-bold flex items-center space-x-1.5 text-xs">
                    <ClipboardList className="w-4 h-4 text-sky-700" />
                    <span>Buyer responded — ready for AP disposition</span>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed">{selected.exception.reason}</p>
                  <p className="mt-1 text-[10px] text-sky-800">{selected.exception.actor_name}</p>
                </div>
              )}

              {selected.exception_dispositions?.length > 0 && (
                <div>
                  <h4 className="font-bold text-slate-800 uppercase tracking-wider text-[11px] mb-2">Prior dispositions</h4>
                  <div className="space-y-2">
                    {selected.exception_dispositions.map((row) => (
                      <div key={row.id} className="border border-slate-200 rounded-lg p-3 bg-white">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold capitalize text-slate-900">{dispositionLabel(row.disposition)}</span>
                          <span className="text-slate-400">{row.created_at}</span>
                        </div>
                        <div className="text-slate-600 mt-1">{row.reason}</div>
                        <div className="text-slate-500 mt-1">
                          {row.actor_name}
                          {row.disposition === 'short_pay'
                            ? ` · billed $${formatMoney(row.billed_total_cents ?? selected.total_amount)} → pay $${formatMoney(row.accepted_total_cents)}`
                            : row.disposition === 'buyer_response' || row.disposition === 'return_to_buyer'
                              ? ''
                              : ` · accepted $${formatMoney(row.accepted_total_cents)}`}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selected.audit_logs?.length > 0 && (
                <div>
                  <h4 className="font-bold text-slate-800 uppercase tracking-wider text-[11px] mb-2">Invoice audit</h4>
                  <ul className="space-y-1.5">
                    {selected.audit_logs.map((log) => (
                      <li key={log.id} className="text-[11px] text-slate-600">
                        <span className="font-mono font-semibold text-slate-800">{log.action}</span>
                        {' · '}{log.actor_name}{' · '}{log.details}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {selected.status === 'variance_flagged' && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                  <div className="font-bold text-slate-800 flex items-center space-x-2">
                    <ClipboardList className="w-4 h-4" />
                    <span>Take disposition</span>
                    <span className="font-normal text-slate-500">as {currentUser?.name || 'current persona'}</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {DISPOSITIONS.map((option) => (
                      <label
                        key={option.id}
                        className={`border rounded-lg p-3 cursor-pointer ${
                          disposition === option.id ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 bg-white'
                        }`}
                      >
                        <input
                          type="radio"
                          className="mr-2"
                          checked={disposition === option.id}
                          onChange={() => setDisposition(option.id)}
                        />
                        <span className="font-semibold text-slate-900">{option.label}</span>
                        <p className="text-[11px] text-slate-500 mt-1">{option.hint}</p>
                      </label>
                    ))}
                  </div>
                  {disposition === 'short_pay' && (
                    <div className="bg-white border border-amber-200 rounded-lg p-3 space-y-2">
                      <div className="text-[11px] text-slate-600">
                        Billed total <strong className="text-slate-900">${formatMoney(selected.total_amount)}</strong>
                        {' · '}Match {selected.match_status?.replace(/_/g, ' ')} (not rematched)
                      </div>
                      <label className="block text-slate-700 font-bold text-[11px]">
                        Payable amount (dollars) — must be ≥ 0 and less than billed
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={payableDollars}
                        onChange={(e) => setPayableDollars(e.target.value)}
                        placeholder="e.g. 1498.00 for 2 × $749 PO/GRN"
                        className="w-full p-2 border border-slate-300 rounded-lg text-xs font-mono"
                      />
                      {payableDollars !== '' && (
                        <div className="text-[11px] text-amber-900 font-semibold">
                          Billed ${formatMoney(selected.total_amount)} → Pay ${formatMoney(toCents(payableDollars))}
                        </div>
                      )}
                    </div>
                  )}
                  <div>
                    <label className="block text-slate-700 font-bold text-[11px] mb-1">Reason (required)</label>
                    <textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      rows={3}
                      placeholder="Why is AP accepting, short-paying, rejecting, or returning this invoice?"
                      className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-4 border-t border-slate-200">
              <button
                onClick={() => onNavigate?.('invoices', { focusId: selected.id })}
                className="text-xs font-semibold text-indigo-700 hover:text-indigo-900 inline-flex items-center space-x-1"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span>Open on Invoices & Matching</span>
              </button>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setSelected(null)}
                  className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold"
                >
                  Close
                </button>
                {selected.status === 'variance_flagged' && (
                  <button
                    disabled={processing}
                    onClick={handleResolve}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold inline-flex items-center space-x-1.5"
                  >
                    {disposition === 'return_to_buyer' ? <RotateCcw className="w-4 h-4" /> : disposition === 'short_pay' ? <Banknote className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                    <span>{disposition === 'short_pay' ? 'Confirm short pay' : 'Record disposition'}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
