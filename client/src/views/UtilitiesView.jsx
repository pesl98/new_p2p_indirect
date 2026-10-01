import React, { useEffect, useState } from 'react';
import { Gauge, Plus, X } from 'lucide-react';
import { api } from '../api';
import { formatMoney, fromCents, toCents } from '../money';
import { UTILITY_UNITS, formatMeasured } from '../measuredQty';

const EMPTY = { arrangements: [], consumptions: [] };
const UTILITY_LABEL = { water: 'Water', electricity: 'Electricity', gas: 'Gas' };

export default function UtilitiesView({ currentUser, onNavigate }) {
  const [overview, setOverview] = useState(EMPTY);
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState(null);
  const [showOpen, setShowOpen] = useState(false);
  const [recordArrangement, setRecordArrangement] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [rows, supplierRows] = await Promise.all([
        api.getUtilities(),
        api.getSuppliers('active')
      ]);
      setOverview(rows || EMPTY);
      setSuppliers(Array.isArray(supplierRows) ? supplierRows : []);
    } catch (err) {
      console.error(err);
      setBanner({ tone: 'error', text: err.message || 'Failed to load utility arrangements.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Metered Utilities</h2>
          <p className="text-xs text-slate-500 mt-0.5 max-w-2xl">
            Water, electricity, and gas are billed by measured consumption against a supply arrangement.
            Recording a reading opens a payable purchase order. It does not post a goods receipt.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setBanner(null); setShowOpen(true); }}
          className="px-3 py-2 bg-sky-700 hover:bg-sky-800 text-white rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Open arrangement
        </button>
      </div>

      {banner && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${banner.tone === 'error' ? 'bg-rose-50 border-rose-200 text-rose-900' : 'bg-emerald-50 border-emerald-200 text-emerald-900'}`}>
          <div className="flex items-start justify-between gap-3">
            <p>{banner.text}</p>
            <button type="button" onClick={() => setBanner(null)} className="text-current opacity-60 hover:opacity-100">
              <X className="w-4 h-4" />
            </button>
          </div>
          {banner.poId && (
            <button type="button" onClick={() => onNavigate?.('purchase_orders', { focusId: banner.poId })} className="mt-2 text-xs font-semibold underline">
              Open {banner.poNumber}
            </button>
          )}
        </div>
      )}

      <section className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
          <Gauge className="w-4 h-4 text-sky-700" />
          <h3 className="text-sm font-bold text-slate-900">Supply arrangements</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px]">
              <tr>
                <th className="py-2.5 px-4">Arrangement</th>
                <th className="py-2.5 px-4">Supplier</th>
                <th className="py-2.5 px-4">Meter</th>
                <th className="py-2.5 px-4 text-right">Price</th>
                <th className="py-2.5 px-4" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan="5" className="py-8 text-center text-slate-400">Loading utilities…</td></tr>
              ) : overview.arrangements.length === 0 ? (
                <tr><td colSpan="5" className="py-8 text-center text-slate-400">No utility arrangements yet.</td></tr>
              ) : overview.arrangements.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4">
                    <div className="font-semibold text-slate-900">{row.name}</div>
                    <div className="text-[10px] text-slate-400 font-mono">{row.arrangement_number} · {UTILITY_LABEL[row.utility_type] || row.utility_type}</div>
                  </td>
                  <td className="py-3 px-4 text-slate-700">{row.supplier_name}</td>
                  <td className="py-3 px-4 text-slate-600">{row.meter_label}</td>
                  <td className="py-3 px-4 text-right font-semibold">${formatMoney(row.unit_price)} / {row.unit_of_measure}</td>
                  <td className="py-3 px-4 text-right">
                    <button
                      type="button"
                      disabled={row.status !== 'active'}
                      onClick={() => { setBanner(null); setRecordArrangement(row); }}
                      className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white rounded font-semibold text-[11px]"
                    >
                      Record usage
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-900">Recorded consumption</h3>
          <p className="text-[11px] text-slate-500">Each row is a payable. Match the supplier invoice to this quantity. No goods receipt.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px]">
              <tr>
                <th className="py-2.5 px-4">Number</th>
                <th className="py-2.5 px-4">Arrangement</th>
                <th className="py-2.5 px-4">Period</th>
                <th className="py-2.5 px-4 text-right">Usage</th>
                <th className="py-2.5 px-4 text-right">Amount</th>
                <th className="py-2.5 px-4">Payable</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {overview.consumptions.length === 0 ? (
                <tr><td colSpan="6" className="py-8 text-center text-slate-400">No consumption recorded yet.</td></tr>
              ) : overview.consumptions.map((row) => (
                <tr key={row.id}>
                  <td className="py-3 px-4 font-mono font-semibold">{row.consumption_number}</td>
                  <td className="py-3 px-4">{row.arrangement_name}</td>
                  <td className="py-3 px-4 text-slate-600">{row.period_start} → {row.period_end}</td>
                  <td className="py-3 px-4 text-right font-semibold">{formatMeasured(row.quantity_milli, row.unit_of_measure)}</td>
                  <td className="py-3 px-4 text-right">${formatMoney(row.amount_cents)}</td>
                  <td className="py-3 px-4">
                    <button type="button" onClick={() => onNavigate?.('purchase_orders', { focusId: row.po_id })} className="font-mono font-semibold text-sky-800 hover:text-sky-950">
                      {row.po_number}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {showOpen && (
        <OpenModal
          suppliers={suppliers}
          currentUser={currentUser}
          onClose={() => setShowOpen(false)}
          onSaved={async (result) => {
            setShowOpen(false);
            setBanner({ tone: 'ok', text: result.message });
            await load();
          }}
        />
      )}
      {recordArrangement && (
        <RecordModal
          arrangement={recordArrangement}
          currentUser={currentUser}
          onClose={() => setRecordArrangement(null)}
          onSaved={async (result) => {
            setRecordArrangement(null);
            setBanner({ tone: 'ok', text: result.message, poId: result.poId, poNumber: result.poNumber });
            await load();
          }}
        />
      )}
    </div>
  );
}

function OpenModal({ suppliers, currentUser, onClose, onSaved }) {
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ? String(suppliers[0].id) : '');
  const [utilityType, setUtilityType] = useState('electricity');
  const [name, setName] = useState('');
  const [meterLabel, setMeterLabel] = useState('');
  const [unitOfMeasure, setUnitOfMeasure] = useState('kWh');
  const [unitPrice, setUnitPrice] = useState('0.18');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const units = UTILITY_UNITS[utilityType] || [];
    setUnitOfMeasure(units[0] || '');
  }, [utilityType]);

  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      const result = await api.openUtilityArrangement({
        supplier_id: Number(supplierId),
        utility_type: utilityType,
        name,
        meter_label: meterLabel,
        unit_of_measure: unitOfMeasure,
        unit_price: toCents(unitPrice),
        notes,
        opened_by: currentUser?.id || 3,
        actor_name: currentUser?.name
      });
      await onSaved(result);
    } catch (err) {
      setError(err.message || 'Failed to open the arrangement.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Open a utility arrangement" subtitle="Standing metered supply. Does not create a purchase order until you record usage." onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <Field label="Supplier">
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg">
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Utility">
          <select value={utilityType} onChange={(e) => setUtilityType(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg">
            <option value="electricity">Electricity</option>
            <option value="water">Water</option>
            <option value="gas">Gas</option>
          </select>
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" placeholder="HQ campus electricity" />
        </Field>
        <Field label="Meter">
          <input value={meterLabel} onChange={(e) => setMeterLabel(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" placeholder="E-104" />
        </Field>
        <Field label="Unit of measure">
          <select value={unitOfMeasure} onChange={(e) => setUnitOfMeasure(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg">
            {(UTILITY_UNITS[utilityType] || []).map((unit) => (
              <option key={unit} value={unit}>{unit}</option>
            ))}
          </select>
        </Field>
        <Field label="Price per unit ($)">
          <input type="number" min="0" step="0.01" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
        <Field label="Notes">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
      </div>
      {error && <p className="text-xs text-rose-700 mt-3">{error}</p>}
      <ModalActions saving={saving} label="Open arrangement" onClose={onClose} onSubmit={submit} />
    </Modal>
  );
}

function RecordModal({ arrangement, currentUser, onClose, onSaved }) {
  const [mode, setMode] = useState('readings');
  const [periodStart, setPeriodStart] = useState(new Date().toISOString().slice(0, 8) + '01');
  const [periodEnd, setPeriodEnd] = useState(new Date().toISOString().split('T')[0]);
  const [previous, setPrevious] = useState('');
  const [current, setCurrent] = useState('');
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const usage = mode === 'readings' && previous !== '' && current !== ''
    ? Math.round((Number(current) - Number(previous)) * 1000) / 1000
    : Number(quantity);
  const amount = Number.isFinite(usage) && usage > 0
    ? Math.round(Math.round(usage * 1000) * arrangement.unit_price / 1000)
    : 0;

  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      const body = {
        arrangement_id: arrangement.id,
        period_start: periodStart,
        period_end: periodEnd,
        notes,
        recorded_by: currentUser?.id || 3,
        actor_name: currentUser?.name
      };
      if (mode === 'readings') {
        body.reading_previous = previous;
        body.reading_current = current;
      } else {
        body.quantity = quantity;
      }
      const result = await api.recordUtilityConsumption(body);
      await onSaved(result);
    } catch (err) {
      setError(err.message || 'Failed to record consumption.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Record ${UTILITY_LABEL[arrangement.utility_type] || 'utility'} usage`}
      subtitle={`${arrangement.name} · ${arrangement.meter_label} · $${formatMoney(arrangement.unit_price)} / ${arrangement.unit_of_measure}. Opens a payable. No goods receipt.`}
      onClose={onClose}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <Field label="How is usage known?">
          <select value={mode} onChange={(e) => setMode(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg">
            <option value="readings">Meter readings</option>
            <option value="quantity">Billed quantity</option>
          </select>
        </Field>
        <Field label="Period start">
          <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
        <Field label="Period end">
          <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
        {mode === 'readings' ? (
          <>
            <Field label={`Previous reading (${arrangement.unit_of_measure})`}>
              <input type="number" min="0" step="0.001" value={previous} onChange={(e) => setPrevious(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
            </Field>
            <Field label={`Current reading (${arrangement.unit_of_measure})`}>
              <input type="number" min="0" step="0.001" value={current} onChange={(e) => setCurrent(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
            </Field>
          </>
        ) : (
          <Field label={`Billed quantity (${arrangement.unit_of_measure})`}>
            <input type="number" min="0" step="0.001" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
          </Field>
        )}
        <Field label="Notes">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
      </div>
      <p className="text-xs text-slate-600 mt-3">
        Usage {Number.isFinite(usage) ? usage.toFixed(3) : '—'} {arrangement.unit_of_measure}
        {amount > 0 ? ` · payable about $${formatMoney(amount)}` : ''}. Price shown is ${fromCents(arrangement.unit_price).toFixed(2)} per {arrangement.unit_of_measure}.
      </p>
      {error && <p className="text-xs text-rose-700 mt-3">{error}</p>}
      <ModalActions saving={saving} label="Record usage and open payable" onClose={onClose} onSubmit={submit} />
    </Modal>
  );
}

function Modal({ title, subtitle, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-slate-200">
        <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-200 mb-4">
          <div>
            <h3 className="text-lg font-bold text-slate-900">{title}</h3>
            <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block font-semibold text-slate-600 mb-1">{label}</span>
      {children}
    </label>
  );
}

function ModalActions({ saving, label, onClose, onSubmit }) {
  return (
    <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-slate-200">
      <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold">Cancel</button>
      <button type="button" disabled={saving} onClick={onSubmit} className="px-4 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white rounded-lg text-xs font-semibold">
        {saving ? 'Saving…' : label}
      </button>
    </div>
  );
}
