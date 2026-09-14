import React, { useEffect, useMemo, useState } from 'react';
import {
  Ban,
  Banknote,
  Play,
  Plus,
  Wallet,
  X
} from 'lucide-react';
import { api } from '../api';
import { formatMoney } from '../money';

const STATUS_CHIPS = [
  { id: 'all', label: 'All runs' },
  { id: 'draft', label: 'Draft' },
  { id: 'executed', label: 'Executed' },
  { id: 'cancelled', label: 'Cancelled' }
];

function utcTodayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function statusBadge(status) {
  switch (status) {
    case 'draft':
      return <span className="bg-amber-100 text-amber-900 text-[11px] font-bold px-2 py-0.5 rounded-full">Draft proposal</span>;
    case 'executed':
      return <span className="bg-emerald-100 text-emerald-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Executed</span>;
    case 'cancelled':
      return <span className="bg-slate-200 text-slate-600 text-[11px] font-semibold px-2 py-0.5 rounded-full">Cancelled</span>;
    default:
      return <span className="bg-slate-100 text-slate-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">{status}</span>;
  }
}

function invoiceStatusBadge(status) {
  switch (status) {
    case 'approved_for_payment':
      return <span className="bg-indigo-100 text-indigo-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Approved</span>;
    case 'paid':
      return <span className="bg-emerald-100 text-emerald-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Paid</span>;
    default:
      return <span className="bg-slate-100 text-slate-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">{status}</span>;
  }
}

export default function PaymentRunsView({ currentUser, onDataChanged, onNavigate, focusId, createInvoiceIds }) {
  const [status, setStatus] = useState('all');
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [eligible, setEligible] = useState([]);
  const [picked, setPicked] = useState([]);
  const [createReason, setCreateReason] = useState('');
  const [executing, setExecuting] = useState(false);
  const [paymentDate, setPaymentDate] = useState(utcTodayYmd());
  const [paymentReference, setPaymentReference] = useState('');
  const [executeReason, setExecuteReason] = useState('');
  const [processing, setProcessing] = useState(false);

  const loadRuns = async (nextStatus = status) => {
    setLoading(true);
    try {
      const rows = await api.getPaymentRuns(nextStatus === 'all' ? '' : nextStatus);
      setRuns(Array.isArray(rows) ? rows : []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRuns();
  }, []);

  useEffect(() => {
    if (!focusId) return;
    openDetail(focusId);
  }, [focusId]);

  useEffect(() => {
    if (Array.isArray(createInvoiceIds) && createInvoiceIds.length > 0) {
      openCreate(createInvoiceIds);
    }
  }, [createInvoiceIds]);

  const draftCount = useMemo(
    () => runs.filter((row) => row.status === 'draft').length,
    [runs]
  );

  const openDetail = async (id) => {
    try {
      const detail = await api.getPaymentRunDetail(id);
      setSelected(detail);
    } catch (err) {
      alert(err.message);
    }
  };

  const openCreate = async (preselectIds = []) => {
    try {
      const rows = await api.getEligiblePaymentRunInvoices();
      setEligible(Array.isArray(rows) ? rows : []);
      const allowed = new Set((rows || []).map((row) => row.id));
      setPicked((preselectIds || []).filter((id) => allowed.has(id)));
      setCreateReason('');
      setCreating(true);
    } catch (err) {
      alert(err.message);
    }
  };

  const togglePicked = (id) => {
    setPicked((current) => (
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    ));
  };

  const handleCreate = async () => {
    if (picked.length === 0) {
      alert('Select at least one approved invoice.');
      return;
    }
    setProcessing(true);
    try {
      const created = await api.createPaymentRun({
        invoice_ids: picked,
        actor_name: currentUser?.name || 'David Miller',
        reason: createReason.trim() || undefined
      });
      setCreating(false);
      setSelected(created);
      await loadRuns();
      if (onDataChanged) onDataChanged();
    } catch (err) {
      alert(err.message);
    } finally {
      setProcessing(false);
    }
  };

  const openExecute = (run) => {
    setPaymentDate(utcTodayYmd());
    setPaymentReference(`ACH-${run.run_number.replace(/[^A-Z0-9]/g, '')}`);
    setExecuteReason(run.reason || '');
    setExecuting(true);
  };

  const handleExecute = async () => {
    if (!selected) return;
    if (!paymentDate.trim() || !paymentReference.trim()) {
      alert('Payment date (YYYY-MM-DD) and ACH reference are required.');
      return;
    }
    setProcessing(true);
    try {
      const executed = await api.executePaymentRun(selected.id, {
        payment_date: paymentDate.trim(),
        payment_reference: paymentReference.trim(),
        actor_name: currentUser?.name || 'David Miller',
        reason: executeReason.trim() || undefined
      });
      setExecuting(false);
      setSelected(executed);
      await loadRuns();
      if (onDataChanged) onDataChanged();
    } catch (err) {
      alert(err.message);
    } finally {
      setProcessing(false);
    }
  };

  const handleCancel = async () => {
    if (!selected) return;
    const reason = window.prompt('Cancel this draft payment run? Optional reason:', '');
    if (reason === null) return;
    setProcessing(true);
    try {
      const cancelled = await api.cancelPaymentRun(selected.id, {
        actor_name: currentUser?.name || 'David Miller',
        reason: reason.trim() || undefined
      });
      setSelected(cancelled);
      await loadRuns();
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
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Payment Runs</h2>
          <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">
            Coupa/Ariba-style payment proposal. Select approved invoices, create a numbered
            <code className="mx-1 font-mono">PAY-YYYY-NNN</code> draft, then execute once.
            All lines become paid with a shared ACH reference via the existing mark-paid path.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-[11px] font-semibold text-slate-500 bg-slate-100 rounded-lg px-3 py-1.5 inline-flex items-center space-x-1.5">
            <Banknote className="w-3.5 h-3.5" />
            <span>{draftCount} draft</span>
          </div>
          <button
            onClick={() => openCreate()}
            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold inline-flex items-center space-x-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>New payment run</span>
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUS_CHIPS.map((chip) => {
          const active = status === chip.id;
          return (
            <button
              key={chip.id}
              onClick={() => {
                setStatus(chip.id);
                loadRuns(chip.id);
              }}
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

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        <div className="xl:col-span-2 bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">Run</th>
                <th className="py-3 px-4">Payable</th>
                <th className="py-3 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="3" className="py-8 text-center text-slate-400">Loading payment runs...</td>
                </tr>
              ) : runs.length === 0 ? (
                <tr>
                  <td colSpan="3" className="py-8 text-center text-slate-400">
                    No payment runs in this filter. Create one from approved invoices.
                  </td>
                </tr>
              ) : (
                runs.map((run) => (
                  <tr
                    key={run.id}
                    onClick={() => openDetail(run.id)}
                    className={`hover:bg-slate-50/70 cursor-pointer transition-colors ${
                      selected?.id === run.id ? 'bg-indigo-50/70' : ''
                    }`}
                  >
                    <td className="py-3 px-4">
                      <div className="font-mono font-bold text-slate-900">{run.run_number}</div>
                      <div className="text-[10px] text-slate-500 mt-0.5">
                        {run.invoice_count} invoice{run.invoice_count === 1 ? '' : 's'}
                        {run.payment_reference ? ` · ${run.payment_reference}` : ''}
                      </div>
                    </td>
                    <td className="py-3 px-4 font-bold text-slate-900">${formatMoney(run.payable_total_cents)}</td>
                    <td className="py-3 px-4">{statusBadge(run.status)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="xl:col-span-3 bg-white rounded-xl border border-slate-200/80 shadow-sm p-5 min-h-[280px]">
          {!selected ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-slate-400 py-12">
              <Banknote className="w-8 h-8 mb-2" />
              <p className="text-sm font-semibold text-slate-600">Select a payment run</p>
              <p className="text-xs mt-1 max-w-sm">
                Seed walkthrough: open <span className="font-mono font-bold text-slate-700">PAY-2026-001</span>
                {' '}(INV-WED-4419 + INV-FCJ-9920) and Execute. Leave INV-FCJ-8810 for single mark-paid on AP Aging.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div>
                  <div className="font-mono text-lg font-bold text-slate-900">{selected.run_number}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {statusBadge(selected.status)}
                    <span className="text-[11px] text-slate-500">{selected.actor_name}</span>
                  </div>
                  {selected.reason && (
                    <p className="text-xs text-slate-500 mt-2">{selected.reason}</p>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-slate-500">Payable</div>
                  <div className="text-xl font-extrabold text-slate-900">${formatMoney(selected.payable_total_cents)}</div>
                  <div className="text-[11px] text-slate-500">Billed ${formatMoney(selected.billed_total_cents)}</div>
                </div>
              </div>

              {selected.payment_reference && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs text-emerald-900">
                  Shared ACH <span className="font-mono font-bold">{selected.payment_reference}</span>
                  {selected.payment_date ? ` · ${selected.payment_date}` : ''}
                </div>
              )}

              <table className="w-full text-left text-xs">
                <thead className="text-slate-500 font-semibold uppercase tracking-wider border-b border-slate-200">
                  <tr>
                    <th className="py-2 pr-2">Invoice</th>
                    <th className="py-2 pr-2">Supplier / PO</th>
                    <th className="py-2 pr-2">Payable</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(selected.items || []).map((item) => (
                    <tr key={item.id}>
                      <td className="py-2 pr-2">
                        <button
                          onClick={() => onNavigate?.('invoices', { focusId: item.invoice_id })}
                          className="font-mono font-bold text-indigo-700 hover:underline"
                        >
                          {item.invoice_number}
                        </button>
                      </td>
                      <td className="py-2 pr-2">
                        <div className="font-medium text-slate-900">{item.supplier_name}</div>
                        <div className="font-mono text-[10px] text-slate-500">{item.po_number}</div>
                      </td>
                      <td className="py-2 pr-2 font-bold">
                        ${formatMoney(item.payable_total_cents)}
                        {item.has_short_pay && (
                          <div className="text-[10px] font-semibold text-amber-800">
                            billed ${formatMoney(item.billed_total_cents)}
                          </div>
                        )}
                      </td>
                      <td className="py-2 space-y-1">
                        {invoiceStatusBadge(item.invoice_status)}
                        <button
                          onClick={() => onNavigate?.('document_trail', { q: item.invoice_number })}
                          className="block text-[10px] font-semibold text-slate-500 hover:text-slate-800"
                        >
                          Trail
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {selected.status === 'draft' && (
                <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                  <button
                    disabled={processing}
                    onClick={handleCancel}
                    className="px-3 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold inline-flex items-center space-x-1"
                  >
                    <Ban className="w-3.5 h-3.5" />
                    <span>Cancel draft</span>
                  </button>
                  <button
                    disabled={processing}
                    onClick={() => openExecute(selected)}
                    className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold inline-flex items-center space-x-1.5"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>Execute run</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {creating && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-slate-200 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div>
                <h3 className="text-base font-bold text-slate-900">Create payment run</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Only invoices already approved for payment, not on another open or executed run.
                </p>
              </div>
              <button onClick={() => setCreating(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="py-4 space-y-3">
              {eligible.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No eligible invoices. Approve matched invoices first, or cancel a draft that is holding them.
                </p>
              ) : (
                <div className="space-y-2">
                  {eligible.map((inv) => {
                    const checked = picked.includes(inv.id);
                    return (
                      <label
                        key={inv.id}
                        className={`flex items-start gap-3 rounded-xl border p-3 text-xs cursor-pointer ${
                          checked ? 'border-indigo-300 bg-indigo-50/60' : 'border-slate-200 bg-white'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePicked(inv.id)}
                          className="mt-0.5"
                        />
                        <div className="flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono font-bold text-slate-900">{inv.invoice_number}</span>
                            <span className="font-bold">${formatMoney(inv.effective_payable_cents)}</span>
                          </div>
                          <div className="text-slate-500 mt-0.5">
                            {inv.supplier_name} · {inv.po_number} · due {inv.due_date}
                            {inv.has_short_pay ? ` · billed $${formatMoney(inv.billed_total_cents)}` : ''}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
              <div>
                <label className="block text-slate-700 font-semibold mb-1 text-xs">Reason (optional)</label>
                <input
                  type="text"
                  value={createReason}
                  onChange={(e) => setCreateReason(e.target.value)}
                  className="w-full p-2.5 border border-slate-300 rounded-lg text-xs"
                  placeholder="September ACH batch"
                />
              </div>
            </div>
            <div className="flex justify-end space-x-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setCreating(false)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold"
              >
                Close
              </button>
              <button
                disabled={processing || picked.length === 0}
                onClick={handleCreate}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold"
              >
                {processing ? 'Creating…' : `Create draft (${picked.length})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {executing && selected && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div>
                <h3 className="text-base font-bold text-slate-900">Execute payment run</h3>
                <p className="text-xs text-slate-500 mt-0.5 font-mono">{selected.run_number}</p>
              </div>
              <button onClick={() => setExecuting(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="py-4 space-y-3 text-xs">
              <p className="text-slate-600">
                Marks every line paid in one transaction using the same mark-paid API as Invoices & Matching.
                Shared ACH reference is written on each invoice. Budget actuals already posted at approve — this does not double-post.
              </p>
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                <div className="text-slate-500">Payable total</div>
                <div className="font-bold text-slate-900 text-sm">${formatMoney(selected.payable_total_cents)}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">{selected.invoice_count} invoices</div>
              </div>
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Payment date (UTC)</label>
                <input
                  type="date"
                  value={paymentDate}
                  onChange={(e) => setPaymentDate(e.target.value)}
                  className="w-full p-2.5 border border-slate-300 rounded-lg text-xs font-mono font-bold"
                />
              </div>
              <div>
                <label className="block text-slate-700 font-semibold mb-1">ACH / payment reference</label>
                <input
                  type="text"
                  value={paymentReference}
                  onChange={(e) => setPaymentReference(e.target.value)}
                  className="w-full p-2.5 border border-slate-300 rounded-lg text-xs font-mono font-bold"
                />
              </div>
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Reason (optional)</label>
                <input
                  type="text"
                  value={executeReason}
                  onChange={(e) => setExecuteReason(e.target.value)}
                  className="w-full p-2.5 border border-slate-300 rounded-lg text-xs"
                />
              </div>
            </div>
            <div className="flex justify-end space-x-2 pt-3 border-t border-slate-200">
              <button
                onClick={() => setExecuting(false)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold"
              >
                Back
              </button>
              <button
                disabled={processing}
                onClick={handleExecute}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold inline-flex items-center space-x-1.5"
              >
                <Wallet className="w-4 h-4" />
                <span>{processing ? 'Executing…' : 'Confirm execute'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
