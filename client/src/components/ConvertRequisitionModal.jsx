import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { api } from '../api';
import { formatMoney } from '../money';

function defaultSupplierId(item) {
  return item.resolved_supplier_id
    || item.estimated_supplier_id
    || item.catalog_preferred_supplier_id
    || '';
}

function defaultSupplierName(item, suppliers) {
  if (item.resolved_supplier_name) return item.resolved_supplier_name;
  if (item.estimated_supplier_name) return item.estimated_supplier_name;
  if (item.catalog_preferred_supplier_name) return item.catalog_preferred_supplier_name;
  const sid = defaultSupplierId(item);
  return suppliers.find((s) => Number(s.id) === Number(sid))?.name || null;
}

function selectedSupplierId(item, mappings) {
  const mapped = mappings[item.id];
  if (mapped === '' || mapped == null) return null;
  const n = Number(mapped);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export default function ConvertRequisitionModal({
  currentUser,
  approvedPRs = [],
  suppliers = [],
  initialRequisitionId = null,
  onClose,
  onConverted,
  onViewPurchaseOrder
}) {
  const [selectedPR, setSelectedPR] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [supplierMappings, setSupplierMappings] = useState({});
  const [shippingAddress, setShippingAddress] = useState(
    'Acme HQ - Receiving Bay 2, 450 Tech Blvd, Austin, TX 78701'
  );
  const [poNotes, setPoNotes] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('Net 30');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  const selectRequisition = async (pr) => {
    setSelectedPR(pr);
    setError('');
    setResult(null);
    setDetail(null);
    if (!pr) return;
    setLoadingDetail(true);
    try {
      const loaded = await api.getRequisitionDetail(pr.id);
      setDetail(loaded);
      const nextMappings = {};
      for (const item of loaded.items || []) {
        const fallback = defaultSupplierId(item);
        nextMappings[item.id] = fallback ? String(fallback) : '';
      }
      setSupplierMappings(nextMappings);
    } catch (err) {
      setError(err.message || 'Failed to load requisition lines.');
    } finally {
      setLoadingDetail(false);
    }
  };

  useEffect(() => {
    if (!initialRequisitionId || selectedPR) return;
    const match = approvedPRs.find((pr) => Number(pr.id) === Number(initialRequisitionId));
    if (match) {
      selectRequisition(match);
    }
    // Auto-select once when the modal opens on a specific approved PR.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRequisitionId, approvedPRs]);

  const items = detail?.items || [];

  const preview = useMemo(() => {
    const groups = new Map();
    const unresolved = [];
    for (const item of items) {
      const sid = selectedSupplierId(item, supplierMappings);
      if (!sid) {
        unresolved.push(item);
        continue;
      }
      if (!groups.has(sid)) {
        groups.set(sid, {
          supplier_id: sid,
          supplier_name: suppliers.find((s) => Number(s.id) === Number(sid))?.name || `Supplier ${sid}`,
          items: [],
          total: 0
        });
      }
      const group = groups.get(sid);
      group.items.push(item);
      group.total += Number(item.total_price) || 0;
    }
    return { groups: [...groups.values()], unresolved };
  }, [items, supplierMappings, suppliers]);

  const remapCount = items.filter((item) => {
    const selected = selectedSupplierId(item, supplierMappings);
    const fallback = Number(defaultSupplierId(item)) || null;
    return selected && fallback && selected !== fallback;
  }).length;

  const handleMappingChange = (itemId, value) => {
    setError('');
    setSupplierMappings((prev) => ({ ...prev, [itemId]: value }));
  };

  const handleConvert = async () => {
    if (!selectedPR) return;
    const unresolved = preview.unresolved;
    if (unresolved.length > 0) {
      const labels = unresolved.map((item) => item.item_description || `line ${item.id}`).join(', ');
      setError(
        `Cannot convert requisition: ${unresolved.length} line(s) have no resolvable supplier (${labels}). Assign a vendor on each line — convert does not invent a supplier.`
      );
      return;
    }

    const mappings = items
      .map((item) => ({
        requisition_item_id: item.id,
        supplier_id: selectedSupplierId(item, supplierMappings)
      }))
      .filter((row) => row.supplier_id);

    setSubmitting(true);
    setError('');
    try {
      const converted = await api.createPOFromRequisition({
        requisition_id: selectedPR.id,
        created_by: currentUser?.id || 3,
        shipping_address: shippingAddress,
        notes: poNotes || undefined,
        payment_terms: paymentTerms,
        supplier_mappings: mappings
      });
      setResult(converted);
      onConverted?.(converted);
    } catch (err) {
      setError(err.message || 'Failed to generate purchase order');
    } finally {
      setSubmitting(false);
    }
  };

  const issued = result?.purchase_orders || [];

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[92vh] flex flex-col shadow-2xl border border-slate-200">
        <div className="flex items-center justify-between p-5 border-b border-slate-200">
          <div>
            <h3 className="text-base font-bold text-slate-900">
              {issued.length > 0
                ? (issued.length > 1 ? 'Purchase orders issued' : 'Purchase order issued')
                : 'Convert requisition to purchase order(s)'}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {issued.length > 0
                ? result.message
                : 'Confirm or remap the supplier on each line, then issue one PO per vendor.'}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" type="button">
            <X className="w-5 h-5" />
          </button>
        </div>

        {issued.length > 0 ? (
          <div className="p-5 overflow-y-auto space-y-3">
            <div className="flex items-start space-x-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl p-3">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                {issued.length > 1
                  ? `${issued.length} purchase orders were issued from ${selectedPR?.pr_number}.`
                  : `${issued[0].poNumber} was issued from ${selectedPR?.pr_number}.`}
              </span>
            </div>
            {issued.map((po) => (
              <button
                key={po.poId}
                type="button"
                onClick={() => onViewPurchaseOrder?.(po.poId)}
                className="w-full text-left p-3 border border-slate-200 hover:border-indigo-400 hover:bg-indigo-50/40 rounded-xl transition-all"
              >
                <div className="flex justify-between items-center">
                  <span className="font-mono font-bold text-slate-900">{po.poNumber}</span>
                  <span className="text-emerald-700 font-extrabold text-xs">${formatMoney(po.total_amount)}</span>
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {po.supplier_name} · {po.item_count} line{po.item_count === 1 ? '' : 's'}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="p-5 overflow-y-auto space-y-4 text-xs">
            <div>
              <label className="block text-slate-700 font-semibold uppercase tracking-wider text-[11px] mb-2">
                Approved requisition
              </label>
              {approvedPRs.length === 0 ? (
                <p className="text-slate-400">No approved requisitions are waiting to convert.</p>
              ) : (
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {approvedPRs.map((pr) => (
                    <button
                      key={pr.id}
                      type="button"
                      onClick={() => selectRequisition(pr)}
                      className={`w-full text-left p-3 border rounded-xl transition-all ${
                        selectedPR?.id === pr.id
                          ? 'border-indigo-600 bg-indigo-50/50 shadow-sm'
                          : 'border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <div className="flex justify-between items-center font-bold text-slate-900">
                        <span>{pr.pr_number} — {pr.department_name}</span>
                        <span className="text-emerald-700 font-extrabold">${formatMoney(pr.total_amount)}</span>
                      </div>
                      <p className="text-slate-500 text-[11px] mt-1 line-clamp-1">{pr.justification}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {loadingDetail && (
              <p className="text-slate-400">Loading requisition lines…</p>
            )}

            {detail && (
              <div className="space-y-3 pt-3 border-t border-slate-200">
                <div className="font-semibold text-slate-700 uppercase tracking-wider text-[11px]">
                  Line supplier assignment
                </div>
                <p className="text-slate-500">
                  Defaults come from the line’s estimated supplier, then the catalog preferred vendor.
                  Override a line to remap it before issue — the same <code className="font-mono">supplier_mappings</code> the convert API accepts.
                </p>
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <table className="w-full text-left">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider text-[10px]">
                      <tr>
                        <th className="py-2 px-3">Line</th>
                        <th className="py-2 px-3">Qty</th>
                        <th className="py-2 px-3 text-right">Amount</th>
                        <th className="py-2 px-3">Default supplier</th>
                        <th className="py-2 px-3">Issue to</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {items.map((item) => {
                        const fallbackId = Number(defaultSupplierId(item)) || null;
                        const selected = selectedSupplierId(item, supplierMappings);
                        const remapped = selected && fallbackId && selected !== fallbackId;
                        return (
                          <tr key={item.id}>
                            <td className="py-2 px-3 font-medium text-slate-900">
                              {item.item_description}
                              {remapped && (
                                <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-800">
                                  Remapped
                                </span>
                              )}
                            </td>
                            <td className="py-2 px-3 text-slate-600">{item.quantity}</td>
                            <td className="py-2 px-3 text-right font-semibold text-slate-900">
                              ${formatMoney(item.total_price)}
                            </td>
                            <td className="py-2 px-3 text-slate-600">
                              {defaultSupplierName(item, suppliers) || (
                                <span className="text-rose-600 font-medium">Unassigned</span>
                              )}
                            </td>
                            <td className="py-2 px-3">
                              <select
                                value={supplierMappings[item.id] ?? ''}
                                onChange={(e) => handleMappingChange(item.id, e.target.value)}
                                className={`w-full p-1.5 border rounded-lg text-xs ${
                                  selected ? 'border-slate-300' : 'border-rose-300 bg-rose-50'
                                }`}
                              >
                                <option value="">Select supplier…</option>
                                {suppliers.map((supplier) => (
                                  <option key={supplier.id} value={supplier.id}>
                                    {supplier.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="space-y-2">
                  <div className="font-semibold text-slate-700 uppercase tracking-wider text-[11px]">
                    Supplier split preview
                  </div>
                  {preview.groups.map((group) => (
                    <div key={group.supplier_id} className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                      <div className="flex justify-between font-semibold text-slate-900">
                        <span>{group.supplier_name}</span>
                        <span className="text-emerald-700">${formatMoney(group.total)}</span>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {group.items.length} line{group.items.length === 1 ? '' : 's'} → one issued PO
                      </div>
                    </div>
                  ))}
                  {preview.unresolved.length > 0 && (
                    <div className="flex items-start space-x-2 text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                      <p>
                        {preview.unresolved.length} line(s) have no resolvable supplier
                        ({preview.unresolved.map((item) => item.item_description).join(', ')}).
                        Convert will fail closed — no vendor is invented.
                      </p>
                    </div>
                  )}
                  {preview.groups.length > 1 && preview.unresolved.length === 0 && (
                    <p className="text-indigo-700 font-medium">
                      This requisition will issue {preview.groups.length} purchase orders in one transaction.
                    </p>
                  )}
                  {preview.groups.length === 1 && preview.unresolved.length === 0 && remapCount === 0 && (
                    <p className="text-slate-500">
                      Single-supplier convert: defaults are already assigned. Confirm to issue one PO.
                    </p>
                  )}
                  {remapCount > 0 && preview.unresolved.length === 0 && (
                    <p className="text-indigo-700 font-medium">
                      {remapCount} line{remapCount === 1 ? '' : 's'} remapped from the default supplier.
                    </p>
                  )}
                </div>

                <div className="space-y-3 pt-3 border-t border-slate-200">
                  <div>
                    <label className="block text-slate-600 font-medium mb-1">Delivery / Ship-To Address</label>
                    <input
                      type="text"
                      value={shippingAddress}
                      onChange={(e) => setShippingAddress(e.target.value)}
                      className="w-full p-2 border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-600 font-medium mb-1">Payment terms</label>
                      <input
                        type="text"
                        value={paymentTerms}
                        onChange={(e) => setPaymentTerms(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-600 font-medium mb-1">PO notes / instructions</label>
                      <input
                        type="text"
                        value={poNotes}
                        placeholder="Optional instructions for the vendor…"
                        onChange={(e) => setPoNotes(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded-lg"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-start space-x-2 text-rose-800 bg-rose-50 border border-rose-200 rounded-xl p-3">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <p>{error}</p>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end space-x-2 p-4 border-t border-slate-200">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold"
          >
            {issued.length > 0 ? 'Done' : 'Cancel'}
          </button>
          {issued.length === 0 && (
            <button
              type="button"
              disabled={!selectedPR || !detail || submitting}
              onClick={handleConvert}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold"
            >
              {submitting
                ? 'Issuing…'
                : preview.groups.length > 1
                  ? `Generate & Issue ${preview.groups.length} POs`
                  : 'Generate & Issue PO'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
