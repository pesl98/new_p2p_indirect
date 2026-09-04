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
  ShieldAlert
} from 'lucide-react';
import { api } from '../api';
import { formatMoney, fromCents, toCents } from '../money';

export default function InvoicesMatchingView({ currentUser, onDataChanged }) {
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
  const [overrideReason, setOverrideReason] = useState('');

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

  const handleOpenDetail = async (id) => {
    try {
      const detail = await api.getInvoiceDetail(id);
      setSelectedInvoice(detail);
      setOverrideReason('');
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
        po_quantity: item.quantity,
        po_unit_price: item.unit_price,
        po_quantity_received: item.quantity_received,
        quantity_invoiced: item.quantity, // default to ordered
        unit_price: fromCents(item.unit_price) // billed price input is dollars
      }));
      setInvoiceLines(lines);
    } catch (err) {
      console.error(err);
    }
  };

  const handleLineChange = (index, field, value) => {
    const updated = [...invoiceLines];
    updated[index][field] = Number(value);
    setInvoiceLines(updated);
  };

  const calculateSubtotalCents = () => {
    return invoiceLines.reduce(
      (sum, item) => sum + Math.trunc(Number(item.quantity_invoiced) || 0) * toCents(item.unit_price),
      0
    );
  };

  const handleSubmitInvoice = async () => {
    if (!invoiceNumber || invoiceLines.length === 0) {
      alert('Please fill in invoice details and at least one line item.');
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
          quantity_invoiced: Math.trunc(Number(line.quantity_invoiced) || 0),
          unit_price: toCents(line.unit_price)
        }))
      });

      setShowCreateModal(false);
      setSelectedPOId('');
      setTargetPOData(null);
      setInvoiceLines([]);
      await loadData();
      if (onDataChanged) onDataChanged();
      handleOpenDetail(result.invoiceId);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleApprovePayment = async (invId) => {
    try {
      await api.approveInvoicePayment(invId, {
        approver_name: currentUser?.name || 'David Miller (Finance)',
        override_reason: overrideReason
      });
      await loadData();
      if (onDataChanged) onDataChanged();
      handleOpenDetail(invId);
    } catch (err) {
      alert(err.message);
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
      alert(err.message);
    }
  };

  const getMatchBadge = (matchStatus) => {
    switch (matchStatus) {
      case 'perfect_match':
        return (
          <span className="bg-emerald-100 text-emerald-800 text-xs px-2.5 py-1 rounded-full font-bold flex items-center space-x-1">
            <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
            <span>Exact 3-Way Match</span>
          </span>
        );
      case 'tolerated_match':
        return (
          <span className="bg-amber-100 text-amber-800 text-xs px-2.5 py-1 rounded-full font-bold flex items-center space-x-1">
            <AlertTriangle className="w-3.5 h-3.5 mr-1" />
            <span>Tolerated Variance</span>
          </span>
        );
      case 'price_variance':
        return (
          <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-bold flex items-center space-x-1">
            <XCircle className="w-3.5 h-3.5 mr-1" />
            <span>Price Discrepancy</span>
          </span>
        );
      case 'quantity_variance':
        return (
          <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-bold flex items-center space-x-1">
            <XCircle className="w-3.5 h-3.5 mr-1" />
            <span>Quantity Variance</span>
          </span>
        );
      case 'total_variance':
        return (
          <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-bold flex items-center space-x-1">
            <ShieldAlert className="w-3.5 h-3.5 mr-1" />
            <span>Multiple Variances</span>
          </span>
        );
      default:
        return <span className="bg-slate-100 text-slate-700 text-xs px-2 py-0.5 rounded">Pending Match</span>;
    }
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'approved_for_payment':
        return <span className="bg-indigo-100 text-indigo-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Approved for Payment</span>;
      case 'paid':
        return <span className="bg-emerald-100 text-emerald-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Paid</span>;
      case 'variance_flagged':
        return <span className="bg-rose-100 text-rose-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">Discrepancy Flagged</span>;
      default:
        return <span className="bg-slate-100 text-slate-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">{status}</span>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Invoices & Automated 3-Way Matching</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Automated reconciliation comparing Purchase Orders (PO) vs. Physical Goods Receipts (GRN) vs. Supplier Invoices.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowCreateModal(true)}
            className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-sm transition-all flex items-center space-x-2"
          >
            <Plus className="w-4 h-4" />
            <span>Enter Vendor Invoice</span>
          </button>
        </div>
      </div>

      {/* Invoice Table */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">Invoice #</th>
                <th className="py-3 px-4">Supplier</th>
                <th className="py-3 px-4">PO Reference</th>
                <th className="py-3 px-4">Billed Amount</th>
                <th className="py-3 px-4">3-Way Match Audit</th>
                <th className="py-3 px-4">Invoice Status</th>
                <th className="py-3 px-4">Due Date</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">Loading invoices...</td>
                </tr>
              ) : invoices.length === 0 ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">No invoices entered yet.</td>
                </tr>
              ) : (
                invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-slate-900">
                      {inv.invoice_number}
                    </td>
                    <td className="py-3 px-4 font-medium text-slate-900">
                      {inv.supplier_name}
                    </td>
                    <td className="py-3 px-4 font-mono text-indigo-700 font-semibold">
                      {inv.po_number}
                    </td>
                    <td className="py-3 px-4 font-bold text-slate-900 text-sm">
                      ${formatMoney(inv.total_amount)}
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
                        <span>3-Way Matrix</span>
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
                <h3 className="text-base font-bold text-slate-900">Enter Supplier Vendor Invoice</h3>
                <p className="text-xs text-slate-500">Input invoice received from vendor and run the automated 3-way match engine</p>
              </div>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 space-y-4 text-xs overflow-y-auto flex-1">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Select Associated Purchase Order</label>
                <select
                  value={selectedPOId}
                  onChange={(e) => handleSelectPO(e.target.value)}
                  className="w-full p-2.5 border border-slate-300 rounded-lg text-xs font-medium"
                >
                  <option value="">-- Choose Purchase Order --</option>
                  {activePOs.map(po => (
                    <option key={po.id} value={po.id}>
                      {po.po_number} - {po.supplier_name} (${formatMoney(po.total_amount)}) [{po.status}]
                    </option>
                  ))}
                </select>
              </div>

              {targetPOData && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                    <div>
                      <label className="block text-slate-500 text-[11px] mb-1">Vendor Invoice #</label>
                      <input
                        type="text"
                        value={invoiceNumber}
                        onChange={(e) => setInvoiceNumber(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded-lg text-xs font-mono font-bold"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-500 text-[11px] mb-1">Invoice Date</label>
                      <input
                        type="date"
                        value={invoiceDate}
                        onChange={(e) => setInvoiceDate(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-500 text-[11px] mb-1">Payment Due Date</label>
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
                        Invoice Line Items (Billed Values)
                      </span>
                      <span className="text-emerald-700 font-bold">
                        Calculated Subtotal: ${formatMoney(calculateSubtotalCents())}
                      </span>
                    </div>

                    <div className="border border-slate-200 rounded-xl overflow-hidden">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-100 border-b border-slate-200 text-slate-600 font-semibold text-[11px]">
                          <tr>
                            <th className="py-2.5 px-3">Description</th>
                            <th className="py-2.5 px-3 text-center">PO Price</th>
                            <th className="py-2.5 px-3 text-center">Physically Recv</th>
                            <th className="py-2.5 px-3 text-center w-28">Billed Qty</th>
                            <th className="py-2.5 px-3 text-center w-28">Billed Price</th>
                            <th className="py-2.5 px-3 text-right">Line Total</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {invoiceLines.map((line, idx) => (
                            <tr key={idx} className="hover:bg-slate-50">
                              <td className="py-2.5 px-3 font-medium text-slate-900">{line.description}</td>
                              <td className="py-2.5 px-3 text-center text-slate-500">${formatMoney(line.po_unit_price)}</td>
                              <td className="py-2.5 px-3 text-center font-semibold text-slate-800">{line.po_quantity_received}</td>
                              <td className="py-2.5 px-3 text-center">
                                <input
                                  type="number"
                                  min="0"
                                  value={line.quantity_invoiced}
                                  onChange={(e) => handleLineChange(idx, 'quantity_invoiced', e.target.value)}
                                  className="w-20 text-center p-1.5 border border-slate-300 rounded font-semibold"
                                />
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                <input
                                  type="number"
                                  step="0.01"
                                  value={line.unit_price}
                                  onChange={(e) => handleLineChange(idx, 'unit_price', e.target.value)}
                                  className="w-24 text-center p-1.5 border border-slate-300 rounded font-semibold"
                                />
                              </td>
                              <td className="py-2.5 px-3 text-right font-bold text-slate-900">
                                ${formatMoney(Math.trunc(Number(line.quantity_invoiced) || 0) * toCents(line.unit_price))}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1.5">
                      💡 Tip: Try editing the billed price or quantity above to observe the 3-Way Matching engine automatically catch discrepancies!
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
                Cancel
              </button>
              <button
                disabled={!targetPOData}
                onClick={handleSubmitInvoice}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 shadow-sm"
              >
                <FileCheck className="w-4 h-4" />
                <span>Submit & Run 3-Way Match</span>
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
                <div className="flex items-center space-x-3">
                  <h3 className="text-lg font-mono font-bold text-slate-900">{selectedInvoice.invoice_number}</h3>
                  {getMatchBadge(selectedInvoice.match_status)}
                  {getStatusBadge(selectedInvoice.status)}
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Vendor: <strong>{selectedInvoice.supplier_name}</strong> • Against <strong>{selectedInvoice.po_number}</strong>
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
                  <span>3-Way Line Reconciliation Matrix</span>
                  <span className="text-slate-400 font-normal">(PO vs. Physical Goods Receipt vs. Billed Invoice)</span>
                </h4>

                <div className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-100 border-b border-slate-200 text-slate-700 font-bold uppercase text-[10px]">
                      <tr>
                        <th className="py-2.5 px-3">Item Description</th>
                        <th className="py-2.5 px-3 text-center bg-blue-50/70 text-blue-900">1. PO Ordered</th>
                        <th className="py-2.5 px-3 text-center bg-blue-50/70 text-blue-900">PO Unit Price</th>
                        <th className="py-2.5 px-3 text-center bg-amber-50/70 text-amber-900">2. Physically Recv</th>
                        <th className="py-2.5 px-3 text-center bg-purple-50/70 text-purple-900">3. Invoiced Qty</th>
                        <th className="py-2.5 px-3 text-center bg-purple-50/70 text-purple-900">Invoiced Price</th>
                        <th className="py-2.5 px-3 text-center">3-Way Match Status</th>
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
                            <td className="py-2.5 px-3 text-center bg-blue-50/30 font-semibold">{res.ordered_qty}</td>
                            <td className="py-2.5 px-3 text-center bg-blue-50/30 text-slate-700">${formatMoney(res.po_unit_price)}</td>
                            <td className="py-2.5 px-3 text-center bg-amber-50/30 font-bold text-amber-900">{res.received_qty}</td>
                            <td className="py-2.5 px-3 text-center bg-purple-50/30 font-bold">{res.invoiced_qty}</td>
                            <td className="py-2.5 px-3 text-center bg-purple-50/30 font-bold">${formatMoney(res.invoice_unit_price)}</td>
                            <td className="py-2.5 px-3 text-center">
                              {isFail ? (
                                <span className="bg-rose-100 text-rose-800 text-[10px] font-bold px-2 py-0.5 rounded-full inline-flex items-center">
                                  <XCircle className="w-3 h-3 mr-1" />
                                  Fail Discrepancy
                                </span>
                              ) : isWarning ? (
                                <span className="bg-amber-100 text-amber-800 text-[10px] font-bold px-2 py-0.5 rounded-full inline-flex items-center">
                                  <AlertTriangle className="w-3 h-3 mr-1" />
                                  Warning
                                </span>
                              ) : (
                                <span className="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2 py-0.5 rounded-full inline-flex items-center">
                                  <CheckCircle2 className="w-3 h-3 mr-1" />
                                  100% Match
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
                    <span>Automated Engine Findings & Discrepancy Analysis:</span>
                  </div>
                  <ul className="list-disc list-inside text-[11px] space-y-1">
                    {selectedInvoice.match_results?.filter(r => r.status !== 'pass').map((r, i) => (
                      <li key={i}>{r.message}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Financial Totals */}
              <div className="grid grid-cols-3 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200">
                <div>
                  <span className="text-slate-500 text-[11px]">Authorized PO Value:</span>
                  <div className="font-bold text-slate-900 text-sm">
                    ${formatMoney(selectedInvoice.po_total_amount)}
                  </div>
                </div>
                <div>
                  <span className="text-slate-500 text-[11px]">Billed Total (With Tax):</span>
                  <div className="font-bold text-slate-900 text-sm">
                    ${formatMoney(selectedInvoice.total_amount)}
                  </div>
                </div>
                <div>
                  <span className="text-slate-500 text-[11px]">Department Cost Center:</span>
                  <div className="font-bold text-slate-900 text-sm">
                    {selectedInvoice.department_name || 'Corporate'}
                  </div>
                </div>
              </div>

              {/* AP Actions & Payment Status */}
              {selectedInvoice.status === 'variance_flagged' && (
                <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 space-y-2">
                  <label className="block text-slate-700 font-bold text-[11px]">
                    Finance / AP Override Approval Reason (Required if overriding variances):
                  </label>
                  <input
                    type="text"
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="e.g. Approved price variance authorized by VP Marketing..."
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  />
                </div>
              )}
            </div>

            {/* Footer Buttons */}
            <div className="flex items-center justify-between pt-4 border-t border-slate-200">
              <div className="text-slate-500 text-xs">
                {selectedInvoice.payment_reference && (
                  <span>Payment Ref: <strong className="font-mono text-emerald-700">{selectedInvoice.payment_reference}</strong></span>
                )}
              </div>

              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setSelectedInvoice(null)}
                  className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold"
                >
                  Close
                </button>

                {selectedInvoice.status !== 'approved_for_payment' && selectedInvoice.status !== 'paid' && (
                  <button
                    onClick={() => handleApprovePayment(selectedInvoice.id)}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 shadow-sm"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Approve for Payment</span>
                  </button>
                )}

                {selectedInvoice.status === 'approved_for_payment' && (
                  <button
                    onClick={() => handleMarkPaid(selectedInvoice.id)}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 shadow-sm"
                  >
                    <CreditCard className="w-4 h-4" />
                    <span>Execute ACH Payment</span>
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
