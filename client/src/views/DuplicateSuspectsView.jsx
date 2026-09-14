import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Copy,
  FileSpreadsheet,
  GitBranch,
  X
} from 'lucide-react';
import { api } from '../api';
import { formatMoney } from '../money';

const DISPOSITIONS = [
  {
    id: 'confirm_unique',
    label: 'Confirm unique',
    hint: 'Clear the hold. Invoice may proceed to Approve for Payment if it is matched and any hard exception is resolved.'
  },
  {
    id: 'confirm_duplicate',
    label: 'Confirm duplicate',
    hint: 'Void this invoice (status → rejected). The candidate original is unchanged. Approve and pay stay blocked.'
  }
];

function matchRuleLabel(rule) {
  switch (rule) {
    case 'same_amount_near_date':
      return 'Same billed amount + invoice date within ±7 UTC days';
    case 'same_po_same_amount':
      return 'Same PO + same billed amount';
    case 'both':
      return 'Same amount + near date, and same PO + amount';
    default:
      return rule;
  }
}

function duplicateBadge(status) {
  switch (status) {
    case 'suspect':
      return <span className="bg-amber-100 text-amber-900 text-[11px] font-bold px-2 py-0.5 rounded-full">Duplicate suspect</span>;
    case 'confirmed_unique':
      return <span className="bg-emerald-100 text-emerald-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Confirmed unique</span>;
    case 'confirmed_duplicate':
      return <span className="bg-slate-800 text-white text-[11px] font-semibold px-2 py-0.5 rounded-full">Confirmed duplicate</span>;
    default:
      return <span className="bg-slate-100 text-slate-600 text-[11px] font-semibold px-2 py-0.5 rounded-full">Clear</span>;
  }
}

function statusBadge(status) {
  switch (status) {
    case 'approved_for_payment':
      return <span className="bg-indigo-100 text-indigo-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Approved for Payment</span>;
    case 'paid':
      return <span className="bg-emerald-100 text-emerald-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Paid</span>;
    case 'matched':
      return <span className="bg-emerald-50 text-emerald-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Matched</span>;
    case 'rejected':
      return <span className="bg-slate-800 text-white text-[11px] font-semibold px-2 py-0.5 rounded-full">Rejected</span>;
    case 'variance_flagged':
      return <span className="bg-rose-100 text-rose-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">Hard exception</span>;
    default:
      return <span className="bg-slate-100 text-slate-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">{status}</span>;
  }
}

function InvoiceCard({ title, invoice, highlight }) {
  if (!invoice) return null;
  return (
    <div className={`rounded-xl border p-3.5 space-y-2 ${highlight ? 'border-amber-300 bg-amber-50/60' : 'border-slate-200 bg-slate-50'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="font-bold text-slate-900 text-xs">{title}</div>
        {duplicateBadge(invoice.duplicate_status)}
      </div>
      <div className="font-mono font-bold text-slate-900">{invoice.invoice_number}</div>
      <div className="text-[11px] text-slate-600 space-y-0.5">
        <div>{invoice.supplier_name}</div>
        <div className="font-mono text-indigo-700 font-semibold">{invoice.po_number}</div>
        <div>Invoice date {invoice.invoice_date}</div>
        <div className="font-bold text-slate-900 text-sm">${formatMoney(invoice.total_amount)}</div>
        <div>{statusBadge(invoice.status)}</div>
      </div>
    </div>
  );
}

export default function DuplicateSuspectsView({ currentUser, onDataChanged, onNavigate, focusId }) {
  const [queue, setQueue] = useState('open');
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [disposition, setDisposition] = useState('confirm_unique');
  const [reason, setReason] = useState('');
  const [processing, setProcessing] = useState(false);

  const loadQueue = async (nextQueue = queue) => {
    setLoading(true);
    try {
      const rows = await api.getInvoiceDuplicates(nextQueue);
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
      const detail = await api.getInvoiceDuplicateDetail(id);
      setSelected(detail);
      setDisposition('confirm_unique');
      setReason('');
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
      alert('A resolution reason is required.');
      return;
    }
    if (disposition === 'confirm_duplicate' && !window.confirm(
      `Confirm ${selected.invoice_number} as a duplicate? This rejects/voids the invoice. The candidate original is unchanged.`
    )) {
      return;
    }
    setProcessing(true);
    try {
      const result = await api.resolveInvoiceDuplicate(selected.id, {
        disposition,
        reason: reason.trim(),
        actor_name: currentUser?.name || 'David Miller'
      });
      setSelected(result.invoice);
      setReason('');
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
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Duplicate Suspects</h2>
          <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">
            AP soft-hold for likely duplicates (same supplier + billed cents + dates within ±7 UTC days, or same PO + billed cents).
            Exact invoice-number reuse is still a hard uniqueness fail. Dual match is unchanged — this is a separate control.
          </p>
        </div>
        <div className="text-[11px] font-semibold text-slate-500 bg-amber-50 text-amber-900 border border-amber-200 rounded-lg px-3 py-1.5 inline-flex items-center space-x-1.5">
          <Copy className="w-3.5 h-3.5" />
          <span>{queue === 'open' ? invoices.length : invoices.filter((row) => row.duplicate_status === 'suspect').length} open suspects</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          { id: 'open', label: 'Open suspects' },
          { id: 'resolved', label: 'Resolved' },
          { id: 'all', label: 'All' }
        ].map((chip) => {
          const active = queue === chip.id;
          return (
            <button
              key={chip.id}
              onClick={() => setQueue(chip.id)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${
                active
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
              }`}
            >
              {chip.label}
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
                <th className="py-3 px-4">PO</th>
                <th className="py-3 px-4">Date / Amount</th>
                <th className="py-3 px-4">Candidate</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="7" className="py-8 text-center text-slate-400">Loading duplicate suspects...</td>
                </tr>
              ) : invoices.length === 0 ? (
                <tr>
                  <td colSpan="7" className="py-8 text-center text-slate-400">
                    {queue === 'open' ? 'No open likely-duplicate holds.' : 'No resolved duplicate dispositions.'}
                  </td>
                </tr>
              ) : (
                invoices.map((inv) => {
                  const candidate = inv.duplicate_suspects?.[0];
                  return (
                    <tr key={inv.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-3 px-4 font-mono font-bold text-slate-900">{inv.invoice_number}</td>
                      <td className="py-3 px-4 font-medium text-slate-900">{inv.supplier_name}</td>
                      <td className="py-3 px-4 font-mono text-indigo-700 font-semibold">{inv.po_number}</td>
                      <td className="py-3 px-4">
                        <div className="text-slate-500">{inv.invoice_date}</div>
                        <div className="font-bold text-slate-900">${formatMoney(inv.total_amount)}</div>
                      </td>
                      <td className="py-3 px-4">
                        {candidate ? (
                          <div>
                            <div className="font-mono font-semibold text-slate-800">{candidate.invoice_number}</div>
                            <div className="text-[10px] text-slate-500 mt-0.5">{matchRuleLabel(candidate.match_rule)}</div>
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4 space-y-1">
                        {duplicateBadge(inv.duplicate_status)}
                        <div>{statusBadge(inv.status)}</div>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap space-x-1">
                        <button
                          onClick={() => openDetail(inv.id)}
                          className="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded font-semibold text-[11px]"
                        >
                          Review
                        </button>
                        <button
                          onClick={() => onNavigate?.('invoices', { focusId: inv.id })}
                          className="px-2 py-1 border border-slate-300 text-slate-700 rounded font-semibold text-[11px] inline-flex items-center space-x-1"
                        >
                          <FileSpreadsheet className="w-3.5 h-3.5" />
                          <span>Invoice</span>
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-3xl w-full p-6 shadow-2xl border border-slate-200 max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div>
                <h3 className="text-base font-bold text-slate-900">Likely duplicate review</h3>
                <p className="text-xs text-slate-500 mt-0.5 font-mono">{selected.invoice_number}</p>
              </div>
              <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 space-y-4 text-xs overflow-y-auto flex-1">
              {selected.duplicate_status === 'suspect' && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-amber-950 flex items-start space-x-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <p>
                    Approve for Payment and mark-paid are blocked until AP confirms this invoice is unique
                    or voids it as a duplicate. Dual match already ran — this hold is a separate AP control.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <InvoiceCard title="This invoice (new)" invoice={selected} highlight />
                {selected.candidates?.map((candidate) => (
                  <InvoiceCard
                    key={candidate.id}
                    title="Candidate (existing)"
                    invoice={candidate}
                  />
                ))}
              </div>

              <div className="space-y-2">
                {(selected.duplicate_flags || []).map((flag) => (
                  <div key={flag.id} className="border border-slate-200 rounded-xl p-3">
                    <div className="font-semibold text-slate-800">{matchRuleLabel(flag.match_rule)}</div>
                    <div className="text-slate-500 mt-0.5">
                      {flag.invoice_date} · ${formatMoney(flag.billed_total_cents)} vs {flag.candidate_invoice_date} · ${formatMoney(flag.candidate_billed_total_cents)}
                      {' '}({flag.candidate_invoice_number})
                    </div>
                    {flag.reason && (
                      <div className="text-slate-600 mt-1">
                        {flag.actor_name}: {flag.reason}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {selected.duplicate_status === 'suspect' && (
                <div className="space-y-3 border-t border-slate-200 pt-3">
                  <div className="flex flex-wrap gap-2">
                    {DISPOSITIONS.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => setDisposition(item.id)}
                        className={`text-xs font-semibold px-3 py-1.5 rounded-full border ${
                          disposition === item.id
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-600 border-slate-200'
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-slate-500">
                    {DISPOSITIONS.find((item) => item.id === disposition)?.hint}
                  </p>
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Reason</label>
                    <textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      rows={3}
                      className="w-full p-2.5 border border-slate-300 rounded-lg text-xs"
                      placeholder="Why this is unique, or why it is a duplicate…"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-slate-200">
              <button
                onClick={() => onNavigate?.('document_trail', { q: selected.invoice_number })}
                className="px-3 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold inline-flex items-center space-x-1"
              >
                <GitBranch className="w-3.5 h-3.5" />
                <span>Trail</span>
              </button>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setSelected(null)}
                  className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold"
                >
                  Close
                </button>
                {selected.duplicate_status === 'suspect' && (
                  <button
                    disabled={processing}
                    onClick={handleResolve}
                    className={`px-4 py-2 disabled:opacity-50 text-white rounded-lg text-xs font-semibold inline-flex items-center space-x-1.5 ${
                      disposition === 'confirm_duplicate'
                        ? 'bg-slate-800 hover:bg-slate-900'
                        : 'bg-emerald-600 hover:bg-emerald-700'
                    }`}
                  >
                    {disposition === 'confirm_duplicate' ? <Ban className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                    <span>{processing ? 'Saving…' : disposition === 'confirm_duplicate' ? 'Confirm duplicate' : 'Confirm unique'}</span>
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
