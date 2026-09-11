import React, { useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { api } from '../api';
import { formatMoney, fromCents, toCents } from '../money';
import { isServiceLine, lineTypeLabel } from '../lineType';

const INCREASE_CONFIRM_CENTS = 100000;

function qtyFloor(item) {
  const fulfilled = isServiceLine(item)
    ? Number(item.quantity_accepted || 0)
    : Number(item.quantity_received || 0);
  return Math.max(fulfilled, Number(item.quantity_invoiced || 0));
}

function floorLabel(item) {
  if (isServiceLine(item)) {
    return `accepted ${item.quantity_accepted || 0} · invoiced ${item.quantity_invoiced || 0}`;
  }
  return `received ${item.quantity_received || 0} · invoiced ${item.quantity_invoiced || 0}`;
}

export default function ChangeOrderModal({ purchaseOrder, currentUser, onClose, onApplied }) {
  const items = purchaseOrder?.items || [];
  const [qtyDrafts, setQtyDrafts] = useState(() => {
    const next = {};
    for (const item of items) next[item.id] = String(item.quantity);
    return next;
  });
  const [priceDrafts, setPriceDrafts] = useState(() => {
    const next = {};
    for (const item of items) next[item.id] = String(fromCents(item.unit_price));
    return next;
  });
  const [reason, setReason] = useState('');
  const [deliveryNotes, setDeliveryNotes] = useState(purchaseOrder?.notes || '');
  const [confirmIncrease, setConfirmIncrease] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const preview = useMemo(() => {
    const lines = items.map((item) => {
      const qty = Number.parseInt(String(qtyDrafts[item.id] ?? item.quantity), 10);
      const unitPrice = toCents(priceDrafts[item.id] ?? fromCents(item.unit_price));
      const quantity = Number.isFinite(qty) ? qty : item.quantity;
      return {
        ...item,
        next_quantity: quantity,
        next_unit_price: unitPrice,
        next_total: quantity * unitPrice,
        floor: qtyFloor(item),
        changed: quantity !== item.quantity || unitPrice !== item.unit_price
      };
    });
    const afterTotal = lines.reduce((sum, line) => sum + line.next_total, 0);
    const beforeTotal = purchaseOrder.total_amount;
    return {
      lines,
      beforeTotal,
      afterTotal,
      delta: afterTotal - beforeTotal,
      deliveryChanged: deliveryNotes.trim() !== (purchaseOrder.notes || '')
    };
  }, [items, qtyDrafts, priceDrafts, deliveryNotes, purchaseOrder]);

  const needsIncreaseConfirm = preview.delta > INCREASE_CONFIRM_CENTS;

  const handleSubmit = async () => {
    setError('');
    if (!reason.trim()) {
      setError('Reason is required.');
      return;
    }
    const lines = preview.lines
      .filter((line) => line.changed)
      .map((line) => ({
        po_item_id: line.id,
        quantity: line.next_quantity,
        unit_price: line.next_unit_price
      }));
    if (lines.length === 0 && !preview.deliveryChanged) {
      setError('Change at least one quantity, unit price, or the delivery notes.');
      return;
    }
    for (const line of preview.lines) {
      if (line.next_quantity < line.floor) {
        setError(
          `Cannot reduce "${line.item_description}" below ${line.floor} (${floorLabel(line)}).`
        );
        return;
      }
    }
    if (needsIncreaseConfirm && !confirmIncrease) {
      setError(
        `Net increase of $${formatMoney(preview.delta)} is over $1,000.00. Confirm the increase to apply.`
      );
      return;
    }

    setSubmitting(true);
    try {
      const result = await api.createChangeOrder(purchaseOrder.id, {
        reason: reason.trim(),
        actor_name: currentUser?.name || 'Procurement Officer',
        lines,
        delivery_notes: deliveryNotes,
        confirm_increase: needsIncreaseConfirm ? true : undefined
      });
      onApplied?.(result);
    } catch (err) {
      setError(err.message || 'Failed to apply change order');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[92vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden">
        <div className="p-4 bg-slate-800 text-white flex items-center justify-between">
          <div>
            <div className="text-sm font-bold">Change order · {purchaseOrder.po_number}</div>
            <div className="text-[11px] text-slate-300 mt-0.5">
              Amend existing lines only. Qty cannot drop below received / accepted / invoiced. Money is integer cents.
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4 text-xs">
          {error && (
            <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-lg px-3 py-2 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div>{error}</div>
            </div>
          )}

          <table className="w-full text-left border border-slate-200 rounded-lg overflow-hidden">
            <thead className="bg-slate-100 text-[10px] uppercase tracking-wider text-slate-500 font-bold">
              <tr>
                <th className="py-2 px-3">Line</th>
                <th className="py-2 px-3">Caps</th>
                <th className="py-2 px-3 text-center">New qty</th>
                <th className="py-2 px-3 text-right">New unit price ($)</th>
                <th className="py-2 px-3 text-right">Line total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {preview.lines.map((line) => (
                <tr key={line.id} className={line.changed ? 'bg-amber-50/60' : ''}>
                  <td className="py-2.5 px-3">
                    <div className="font-semibold text-slate-900">{line.item_description}</div>
                    <div className="text-[10px] text-slate-400">
                      {lineTypeLabel(line)} · current {line.quantity} @ ${formatMoney(line.unit_price)}
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-[10px] text-slate-500">
                    Floor {line.floor}<br />{floorLabel(line)}
                  </td>
                  <td className="py-2.5 px-3">
                    <input
                      type="number"
                      min={line.floor}
                      step="1"
                      value={qtyDrafts[line.id]}
                      onChange={(e) => setQtyDrafts((prev) => ({ ...prev, [line.id]: e.target.value }))}
                      className="w-20 mx-auto block border border-slate-200 rounded-lg px-2 py-1.5 text-center font-semibold"
                    />
                  </td>
                  <td className="py-2.5 px-3">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={priceDrafts[line.id]}
                      onChange={(e) => setPriceDrafts((prev) => ({ ...prev, [line.id]: e.target.value }))}
                      className="w-28 ml-auto block border border-slate-200 rounded-lg px-2 py-1.5 text-right font-semibold"
                    />
                  </td>
                  <td className="py-2.5 px-3 text-right font-bold text-slate-900">
                    ${formatMoney(line.next_total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Reason (required)</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Why is this PO being amended?"
              className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Delivery notes</span>
            <textarea
              value={deliveryNotes}
              onChange={(e) => setDeliveryNotes(e.target.value)}
              rows={2}
              className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </label>

          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Before → after</div>
              <div className="text-sm font-black text-slate-900">
                ${formatMoney(preview.beforeTotal)} → ${formatMoney(preview.afterTotal)}
              </div>
              <div className={`text-[11px] font-semibold ${preview.delta > 0 ? 'text-amber-700' : preview.delta < 0 ? 'text-emerald-700' : 'text-slate-500'}`}>
                Delta {preview.delta >= 0 ? '+' : ''}${formatMoney(preview.delta)}
              </div>
            </div>
            {needsIncreaseConfirm && (
              <label className="flex items-start gap-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 max-w-sm">
                <input
                  type="checkbox"
                  checked={confirmIncrease}
                  onChange={(e) => setConfirmIncrease(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Confirm increase over $1,000.00 (CHANGE_ORDER_INCREASE_CONFIRM_CENTS / APPROVAL_TIER2_CENTS).
                  This is an explicit confirm flag, not a second approval chain.
                </span>
              </label>
            )}
          </div>
        </div>

        <div className="p-4 border-t border-slate-200 bg-slate-50 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-200 text-slate-600"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            {submitting ? 'Applying…' : 'Apply change order'}
          </button>
        </div>
      </div>
    </div>
  );
}
