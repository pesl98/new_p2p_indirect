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
import { t, presentError, statusLabel } from '../i18n';
import { formatMoney } from '../money';
import { isServiceLine } from '../lineType';

export default function GoodsReceiptView({ currentUser, onDataChanged, focusId }) {
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
  const [allowOverReceipt, setAllowOverReceipt] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [grns, pos] = await Promise.all([
        api.getGoodsReceipts(),
        api.getPurchaseOrders()
      ]);
      setReceipts(grns);
      // Filter POs that still have unreceived items or are active
      setActivePOs(pos.filter(po => po.status !== 'closed' && po.status !== 'cancelled' && (po.goods_line_count || 0) > 0));
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
      handleOpenReceiptDetail(focusId);
    }
  }, [focusId]);

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
      const items = poDetail.items.filter((item) => !isServiceLine(item)).map(item => {
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
      alert(t('receiving.grn.needQuantity'));
      return;
    }

    const hasOverReceipt = receivingItems.some(
      (item) => Number(item.quantity_received) > 0
        && Number(item.received_already) + Number(item.quantity_received) > Number(item.ordered_qty)
    );
    if (hasOverReceipt && !allowOverReceipt) {
      alert(t('receiving.grn.overReceipt'));
      return;
    }

    try {
      await api.createGoodsReceipt({
        po_id: Number(selectedPOId),
        received_by: currentUser?.id,
        receipt_date: receiptDate,
        carrier_tracking: carrierTracking,
        delivery_note_number: deliveryNote,
        notes: receivingNotes,
        items: itemsToSubmit,
        allow_over_receipt: hasOverReceipt ? allowOverReceipt : false
      });

      setShowReceiveModal(false);
      setSelectedPOId('');
      setTargetPOData(null);
      setReceivingItems([]);
      setCarrierTracking('');
      setDeliveryNote('');
      setReceivingNotes('');
      setAllowOverReceipt(false);
      await loadData();
      if (onDataChanged) onDataChanged();
    } catch (err) {
      alert(presentError(err, 'errors.grn'));
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
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">{t('receiving.grn.title')}</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t('receiving.grn.intro')}
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowReceiveModal(true)}
            className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-sm transition-all flex items-center space-x-2"
          >
            <Plus className="w-4 h-4" />
            <span>{t('receiving.grn.receiveAgainstPo')}</span>
          </button>
        </div>
      </div>

      {/* Receipts Table */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">{t('receiving.grn.colReceipt')}</th>
                <th className="py-3 px-4">{t('receiving.grn.colPo')}</th>
                <th className="py-3 px-4">{t('common.supplier')}</th>
                <th className="py-3 px-4">{t('receiving.grn.colDate')}</th>
                <th className="py-3 px-4">{t('receiving.grn.colReceivedBy')}</th>
                <th className="py-3 px-4">{t('receiving.grn.colCarrier')}</th>
                <th className="py-3 px-4">{t('receiving.grn.colUnits')}</th>
                <th className="py-3 px-4 text-right">{t('common.action')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">{t('receiving.grn.loading')}</td>
                </tr>
              ) : receipts.length === 0 ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">{t('receiving.grn.empty')}</td>
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
                      {gr.carrier_tracking || gr.delivery_note_number || t('receiving.grn.internal')}
                    </td>
                    <td className="py-3 px-4 font-bold text-emerald-700">
                      {t('receiving.grn.units', { qty: gr.total_qty_received })}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => handleOpenReceiptDetail(gr.id)}
                        className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded font-semibold text-[11px] inline-flex items-center space-x-1"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>{t('receiving.grn.inspect')}</span>
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
                <h3 className="text-base font-bold text-slate-900">{t('receiving.grn.modalTitle')}</h3>
                <p className="text-xs text-slate-500">{t('receiving.grn.modalSubtitle')}</p>
              </div>
              <button onClick={() => setShowReceiveModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 space-y-4 text-xs overflow-y-auto flex-1">
              {/* PO Selection */}
              <div>
                <label className="block text-slate-700 font-semibold mb-1">{t('receiving.grn.selectPo')}</label>
                <select
                  value={selectedPOId}
                  onChange={(e) => handleSelectPO(e.target.value)}
                  className="w-full p-2.5 border border-slate-300 rounded-lg text-xs font-medium"
                >
                  <option value="">{t('receiving.choosePo')}</option>
                  {activePOs.map(po => (
                    <option key={po.id} value={po.id}>
                      {po.po_number} - {po.supplier_name} ({formatMoney(po.total_amount)}) [{statusLabel(po.status)}]
                    </option>
                  ))}
                </select>
              </div>

              {targetPOData && receivingItems.length === 0 && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-900">
                  {t('receiving.grn.noGoodsLines')}
                </div>
              )}

              {targetPOData && receivingItems.length > 0 && (
                <>
                  {/* Delivery Slip & Carrier Info */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                    <div>
                      <label className="block text-slate-500 text-[11px] mb-1">{t('receiving.grn.colDate')}</label>
                      <input
                        type="date"
                        value={receiptDate}
                        onChange={(e) => setReceiptDate(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-500 text-[11px] mb-1">{t('receiving.grn.carrier')}</label>
                      <input
                        type="text"
                        placeholder={t('receiving.grn.carrierPlaceholder')}
                        value={carrierTracking}
                        onChange={(e) => setCarrierTracking(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded-lg text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-500 text-[11px] mb-1">{t('receiving.grn.slip')}</label>
                      <input
                        type="text"
                        placeholder={t('receiving.grn.slipPlaceholder')}
                        value={deliveryNote}
                        onChange={(e) => setDeliveryNote(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded-lg text-xs font-mono"
                      />
                    </div>
                  </div>

                  {/* Line Items to Receive */}
                  <div>
                    <label className="block text-slate-700 font-bold uppercase tracking-wider text-[11px] mb-2">
                      {t('receiving.grn.inspectLines')}
                    </label>
                    <div className="border border-slate-200 rounded-xl overflow-hidden">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-100 border-b border-slate-200 text-slate-600 font-semibold">
                          <tr>
                            <th className="py-2.5 px-3">{t('receiving.grn.itemDescription')}</th>
                            <th className="py-2.5 px-3 text-center">{t('receiving.ordered')}</th>
                            <th className="py-2.5 px-3 text-center">{t('receiving.grn.alreadyReceived')}</th>
                            <th className="py-2.5 px-3 text-center w-24">{t('receiving.grn.receivingNow')}</th>
                            <th className="py-2.5 px-3">{t('receiving.grn.condition')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {receivingItems.map((item, idx) => {
                            const wouldOver = Number(item.received_already) + Number(item.quantity_received) > Number(item.ordered_qty);
                            return (
                            <tr key={idx} className={wouldOver ? 'bg-amber-50 hover:bg-amber-50' : 'hover:bg-slate-50'}>
                              <td className="py-2.5 px-3 font-medium text-slate-900">{item.description}</td>
                              <td className="py-2.5 px-3 text-center">{item.ordered_qty}</td>
                              <td className="py-2.5 px-3 text-center text-slate-500">{item.received_already}</td>
                              <td className="py-2.5 px-3 text-center">
                                <input
                                  type="number"
                                  min="0"
                                  value={item.quantity_received}
                                  onChange={(e) => handleUpdateItemQty(idx, e.target.value)}
                                  className={`w-20 text-center p-1.5 border rounded font-bold ${
                                    wouldOver ? 'border-amber-400 text-amber-800' : 'border-slate-300 text-emerald-700'
                                  }`}
                                />
                              </td>
                              <td className="py-2.5 px-3">
                                <select
                                  value={item.condition}
                                  onChange={(e) => handleUpdateItemCondition(idx, e.target.value)}
                                  className="p-1 border border-slate-300 rounded text-xs"
                                >
                                  <option value="good">{statusLabel('good')}</option>
                                  <option value="damaged">{statusLabel('damaged')}</option>
                                  <option value="partial">{statusLabel('partial')}</option>
                                  <option value="incorrect_item">{statusLabel('incorrect_item')}</option>
                                </select>
                              </td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-600 font-medium mb-1">{t('receiving.grn.notes')}</label>
                    <textarea
                      rows="2"
                      placeholder={t('receiving.grn.notesPlaceholder')}
                      value={receivingNotes}
                      onChange={(e) => setReceivingNotes(e.target.value)}
                      className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                    />
                  </div>

                  {receivingItems.some(
                    (item) => Number(item.received_already) + Number(item.quantity_received) > Number(item.ordered_qty)
                  ) && (
                    <label className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-900">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={allowOverReceipt}
                        onChange={(e) => setAllowOverReceipt(e.target.checked)}
                      />
                      <span>
                        <strong>{t('receiving.grn.allowOver')}</strong> {t('receiving.grn.allowOverDetail')}
                      </span>
                    </label>
                  )}
                </>
              )}
            </div>

            <div className="flex justify-end space-x-2 pt-4 border-t border-slate-200">
              <button
                onClick={() => setShowReceiveModal(false)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold"
              >
                {t('common.cancel')}
              </button>
              <button
                disabled={!targetPOData || receivingItems.length === 0}
                onClick={handleSubmitReceipt}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 shadow-sm"
              >
                <PackageCheck className="w-4 h-4" />
                <span>{t('receiving.grn.record')}</span>
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
                  <span className="bg-emerald-100 text-emerald-800 text-[11px] font-semibold px-2 py-0.5 rounded">{t('receiving.grn.verified')}</span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  {t('receiving.againstPo', { po: selectedReceipt.po_number, supplier: selectedReceipt.supplier_name })}
                </p>
              </div>
              <button onClick={() => setSelectedReceipt(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-4 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                <div>
                  <span className="text-slate-500">{t('receiving.grn.dateReceived')}</span>
                  <div className="font-semibold text-slate-900">{selectedReceipt.receipt_date}</div>
                </div>
                <div>
                  <span className="text-slate-500">{t('receiving.grn.receivedBy')}</span>
                  <div className="font-semibold text-slate-900">{selectedReceipt.received_by_name}</div>
                </div>
                <div>
                  <span className="text-slate-500">{t('receiving.grn.carrierTracking')}</span>
                  <div className="font-mono text-slate-900">{selectedReceipt.carrier_tracking || t('receiving.na')}</div>
                </div>
                <div>
                  <span className="text-slate-500">{t('receiving.grn.slipNumber')}</span>
                  <div className="font-mono text-slate-900">{selectedReceipt.delivery_note_number || t('receiving.na')}</div>
                </div>
              </div>

              <div>
                <span className="font-bold text-slate-800 uppercase tracking-wider text-[11px] block mb-2">
                  {t('receiving.grn.itemsDetail')}
                </span>
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-100 border-b border-slate-200 text-slate-600 font-semibold">
                      <tr>
                        <th className="py-2.5 px-3">{t('common.description')}</th>
                        <th className="py-2.5 px-3 text-center">{t('receiving.grn.qtyReceived')}</th>
                        <th className="py-2.5 px-3">{t('receiving.grn.condition')}</th>
                        <th className="py-2.5 px-3">{t('common.comments')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedReceipt.items?.map((item) => (
                        <tr key={item.id}>
                          <td className="py-2 px-3 font-medium text-slate-900">{item.item_description}</td>
                          <td className="py-2 px-3 text-center font-bold text-emerald-700">{item.quantity_received}</td>
                          <td className="py-2 px-3">
                            <span className="capitalize px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-medium">
                              {statusLabel(item.condition)}
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
                  <strong className="block text-[11px] text-slate-500 uppercase">{t('receiving.grn.inspectionLog')}</strong>
                  {selectedReceipt.notes}
                </div>
              )}
            </div>

            <div className="flex justify-end pt-3 border-t border-slate-200">
              <button
                onClick={() => setSelectedReceipt(null)}
                className="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold"
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
