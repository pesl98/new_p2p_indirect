import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  GitBranch,
  MessageSquareReply,
  ShieldAlert,
  X,
  XCircle
} from 'lucide-react';
import { api } from '../api';
import { formatMoney } from '../money';

function matchBadge(matchStatus) {
  switch (matchStatus) {
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

export default function BuyerInboxView({ currentUser, onDataChanged, onNavigate, focusId }) {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [reason, setReason] = useState('');
  const [processing, setProcessing] = useState(false);

  const loadQueue = async () => {
    setLoading(true);
    try {
      const rows = await api.getBuyerInbox({
        requester_id: currentUser?.id
      });
      setInvoices(rows);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadQueue();
  }, [currentUser?.id]);

  const openDetail = async (id) => {
    try {
      const detail = await api.getInvoiceExceptionDetail(id);
      setSelected(detail);
      setReason('');
    } catch (err) {
      alert(err.message);
    }
  };

  useEffect(() => {
    if (focusId) openDetail(focusId);
  }, [focusId]);

  const handleRespond = async () => {
    if (!selected) return;
    if (!reason.trim()) {
      alert('A response reason is required.');
      return;
    }
    setProcessing(true);
    try {
      await api.respondBuyerInbox(selected.id, {
        reason: reason.trim(),
        actor_name: currentUser?.name || 'Requester'
      });
      setSelected(null);
      setReason('');
      await loadQueue();
      if (onDataChanged) onDataChanged();
    } catch (err) {
      alert(err.message);
    } finally {
      setProcessing(false);
    }
  };

  const returnReason = selected?.exception_dispositions
    ?.slice()
    .reverse()
    .find((row) => row.disposition === 'return_to_buyer');

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Buyer Inbox</h2>
          <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">
            Invoices AP returned to you (<code className="font-mono">return_to_buyer</code>).
            Respond with a note so AP can accept, short-pay, or reject. This is not an approve-for-payment override.
          </p>
        </div>
        <div className="text-[11px] font-semibold text-slate-500 bg-slate-100 rounded-lg px-3 py-1.5">
          {invoices.length} open
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">Invoice #</th>
                <th className="py-3 px-4">Supplier</th>
                <th className="py-3 px-4">PO / PR</th>
                <th className="py-3 px-4">Billed</th>
                <th className="py-3 px-4">Match</th>
                <th className="py-3 px-4">AP return reason</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="7" className="py-8 text-center text-slate-400">Loading buyer inbox...</td>
                </tr>
              ) : invoices.length === 0 ? (
                <tr>
                  <td colSpan="7" className="py-8 text-center text-slate-400">
                    No invoices returned to you. AP parks show up here after Return to buyer.
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
                        <div className="font-mono text-[10px] text-slate-500 mt-0.5">{inv.pr_number}</div>
                      )}
                    </td>
                    <td className="py-3 px-4 font-bold text-slate-900">${formatMoney(inv.total_amount)}</td>
                    <td className="py-3 px-4">{matchBadge(inv.match_status)}</td>
                    <td className="py-3 px-4 text-slate-600 max-w-xs">
                      <div className="line-clamp-2">{inv.exception?.reason || '—'}</div>
                      <div className="text-[10px] text-slate-400 mt-0.5">{inv.exception?.actor_name}</div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => openDetail(inv.id)}
                        className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded font-semibold text-[11px] inline-flex items-center space-x-1 shadow-sm"
                      >
                        <MessageSquareReply className="w-3.5 h-3.5" />
                        <span>Respond</span>
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
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-slate-200 max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div>
                <div className="flex items-center space-x-3 flex-wrap gap-y-2">
                  <h3 className="text-lg font-mono font-bold text-slate-900">{selected.invoice_number}</h3>
                  {matchBadge(selected.match_status)}
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

            <div className="py-4 space-y-4 text-xs overflow-y-auto flex-1">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-amber-950">
                <div className="font-bold flex items-center space-x-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  <span>AP returned this invoice</span>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed">
                  {returnReason?.reason || selected.exception?.reason || 'No return reason recorded.'}
                </p>
                <p className="mt-1 text-[10px] text-amber-800">
                  {returnReason?.actor_name || selected.exception?.actor_name}
                  {returnReason?.created_at ? ` · ${returnReason.created_at}` : ''}
                </p>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                <div className="font-bold text-slate-700 uppercase tracking-wider text-[11px] mb-1">Amounts (integer cents)</div>
                <div className="text-[11px] text-slate-600">
                  PO ${formatMoney(selected.po_total_amount)} · Billed ${formatMoney(selected.total_amount)}
                  {' · '}Match {String(selected.match_status || '').replace(/_/g, ' ')}
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-bold text-[11px] mb-1">Your response to AP (required)</label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={4}
                  placeholder="Confirm receiving, explain the variance, or note that AP may proceed. This stays on the disposition history."
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  Sends a ready-for-AP note. Invoice stays <code className="font-mono">variance_flagged</code> until AP takes a final disposition.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between pt-4 border-t border-slate-200">
              <div className="flex items-center space-x-3">
                <button
                  onClick={() => onNavigate?.('invoices', { focusId: selected.id })}
                  className="text-xs font-semibold text-indigo-700 hover:text-indigo-900 inline-flex items-center space-x-1"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  <span>Invoice</span>
                </button>
                <button
                  onClick={() => onNavigate?.('document_trail', {
                    q: selected.pr_number || selected.invoice_number
                  })}
                  className="text-xs font-semibold text-indigo-700 hover:text-indigo-900 inline-flex items-center space-x-1"
                >
                  <GitBranch className="w-3.5 h-3.5" />
                  <span>Document trail</span>
                </button>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setSelected(null)}
                  className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold"
                >
                  Close
                </button>
                {selected.status === 'variance_flagged' && selected.exception?.disposition === 'return_to_buyer' && (
                  <button
                    disabled={processing}
                    onClick={handleRespond}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold inline-flex items-center space-x-1.5"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Send to AP</span>
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
