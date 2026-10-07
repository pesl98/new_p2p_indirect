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
import { formatMoney, moneyInputProps, toCents } from '../money';
import { t, presentError, presentNotice, statusLabel } from '../i18n';
import { lineTypeLabel, receiptBasisLabel } from '../lineType';
import { formatMeasured, formatStoredQuantity, isScaledQuantity } from '../measuredQty';

const DISPOSITIONS = [
  {
    id: 'accept_variance',
    labelKey: 'payables.exceptions.disposition.accept',
    hintKey: 'payables.exceptions.disposition.acceptHint'
  },
  {
    id: 'short_pay',
    labelKey: 'payables.exceptions.disposition.shortPay',
    hintKey: 'payables.exceptions.disposition.shortPayHint'
  },
  {
    id: 'reject_invoice',
    labelKey: 'payables.exceptions.disposition.reject',
    hintKey: 'payables.exceptions.disposition.rejectHint'
  },
  {
    id: 'return_to_buyer',
    labelKey: 'status.returnToBuyer',
    hintKey: 'payables.exceptions.disposition.returnHint'
  }
];

function matchBadge(matchStatus) {
  switch (matchStatus) {
    case 'perfect_match':
      return (
        <span className="bg-emerald-100 text-emerald-800 text-xs px-2.5 py-1 rounded-full font-bold inline-flex items-center">
          <CheckCircle2 className="w-3.5 h-3.5 mr-1" />{statusLabel('perfect_match')}
        </span>
      );
    case 'tolerated_match':
      return (
        <span className="bg-amber-100 text-amber-800 text-xs px-2.5 py-1 rounded-full font-bold inline-flex items-center">
          <AlertTriangle className="w-3.5 h-3.5 mr-1" />{statusLabel('tolerated_match')}
        </span>
      );
    case 'price_variance':
      return (
        <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-bold inline-flex items-center">
          <XCircle className="w-3.5 h-3.5 mr-1" />{statusLabel('price_variance')}
        </span>
      );
    case 'quantity_variance':
      return (
        <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-bold inline-flex items-center">
          <XCircle className="w-3.5 h-3.5 mr-1" />{statusLabel('quantity_variance')}
        </span>
      );
    case 'total_variance':
      return (
        <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-bold inline-flex items-center">
          <ShieldAlert className="w-3.5 h-3.5 mr-1" />{statusLabel('total_variance')}
        </span>
      );
    default:
      return <span className="bg-slate-100 text-slate-700 text-xs px-2 py-0.5 rounded">{statusLabel(matchStatus)}</span>;
  }
}

function statusBadge(status) {
  switch (status) {
    case 'approved_for_payment':
      return <span className="bg-indigo-100 text-indigo-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">{statusLabel('approved_for_payment')}</span>;
    case 'paid':
      return <span className="bg-emerald-100 text-emerald-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">{statusLabel('paid')}</span>;
    case 'variance_flagged':
      return <span className="bg-rose-100 text-rose-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">{t('payables.exceptions.needsDisposition')}</span>;
    case 'rejected':
      return <span className="bg-slate-800 text-white text-[11px] font-semibold px-2 py-0.5 rounded-full">{statusLabel('rejected')}</span>;
    case 'matched':
      return <span className="bg-emerald-50 text-emerald-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">{t('payables.exceptions.clearedForAp')}</span>;
    default:
      return <span className="bg-slate-100 text-slate-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">{statusLabel(status)}</span>;
  }
}

function dispositionLabel(value) {
  if (value === 'accept_variance') return t('payables.exceptions.disposition.accept');
  if (value === 'reject_invoice') return t('payables.exceptions.disposition.reject');
  if (value === 'buyer_response') return t('payables.exceptions.disposition.buyerResponse');
  return statusLabel(value);
}

function lineResultLabel(status) {
  if (status === 'pass') return t('payables.exceptions.linePass');
  if (status === 'fail') return t('payables.exceptions.lineFail');
  if (status === 'warning') return t('payables.exceptions.lineWarning');
  return statusLabel(status);
}

function billedPayBadge(inv) {
  if (inv?.payable_total_cents == null) return null;
  return (
    <span className="bg-amber-100 text-amber-900 text-[11px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center">
      <Banknote className="w-3 h-3 mr-1" />
      {t('payables.shared.billedPay', {
        billed: formatMoney(inv.total_amount),
        pay: formatMoney(inv.payable_total_cents)
      })}
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
      alert(presentError(err, 'errors.exception'));
    }
  };

  useEffect(() => {
    if (focusId) openDetail(focusId);
  }, [focusId]);

  const handleResolve = async () => {
    if (!selected) return;
    if (!reason.trim()) {
      alert(t('payables.exceptions.reasonAlert'));
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
        alert(t('payables.exceptions.payableAlert', { zero: formatMoney(0) }));
        return;
      }
      if (!window.confirm(
        t('payables.exceptions.shortConfirm', {
          billed: formatMoney(selected.total_amount),
          pay: formatMoney(payableCents)
        })
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
      alert(presentError(err, 'errors.exceptionResolve'));
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">{t('payables.exceptions.title')}</h2>
          <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">
            {t('payables.exceptions.lead')} (<code className="font-mono">variance_flagged</code>).{' '}
            {t('payables.exceptions.leadTail')} <code className="font-mono">matched</code> {t('payables.exceptions.leadEnd')}
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
              {statusLabel(key)}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">{t('payables.invoices.colNumber')}</th>
                <th className="py-3 px-4">{t('common.supplier')}</th>
                <th className="py-3 px-4">{t('payables.exceptions.colPo')}</th>
                <th className="py-3 px-4">{t('payables.exceptions.colBilled')}</th>
                <th className="py-3 px-4">{t('payables.shared.match')}</th>
                <th className="py-3 px-4">{t('common.status')}</th>
                <th className="py-3 px-4">{t('payables.exceptions.colLatest')}</th>
                <th className="py-3 px-4 text-right">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">{t('common.loading')}</td>
                </tr>
              ) : invoices.length === 0 ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">
                    {queue === 'open' ? t('payables.exceptions.emptyOpen') : t('payables.exceptions.emptyFilter')}
                  </td>
                </tr>
              ) : (
                invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-slate-900">{inv.invoice_number}</td>
                    <td className="py-3 px-4 font-medium text-slate-900">{inv.supplier_name}</td>
                    <td className="py-3 px-4 font-mono text-indigo-700 font-semibold">{inv.po_number}</td>
                    <td className="py-3 px-4 font-bold text-slate-900">
                      <div>{formatMoney(inv.total_amount)}</div>
                      {inv.payable_total_cents != null && (
                        <div className="text-[10px] font-semibold text-amber-800 mt-0.5">
                          {t('payables.shared.pay', { amount: formatMoney(inv.payable_total_cents) })}
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
                        <span>{t('payables.exceptions.openMatrix')}</span>
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
                  {t('common.supplier')}: <strong>{selected.supplier_name}</strong> • {selected.po_number}
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
                      <th className="py-2.5 px-3">{t('common.item')}</th>
                      <th className="py-2.5 px-3 text-center">{t('common.type')}</th>
                      <th className="py-2.5 px-3 text-center bg-blue-50/70">{t('payables.exceptions.colPoPrice')}</th>
                      <th className="py-2.5 px-3 text-center bg-amber-50/70">{t('payables.invoices.colReceipt')}</th>
                      <th className="py-2.5 px-3 text-center bg-purple-50/70">{t('payables.exceptions.colInvoiced')}</th>
                      <th className="py-2.5 px-3 text-center">{t('payables.exceptions.colVariance')}</th>
                      <th className="py-2.5 px-3 text-center">{t('payables.exceptions.colLineResult')}</th>
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
                          {formatStoredQuantity(res.ordered_qty, res)} à {formatMoney(res.po_unit_price)}
                        </td>
                        <td className="py-2.5 px-3 text-center bg-amber-50/30 font-semibold">
                          {formatStoredQuantity(res.received_qty, res)} {receiptBasisLabel(res)}
                        </td>
                        <td className="py-2.5 px-3 text-center bg-purple-50/30 font-bold">
                          {formatStoredQuantity(res.invoiced_qty, res)} à {formatMoney(res.invoice_unit_price)}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          {t('payables.exceptions.qtyCents', {
                            qty: isScaledQuantity(res) ? formatMeasured(res.qty_variance, res.unit_of_measure) : res.qty_variance,
                            cents: res.price_variance
                          })}
                        </td>
                        <td className="py-2.5 px-3 text-center capitalize font-semibold">{lineResultLabel(res.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selected.match_results?.some((r) => r.status !== 'pass') && (
                <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-rose-900 space-y-2">
                  <div className="font-bold flex items-center space-x-1.5 text-xs">
                    <AlertTriangle className="w-4 h-4 text-rose-600" />
                    <span>{t('payables.exceptions.findings')}</span>
                  </div>
                  <ul className="list-disc list-inside text-[11px] space-y-1">
                    {selected.match_results.filter((r) => r.status !== 'pass').map((r, i) => (
                      <li key={i}>{presentNotice(r.message, 'payables.exceptions.findings')}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <div className="font-bold text-slate-700 uppercase tracking-wider text-[11px] mb-1">{t('payables.invoices.colReceipt')}</div>
                  <div className="text-[11px] text-slate-600">
                    GRN: {selected.receipts?.length
                      ? selected.receipts.map((grn) => `${grn.grn_number} (${grn.received_by_name})`).join(' · ')
                      : t('common.none')}
                  </div>
                  <div className="text-[11px] text-slate-600 mt-1">
                    SES: {selected.service_entry_sheets?.length
                      ? selected.service_entry_sheets.map((ses) => `${ses.ses_number} (${statusLabel(ses.status)})`).join(' · ')
                      : t('common.none')}
                  </div>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <div className="font-bold text-slate-700 uppercase tracking-wider text-[11px] mb-1">{t('payables.exceptions.amounts')}</div>
                  <div className="text-[11px] text-slate-600">
                    {t('payables.exceptions.poBilled', {
                      po: formatMoney(selected.po_total_amount),
                      billed: formatMoney(selected.total_amount)
                    })}
                  </div>
                  {selected.payable_total_cents != null && (
                    <div className="text-[11px] font-semibold text-amber-900 mt-1">
                      {t('payables.exceptions.payableUnchanged', { amount: formatMoney(selected.payable_total_cents) })}
                    </div>
                  )}
                  {selected.exception?.accepted_total_cents != null && (
                    <div className="text-[11px] text-slate-600 mt-1">
                      {selected.exception.disposition === 'short_pay'
                        ? t('payables.exceptions.lastPayable', { amount: formatMoney(selected.exception.accepted_total_cents) })
                        : t('payables.exceptions.lastAccepted', { amount: formatMoney(selected.exception.accepted_total_cents) })}
                      {selected.exception.billed_total_cents != null
                        ? ` · ${t('payables.shared.billedInline', { amount: formatMoney(selected.exception.billed_total_cents) })}`
                        : ''}
                      {selected.exception.accepted_match_status
                        ? ` (${statusLabel(selected.exception.accepted_match_status)})`
                        : ''}
                    </div>
                  )}
                </div>
              </div>

              {selected.exception?.disposition === 'buyer_response' && selected.status === 'variance_flagged' && (
                <div className="bg-sky-50 border border-sky-200 rounded-xl p-4 text-sky-950">
                  <div className="font-bold flex items-center space-x-1.5 text-xs">
                    <ClipboardList className="w-4 h-4 text-sky-700" />
                    <span>{t('payables.exceptions.buyerReady')}</span>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed">{selected.exception.reason}</p>
                  <p className="mt-1 text-[10px] text-sky-800">{selected.exception.actor_name}</p>
                </div>
              )}

              {selected.exception_dispositions?.length > 0 && (
                <div>
                  <h4 className="font-bold text-slate-800 uppercase tracking-wider text-[11px] mb-2">{t('payables.exceptions.prior')}</h4>
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
                            ? ` · ${t('payables.shared.billedPay', {
                              billed: formatMoney(row.billed_total_cents ?? selected.total_amount),
                              pay: formatMoney(row.accepted_total_cents)
                            })}`
                            : row.disposition === 'buyer_response' || row.disposition === 'return_to_buyer'
                              ? ''
                              : ` · ${t('payables.exceptions.acceptedPart', { amount: formatMoney(row.accepted_total_cents) })}`}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selected.audit_logs?.length > 0 && (
                <div>
                  <h4 className="font-bold text-slate-800 uppercase tracking-wider text-[11px] mb-2">{t('payables.exceptions.audit')}</h4>
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
                    <span>{t('payables.exceptions.take')}</span>
                    <span className="font-normal text-slate-500">{t('payables.exceptions.asActor', { name: currentUser?.name || t('payables.exceptions.currentPersona') })}</span>
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
                        <span className="font-semibold text-slate-900">{t(option.labelKey)}</span>
                        <p className="text-[11px] text-slate-500 mt-1">{t(option.hintKey)}</p>
                      </label>
                    ))}
                  </div>
                  {disposition === 'short_pay' && (
                    <div className="bg-white border border-amber-200 rounded-lg p-3 space-y-2">
                      <div className="text-[11px] text-slate-600">
                        {t('payables.exceptions.billedTotal')}{' '}
                        <strong className="text-slate-900">{formatMoney(selected.total_amount)}</strong>
                        {' · '}{t('payables.exceptions.matchNote', { status: statusLabel(selected.match_status) })}
                      </div>
                      <label className="block text-slate-700 font-bold text-[11px]">
                        {t('payables.exceptions.payableLabel')}
                      </label>
                      <input
                        {...moneyInputProps}
                        value={payableDollars}
                        onChange={(e) => setPayableDollars(e.target.value)}
                        placeholder={t('payables.exceptions.payablePlaceholder', { amount: formatMoney(74900) })}
                        className="w-full p-2 border border-slate-300 rounded-lg text-xs font-mono"
                      />
                      {payableDollars !== '' && (
                        <div className="text-[11px] text-amber-900 font-semibold">
                          {t('payables.shared.billedPay', {
                            billed: formatMoney(selected.total_amount),
                            pay: formatMoney(toCents(payableDollars))
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  <div>
                    <label className="block text-slate-700 font-bold text-[11px] mb-1">{t('common.reason')} ({t('common.required')})</label>
                    <textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      rows={3}
                      placeholder={t('payables.exceptions.reasonPlaceholder')}
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
                <span>{t('payables.exceptions.openInvoices')}</span>
              </button>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setSelected(null)}
                  className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold"
                >
                  {t('common.close')}
                </button>
                {selected.status === 'variance_flagged' && (
                  <button
                    disabled={processing}
                    onClick={handleResolve}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold inline-flex items-center space-x-1.5"
                  >
                    {disposition === 'return_to_buyer' ? <RotateCcw className="w-4 h-4" /> : disposition === 'short_pay' ? <Banknote className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                    <span>{disposition === 'short_pay' ? t('payables.exceptions.confirmShort') : t('payables.exceptions.record')}</span>
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
