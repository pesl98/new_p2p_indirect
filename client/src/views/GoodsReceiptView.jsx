import React, { useState, useEffect } from 'react';
import { 
  PackageCheck, 
  Plus, 
  Search, 
  Truck, 
  CheckCircle, 
  AlertCircle, 
  Eye, 
  Building2, 
  X,
  FileCheck
} from 'lucide-react';
import { api } from '../api';
import { formatMoney } from '../money';

export default function GoodsReceiptView({ currentUser, onDataChanged }) {
  const [receipts, setReceipts] = useState([]);
  const [activePOs, setActivePOs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showReceiveModal, setShowReceiveModal] = useState(false);
  const [selectedPOId, setSelectedPOId] = useState('');
  const [targetPOData, setTargetPOData] = useState(null);
  const [selectedReceipt, setSelectedReceipt] = useState(null);

  // Receiving Form State
  const [receiptDate, setReceiptDate] = useState(new Date().toISOString().split('T')[0]);
  const [carrierTracking, setCarrierTracking] = useState('');
  const [deliveryNote, setDeliveryNote] = useState('');
  const [receivingNotes, setReceivingNotes] = useState('');
  const [receivingItems, setReceivingItems] = useState([]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [grns, pos] = await Promise.all([
        api.getGoodsReceipts(),
        api.getPurchaseOrders()
      ]);
      setReceipts(grns);
      // Filter POs that still have unreceived items or are active
      setActivePOs(pos.filter(po => po.status !== 'closed' && po.status !== 'cancelled'));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSelectPO = async (poId) => {
    setSelectedPOId(poId);
    if (!poId) {
      setTargetPOData(null);
      setReceivingItems([]);
      return;
    }

    try {
      const poDetail = await api.getPurchaseOrderDetail(poId);
      setTargetPOData(poDetail);
      // Initialize receiving lines
      const items = poDetail.items.map(item => {
        const remaining = Math.max(0, item.quantity - item.quantity_received);
        return {
          po_item_id: item.id,
          description: item.item_description,
          ordered_qty: item.quantity,
          received_already: item.quantity_received,
          remaining_qty: remaining,
          quantity_received: remaining, // default to remaining
          condition: 'good',
          comments: ''
        };
      });
      setReceivingItems(items);
    } catch (err) {
      console.error(err);
    }
  };

  const handleUpdateItemQty = (index, val) => {
    const updated = [...receivingItems];
    updated[index].quantity_received = Number(val);
    setReceivingItems(updated);
  };

  const handleUpdateItemCondition = (index, val) => {
    const updated = [...receivingItems];
    updated[index].condition = val;
    setReceivingItems(updated);
  };

  const handleUpdateItemComment = (index, val) => {
    const updated = [...receivingItems];
    updated[index].comments = val;
    setReceivingItems(updated);
  };

  const handleSubmitReceipt = async () => {
    const itemsToSubmit = receivingItems
      .filter(item => Number(item.quantity_received) > 0)
      .map(item => ({
        po_item_id: item.po_item_id,
        quantity_received: Number(item.quantity_received),
        condition: item.condition,
        comments: item.comments
      }));

    if (itemsToSubmit.length === 0) {
      alert('Please enter at least one received quantity greater than 0.');
      return;
    }

    try {
      await api.createGoodsReceipt({
        po_id: Number(selectedPOId),
        received_by: currentUser?.id || 3,
        receipt_date: receiptDate,
        carrier_tracking: carrierTracking,
        delivery_note_number: deliveryNote,
        notes: receivingNotes,
        items: itemsToSubmit
      });

      setShowReceiveModal(false);
      setSelectedPOId('');
      setTargetPOData(null);
      setReceivingItems([]);
      setCarrierTracking('');
      setDeliveryNote('');
      setReceivingNotes('');
      await loadData();
      if (onDataChanged) onDataChanged();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleOpenReceiptDetail = async (id) => {
    try {
      const detail = await api.getGoodsReceiptDetail(id);
      setSelectedReceipt(detail);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Goods & Service Receipts (GRN)</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Log physical deliveries, verify packaging conditions, and authorize partial shipments for 3-way matching.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowReceiveModal(true)}
            className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-sm transition-all flex items-center space-x-2"
          >
            <Plus className="w-4 h-4" />
            <span>Receive Against PO</span>
          </button>
        </div>
      </div>

      {/* Receipts Table */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">Receipt (GRN #)</th>
                <th className="py-3 px-4">PO Reference</th>
                <th className="py-3 px-4">Supplier</th>
                <th className="py-3 px-4">Receipt Date</th>
                <th className="py-3 px-4">Received By</th>
                <th className="py-3 px-4">Carrier / Slip #</th>
                <th className="py-3 px-4">Units Received</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">Loading goods receipts...</td>
                </tr>
              ) : receipts.length === 0 ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">No goods receipts recorded yet.</td>
                </tr>
              ) : (
                receipts.map((gr) => (
                  <tr key={gr.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-slate-900">
                      {gr.grn_number}
                    </td>
                    <td className="py-3 px-4 font-mono text-indigo-700 font-semibold">
                      {gr.po_number}
                    </td>
                    <td className="py-3 px-4 font-medium text-slate-900">
                      {gr.supplier_name}
                    </td>
                    <td className="py-3 px-4 text-slate-500">
                      {gr.receipt_date}
                    </td>
                    <td className="py-3 px-4 text-slate-700">
                      {gr.received_by_name}
                    </td>
                    <td className="py-3 px-4 text-slate-500 font-mono text-[11px]">
                      {gr.carrier_tracking || gr.delivery_note_number || 'Internal'}
                    </td>
                    <td className="py-3 px-4 font-bold text-emerald-700">
                      {gr.total_qty_received} units
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => handleOpenReceiptDetail(gr.id)}
                        className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded font-semibold text-[11px] inline-flex items-center space-x-1"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>Inspect</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Receive Against PO Wizard Modal */}
      {showReceiveModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-3xl w-full p-6 shadow-2xl border border-slate-200 max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div>
                <h3 className="text-base font-bold text-slate-900">Receive Goods or Services</h3>
                <p className="text-xs text-slate-500">Document physical delivery against an active Purchase Order</p>
              </div>
              <button onClick={() => setShowReceiveModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 space-y-4 text-xs overflow-y-auto flex-1">
              {/* PO Selection */}
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Select Active Purchase Order</label>
                <select
                  value={selectedPOId}
                  onChange={(e) => handleSelectPO(e.target.value)}
                  className="w-full p-2.5 border border-slate-300 rounded-lg text-xs font-medium"
                >
                  <option value="">-- Choose a Purchase Order --</option>
                  {activePOs.map(po => (
                    <option key={po.id} value={po.id}>
                      {po.po_number} - {po.supplier_name} (${formatMoney(po.total_amount)}) [{po.status}]
                    </option>
                  ))}
                </select>
              </div>

              {targetPOData && (
                <>
                  {/* Delivery Slip & Carrier Info */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                    <div>
                      <label className="block text-slate-500 text-[11px] mb-1">Receipt Date</label>
                      <input
                        type="date"
                        value={receiptDate}
                        onChange={(e) => setReceiptDate(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-500 text-[11px] mb-1">Carrier Tracking #</label>
                      <input
                        type="text"
                        placeholder="e.g. FEDEX-889123"
                        value={carrierTracking}
                        onChange={(e) => setCarrierTracking(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded-lg text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-500 text-[11px] mb-1">Supplier Delivery Slip #</label>
                      <input
                        type="text"
                        placeholder="e.g. DN-9021"
                        value={deliveryNote}
                        onChange={(e) => setDeliveryNote(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded-lg text-xs font-mono"
                      />
                    </div>
                  </div>

                  {/* Line Items to Receive */}
                  <div>
                    <label className="block text-slate-700 font-bold uppercase tracking-wider text-[11px] mb-2">
                      Inspect & Confirm Line Quantities
                    </label>
                    <div className="border border-slate-200 rounded-xl overflow-hidden">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-100 border-b border-slate-200 text-slate-600 font-semibold">
                          <tr>
                            <th className="py-2.5 px-3">Item Description</th>
                            <th className="py-2.5 px-3 text-center">Ordered</th>
                            <th className="py-2.5 px-3 text-center">Already Recv</th>
                            <th className="py-2.5 px-3 text-center w-24">Receiving Now</th>
                            <th className="py-2.5 px-3">Condition</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {receivingItems.map((item, idx) => (
                            <tr key={idx} className="hover:bg-slate-50">
                              <td className="py-2.5 px-3 font-medium text-slate-900">{item.description}</td>
                              <td className="py-2.5 px-3 text-center">{item.ordered_qty}</td>
                              <td className="py-2.5 px-3 text-center text-slate-500">{item.received_already}</td>
                              <td className="py-2.5 px-3 text-center">
                                <input
                                  type="number"
                                  min="0"
                                  max={item.remaining_qty}
                                  value={item.quantity_received}
                                  onChange={(e) => handleUpdateItemQty(idx, e.target.value)}
                                  className="w-20 text-center p-1.5 border border-slate-300 rounded font-bold text-emerald-700"
                                />
                              </td>
                              <td className="py-2.5 px-3">
                                <select
                                  value={item.condition}
                                  onChange={(e) => handleUpdateItemCondition(idx, e.target.value)}
                                  className="p-1 border border-slate-300 rounded text-xs"
                                >
                                  <option value="good">Good Condition</option>
                                  <option value="damaged">Damaged Box/Item</option>
                                  <option value="partial">Partial Delivery</option>
                                  <option value="incorrect_item">Incorrect Spec</option>
                                </select>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-600 font-medium mb-1">Receiving Notes / Inspection Comments</label>
                    <textarea
                      rows="2"
                      placeholder="e.g. Unboxed in receiving bay 2, tested power, verified serial numbers..."
                      value={receivingNotes}
                      onChange={(e) => setReceivingNotes(e.target.value)}
                      className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end space-x-2 pt-4 border-t border-slate-200">
              <button
                onClick={() => setShowReceiveModal(false)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                disabled={!targetPOData}
                onClick={handleSubmitReceipt}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 shadow-sm"
              >
                <PackageCheck className="w-4 h-4" />
                <span>Record Goods Receipt (GRN)</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Goods Receipt Detail Inspection Modal */}
      {selectedReceipt && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div>
                <div className="flex items-center space-x-2">
                  <h3 className="text-base font-mono font-bold text-slate-900">{selectedReceipt.grn_number}</h3>
                  <span className="bg-emerald-100 text-emerald-800 text-[11px] font-semibold px-2 py-0.5 rounded">Verified Inward</span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Against PO {selectedReceipt.po_number} from {selectedReceipt.supplier_name}
                </p>
              </div>
              <button onClick={() => setSelectedReceipt(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-4 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                <div>
                  <span className="text-slate-500">Date Received:</span>
                  <div className="font-semibold text-slate-900">{selectedReceipt.receipt_date}</div>
                </div>
                <div>
                  <span className="text-slate-500">Received By:</span>
                  <div className="font-semibold text-slate-900">{selectedReceipt.received_by_name}</div>
                </div>
                <div>
                  <span className="text-slate-500">Carrier Tracking:</span>
                  <div className="font-mono text-slate-900">{selectedReceipt.carrier_tracking || 'N/A'}</div>
                </div>
                <div>
                  <span className="text-slate-500">Delivery Slip #:</span>
                  <div className="font-mono text-slate-900">{selectedReceipt.delivery_note_number || 'N/A'}</div>
                </div>
              </div>

              <div>
                <span className="font-bold text-slate-800 uppercase tracking-wider text-[11px] block mb-2">
                  Received Items Detail
                </span>
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-100 border-b border-slate-200 text-slate-600 font-semibold">
                      <tr>
                        <th className="py-2.5 px-3">Description</th>
                        <th className="py-2.5 px-3 text-center">Qty Received</th>
                        <th className="py-2.5 px-3">Condition</th>
                        <th className="py-2.5 px-3">Comments</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedReceipt.items?.map((item) => (
                        <tr key={item.id}>
                          <td className="py-2 px-3 font-medium text-slate-900">{item.item_description}</td>
                          <td className="py-2 px-3 text-center font-bold text-emerald-700">{item.quantity_received}</td>
                          <td className="py-2 px-3">
                            <span className="capitalize px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-medium">
                              {item.condition}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-slate-500">{item.comments || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {selectedReceipt.notes && (
                <div className="p-3 bg-slate-50 rounded-lg text-slate-700 text-xs border border-slate-200">
                  <strong className="block text-[11px] text-slate-500 uppercase">Receiving Inspection Log:</strong>
                  {selectedReceipt.notes}
                </div>
              )}
            </div>

            <div className="flex justify-end pt-3 border-t border-slate-200">
              <button
                onClick={() => setSelectedReceipt(null)}
                className="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
