import React, { useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { api } from '../api';
import { formatMoney, formatMajorInput, moneyInputProps, toCents } from '../money';
import { t, presentError } from '../i18n';
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
    return t('purchasing.co.floorService', {
      accepted: item.quantity_accepted || 0,
      invoiced: item.quantity_invoiced || 0
    });
  }
  return t('purchasing.co.floorGoods', {
    received: item.quantity_received || 0,
    invoiced: item.quantity_invoiced || 0
  });
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
    for (const item of items) next[item.id] = formatMajorInput(item.unit_price);
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
      const unitPrice = toCents(priceDrafts[item.id] ?? formatMajorInput(item.unit_price));
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
      setError(t('purchasing.co.reasonMissing'));
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
      setError(t('purchasing.co.needChange'));
      return;
    }
    for (const line of preview.lines) {
      if (line.next_quantity < line.floor) {
        setError(
          t('purchasing.co.belowFloor', {
            description: line.item_description,
            floor: line.floor,
            detail: floorLabel(line)
          })
        );
        return;
      }
    }
    if (needsIncreaseConfirm && !confirmIncrease) {
      setError(
        t('purchasing.co.increaseBlocked', {
          delta: formatMoney(preview.delta),
          limit: formatMoney(100_000)
        })
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
      setError(presentError(err, 'errors.changeOrder'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[92vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden">
        <div className="p-4 bg-slate-800 text-white flex items-center justify-between">
          <div>
            <div className="text-sm font-bold">{t('purchasing.co.title', { number: purchaseOrder.po_number })}</div>
            <div className="text-[11px] text-slate-300 mt-0.5">
              {t('purchasing.co.subtitle')}
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
                <th className="py-2 px-3">{t('common.line')}</th>
                <th className="py-2 px-3">{t('purchasing.co.caps')}</th>
                <th className="py-2 px-3 text-center">{t('purchasing.co.newQty')}</th>
                <th className="py-2 px-3 text-right">{t('purchasing.co.newPrice')}</th>
                <th className="py-2 px-3 text-right">{t('purchasing.co.lineTotal')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {preview.lines.map((line) => (
                <tr key={line.id} className={line.changed ? 'bg-amber-50/60' : ''}>
                  <td className="py-2.5 px-3">
                    <div className="font-semibold text-slate-900">{line.item_description}</div>
                    <div className="text-[10px] text-slate-400">
                      {lineTypeLabel(line)} · {t('purchasing.co.current', { qty: line.quantity, price: formatMoney(line.unit_price) })}
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-[10px] text-slate-500">
                    {t('purchasing.co.floor', { n: line.floor })}<br />{floorLabel(line)}
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
                      {...moneyInputProps}
                      value={priceDrafts[line.id]}
                      onChange={(e) => setPriceDrafts((prev) => ({ ...prev, [line.id]: e.target.value }))}
                      className="w-28 ml-auto block border border-slate-200 rounded-lg px-2 py-1.5 text-right font-semibold"
                    />
                  </td>
                  <td className="py-2.5 px-3 text-right font-bold text-slate-900">
                    {formatMoney(line.next_total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[10px] text-slate-400">{t('money.hint')}</p>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('purchasing.co.reasonLabel')}</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder={t('purchasing.co.reasonPlaceholder')}
              className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t('purchasing.co.deliveryNotes')}</span>
            <textarea
              value={deliveryNotes}
              onChange={(e) => setDeliveryNotes(e.target.value)}
              rows={2}
              className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </label>

          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">{t('purchasing.co.beforeAfter')}</div>
              <div className="text-sm font-black text-slate-900">
                {formatMoney(preview.beforeTotal)} → {formatMoney(preview.afterTotal)}
              </div>
              <div className={`text-[11px] font-semibold ${preview.delta > 0 ? 'text-amber-700' : preview.delta < 0 ? 'text-emerald-700' : 'text-slate-500'}`}>
                {t('purchasing.co.delta')} {preview.delta >= 0 ? '+' : ''}{formatMoney(preview.delta)}
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
                  {t('purchasing.co.confirmIncrease', { amount: formatMoney(100_000) })}
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
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            {submitting ? t('purchasing.co.applying') : t('purchasing.co.apply')}
          </button>
        </div>
      </div>
    </div>
  );
}
