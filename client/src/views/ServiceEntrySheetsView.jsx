import React, { useState, useEffect } from 'react';
import {
  ClipboardCheck,
  Plus,
  Eye,
  X,
  CheckCircle,
  XCircle
} from 'lucide-react';
import { api } from '../api';
import { formatMoney } from '../money';
import { isServiceLine } from '../lineType';

export default function ServiceEntrySheetsView({ currentUser, onDataChanged, focusId }) {
  const [sheets, setSheets] = useState([]);
  const [activePOs, setActivePOs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedPOId, setSelectedPOId] = useState('');
  const [targetPOData, setTargetPOData] = useState(null);
  const [selectedSES, setSelectedSES] = useState(null);

  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [sesNotes, setSesNotes] = useState('');
  const [sesItems, setSesItems] = useState([]);
  const [submitImmediately, setSubmitImmediately] = useState(true);
  const [allowOverAcceptance, setAllowOverAcceptance] = useState(false);
  const [decisionComments, setDecisionComments] = useState('');

  const canDecide = ['procurement', 'finance', 'admin'].includes(currentUser?.role);

  const loadData = async () => {
    setLoading(true);
    try {
      const [sesList, pos] = await Promise.all([
        api.getServiceEntrySheets(),
        api.getPurchaseOrders()
      ]);
      setSheets(sesList);
      setActivePOs(pos.filter((po) => po.status !== 'closed' && po.status !== 'cancelled' && (po.service_line_count || 0) > 0));
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

  const handleSelectPO = async (poId) => {
    setSelectedPOId(poId);
    if (!poId) {
      setTargetPOData(null);
      setSesItems([]);
      return;
    }

    try {
      const poDetail = await api.getPurchaseOrderDetail(poId);
      setTargetPOData(poDetail);
      const items = (poDetail.items || [])
        .filter((item) => isServiceLine(item))
        .map((item) => {
          const remaining = Math.max(0, item.quantity - (item.quantity_accepted || 0));
          return {
            po_item_id: item.id,
            description: item.item_description,
            ordered_qty: item.quantity,
            accepted_already: item.quantity_accepted || 0,
            remaining_qty: remaining,
            unit_price: item.unit_price,
            quantity_accepted: remaining,
            comments: ''
          };
        });
      setSesItems(items);
    } catch (err) {
      console.error(err);
    }
  };

  const handleUpdateItem = (index, field, value) => {
    const updated = [...sesItems];
    updated[index][field] = field === 'comments' ? value : Number(value);
    setSesItems(updated);
  };

  const resetCreateForm = () => {
    setShowCreateModal(false);
    setSelectedPOId('');
    setTargetPOData(null);
    setSesItems([]);
    setPeriodStart('');
    setPeriodEnd('');
    setSesNotes('');
    setSubmitImmediately(true);
  };

  const handleSubmitSES = async () => {
    const itemsToSubmit = sesItems
      .filter((item) => Number(item.quantity_accepted) > 0)
      .map((item) => ({
        po_item_id: item.po_item_id,
        quantity_accepted: Number(item.quantity_accepted),
        comments: item.comments
      }));

    if (itemsToSubmit.length === 0) {
      alert('Please enter at least one accepted quantity greater than 0.');
      return;
    }

    try {
      const created = await api.createServiceEntrySheet({
        po_id: Number(selectedPOId),
        created_by: currentUser?.id || 1,
        service_period_start: periodStart || null,
        service_period_end: periodEnd || null,
        notes: sesNotes,
        items: itemsToSubmit,
        submitImmediately,
        actor_name: currentUser?.name || 'Requester'
      });
      resetCreateForm();
      await loadData();
      if (onDataChanged) onDataChanged();
      handleOpenDetail(created.sesId);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleOpenDetail = async (id) => {
    try {
      const detail = await api.getServiceEntrySheetDetail(id);
      setSelectedSES(detail);
      setAllowOverAcceptance(false);
      setDecisionComments('');
    } catch (err) {
      console.error(err);
    }
  };

  const handleSubmitDraft = async (id) => {
    try {
      await api.submitServiceEntrySheet(id, { actor_name: currentUser?.name || 'Requester' });
      await loadData();
      if (onDataChanged) onDataChanged();
      handleOpenDetail(id);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleAccept = async (id) => {
    try {
      await api.acceptServiceEntrySheet(id, {
        decided_by: currentUser?.id || 3,
        actor_name: currentUser?.name || 'Procurement Officer',
        decision_comments: decisionComments,
        allow_over_acceptance: allowOverAcceptance
      });
      await loadData();
      if (onDataChanged) onDataChanged();
      handleOpenDetail(id);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleReject = async (id) => {
    try {
      await api.rejectServiceEntrySheet(id, {
        decided_by: currentUser?.id || 3,
        actor_name: currentUser?.name || 'Procurement Officer',
        decision_comments: decisionComments
      });
      await loadData();
      if (onDataChanged) onDataChanged();
      handleOpenDetail(id);
    } catch (err) {
      alert(err.message);
    }
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'draft':
        return <span className="bg-slate-100 text-slate-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">Draft</span>;
      case 'submitted':
        return <span className="bg-amber-100 text-amber-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Submitted</span>;
      case 'accepted':
        return <span className="bg-emerald-100 text-emerald-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Accepted</span>;
      case 'rejected':
        return <span className="bg-rose-100 text-rose-800 text-[11px] font-semibold px-2 py-0.5 rounded-full">Rejected</span>;
      default:
        return <span className="bg-slate-100 text-slate-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">{status}</span>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Service Entry Sheets (SES)</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Accept consulting, SaaS, and professional-service PO lines. Accepted qty is the receipt basis for SES-backed invoice match — no physical GRN.
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-sm transition-all flex items-center space-x-2"
        >
          <Plus className="w-4 h-4" />
          <span>Create Service Entry Sheet</span>
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">SES Number</th>
                <th className="py-3 px-4">PO Reference</th>
                <th className="py-3 px-4">Supplier</th>
                <th className="py-3 px-4">Period</th>
                <th className="py-3 px-4">Created By</th>
                <th className="py-3 px-4">Accepted Qty / Amount</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">Loading service entry sheets...</td>
                </tr>
              ) : sheets.length === 0 ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">No service entry sheets recorded yet.</td>
                </tr>
              ) : (
                sheets.map((ses) => (
                  <tr key={ses.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-slate-900">{ses.ses_number}</td>
                    <td className="py-3 px-4 font-mono text-indigo-700 font-semibold">{ses.po_number}</td>
                    <td className="py-3 px-4 font-medium text-slate-900">{ses.supplier_name}</td>
                    <td className="py-3 px-4 text-slate-500">
                      {ses.service_period_start || ses.service_period_end
                        ? `${ses.service_period_start || '—'} → ${ses.service_period_end || '—'}`
                        : '—'}
                    </td>
                    <td className="py-3 px-4 text-slate-700">{ses.created_by_name}</td>
                    <td className="py-3 px-4">
                      <div className="font-bold text-indigo-700">{ses.total_qty_accepted} units</div>
                      <div className="text-[10px] text-slate-400">${formatMoney(ses.total_amount_cents)}</div>
                    </td>
                    <td className="py-3 px-4">{getStatusBadge(ses.status)}</td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => handleOpenDetail(ses.id)}
                        className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded font-semibold text-[11px] inline-flex items-center space-x-1"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>Review</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showCreateModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-3xl w-full p-6 shadow-2xl border border-slate-200 max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div>
                <h3 className="text-base font-bold text-slate-900">Create Service Entry Sheet</h3>
                <p className="text-xs text-slate-500">Record accepted service qty against open service PO lines</p>
              </div>
              <button onClick={resetCreateForm} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 space-y-4 text-xs overflow-y-auto flex-1">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Select Purchase Order (service lines)</label>
                <select
                  value={selectedPOId}
                  onChange={(e) => handleSelectPO(e.target.value)}
                  className="w-full p-2.5 border border-slate-300 rounded-lg text-xs font-medium"
                >
                  <option value="">-- Choose a Purchase Order --</option>
                  {activePOs.map((po) => (
                    <option key={po.id} value={po.id}>
                      {po.po_number} - {po.supplier_name} (${formatMoney(po.total_amount)}) [{po.status}]
                    </option>
                  ))}
                </select>
              </div>

              {targetPOData && sesItems.length === 0 && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-900">
                  This PO has no service lines. Use Goods Receipt (GRN) for physical items.
                </div>
              )}

              {sesItems.length > 0 && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                    <div>
                      <label className="block text-slate-500 text-[11px] mb-1">Service Period Start</label>
                      <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg text-xs" />
                    </div>
                    <div>
                      <label className="block text-slate-500 text-[11px] mb-1">Service Period End</label>
                      <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg text-xs" />
                    </div>
                  </div>

                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-100 border-b border-slate-200 text-slate-600 font-semibold">
                        <tr>
                          <th className="py-2.5 px-3">Service Description</th>
                          <th className="py-2.5 px-3 text-center">Ordered</th>
                          <th className="py-2.5 px-3 text-center">Already Accepted</th>
                          <th className="py-2.5 px-3 text-center w-24">Accepting Now</th>
                          <th className="py-2.5 px-3 text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {sesItems.map((item, idx) => {
                          const wouldOver = Number(item.accepted_already) + Number(item.quantity_accepted) > Number(item.ordered_qty);
                          return (
                            <tr key={idx} className={wouldOver ? 'bg-amber-50' : 'hover:bg-slate-50'}>
                              <td className="py-2.5 px-3 font-medium text-slate-900">{item.description}</td>
                              <td className="py-2.5 px-3 text-center">{item.ordered_qty}</td>
                              <td className="py-2.5 px-3 text-center text-slate-500">{item.accepted_already}</td>
                              <td className="py-2.5 px-3 text-center">
                                <input
                                  type="number"
                                  min="0"
                                  value={item.quantity_accepted}
                                  onChange={(e) => handleUpdateItem(idx, 'quantity_accepted', e.target.value)}
                                  className={`w-20 text-center p-1.5 border rounded font-bold ${wouldOver ? 'border-amber-400 text-amber-800' : 'border-slate-300 text-indigo-700'}`}
                                />
                              </td>
                              <td className="py-2.5 px-3 text-right font-bold text-slate-900">
                                ${formatMoney(Math.trunc(Number(item.quantity_accepted) || 0) * item.unit_price)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <textarea
                    rows="2"
                    placeholder="Acceptance notes (deliverable, period, stakeholder sign-off)..."
                    value={sesNotes}
                    onChange={(e) => setSesNotes(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  />

                  <label className="flex items-start gap-2 text-slate-700">
                    <input type="checkbox" className="mt-0.5" checked={submitImmediately} onChange={(e) => setSubmitImmediately(e.target.checked)} />
                    <span>Submit immediately for procurement / finance acceptance</span>
                  </label>
                </>
              )}
            </div>

            <div className="flex justify-end space-x-2 pt-4 border-t border-slate-200">
              <button onClick={resetCreateForm} className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold">Cancel</button>
              <button
                disabled={!targetPOData || sesItems.length === 0}
                onClick={handleSubmitSES}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 shadow-sm"
              >
                <ClipboardCheck className="w-4 h-4" />
                <span>{submitImmediately ? 'Create & Submit SES' : 'Save Draft SES'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedSES && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-slate-200 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div>
                <div className="flex items-center space-x-2">
                  <h3 className="text-base font-mono font-bold text-slate-900">{selectedSES.ses_number}</h3>
                  {getStatusBadge(selectedSES.status)}
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Against PO {selectedSES.po_number} from {selectedSES.supplier_name}
                </p>
              </div>
              <button onClick={() => setSelectedSES(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-4 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                <div>
                  <span className="text-slate-500">Created By:</span>
                  <div className="font-semibold text-slate-900">{selectedSES.created_by_name}</div>
                </div>
                <div>
                  <span className="text-slate-500">Decided By:</span>
                  <div className="font-semibold text-slate-900">{selectedSES.decided_by_name || '—'}</div>
                </div>
                <div>
                  <span className="text-slate-500">Service Period:</span>
                  <div className="font-semibold text-slate-900">
                    {selectedSES.service_period_start || '—'} → {selectedSES.service_period_end || '—'}
                  </div>
                </div>
                <div>
                  <span className="text-slate-500">Decision:</span>
                  <div className="font-semibold text-slate-900">{selectedSES.decision_comments || '—'}</div>
                </div>
              </div>

              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100 border-b border-slate-200 text-slate-600 font-semibold">
                    <tr>
                      <th className="py-2.5 px-3">Description</th>
                      <th className="py-2.5 px-3 text-center">Qty Accepted</th>
                      <th className="py-2.5 px-3 text-right">Amount</th>
                      <th className="py-2.5 px-3">Comments</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedSES.items?.map((item) => (
                      <tr key={item.id}>
                        <td className="py-2 px-3 font-medium text-slate-900">{item.item_description}</td>
                        <td className="py-2 px-3 text-center font-bold text-indigo-700">{item.quantity_accepted}</td>
                        <td className="py-2 px-3 text-right font-bold">${formatMoney(item.amount_cents)}</td>
                        <td className="py-2 px-3 text-slate-500">{item.comments || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selectedSES.notes && (
                <div className="p-3 bg-slate-50 rounded-lg text-slate-700 border border-slate-200">
                  <strong className="block text-[11px] text-slate-500 uppercase">Notes:</strong>
                  {selectedSES.notes}
                </div>
              )}

              {selectedSES.status === 'draft' && (
                <button
                  onClick={() => handleSubmitDraft(selectedSES.id)}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-semibold"
                >
                  Submit for Acceptance
                </button>
              )}

              {selectedSES.status === 'submitted' && canDecide && (
                <div className="space-y-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <input
                    type="text"
                    value={decisionComments}
                    onChange={(e) => setDecisionComments(e.target.value)}
                    placeholder="Acceptance / rejection comments"
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  />
                  <label className="flex items-start gap-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-amber-900">
                    <input type="checkbox" className="mt-0.5" checked={allowOverAcceptance} onChange={(e) => setAllowOverAcceptance(e.target.checked)} />
                    <span>
                      <strong>Allow over-acceptance (exception).</strong> Use only if cumulative accepted qty would exceed ordered qty. Audited.
                    </span>
                  </label>
                  <div className="flex space-x-2">
                    <button
                      onClick={() => handleAccept(selectedSES.id)}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold inline-flex items-center space-x-1"
                    >
                      <CheckCircle className="w-4 h-4" />
                      <span>Accept SES</span>
                    </button>
                    <button
                      onClick={() => handleReject(selectedSES.id)}
                      className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-semibold inline-flex items-center space-x-1"
                    >
                      <XCircle className="w-4 h-4" />
                      <span>Reject</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end pt-3 border-t border-slate-200">
              <button onClick={() => setSelectedSES(null)} className="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
