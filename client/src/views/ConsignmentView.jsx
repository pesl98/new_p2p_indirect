import React, { useEffect, useState } from 'react';
import { Warehouse, Plus, ArrowDownToLine, X, Building2 } from 'lucide-react';
import { api } from '../api';
import { formatMoney, fromCents, toCents } from '../money';

const EMPTY_OVERVIEW = { balances: [], receipts: [], issues: [], owned_stock: [] };

export default function ConsignmentView({ currentUser, onDataChanged, onNavigate }) {
  const [overview, setOverview] = useState(EMPTY_OVERVIEW);
  const [suppliers, setSuppliers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState(null);
  const [showReceive, setShowReceive] = useState(false);
  const [issueBalance, setIssueBalance] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [stock, supplierRows, catalogRows] = await Promise.all([
        api.getConsignment(),
        api.getSuppliers('active'),
        api.getCatalog()
      ]);
      setOverview(stock || EMPTY_OVERVIEW);
      setSuppliers(Array.isArray(supplierRows) ? supplierRows : []);
      setCatalog(
        (Array.isArray(catalogRows) ? catalogRows : []).filter((item) => item.line_type !== 'service')
      );
    } catch (err) {
      console.error(err);
      setBanner({ tone: 'error', text: err.message || 'Failed to load consignment stock.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const goodsCatalog = catalog;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Consignment Stock</h2>
          <p className="text-xs text-slate-500 mt-0.5 max-w-2xl">
            Supplier-owned inventory held at your site. Receiving it does not post a goods receipt or book company-owned stock.
            Issuing it into use creates a payable purchase order so AP can match the supplier invoice to what was drawn.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setBanner(null); setShowReceive(true); }}
          className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Record consignment
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
            <button
              type="button"
              onClick={() => onNavigate?.('purchase_orders', { focusId: banner.poId })}
              className="mt-2 text-xs font-semibold underline"
            >
              Open {banner.poNumber}
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <section className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
            <Warehouse className="w-4 h-4 text-emerald-700" />
            <h3 className="text-sm font-bold text-slate-900">Supplier-owned on hand</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="py-2.5 px-4">Item</th>
                  <th className="py-2.5 px-4">Supplier</th>
                  <th className="py-2.5 px-4">Location</th>
                  <th className="py-2.5 px-4 text-right">On hand</th>
                  <th className="py-2.5 px-4 text-right">Draw price</th>
                  <th className="py-2.5 px-4" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr><td colSpan="6" className="py-8 text-center text-slate-400">Loading consignment…</td></tr>
                ) : overview.balances.length === 0 ? (
                  <tr><td colSpan="6" className="py-8 text-center text-slate-400">No consignment balances yet.</td></tr>
                ) : overview.balances.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/80">
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-900">{row.item_name}</div>
                      <div className="text-[10px] text-slate-400 font-mono">{row.sku}</div>
                    </td>
                    <td className="py-3 px-4 text-slate-700">{row.supplier_name}</td>
                    <td className="py-3 px-4 text-slate-600">{row.location_label}</td>
                    <td className="py-3 px-4 text-right font-bold text-slate-900">{row.quantity_on_hand} {row.unit}</td>
                    <td className="py-3 px-4 text-right">{formatMoney(row.unit_price)}</td>
                    <td className="py-3 px-4 text-right">
                      <button
                        type="button"
                        disabled={row.quantity_on_hand <= 0 || row.status !== 'active'}
                        onClick={() => { setBanner(null); setIssueBalance(row); }}
                        className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white rounded font-semibold text-[11px] inline-flex items-center gap-1"
                      >
                        <ArrowDownToLine className="w-3.5 h-3.5" />
                        Issue
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
            <Building2 className="w-4 h-4 text-slate-600" />
            <div>
              <h3 className="text-sm font-bold text-slate-900">Company-owned receipts (GRN)</h3>
              <p className="text-[11px] text-slate-500">Units booked to the company on a goods receipt. Not consignment on-hand.</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="py-2.5 px-4">Item</th>
                  <th className="py-2.5 px-4 text-right">Received on GRN</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr><td colSpan="2" className="py-8 text-center text-slate-400">Loading owned receipts…</td></tr>
                ) : overview.owned_stock.length === 0 ? (
                  <tr><td colSpan="2" className="py-8 text-center text-slate-400">No goods receipts yet.</td></tr>
                ) : overview.owned_stock.map((row) => (
                  <tr key={`${row.sku || row.item_name}`} className="hover:bg-slate-50/80">
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-900">{row.item_name}</div>
                      {row.sku && <div className="text-[10px] text-slate-400 font-mono">{row.sku}</div>}
                    </td>
                    <td className="py-3 px-4 text-right font-bold text-slate-900">{row.quantity_received}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <MovementTable
          title="Consignment receipts"
          empty="No consignment receipts yet."
          rows={overview.receipts}
          loading={loading}
        />
        <MovementTable
          title="Issues into company use"
          empty="No consignment issues yet."
          rows={overview.issues}
          loading={loading}
          onOpenPo={(row) => onNavigate?.('purchase_orders', { focusId: row.po_id })}
        />
      </div>

      {showReceive && (
        <ReceiveModal
          suppliers={suppliers}
          catalog={goodsCatalog}
          currentUser={currentUser}
          onClose={() => setShowReceive(false)}
          onSaved={async (result) => {
            setShowReceive(false);
            setBanner({ tone: 'ok', text: result.message });
            await load();
            onDataChanged?.();
          }}
        />
      )}

      {issueBalance && (
        <IssueModal
          balance={issueBalance}
          currentUser={currentUser}
          onClose={() => setIssueBalance(null)}
          onSaved={async (result) => {
            setIssueBalance(null);
            setBanner({
              tone: 'ok',
              text: result.message,
              poId: result.poId,
              poNumber: result.poNumber
            });
            await load();
            onDataChanged?.();
          }}
        />
      )}
    </div>
  );
}

function MovementTable({ title, empty, rows, loading, onOpenPo }) {
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
              <th className="py-2.5 px-4">Item</th>
              <th className="py-2.5 px-4">Supplier</th>
              <th className="py-2.5 px-4 text-right">Qty</th>
              <th className="py-2.5 px-4">Date</th>
              {onOpenPo && <th className="py-2.5 px-4">Payable</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={onOpenPo ? 6 : 5} className="py-6 text-center text-slate-400">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={onOpenPo ? 6 : 5} className="py-6 text-center text-slate-400">{empty}</td></tr>
            ) : rows.map((row) => (
              <tr key={row.id}>
                <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">{row.receipt_number || row.issue_number}</td>
                <td className="py-2.5 px-4">{row.item_name}</td>
                <td className="py-2.5 px-4">{row.supplier_name}</td>
                <td className="py-2.5 px-4 text-right font-semibold">{row.quantity}</td>
                <td className="py-2.5 px-4 text-slate-500">{row.receipt_date || row.issue_date}</td>
                {onOpenPo && (
                  <td className="py-2.5 px-4">
                    <button type="button" onClick={() => onOpenPo(row)} className="font-mono font-semibold text-emerald-700 hover:text-emerald-800">
                      {row.po_number}
                    </button>
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

function ReceiveModal({ suppliers, catalog, currentUser, onClose, onSaved }) {
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ? String(suppliers[0].id) : '');
  const [catalogItemId, setCatalogItemId] = useState('');
  const [locationLabel, setLocationLabel] = useState('HQ facilities cage');
  const [quantity, setQuantity] = useState(1);
  const [unitPrice, setUnitPrice] = useState('');
  const [receiptDate, setReceiptDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const item = catalog.find((row) => String(row.id) === String(catalogItemId));
    if (item) setUnitPrice(fromCents(item.unit_price).toFixed(2));
  }, [catalogItemId, catalog]);

  const submit = async () => {
    setError('');
    if (!supplierId || !catalogItemId) {
      setError('Choose a supplier and a goods catalog item.');
      return;
    }
    setSaving(true);
    try {
      const result = await api.receiveConsignment({
        supplier_id: Number(supplierId),
        catalog_item_id: Number(catalogItemId),
        location_label: locationLabel,
        quantity: Number(quantity),
        unit_price: toCents(unitPrice),
        receipt_date: receiptDate,
        notes,
        received_by: currentUser?.id,
        actor_name: currentUser?.name
      });
      await onSaved(result);
    } catch (err) {
      setError(err.message || 'Failed to record consignment.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Record consignment receipt" subtitle="Adds supplier-owned on-hand. Does not create a GRN or a purchase order." onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <Field label="Supplier">
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg">
            <option value="">Select supplier</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Catalog item (goods)">
          <select value={catalogItemId} onChange={(e) => setCatalogItemId(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg">
            <option value="">Select item</option>
            {catalog.map((item) => (
              <option key={item.id} value={item.id}>{item.sku} — {item.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Location">
          <input value={locationLabel} onChange={(e) => setLocationLabel(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
        <Field label="Quantity">
          <input type="number" min="1" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
        <Field label="Agreed unit price">
          <input type="number" min="0" step="0.01" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
        <Field label="Receipt date">
          <input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Notes">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" placeholder="Optional delivery note" />
          </Field>
        </div>
      </div>
      {error && <p className="text-xs text-rose-700 mt-3">{error}</p>}
      <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-slate-200">
        <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold">Cancel</button>
        <button type="button" disabled={saving} onClick={submit} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold">
          {saving ? 'Saving…' : 'Record supplier-owned stock'}
        </button>
      </div>
    </Modal>
  );
}

function IssueModal({ balance, currentUser, onClose, onSaved }) {
  const [quantity, setQuantity] = useState(Math.min(1, balance.quantity_on_hand) || 1);
  const [issueDate, setIssueDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      const result = await api.issueConsignment({
        balance_id: balance.id,
        quantity: Number(quantity),
        issue_date: issueDate,
        notes,
        issued_by: currentUser?.id,
        actor_name: currentUser?.name
      });
      await onSaved(result);
    } catch (err) {
      setError(err.message || 'Failed to issue consignment.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Issue into company use"
      subtitle={`${balance.item_name} · ${balance.supplier_name} · ${balance.quantity_on_hand} on hand at ${balance.location_label}`}
      onClose={onClose}
    >
      <p className="text-xs text-slate-600 mb-3">
        This reduces supplier-owned on-hand and opens a consignment purchase order at {formatMoney(balance.unit_price)} each.
        Record the supplier invoice against that PO. A goods receipt is not created.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <Field label="Quantity to issue">
          <input type="number" min="1" max={balance.quantity_on_hand} step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
        <Field label="Issue date">
          <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Notes">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg" placeholder="Where the stock was put into use" />
          </Field>
        </div>
      </div>
      {error && <p className="text-xs text-rose-700 mt-3">{error}</p>}
      <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-slate-200">
        <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold">Cancel</button>
        <button type="button" disabled={saving} onClick={submit} className="px-4 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white rounded-lg text-xs font-semibold">
          {saving ? 'Issuing…' : 'Issue and create payable PO'}
        </button>
      </div>
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
