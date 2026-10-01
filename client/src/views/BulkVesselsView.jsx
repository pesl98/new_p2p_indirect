import React, { useEffect, useMemo, useState } from 'react';
import { Cylinder, Plus, X } from 'lucide-react';
import { api } from '../api';
import { formatMoney, fromCents, toCents } from '../money';
import { BULK_UNITS, formatMeasured } from '../measuredQty';

const EMPTY = { containers: [], fills: [], draws: [] };

export default function BulkVesselsView({ currentUser, onNavigate }) {
  const [overview, setOverview] = useState(EMPTY);
  const [suppliers, setSuppliers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState(null);
  const [showRegister, setShowRegister] = useState(false);
  const [fillTarget, setFillTarget] = useState(null);
  const [drawTarget, setDrawTarget] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [rows, supplierRows, catalogRows] = await Promise.all([
        api.getBulkVessels(),
        api.getSuppliers('active'),
        api.getCatalog()
      ]);
      setOverview(rows || EMPTY);
      setSuppliers(Array.isArray(supplierRows) ? supplierRows : []);
      setCatalog((Array.isArray(catalogRows) ? catalogRows : []).filter((item) => item.line_type !== 'service'));
    } catch (err) {
      console.error(err);
      setBanner({ tone: 'error', text: err.message || 'Failed to load vendor-managed bulk.' });
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
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Vendor-Managed Bulk</h2>
          <p className="text-xs text-slate-500 mt-0.5 max-w-2xl">
            Gases and fluids stay supplier-owned in a container or silo until a measured quantity is drawn.
            Filling the vessel does not post a goods receipt. Drawing it opens a payable for the measured quantity.
            This is separate from discrete consignment, which tracks whole catalog units at a free-text location.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setBanner(null); setShowRegister(true); }}
          className="px-3 py-2 bg-teal-700 hover:bg-teal-800 text-white rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Register vessel
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
          <Cylinder className="w-4 h-4 text-teal-700" />
          <h3 className="text-sm font-bold text-slate-900">Containers and silos</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px]">
              <tr>
                <th className="py-2.5 px-4">Vessel</th>
                <th className="py-2.5 px-4">Material</th>
                <th className="py-2.5 px-4">Supplier</th>
                <th className="py-2.5 px-4 text-right">Level</th>
                <th className="py-2.5 px-4 text-right">Capacity</th>
                <th className="py-2.5 px-4 text-right">Draw price</th>
                <th className="py-2.5 px-4" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan="7" className="py-8 text-center text-slate-400">Loading vessels…</td></tr>
              ) : overview.containers.length === 0 ? (
                <tr><td colSpan="7" className="py-8 text-center text-slate-400">No containers or silos yet.</td></tr>
              ) : overview.containers.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4">
                    <div className="font-semibold text-slate-900">{row.name}</div>
                    <div className="text-[10px] text-slate-400 font-mono">{row.container_number} · {row.vessel_type}</div>
                  </td>
                  <td className="py-3 px-4">
                    <div>{row.item_name}</div>
                    <div className="text-[10px] text-slate-400 font-mono">{row.sku}</div>
                  </td>
                  <td className="py-3 px-4 text-slate-700">{row.supplier_name}</td>
                  <td className="py-3 px-4 text-right font-bold">{formatMeasured(row.level_milli, row.unit_of_measure)}</td>
                  <td className="py-3 px-4 text-right text-slate-600">{formatMeasured(row.capacity_milli, row.unit_of_measure)}</td>
                  <td className="py-3 px-4 text-right">${formatMoney(row.unit_price)}</td>
                  <td className="py-3 px-4 text-right space-x-1 whitespace-nowrap">
                    <button type="button" onClick={() => { setBanner(null); setFillTarget(row); }} className="px-2 py-1 border border-slate-300 rounded font-semibold text-[11px]">Fill</button>
                    <button
                      type="button"
                      disabled={row.level_milli <= 0 || row.status !== 'active'}
                      onClick={() => { setBanner(null); setDrawTarget(row); }}
                      className="px-2 py-1 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white rounded font-semibold text-[11px]"
                    >
                      Draw
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <MovementTable
          title="Fills"
          empty="No fills yet. A fill increases supplier-owned level and does not create a PO."
          rows={overview.fills}
          quantityLabel="Filled"
        />
        <MovementTable
          title="Draws"
          empty="No draws yet. A draw opens a payable without a goods receipt."
          rows={overview.draws}
          quantityLabel="Drawn"
          onOpenPo={(row) => onNavigate?.('purchase_orders', { focusId: row.po_id })}
        />
      </div>

      {showRegister && (
        <RegisterModal
          suppliers={suppliers}
          catalog={catalog}
          currentUser={currentUser}
          onClose={() => setShowRegister(false)}
          onSaved={async (result) => {
            setShowRegister(false);
            setBanner({ tone: 'ok', text: result.message });
            await load();
          }}
        />
      )}
      {fillTarget && (
        <QuantityModal
          title={`Fill ${fillTarget.name}`}
          subtitle="Adds supplier-owned measured product. Does not create a GRN or a purchase order."
          unit={fillTarget.unit_of_measure}
          actionLabel="Record fill"
          currentUser={currentUser}
          onClose={() => setFillTarget(null)}
          onSubmit={(body) => api.fillBulkVessel({ ...body, container_id: fillTarget.id, filled_by: currentUser?.id || 3 })}
          onSaved={async (result) => {
            setFillTarget(null);
            setBanner({ tone: 'ok', text: result.message });
            await load();
          }}
        />
      )}
      {drawTarget && (
        <QuantityModal
          title={`Draw from ${drawTarget.name}`}
          subtitle={`On hand ${formatMeasured(drawTarget.level_milli, drawTarget.unit_of_measure)} at $${formatMoney(drawTarget.unit_price)} per ${drawTarget.unit_of_measure}. Opens a payable. No goods receipt.`}
          unit={drawTarget.unit_of_measure}
          actionLabel="Draw and create payable PO"
          currentUser={currentUser}
          onClose={() => setDrawTarget(null)}
          onSubmit={(body) => api.drawBulkVessel({ ...body, container_id: drawTarget.id, drawn_by: currentUser?.id || 3 })}
          onSaved={async (result) => {
            setDrawTarget(null);
            setBanner({ tone: 'ok', text: result.message, poId: result.poId, poNumber: result.poNumber });
            await load();
          }}
        />
      )}
    </div>
  );
}

function MovementTable({ title, empty, rows, onOpenPo }) {
  return (
    <section className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <h3 className="text-sm font-bold text-slate-900">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px]">
            <tr>
              <th className="py-2.5 px-4">Number</th>
              <th className="py-2.5 px-4">Vessel</th>
              <th className="py-2.5 px-4 text-right">Quantity</th>
              {onOpenPo && <th className="py-2.5 px-4">Payable</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr><td colSpan={onOpenPo ? 4 : 3} className="py-8 text-center text-slate-400">{empty}</td></tr>
            ) : rows.map((row) => (
              <tr key={row.id}>
                <td className="py-2.5 px-4 font-mono font-semibold">{row.fill_number || row.draw_number}</td>
                <td className="py-2.5 px-4">{row.container_name}</td>
                <td className="py-2.5 px-4 text-right">{formatMeasured(row.quantity_milli, row.unit_of_measure)}</td>
                {onOpenPo && (
                  <td className="py-2.5 px-4">
                    <button type="button" onClick={() => onOpenPo(row)} className="font-mono font-semibold text-teal-800">{row.po_number}</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RegisterModal({ suppliers, catalog, currentUser, onClose, onSaved }) {
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ? String(suppliers[0].id) : '');
  const [catalogItemId, setCatalogItemId] = useState('');
  const [name, setName] = useState('');
  const [vesselType, setVesselType] = useState('silo');
  const [unitOfMeasure, setUnitOfMeasure] = useState('kg');
  const [capacity, setCapacity] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const selected = useMemo(
    () => catalog.find((item) => String(item.id) === String(catalogItemId)),
    [catalog, catalogItemId]
  );

  useEffect(() => {
    if (!selected) return;
    setUnitPrice(fromCents(selected.unit_price).toFixed(2));
    if (BULK_UNITS.includes(selected.unit)) setUnitOfMeasure(selected.unit);
  }, [selected]);

  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      const result = await api.registerBulkVessel({
        supplier_id: Number(supplierId),
        catalog_item_id: Number(catalogItemId),
        name,
        vessel_type: vesselType,
        unit_of_measure: unitOfMeasure,
        capacity,
        unit_price: toCents(unitPrice),
        notes,
        registered_by: currentUser?.id || 3,
        actor_name: currentUser?.name
      });
      await onSaved(result);
    } catch (err) {
      setError(err.message || 'Failed to register the vessel.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Register a container or silo" subtitle="A holding location with capacity and a unit of measure. Level starts at zero. Not a free-text consignment note." onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <Field label="Supplier">
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg">
            {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
          </select>
        </Field>
        <Field label="Material (goods catalog)">
          <select value={catalogItemId} onChange={(e) => setCatalogItemId(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg">
            <option value="">Select item</option>
            {catalog.map((item) => <option key={item.id} value={item.id}>{item.sku} — {item.name}</option>)}
          </select>
        </Field>
        <Field label="Vessel name">
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" placeholder="LN2 silo S-1" />
        </Field>
        <Field label="Type">
          <select value={vesselType} onChange={(e) => setVesselType(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg">
            <option value="silo">Silo</option>
            <option value="container">Container</option>
          </select>
        </Field>
        <Field label="Unit of measure">
          <select value={unitOfMeasure} onChange={(e) => setUnitOfMeasure(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg">
            {BULK_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
          </select>
        </Field>
        <Field label="Capacity">
          <input type="number" min="0" step="0.001" value={capacity} onChange={(e) => setCapacity(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
        <Field label="Draw price per unit ($)">
          <input type="number" min="0" step="0.01" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
        <Field label="Notes">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
      </div>
      {error && <p className="text-xs text-rose-700 mt-3">{error}</p>}
      <ModalActions saving={saving} label="Register vessel" onClose={onClose} onSubmit={submit} />
    </Modal>
  );
}

function QuantityModal({ title, subtitle, unit, actionLabel, currentUser, onClose, onSubmit, onSaved }) {
  const [quantity, setQuantity] = useState('');
  const [eventDate, setEventDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      const result = await onSubmit({
        quantity,
        fill_date: eventDate,
        draw_date: eventDate,
        notes,
        actor_name: currentUser?.name
      });
      await onSaved(result);
    } catch (err) {
      setError(err.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <Field label={`Quantity (${unit})`}>
          <input type="number" min="0" step="0.001" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
        <Field label="Date">
          <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
        <Field label="Notes">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
      </div>
      {error && <p className="text-xs text-rose-700 mt-3">{error}</p>}
      <ModalActions saving={saving} label={actionLabel} onClose={onClose} onSubmit={submit} />
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
