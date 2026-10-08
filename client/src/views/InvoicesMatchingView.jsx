import React, { useState, useEffect } from 'react';
import { 
  FileSpreadsheet, 
  Plus, 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  DollarSign, 
  ArrowRight, 
  Eye, 
  CreditCard, 
  Building2, 
  X,
  FileCheck,
  ShieldAlert,
  Copy
} from 'lucide-react';
import { api } from '../api';
import { formatMoney, formatMajorInput, moneyInputProps, toCents } from '../money';
import { t, presentError, presentNotice, statusLabel } from '../i18n';
import { isServiceLine, lineTypeLabel, receiptBasisLabel } from '../lineType';
import { formatStoredQuantity, isScaledQuantity, measuredLineTotalCents } from '../measuredQty';

function dispositionLabel(value) {
  if (value === 'accept_variance') return t('payables.exceptions.disposition.accept');
  if (value === 'reject_invoice') return t('payables.exceptions.disposition.reject');
  if (value === 'buyer_response') return t('payables.exceptions.disposition.buyerResponse');
  return statusLabel(value);
}

export default function InvoicesMatchingView({ currentUser, onDataChanged, onNavigate, focusId }) {
  const [invoices, setInvoices] = useState([]);
  const [activePOs, setActivePOs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedPOId, setSelectedPOId] = useState('');
  const [targetPOData, setTargetPOData] = useState(null);

  // New Invoice Form
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().split('T')[0]);
  const [dueDate, setDueDate] = useState(new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]);
  const [taxAmount, setTaxAmount] = useState(0);
  const [invoiceNotes, setInvoiceNotes] = useState('');
  const [invoiceLines, setInvoiceLines] = useState([]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [invs, pos] = await Promise.all([
        api.getInvoices(),
        api.getPurchaseOrders()
      ]);
      setInvoices(invs);
      setActivePOs(pos);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (focusId) {
      handleOpenDetail(focusId);
    }
  }, [focusId]);

  const handleOpenDetail = async (id) => {
    try {
      const detail = await api.getInvoiceDetail(id);
      setSelectedInvoice(detail);
    } catch (err) {
      console.error(err);
    }
  };

  const handleSelectPO = async (poId) => {
    setSelectedPOId(poId);
    if (!poId) {
      setTargetPOData(null);
      setInvoiceLines([]);
      return;
    }

    try {
      const poDetail = await api.getPurchaseOrderDetail(poId);
      setTargetPOData(poDetail);
      setInvoiceNumber(`INV-${poDetail.supplier_code}-${Math.floor(1000 + Math.random() * 9000)}`);
      
      const lines = poDetail.items.map(item => ({
        po_item_id: item.id,
        description: item.item_description,
        line_type: item.line_type,
        category: item.category,
        po_quantity: item.quantity,
        po_unit_price: item.unit_price,
        po_quantity_received: item.quantity_received,
        po_quantity_accepted: item.quantity_accepted || 0,
        po_quantity_consumed: item.quantity_consumed || 0,
        receipt_basis: item.receipt_basis || 'grn',
        quantity_scale: item.quantity_scale || 1,
        unit_of_measure: item.unit_of_measure || '',
        settlement_kind: item.settlement_kind || 'purchase',
        quantity_invoiced: Number(item.quantity_scale) === 1000
          ? (Number(item.quantity) / 1000).toFixed(3)
          : item.quantity,
        unit_price: formatMajorInput(item.unit_price)
      }));
      setInvoiceLines(lines);
    } catch (err) {
      console.error(err);
    }
  };

  const handleLineChange = (index, field, value) => {
    const updated = [...invoiceLines];
    if (field === 'unit_price' || (field === 'quantity_invoiced' && isScaledQuantity(updated[index]))) {
      updated[index][field] = value;
    } else {
      updated[index][field] = Number(value);
    }
    setInvoiceLines(updated);
  };

  const linePreviewCents = (item) => {
    if (isScaledQuantity(item)) return measuredLineTotalCents(item.quantity_invoiced, toCents(item.unit_price));
    return Math.trunc(Number(item.quantity_invoiced) || 0) * toCents(item.unit_price);
  };

  const calculateSubtotalCents = () => {
    return invoiceLines.reduce((sum, item) => sum + linePreviewCents(item), 0);
  };

  const handleSubmitInvoice = async () => {
    if (!invoiceNumber || invoiceLines.length === 0) {
      alert(t('payables.invoices.needLines'));
      return;
    }

    try {
      const result = await api.createInvoice({
        invoice_number: invoiceNumber,
        po_id: Number(selectedPOId),
        supplier_id: targetPOData.supplier_id,
        invoice_date: invoiceDate,
        due_date: dueDate,
        tax_amount: toCents(taxAmount),
        notes: invoiceNotes,
        items: invoiceLines.map((line) => ({
          po_item_id: line.po_item_id,
          description: line.description,
          quantity_invoiced: isScaledQuantity(line)
            ? line.quantity_invoiced
            : Math.trunc(Number(line.quantity_invoiced) || 0),
          unit_price: toCents(line.unit_price)
        }))
      });

      setShowCreateModal(false);
      setSelectedPOId('');
      setTargetPOData(null);
      setInvoiceLines([]);
      await loadData();
      if (onDataChanged) onDataChanged();
      if (result.duplicate_status === 'suspect') {
        alert(presentError(result.message, 'payables.invoices.duplicateSuspectAlert'));
      }
      handleOpenDetail(result.invoiceId);
    } catch (err) {
      alert(presentError(err, 'errors.invoiceCreate'));
    }
  };

  const handleApprovePayment = async (invId) => {
    try {
      await api.approveInvoicePayment(invId, {
        approver_name: currentUser?.name || 'David Miller (Finance)'
      });
      await loadData();
      if (onDataChanged) onDataChanged();
      handleOpenDetail(invId);
    } catch (err) {
      alert(presentError(err, 'errors.invoiceApprove'));
    }
  };

  const handleMarkPaid = async (invId) => {
    try {
      await api.markInvoicePaid(invId, {
        payer_name: currentUser?.name || 'David Miller (Finance)',
        payment_reference: `ACH-PAY-${Math.floor(100000 + Math.random() * 900000)}`
      });
      await loadData();
      if (onDataChanged) onDataChanged();
      handleOpenDetail(invId);
    } catch (err) {
      alert(presentError(err, 'errors.invoicePaid'));
    }
  };

  const getMatchBadge = (matchStatus) => {
    switch (matchStatus) {
      case 'perfect_match':
        return (
          <span className="bg-emerald-100 text-emerald-800 text-xs px-2.5 py-1 rounded-full font-bold flex items-center space-x-1">
            <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
            <span>{statusLabel('perfect_match')}</span>
          </span>
        );
      case 'tolerated_match':
        return (
          <span className="bg-amber-100 text-amber-800 text-xs px-2.5 py-1 rounded-full font-bold flex items-center space-x-1">
            <AlertTriangle className="w-3.5 h-3.5 mr-1" />
            <span>{statusLabel('tolerated_match')}</span>
          </span>
        );
      case 'price_variance':
        return (
          <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-bold flex items-center space-x-1">
            <XCircle className="w-3.5 h-3.5 mr-1" />
            <span>{statusLabel('price_variance')}</span>
          </span>
        );
      case 'quantity_variance':
        return (
          <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-bold flex items-center space-x-1">
            <XCircle className="w-3.5 h-3.5 mr-1" />
            <span>{statusLabel('quantity_variance')}</span>
          </span>
        );
      case 'total_variance':
        return (
          <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-bold flex items-center space-x-1">
            <ShieldAlert className="w-3.5 h-3.5 mr-1" />
            <span>{statusLabel('total_variance')}</span>
          </span>
        );
      default:
        return <span className="bg-slate-100 text-slate-700 text-xs px-2 py-0.5 rounded">{t('payables.invoices.matchPending')}</span>;
    }
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'approved_for_payment':
        return <span className="bg-indigo-100 text-indigo-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">{statusLabel('approved_for_payment')}</span>;
      case 'paid':
        return <span className="bg-emerald-100 text-emerald-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">{statusLabel('paid')}</span>;
      case 'variance_flagged':
        return <span className="bg-rose-100 text-rose-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">{statusLabel('variance_flagged')}</span>;
      case 'rejected':
        return <span className="bg-slate-800 text-white text-[11px] font-semibold px-2 py-0.5 rounded-full">{statusLabel('rejected')}</span>;
      default:
        return <span className="bg-slate-100 text-slate-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">{statusLabel(status)}</span>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">{t('payables.invoices.title')}</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t('payables.invoices.subtitle')}
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowCreateModal(true)}
            className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-sm transition-all flex items-center space-x-2"
          >
            <Plus className="w-4 h-4" />
            <span>{t('payables.invoices.enter')}</span>
          </button>
        </div>
      </div>

      {/* Invoice Table */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">{t('payables.invoices.colNumber')}</th>
                <th className="py-3 px-4">{t('common.supplier')}</th>
                <th className="py-3 px-4">{t('payables.invoices.colPo')}</th>
                <th className="py-3 px-4">{t('payables.invoices.colBilled')}</th>
                <th className="py-3 px-4">{t('payables.invoices.colMatch')}</th>
                <th className="py-3 px-4">{t('payables.invoices.colStatus')}</th>
                <th className="py-3 px-4">{t('payables.invoices.colDue')}</th>
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
                  <td colSpan="8" className="py-8 text-center text-slate-400">{t('payables.invoices.empty')}</td>
                </tr>
              ) : (
                invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-slate-900">
                      <div>{inv.invoice_number}</div>
                      {(inv.duplicate_status === 'suspect' || inv.duplicate_status === 'confirmed_duplicate') && (
                        <span className={`mt-1 inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                          inv.duplicate_status === 'suspect'
                            ? 'bg-amber-100 text-amber-900'
                            : 'bg-slate-800 text-white'
                        }`}>
                          {inv.duplicate_status === 'suspect' ? t('payables.invoices.suspect') : statusLabel('confirmed_duplicate')}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 font-medium text-slate-900">
                      {inv.supplier_name}
                    </td>
                    <td className="py-3 px-4 font-mono text-indigo-700 font-semibold">
                      {inv.po_number}
                    </td>
                    <td className="py-3 px-4 font-bold text-slate-900 text-sm">
                      <div>{formatMoney(inv.total_amount)}</div>
                      {inv.payable_total_cents != null && (
                        <div className="text-[10px] font-semibold text-amber-800 mt-0.5">
                          {t('payables.shared.pay', { amount: formatMoney(inv.payable_total_cents) })}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {getMatchBadge(inv.match_status)}
                    </td>
                    <td className="py-3 px-4">
                      {getStatusBadge(inv.status)}
                    </td>
                    <td className="py-3 px-4 text-slate-500">
                      {inv.due_date}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => handleOpenDetail(inv.id)}
                        className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded font-semibold text-[11px] inline-flex items-center space-x-1 shadow-sm"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        <span>{t('payables.invoices.matchMatrix')}</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Enter Vendor Invoice Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-3xl w-full p-6 shadow-2xl border border-slate-200 max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div>
                <h3 className="text-base font-bold text-slate-900">{t('payables.invoices.enter')}</h3>
                <p className="text-xs text-slate-500">{t('payables.invoices.enterHelp')}</p>
              </div>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 space-y-4 text-xs overflow-y-auto flex-1">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">{t('payables.invoices.selectPo')}</label>
                <select
                  value={selectedPOId}
                  onChange={(e) => handleSelectPO(e.target.value)}
                  className="w-full p-2.5 border border-slate-300 rounded-lg text-xs font-medium"
                >
                  <option value="">{t('payables.invoices.choosePo')}</option>
                  {activePOs.map(po => (
                    <option key={po.id} value={po.id}>
                      {po.po_number} - {po.supplier_name} ({formatMoney(po.total_amount)}) [{statusLabel(po.status)}]
                    </option>
                  ))}
                </select>
              </div>

              {targetPOData && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                    <div>
                      <label className="block text-slate-500 text-[11px] mb-1">{t('payables.invoices.vendorNumber')}</label>
                      <input
                        type="text"
                        value={invoiceNumber}
                        onChange={(e) => setInvoiceNumber(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded-lg text-xs font-mono font-bold"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-500 text-[11px] mb-1">{t('payables.invoices.invoiceDate')}</label>
                      <input
                        type="date"
                        value={invoiceDate}
                        onChange={(e) => setInvoiceDate(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-500 text-[11px] mb-1">{t('payables.invoices.dueDate')}</label>
                      <input
                        type="date"
                        value={dueDate}
                        onChange={(e) => setDueDate(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                      />
                    </div>
                  </div>

                  {/* Line Items Entry (Editable to test price/qty variances!) */}
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <span className="font-bold text-slate-700 uppercase tracking-wider text-[11px]">
                        {t('payables.invoices.lineItems')}
                      </span>
                      <span className="text-emerald-700 font-bold">
                        {t('payables.invoices.subtotal', { amount: formatMoney(calculateSubtotalCents()) })}
                      </span>
                    </div>

                    <div className="border border-slate-200 rounded-xl overflow-hidden">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-100 border-b border-slate-200 text-slate-600 font-semibold text-[11px]">
                          <tr>
                            <th className="py-2.5 px-3">{t('common.description')}</th>
                            <th className="py-2.5 px-3 text-center">{t('common.type')}</th>
                            <th className="py-2.5 px-3 text-center">{t('payables.invoices.colPoPrice')}</th>
                            <th className="py-2.5 px-3 text-center">{t('payables.invoices.colReceipt')}</th>
                            <th className="py-2.5 px-3 text-center w-28">{t('payables.invoices.colBilledQty')}</th>
                            <th className="py-2.5 px-3 text-center w-28">{t('payables.invoices.colBilledPrice')}</th>
                            <th className="py-2.5 px-3 text-right">{t('common.total')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {invoiceLines.map((line, idx) => (
                            <tr key={idx} className="hover:bg-slate-50">
                              <td className="py-2.5 px-3 font-medium text-slate-900">{line.description}</td>
                              <td className="py-2.5 px-3 text-center">
                                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isServiceLine(line) ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-700'}`}>
                                  {lineTypeLabel(line)}
                                </span>
                              </td>
                              <td className="py-2.5 px-3 text-center text-slate-500">{formatMoney(line.po_unit_price)}</td>
                              <td className="py-2.5 px-3 text-center font-semibold text-slate-800">
                                {isServiceLine(line)
                                  ? `${line.po_quantity_accepted} SES`
                                  : isScaledQuantity(line)
                                    ? t('payables.invoices.consumed', { qty: formatStoredQuantity(line.po_quantity_consumed, line) })
                                    : line.receipt_basis === 'consignment'
                                      ? t('payables.invoices.drawn', { qty: line.po_quantity_consumed })
                                      : `${line.po_quantity_received} GRN`}
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                <input
                                  type="number"
                                  min="0"
                                  step={isScaledQuantity(line) ? '0.001' : '1'}
                                  value={line.quantity_invoiced}
                                  onChange={(e) => handleLineChange(idx, 'quantity_invoiced', e.target.value)}
                                  className="w-24 text-center p-1.5 border border-slate-300 rounded font-semibold"
                                />
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                <input
                                  {...moneyInputProps}
                                  value={line.unit_price}
                                  onChange={(e) => handleLineChange(idx, 'unit_price', e.target.value)}
                                  className="w-24 text-center p-1.5 border border-slate-300 rounded font-semibold"
                                />
                              </td>
                              <td className="py-2.5 px-3 text-right font-bold text-slate-900">
                                {formatMoney(linePreviewCents(line))}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1.5">
                      {t('payables.invoices.tip')}
                    </p>
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end space-x-2 pt-4 border-t border-slate-200">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold"
              >
                {t('common.cancel')}
              </button>
              <button
                disabled={!targetPOData}
                onClick={handleSubmitInvoice}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 shadow-sm"
              >
                <FileCheck className="w-4 h-4" />
                <span>{t('payables.invoices.submitMatch')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3-Way Match Reconciliation Matrix Modal */}
      {selectedInvoice && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-4xl w-full p-6 shadow-2xl border border-slate-200 max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div>
                <div className="flex items-center space-x-3 flex-wrap gap-y-2">
                  <h3 className="text-lg font-mono font-bold text-slate-900">{selectedInvoice.invoice_number}</h3>
                  {getMatchBadge(selectedInvoice.match_status)}
                  {getStatusBadge(selectedInvoice.status)}
                  {selectedInvoice.payable_total_cents != null && (
                    <span className="bg-amber-100 text-amber-900 text-[11px] font-semibold px-2 py-0.5 rounded-full">
                      {t('payables.shared.billedPay', {
                        billed: formatMoney(selectedInvoice.total_amount),
                        pay: formatMoney(selectedInvoice.payable_total_cents)
                      })}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  {t('common.supplier')}: <strong>{selectedInvoice.supplier_name}</strong> • {t('payables.invoices.against')} <strong>{selectedInvoice.po_number}</strong>
                </p>
              </div>
              <button onClick={() => setSelectedInvoice(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Reconciliation Comparison Table */}
            <div className="py-4 space-y-5 text-xs overflow-y-auto flex-1">
              <div>
                <h4 className="font-bold text-slate-800 uppercase tracking-wider text-[11px] mb-2 flex items-center space-x-2">
                  <span>{t('payables.invoices.matrixTitle')}</span>
                  <span className="text-slate-400 font-normal">{t('payables.invoices.matrixHint')}</span>
                </h4>

                <div className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-100 border-b border-slate-200 text-slate-700 font-bold uppercase text-[10px]">
                      <tr>
                        <th className="py-2.5 px-3">{t('payables.invoices.colItem')}</th>
                        <th className="py-2.5 px-3 text-center bg-blue-50/70 text-blue-900">{t('payables.invoices.colOrdered')}</th>
                        <th className="py-2.5 px-3 text-center bg-blue-50/70 text-blue-900">{t('payables.invoices.colPoUnit')}</th>
                        <th className="py-2.5 px-3 text-center">{t('common.type')}</th>
                        <th className="py-2.5 px-3 text-center bg-amber-50/70 text-amber-900">{t('payables.invoices.colReceiptPair')}</th>
                        <th className="py-2.5 px-3 text-center bg-purple-50/70 text-purple-900">{t('payables.invoices.colInvQty')}</th>
                        <th className="py-2.5 px-3 text-center bg-purple-50/70 text-purple-900">{t('payables.invoices.colInvPrice')}</th>
                        <th className="py-2.5 px-3 text-center">{t('payables.invoices.colMatchStatus')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedInvoice.match_results?.map((res) => {
                        const isFail = res.status === 'fail';
                        const isWarning = res.status === 'warning';
                        return (
                          <tr key={res.id} className={`hover:bg-slate-50 ${isFail ? 'bg-rose-50/40' : ''}`}>
                            <td className="py-2.5 px-3 font-medium text-slate-900">
                              {res.item_description}
                            </td>
                            <td className="py-2.5 px-3 text-center">
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${res.line_type === 'service' ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-700'}`}>
                                {lineTypeLabel(res.line_type || 'goods')}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-center bg-blue-50/30 font-semibold">{formatStoredQuantity(res.ordered_qty, res)}</td>
                            <td className="py-2.5 px-3 text-center bg-blue-50/30 text-slate-700">{formatMoney(res.po_unit_price)}</td>
                            <td className="py-2.5 px-3 text-center bg-amber-50/30 font-bold text-amber-900">
                              {formatStoredQuantity(res.received_qty, res)} {receiptBasisLabel(res)}
                            </td>
                            <td className="py-2.5 px-3 text-center bg-purple-50/30 font-bold">{formatStoredQuantity(res.invoiced_qty, res)}</td>
                            <td className="py-2.5 px-3 text-center bg-purple-50/30 font-bold">{formatMoney(res.invoice_unit_price)}</td>
                            <td className="py-2.5 px-3 text-center">
                              {isFail ? (
                                <span className="bg-rose-100 text-rose-800 text-[10px] font-bold px-2 py-0.5 rounded-full inline-flex items-center">
                                  <XCircle className="w-3 h-3 mr-1" />
                                  {t('payables.invoices.fail')}
                                </span>
                              ) : isWarning ? (
                                <span className="bg-amber-100 text-amber-800 text-[10px] font-bold px-2 py-0.5 rounded-full inline-flex items-center">
                                  <AlertTriangle className="w-3 h-3 mr-1" />
                                  {t('payables.invoices.warning')}
                                </span>
                              ) : (
                                <span className="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2 py-0.5 rounded-full inline-flex items-center">
                                  <CheckCircle2 className="w-3 h-3 mr-1" />
                                  {t('payables.invoices.fullMatch')}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Discrepancy Findings Box */}
              {selectedInvoice.match_results?.some(r => r.status === 'fail' || r.status === 'warning') && (
                <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-rose-900 space-y-2">
                  <div className="font-bold flex items-center space-x-1.5 text-xs">
                    <AlertTriangle className="w-4 h-4 text-rose-600" />
                    <span>{t('payables.invoices.findings')}</span>
                  </div>
                  <ul className="list-disc list-inside text-[11px] space-y-1">
                    {selectedInvoice.match_results?.filter(r => r.status !== 'pass').map((r, i) => (
                      <li key={i}>{presentNotice(r.message, 'payables.invoices.findings')}</li>
                    ))}
                  </ul>
                </div>
              )}

              {selectedInvoice.service_entry_sheets?.length > 0 && (
                <div className="text-[11px] text-slate-600">
                  <span className="font-bold text-slate-700 uppercase tracking-wider">{t('payables.invoices.ses')} </span>
                  {selectedInvoice.service_entry_sheets.map((ses) => `${ses.ses_number} (${statusLabel(ses.status)})`).join(' · ')}
                </div>
              )}

              {/* Financial Totals */}
              <div className="grid grid-cols-3 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200">
                <div>
                  <span className="text-slate-500 text-[11px]">{t('payables.invoices.poValue')}</span>
                  <div className="font-bold text-slate-900 text-sm">
                    {formatMoney(selectedInvoice.po_total_amount)}
                  </div>
                </div>
                <div>
                  <span className="text-slate-500 text-[11px]">{t('payables.invoices.billedWithTax')}</span>
                  <div className="font-bold text-slate-900 text-sm">
                    {formatMoney(selectedInvoice.total_amount)}
                  </div>
                  {selectedInvoice.payable_total_cents != null && (
                    <div className="text-[11px] font-semibold text-amber-800 mt-1">
                      {t('payables.invoices.shortPayOf', { amount: formatMoney(selectedInvoice.payable_total_cents) })}
                    </div>
                  )}
                </div>
                <div>
                  <span className="text-slate-500 text-[11px]">{t('payables.invoices.costCenter')}</span>
                  <div className="font-bold text-slate-900 text-sm">
                    {selectedInvoice.department_name || t('payables.invoices.corporate')}
                  </div>
                </div>
              </div>

              {selectedInvoice.exception && (
                <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3.5 text-indigo-950 space-y-1">
                  <div className="font-bold text-xs">
                    {t('payables.invoices.exceptionDisposition')} <span className="capitalize">{dispositionLabel(selectedInvoice.exception.disposition)}</span>
                  </div>
                  <div className="text-[11px]">
                    {selectedInvoice.exception.actor_name} — {selectedInvoice.exception.reason}
                  </div>
                  {selectedInvoice.exception.accepted_total_cents != null && (
                    <div className="text-[11px]">
                      {selectedInvoice.exception.disposition === 'short_pay'
                        ? t('payables.shared.billedPay', {
                          billed: formatMoney(selectedInvoice.exception.billed_total_cents ?? selectedInvoice.total_amount),
                          pay: formatMoney(selectedInvoice.exception.accepted_total_cents)
                        })
                        : t('payables.invoices.recordedBilled', {
                          amount: formatMoney(selectedInvoice.exception.accepted_total_cents)
                        })}
                      {selectedInvoice.exception.accepted_match_status
                        ? ` · ${statusLabel(selectedInvoice.exception.accepted_match_status)}`
                        : ''}
                    </div>
                  )}
                </div>
              )}

              {(selectedInvoice.duplicate_status === 'suspect' || selectedInvoice.duplicate_status === 'confirmed_duplicate') && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 text-amber-950 space-y-2">
                  <div className="font-bold text-xs inline-flex items-center space-x-1.5">
                    <Copy className="w-4 h-4" />
                    <span>
                      {selectedInvoice.duplicate_status === 'suspect'
                        ? t('payables.invoices.likelyBlocked')
                        : t('payables.invoices.confirmedVoided')}
                    </span>
                  </div>
                  <p className="text-[11px]">
                    {selectedInvoice.duplicate_status === 'suspect'
                      ? t('payables.invoices.likelyHelp')
                      : t('payables.invoices.confirmedHelp')}
                  </p>
                  {selectedInvoice.duplicate_suspects?.length > 0 && (
                    <ul className="list-disc list-inside text-[11px] space-y-0.5">
                      {selectedInvoice.duplicate_suspects.map((row) => (
                        <li key={row.flag_id || row.id}>
                          {row.invoice_number} · {formatMoney(row.billed_total_cents ?? row.total_amount)} · {row.invoice_date}
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
                    onClick={() => {
                      setSelectedInvoice(null);
                      onNavigate?.('duplicate_suspects', { focusId: selectedInvoice.id });
                    }}
                    className="px-3 py-1.5 bg-amber-700 hover:bg-amber-800 text-white rounded-lg text-[11px] font-semibold inline-flex items-center space-x-1"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>{t('payables.invoices.openDuplicates')}</span>
                  </button>
                </div>
              )}

              {selectedInvoice.status === 'variance_flagged' && (
                <div className="bg-rose-50 border border-rose-200 rounded-xl p-3.5 text-rose-900 space-y-2">
                  <div className="font-bold text-xs">{t('payables.invoices.hardBlocked')}</div>
                  <p className="text-[11px]">
                    {t('payables.invoices.hardHelp')}
                  </p>
                  <button
                    onClick={() => {
                      setSelectedInvoice(null);
                      onNavigate?.('exception_workbench', { focusId: selectedInvoice.id });
                    }}
                    className="px-3 py-1.5 bg-rose-700 hover:bg-rose-800 text-white rounded-lg text-[11px] font-semibold inline-flex items-center space-x-1"
                  >
                    <ShieldAlert className="w-3.5 h-3.5" />
                    <span>{t('payables.invoices.openWorkbench')}</span>
                  </button>
                </div>
              )}

              {selectedInvoice.status === 'rejected' && (
                <div className="bg-slate-800 text-white rounded-xl p-3.5 text-xs">
                  {t('payables.invoices.rejectedHelp')}
                </div>
              )}
            </div>

            {/* Footer Buttons */}
            <div className="flex items-center justify-between pt-4 border-t border-slate-200">
              <div className="text-slate-500 text-xs">
                {selectedInvoice.payment_reference && (
                  <span>{t('payables.invoices.paymentRef')} <strong className="font-mono text-emerald-700">{selectedInvoice.payment_reference}</strong></span>
                )}
              </div>

              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setSelectedInvoice(null)}
                  className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold"
                >
                  {t('common.close')}
                </button>

                {selectedInvoice.status === 'matched' && !['suspect', 'confirmed_duplicate'].includes(selectedInvoice.duplicate_status) && (
                  <button
                    onClick={() => handleApprovePayment(selectedInvoice.id)}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 shadow-sm"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>
                      {selectedInvoice.payable_total_cents != null
                        ? t('payables.invoices.approveShort', { amount: formatMoney(selectedInvoice.payable_total_cents) })
                        : t('payables.invoices.approve')}
                    </span>
                  </button>
                )}

                {selectedInvoice.status === 'approved_for_payment' && (
                  <button
                    onClick={() => handleMarkPaid(selectedInvoice.id)}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 shadow-sm"
                  >
                    <CreditCard className="w-4 h-4" />
                    <span>{t('payables.invoices.executeAch')}</span>
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
