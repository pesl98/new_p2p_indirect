import React, { useState, useEffect } from 'react';
import { 
  ShoppingCart, 
  Plus, 
  Printer, 
  Truck, 
  Eye, 
  CheckCircle, 
  Clock, 
  Package, 
  FileText, 
  Building2, 
  X,
  ExternalLink,
  FileEdit
} from 'lucide-react';
import { api } from '../api';
import { formatMoney } from '../money';
import { isServiceLine, lineTypeLabel } from '../lineType';
import ConvertRequisitionModal from '../components/ConvertRequisitionModal';
import ChangeOrderModal from '../components/ChangeOrderModal';

const AMENDABLE_PO_STATUSES = ['issued', 'acknowledged', 'partially_received', 'received'];

export default function PurchaseOrdersView({ currentUser, onNavigate, focusId, convertRequisitionId }) {
  const [orders, setOrders] = useState([]);
  const [approvedPRs, setApprovedPRs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedPO, setSelectedPO] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showChangeOrder, setShowChangeOrder] = useState(false);
  const [convertTargetId, setConvertTargetId] = useState(null);
  const [suppliers, setSuppliers] = useState([]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [pos, prs, sups] = await Promise.all([
        api.getPurchaseOrders(),
        api.getRequisitions('approved'),
        api.getSuppliers()
      ]);
      setOrders(pos);
      setApprovedPRs(prs);
      setSuppliers(sups);
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

  useEffect(() => {
    if (convertRequisitionId) {
      setConvertTargetId(convertRequisitionId);
      setShowCreateModal(true);
    }
  }, [convertRequisitionId]);

  const handleOpenDetail = async (id) => {
    try {
      const detail = await api.getPurchaseOrderDetail(id);
      setSelectedPO(detail);
    } catch (err) {
      console.error(err);
    }
  };

  const openConvertModal = (requisitionId = null) => {
    setConvertTargetId(requisitionId);
    setShowCreateModal(true);
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'issued':
        return <span className="bg-sky-100 text-sky-800 text-xs px-2.5 py-1 rounded-full font-medium">Issued to Vendor</span>;
      case 'partially_received':
        return <span className="bg-amber-100 text-amber-800 text-xs px-2.5 py-1 rounded-full font-medium">Partially Received</span>;
      case 'received':
        return <span className="bg-emerald-100 text-emerald-800 text-xs px-2.5 py-1 rounded-full font-medium">Fully Received</span>;
      case 'closed':
        return <span className="bg-slate-100 text-slate-800 text-xs px-2.5 py-1 rounded-full font-medium">Closed</span>;
      case 'cancelled':
        return <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-medium">Cancelled</span>;
      default:
        return <span className="bg-slate-100 text-slate-800 text-xs px-2 py-0.5 rounded">{status}</span>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Purchase Orders (PO)</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Manage binding supplier purchase contracts, track shipments, and dispatch formal orders.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          {approvedPRs.length > 0 && (
            <button
              onClick={() => openConvertModal()}
              className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-sm transition-all flex items-center space-x-2"
            >
              <Plus className="w-4 h-4" />
              <span>Convert Approved PR ({approvedPRs.length})</span>
            </button>
          )}
        </div>
      </div>

      {/* PO Table */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">PO Number</th>
                <th className="py-3 px-4">Supplier</th>
                <th className="py-3 px-4">Requisition</th>
                <th className="py-3 px-4">Total Amount</th>
                <th className="py-3 px-4">Fulfillment Status</th>
                <th className="py-3 px-4">Issue Date</th>
                <th className="py-3 px-4">Delivery Due</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">Loading purchase orders...</td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">No purchase orders found.</td>
                </tr>
              ) : (
                orders.map((po) => {
                  const fulfilled = po.total_qty_fulfilled ?? po.total_qty_received;
                  const pct = po.total_qty_ordered > 0
                    ? Math.round((fulfilled / po.total_qty_ordered) * 100)
                    : 0;

                  return (
                    <tr key={po.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-3 px-4 font-mono font-bold text-slate-900">
                        {po.po_number}
                        {po.revision > 0 && (
                          <span className="ml-1.5 text-[10px] font-semibold text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded">
                            Rev {po.revision}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-slate-900">{po.supplier_name}</div>
                        <div className="text-[10px] text-slate-400">{po.supplier_code}</div>
                      </td>
                      <td className="py-3 px-4 text-slate-600 font-mono">
                        {po.pr_number || 'Direct Order'}
                      </td>
                      <td className="py-3 px-4 font-bold text-slate-900 text-sm">
                        ${formatMoney(po.total_amount)}
                      </td>
                      <td className="py-3 px-4 min-w-[160px]">
                        <div className="mb-1">{getStatusBadge(po.status)}</div>
                        <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${pct === 100 ? 'bg-emerald-500' : pct > 0 ? 'bg-amber-500' : 'bg-slate-300'}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {fulfilled} of {po.total_qty_ordered} units fulfilled ({pct}%)
                          {(po.service_line_count > 0 && po.goods_line_count > 0) ? ' · mixed PO' : po.service_line_count > 0 ? ' · SES' : ' · GRN'}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-slate-500">{po.issue_date}</td>
                      <td className="py-3 px-4 text-slate-500">{po.expected_delivery_date || 'TBD'}</td>
                      <td className="py-3 px-4 text-right space-x-2">
                        <button
                          onClick={() => handleOpenDetail(po.id)}
                          className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded font-semibold text-[11px] inline-flex items-center space-x-1"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>View PO</span>
                        </button>
                        {po.status !== 'received' && po.status !== 'closed' && po.goods_line_count > 0 && (
                          <button
                            onClick={() => onNavigate('goods_receipt')}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-semibold text-[11px] inline-flex items-center space-x-1"
                          >
                            <Package className="w-3.5 h-3.5" />
                            <span>GRN</span>
                          </button>
                        )}
                        {po.status !== 'received' && po.status !== 'closed' && po.service_line_count > 0 && (
                          <button
                            onClick={() => onNavigate('service_entry')}
                            className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-semibold text-[11px] inline-flex items-center space-x-1"
                          >
                            <FileText className="w-3.5 h-3.5" />
                            <span>SES</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showCreateModal && (
        <ConvertRequisitionModal
          currentUser={currentUser}
          approvedPRs={approvedPRs}
          suppliers={suppliers}
          initialRequisitionId={convertTargetId}
          onClose={() => {
            setShowCreateModal(false);
            setConvertTargetId(null);
          }}
          onConverted={() => {
            loadData();
          }}
          onViewPurchaseOrder={(poId) => {
            setShowCreateModal(false);
            setConvertTargetId(null);
            handleOpenDetail(poId);
          }}
        />
      )}

      {showChangeOrder && selectedPO && (
        <ChangeOrderModal
          purchaseOrder={selectedPO}
          currentUser={currentUser}
          onClose={() => setShowChangeOrder(false)}
          onApplied={async () => {
            setShowChangeOrder(false);
            await loadData();
            if (selectedPO?.id) {
              await handleOpenDetail(selectedPO.id);
            }
          }}
        />
      )}

      {/* Printable / Formal PO Viewer Modal */}
      {selectedPO && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[92vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden">
            {/* Modal Controls */}
            <div className="p-4 bg-slate-800 text-white flex items-center justify-between">
              <div className="flex items-center space-x-2 text-xs">
                <FileText className="w-4 h-4 text-emerald-400" />
                <span className="font-bold">Official Purchase Order Document</span>
              </div>
              <div className="flex items-center space-x-2">
                {AMENDABLE_PO_STATUSES.includes(selectedPO.status) && (
                  <button
                    onClick={() => setShowChangeOrder(true)}
                    className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-xs rounded-lg font-medium flex items-center space-x-1"
                  >
                    <FileEdit className="w-3.5 h-3.5" />
                    <span>Change order</span>
                  </button>
                )}
                <button
                  onClick={() => window.print()}
                  className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-xs rounded-lg font-medium flex items-center space-x-1"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print Document</span>
                </button>
                <button onClick={() => setSelectedPO(null)} className="text-slate-400 hover:text-white p-1">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Document Body (Standard Corporate PO Layout) */}
            <div className="p-8 overflow-y-auto space-y-6 text-xs font-sans print:p-0">
              {/* Document Header */}
              <div className="flex justify-between items-start border-b border-slate-200 pb-6">
                <div>
                  <h1 className="text-2xl font-black text-slate-900 tracking-tight">ACME ENTERPRISE CORP</h1>
                  <p className="text-slate-500 mt-1">450 Tech Blvd, Building B<br />Austin, TX 78701 • Tax ID: US-8823901</p>
                  <p className="text-slate-500 mt-0.5">Procurement Dept: purchasing@acme.com</p>
                </div>
                <div className="text-right">
                  <div className="text-xl font-mono font-black text-indigo-700">
                    {selectedPO.po_number}
                    {selectedPO.revision > 0 ? ` · Rev ${selectedPO.revision}` : ''}
                  </div>
                  <div className="text-slate-500 mt-1">Date: <strong>{selectedPO.issue_date}</strong></div>
                  <div className="text-slate-500">Terms: <strong>{selectedPO.payment_terms}</strong></div>
                  <div className="mt-2">{getStatusBadge(selectedPO.status)}</div>
                </div>
              </div>

              {/* Vendor & Ship-To Blocks */}
              <div className="grid grid-cols-2 gap-6 bg-slate-50 p-4 rounded-xl border border-slate-200">
                <div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Vendor / Supplier</span>
                  <div className="font-bold text-slate-900 text-sm">{selectedPO.supplier_name}</div>
                  <div className="text-slate-600 mt-0.5">{selectedPO.supplier_address || 'Supplier Headquarters'}</div>
                  <div className="text-slate-500 mt-0.5">Contact: {selectedPO.supplier_contact || 'B2B Sales'} ({selectedPO.supplier_email})</div>
                </div>
                <div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Ship-To Location</span>
                  <div className="font-bold text-slate-900 text-sm">Acme Corp Receiving Dock</div>
                  <div className="text-slate-600 mt-0.5">{selectedPO.shipping_address}</div>
                  <div className="text-slate-500 mt-0.5">Buyer: {selectedPO.buyer_name} ({selectedPO.buyer_email})</div>
                </div>
              </div>

              {/* PO Line Items */}
              <div>
                <table className="w-full text-left border border-slate-200 rounded-lg overflow-hidden">
                  <thead className="bg-slate-100 border-b border-slate-200 text-slate-600 font-bold uppercase text-[10px]">
                    <tr>
                      <th className="py-2.5 px-3">Item / Service Description</th>
                      <th className="py-2.5 px-3">Type</th>
                      <th className="py-2.5 px-3">Category</th>
                      <th className="py-2.5 px-3 text-center">Qty Ordered</th>
                      <th className="py-2.5 px-3 text-center">Fulfilled</th>
                      <th className="py-2.5 px-3 text-right">Unit Price</th>
                      <th className="py-2.5 px-3 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedPO.items?.map((item) => {
                      const service = isServiceLine(item);
                      const fulfilled = service ? (item.quantity_accepted || 0) : item.quantity_received;
                      return (
                      <tr key={item.id}>
                        <td className="py-2.5 px-3 font-medium text-slate-900">{item.item_description}</td>
                        <td className="py-2.5 px-3">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${service ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-700'}`}>
                            {lineTypeLabel(item)}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-slate-500">{item.category}</td>
                        <td className="py-2.5 px-3 text-center font-semibold">{item.quantity}</td>
                        <td className="py-2.5 px-3 text-center">
                          <span className={`font-semibold ${fulfilled >= item.quantity ? 'text-emerald-700' : 'text-amber-600'}`}>
                            {fulfilled} {service ? 'SES' : 'GRN'}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right">${formatMoney(item.unit_price)}</td>
                        <td className="py-2.5 px-3 text-right font-bold text-slate-900">
                          ${formatMoney(item.total_price)}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-slate-50 border-t border-slate-200 font-bold">
                    <tr>
                      <td colSpan="6" className="py-2.5 px-3 text-right text-slate-600">Total Purchase Order Value:</td>
                      <td className="py-2.5 px-3 text-right text-emerald-700 text-sm font-black">
                        ${formatMoney(selectedPO.total_amount)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Terms & Signature Box */}
              <div className="pt-4 border-t border-slate-200 grid grid-cols-2 gap-6 text-[11px] text-slate-500">
                <div>
                  <span className="font-bold text-slate-700 block mb-1">Standard Purchase Terms:</span>
                  <p className="leading-relaxed">
                    Goods are received on a GRN; services are accepted on a Service Entry Sheet. Invoices must reference Purchase Order #{selectedPO.po_number}. Goods match PO+GRN+invoice; services match PO+SES+invoice.
                  </p>
                </div>
                <div className="border border-dashed border-slate-300 rounded-xl p-3 flex flex-col justify-between">
                  <div className="flex justify-between text-[10px] text-slate-400 uppercase font-bold">
                    <span>Authorized Procurement Signature</span>
                    <span>Electronic Validation</span>
                  </div>
                  <div className="font-serif italic text-base text-slate-800 my-1">
                    {selectedPO.buyer_name}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    Acme Strategic Sourcing • Signed {selectedPO.issue_date}
                  </div>
                </div>
              </div>
            </div>

            {selectedPO.change_orders?.length > 0 && (
              <div className="px-8 pb-4 text-xs">
                <div className="font-bold text-slate-700 uppercase tracking-wider text-[10px] mb-2">Change orders</div>
                <div className="space-y-2">
                  {selectedPO.change_orders.map((co) => (
                    <div key={co.id} className="border border-slate-200 rounded-lg px-3 py-2 bg-slate-50">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-bold text-slate-900">{co.co_number}</span>
                        <span className="text-[10px] font-semibold text-indigo-700">Rev {co.revision} · {co.status}</span>
                      </div>
                      <div className="text-slate-600 mt-1">{co.reason}</div>
                      <div className="text-[10px] text-slate-400 mt-0.5">
                        ${formatMoney(co.before_total_cents)} → ${formatMoney(co.after_total_cents)}
                        {co.actor_name ? ` · ${co.actor_name}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedPO.service_entry_sheets?.length > 0 && (
              <div className="px-8 pb-4 text-xs">
                <div className="font-bold text-slate-700 uppercase tracking-wider text-[10px] mb-1">Service Entry Sheets</div>
                <div className="text-slate-600">
                  {selectedPO.service_entry_sheets.map((ses) => `${ses.ses_number} (${ses.status})`).join(' · ')}
                </div>
              </div>
            )}

            <div className="p-4 border-t border-slate-200 bg-slate-50 flex justify-between items-center">
              <div className="text-xs text-slate-500">
                Associated Requisition: <strong className="text-slate-800">{selectedPO.pr_number || 'Direct'}</strong>
              </div>
              <button
                onClick={() => setSelectedPO(null)}
                className="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold"
              >
                Close View
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
