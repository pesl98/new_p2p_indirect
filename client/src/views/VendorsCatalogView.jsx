import React, { useState, useEffect, useMemo } from 'react';
import { Store, BookOpen, Plus, Search, Star, Phone, Mail, MapPin, X, Pencil, Ban, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { t, presentError, statusLabel, categoryLabel, paymentTermLabel } from '../i18n';
import { formatMoney, toCents, formatMajorInput, moneyInputProps } from '../money';
import { lineTypeFromCategory, lineTypeLabel, serviceBasisLabel } from '../lineType';

const CATALOG_CATEGORIES = [
  'IT Hardware',
  'Software & Cloud',
  'Office Supplies',
  'Facilities & MRO',
  'Consulting & Professional Services'
];

function StatusBadge({ status }) {
  const value = status || 'active';
  const styles = {
    active: 'bg-emerald-100 text-emerald-800',
    inactive: 'bg-slate-200 text-slate-700',
    under_review: 'bg-amber-100 text-amber-800'
  };
  return (
    <span className={`font-bold px-2 py-0.5 rounded-full text-[10px] ${styles[value] || styles.inactive}`}>
      {statusLabel(value)}
    </span>
  );
}

function assignableSuppliers(suppliers, keepId) {
  return (suppliers || []).filter((s) => (
    s.status === 'active' || (keepId != null && Number(s.id) === Number(keepId))
  ));
}

function dayCount(n) {
  const count = Number(n) || 0;
  return count === 1 ? t('catalog.dayOne') : t('catalog.daysMany', { n: count });
}

function poCount(n) {
  const count = Number(n) || 0;
  return count === 1 ? t('suppliers.poOne') : t('suppliers.poMany', { n: count });
}

function presentSupplierWarning(message, fallbackKey) {
  const match = String(message).match(/Supplier remains preferred on (\d+) active catalog item/);
  if (match) {
    const count = Number(match[1]);
    return count === 1
      ? t('catalog.preferredWarningOne')
      : t('catalog.preferredWarningMany', { count });
  }
  return presentError(message, fallbackKey);
}

export default function VendorsCatalogView() {
  const [subTab, setSubTab] = useState('catalog'); // 'catalog' | 'suppliers'
  const [catalog, setCatalog] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');

  const [showCatalogModal, setShowCatalogModal] = useState(false);
  const [showSupplierModal, setShowSupplierModal] = useState(false);
  const [editingCatalog, setEditingCatalog] = useState(null);
  const [editingSupplier, setEditingSupplier] = useState(null);

  const [newSKU, setNewSKU] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newCategory, setNewCategory] = useState('IT Hardware');
  const [newUnit, setNewUnit] = useState('each');
  const [newBasis, setNewBasis] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [newSupplierId, setNewSupplierId] = useState('');
  const [newLeadDays, setNewLeadDays] = useState(3);

  const [supName, setSupName] = useState('');
  const [supCode, setSupCode] = useState('');
  const [supContact, setSupContact] = useState('');
  const [supEmail, setSupEmail] = useState('');
  const [supPhone, setSupPhone] = useState('');
  const [supAddress, setSupAddress] = useState('');
  const [supTerms, setSupTerms] = useState('Net 30');
  const [supStatus, setSupStatus] = useState('active');

  const loadData = async () => {
    setLoading(true);
    try {
      const [cat, sups] = await Promise.all([
        api.getCatalog(category, search, { status: 'all' }),
        api.getSuppliers()
      ]);
      setCatalog(Array.isArray(cat) ? cat : []);
      setSuppliers(Array.isArray(sups) ? sups : []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [category, search]);

  const catalogPreferredChoices = useMemo(
    () => assignableSuppliers(suppliers, editingCatalog?.preferred_supplier_id),
    [suppliers, editingCatalog]
  );

  const resetCatalogForm = (firstSupplierId) => {
    setEditingCatalog(null);
    setNewSKU('');
    setNewName('');
    setNewDesc('');
    setNewCategory('IT Hardware');
    setNewUnit('each');
    setNewBasis('');
    setNewPrice('');
    setNewSupplierId(firstSupplierId || '');
    setNewLeadDays(3);
  };

  const resetSupplierForm = () => {
    setEditingSupplier(null);
    setSupName('');
    setSupCode('');
    setSupContact('');
    setSupEmail('');
    setSupPhone('');
    setSupAddress('');
    setSupTerms('Net 30');
    setSupStatus('active');
  };

  const openAddCatalog = () => {
    const firstActive = suppliers.find((s) => s.status === 'active');
    resetCatalogForm(firstActive?.id ? String(firstActive.id) : '');
    setShowCatalogModal(true);
  };

  const openEditCatalog = (item) => {
    setEditingCatalog(item);
    setNewSKU(item.sku || '');
    setNewName(item.name || '');
    setNewDesc(item.description || '');
    setNewCategory(item.category || 'IT Hardware');
    setNewUnit(item.unit || 'each');
    setNewBasis(item.service_basis || '');
    setNewPrice(item.unit_price != null ? formatMajorInput(item.unit_price) : '');
    setNewSupplierId(item.preferred_supplier_id ? String(item.preferred_supplier_id) : '');
    setNewLeadDays(item.lead_time_days || 3);
    setShowCatalogModal(true);
  };

  const openAddSupplier = () => {
    resetSupplierForm();
    setShowSupplierModal(true);
  };

  const openEditSupplier = (sup) => {
    setEditingSupplier(sup);
    setSupName(sup.name || '');
    setSupCode(sup.code || '');
    setSupContact(sup.contact_person || '');
    setSupEmail(sup.email || '');
    setSupPhone(sup.phone || '');
    setSupAddress(sup.address || '');
    setSupTerms(sup.payment_terms || 'Net 30');
    setSupStatus(sup.status || 'active');
    setShowSupplierModal(true);
  };

  const handleSaveCatalogItem = async () => {
    if (!newSKU || !newName || !newPrice) {
      alert(t('catalog.fieldsRequired'));
      return;
    }
    const payload = {
      sku: newSKU,
      name: newName,
      description: newDesc,
      category: newCategory,
      unit: newUnit,
      service_basis: lineTypeFromCategory(newCategory) === 'service' ? (newBasis || null) : null,
      unit_price: toCents(newPrice),
      preferred_supplier_id: newSupplierId ? Number(newSupplierId) : null,
      lead_time_days: Number(newLeadDays)
    };
    try {
      if (editingCatalog) {
        await api.updateCatalogItem(editingCatalog.id, payload);
      } else {
        await api.createCatalogItem(payload);
      }
      setShowCatalogModal(false);
      resetCatalogForm();
      loadData();
    } catch (err) {
      alert(presentError(err, editingCatalog ? 'errors.catalogUpdate' : 'errors.catalogCreate'));
    }
  };

  const handleSaveSupplier = async () => {
    if (!supName || (!editingSupplier && !supCode)) {
      alert(t('suppliers.fieldsRequired'));
      return;
    }
    try {
      if (editingSupplier) {
        const updated = await api.updateSupplier(editingSupplier.id, {
          name: supName,
          contact_person: supContact,
          email: supEmail,
          phone: supPhone,
          address: supAddress,
          payment_terms: supTerms,
          status: supStatus
        });
        if (updated.warnings?.length) {
          alert(updated.warnings.map((warning) => presentSupplierWarning(warning, 'errors.supplierUpdate')).join('\n'));
        }
      } else {
        await api.createSupplier({
          name: supName,
          code: supCode,
          contact_person: supContact,
          email: supEmail,
          phone: supPhone,
          address: supAddress,
          payment_terms: supTerms
        });
      }
      setShowSupplierModal(false);
      resetSupplierForm();
      loadData();
    } catch (err) {
      alert(presentError(err, editingSupplier ? 'errors.supplierUpdate' : 'errors.supplierCreate'));
    }
  };

  const handleCatalogStatus = async (item, nextStatus) => {
    if (nextStatus === 'inactive') {
      const ok = window.confirm(
        t('catalog.deactivateItem', { sku: item.sku, name: item.name })
      );
      if (!ok) return;
    }
    try {
      await api.updateCatalogItemStatus(item.id, nextStatus);
      loadData();
    } catch (err) {
      alert(presentError(err, 'errors.catalogStatus'));
    }
  };

  const handleSupplierStatus = async (sup, nextStatus) => {
    if (nextStatus === 'inactive') {
      const ok = window.confirm(
        t('suppliers.deactivate', { name: sup.name })
      );
      if (!ok) return;
    }
    try {
      const updated = await api.updateSupplierStatus(sup.id, nextStatus);
      if (updated.warnings?.length) {
        alert(updated.warnings.map((warning) => presentSupplierWarning(warning, 'errors.supplierStatus')).join('\n'));
      }
      loadData();
    } catch (err) {
      alert(presentError(err, 'errors.supplierStatus'));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">{t('catalog.title')}</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t('catalog.subtitle')}
          </p>
        </div>

        <div className="flex items-center space-x-3">
          {subTab === 'catalog' ? (
            <button
              onClick={openAddCatalog}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-sm transition-all flex items-center space-x-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>{t('catalog.addItem')}</span>
            </button>
          ) : (
            <button
              onClick={openAddSupplier}
              className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-sm transition-all flex items-center space-x-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>{t('catalog.addSupplier')}</span>
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center space-x-4 border-b border-slate-200 text-xs font-semibold pb-1">
        <button
          onClick={() => setSubTab('catalog')}
          className={`pb-2.5 border-b-2 transition-colors flex items-center space-x-2 ${
            subTab === 'catalog'
              ? 'border-emerald-600 text-emerald-700 font-bold'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <BookOpen className="w-4 h-4" />
          <span>{t('catalog.tabCatalog', { n: catalog.length })}</span>
        </button>
        <button
          onClick={() => setSubTab('suppliers')}
          className={`pb-2.5 border-b-2 transition-colors flex items-center space-x-2 ${
            subTab === 'suppliers'
              ? 'border-indigo-600 text-indigo-700 font-bold'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Store className="w-4 h-4" />
          <span>{t('catalog.tabSuppliers', { n: suppliers.length })}</span>
        </button>
      </div>

      {subTab === 'catalog' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-3 bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm text-xs">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 absolute left-3 top-3 text-slate-400" />
              <input
                type="text"
                placeholder={t('catalog.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-8 pr-3 py-2 border border-slate-200 rounded-lg text-xs"
              />
            </div>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium"
            >
              <option value="All">{categoryLabel('All')}</option>
              {CATALOG_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>{categoryLabel(cat)}</option>
              ))}
            </select>
          </div>

          {loading && <p className="text-xs text-slate-400">{t('catalog.loading')}</p>}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {catalog.map((item) => (
              <div key={item.id} className={`bg-white rounded-xl border p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col justify-between space-y-3 ${item.status === 'inactive' ? 'border-slate-300 opacity-80' : 'border-slate-200/80'}`}>
                <div>
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span className="font-mono text-slate-400 font-bold">{item.sku}</span>
                    <span className="flex items-center gap-1">
                      <StatusBadge status={item.status} />
                      <span className={`font-bold px-2 py-0.5 rounded-full text-[10px] ${item.line_type === 'service' ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-700'}`}>
                        {lineTypeLabel(item)}{serviceBasisLabel(item.service_basis) ? ` · ${serviceBasisLabel(item.service_basis)}` : ''}
                      </span>
                      <span className="bg-slate-100 text-slate-700 font-medium px-2 py-0.5 rounded text-[10px]">
                        {categoryLabel(item.category)}
                      </span>
                    </span>
                  </div>
                  <h3 className="text-sm font-bold text-slate-900 mt-1">{item.name}</h3>
                  <p className="text-xs text-slate-500 mt-1 line-clamp-2 leading-relaxed">{item.description}</p>
                  {item.preferred_supplier_name && (
                    <p className="text-[11px] text-slate-500 mt-2">
                      {t('catalog.preferred', { name: item.preferred_supplier_name })}
                      {item.preferred_supplier_status && item.preferred_supplier_status !== 'active' ? ` (${statusLabel(item.preferred_supplier_status)})` : ''}
                    </p>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-100 space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <div>
                      <span className="text-[10px] text-slate-400 block">{t('catalog.negotiatedPrice')}</span>
                      <div className="text-base font-extrabold text-emerald-700">
                        {formatMoney(item.unit_price)}
                        <span className="text-[10px] text-slate-400 font-normal"> / {item.unit}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] text-slate-400 block">{t('catalog.leadTime')}</span>
                      <span className="font-semibold text-slate-700">{dayCount(item.lead_time_days)}</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => openEditCatalog(item)}
                      className="px-2.5 py-1.5 border border-slate-200 rounded-lg text-[11px] font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-1"
                    >
                      <Pencil className="w-3 h-3" />
                      {t('common.edit')}
                    </button>
                    {item.status === 'inactive' ? (
                      <button
                        type="button"
                        onClick={() => handleCatalogStatus(item, 'active')}
                        className="px-2.5 py-1.5 border border-emerald-200 text-emerald-800 rounded-lg text-[11px] font-semibold hover:bg-emerald-50 flex items-center gap-1"
                      >
                        <RotateCcw className="w-3 h-3" />
                        {t('catalog.reactivate')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleCatalogStatus(item, 'inactive')}
                        className="px-2.5 py-1.5 border border-slate-200 text-slate-600 rounded-lg text-[11px] font-semibold hover:bg-slate-50 flex items-center gap-1"
                      >
                        <Ban className="w-3 h-3" />
                        {t('catalog.deactivate')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {subTab === 'suppliers' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {suppliers.map((sup) => (
            <div key={sup.id} className={`bg-white rounded-xl border p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col justify-between space-y-4 ${sup.status === 'inactive' ? 'border-slate-300 opacity-80' : 'border-slate-200/80'}`}>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-mono font-bold text-slate-400 text-xs">{sup.code}</span>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={sup.status} />
                    <div className="flex items-center text-amber-500 text-xs font-bold space-x-1">
                      <Star className="w-3.5 h-3.5 fill-current" />
                      <span>{sup.rating || '5.0'}</span>
                    </div>
                  </div>
                </div>
                <h3 className="text-base font-bold text-slate-900">{sup.name}</h3>
                <div className="space-y-1 mt-2 text-xs text-slate-600">
                  <div className="flex items-center space-x-2">
                    <span className="text-slate-400 font-medium">{t('common.contact')}:</span>
                    <span>{sup.contact_person || t('suppliers.contactFallback')}</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Mail className="w-3.5 h-3.5 text-slate-400" />
                    <span>{sup.email}</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Phone className="w-3.5 h-3.5 text-slate-400" />
                    <span>{sup.phone}</span>
                  </div>
                  {sup.address && (
                    <div className="flex items-center space-x-2">
                      <MapPin className="w-3.5 h-3.5 text-slate-400" />
                      <span>{sup.address}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <div>
                    <span className="text-[10px] text-slate-400 block">{t('suppliers.standardTerms')}</span>
                    <span className="font-semibold text-slate-800">{paymentTermLabel(sup.payment_terms)}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] text-slate-400 block">{t('suppliers.poOrders')}</span>
                    <span className="font-bold text-indigo-700">{poCount(sup.total_pos || 0)}</span>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => openEditSupplier(sup)}
                    className="px-2.5 py-1.5 border border-slate-200 rounded-lg text-[11px] font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-1"
                  >
                    <Pencil className="w-3 h-3" />
                    {t('common.edit')}
                  </button>
                  {sup.status === 'inactive' ? (
                    <button
                      type="button"
                      onClick={() => handleSupplierStatus(sup, 'active')}
                      className="px-2.5 py-1.5 border border-emerald-200 text-emerald-800 rounded-lg text-[11px] font-semibold hover:bg-emerald-50 flex items-center gap-1"
                    >
                      <RotateCcw className="w-3 h-3" />
                      {t('catalog.reactivate')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleSupplierStatus(sup, 'inactive')}
                      className="px-2.5 py-1.5 border border-slate-200 text-slate-600 rounded-lg text-[11px] font-semibold hover:bg-slate-50 flex items-center gap-1"
                    >
                      <Ban className="w-3 h-3" />
                      {t('catalog.deactivate')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCatalogModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex justify-between items-center pb-3 border-b border-slate-200">
              <h3 className="text-base font-bold text-slate-900">
                {editingCatalog ? t('catalog.editItem') : t('catalog.addIndirect')}
              </h3>
              <button onClick={() => setShowCatalogModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-600 mb-1">{t('catalog.sku')}</label>
                  <input
                    type="text"
                    placeholder={t('catalog.skuPlaceholder')}
                    value={newSKU}
                    onChange={(e) => setNewSKU(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">{t('common.category')}</label>
                  <select
                    value={newCategory}
                    onChange={(e) => {
                      const category = e.target.value;
                      setNewCategory(category);
                      if (lineTypeFromCategory(category) === 'service') {
                        setNewBasis((current) => current || 'lump_sum');
                      } else {
                        setNewBasis('');
                      }
                    }}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  >
                    {CATALOG_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>{cat === 'Consulting & Professional Services' ? t('category.consultingShort') : categoryLabel(cat)}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-600 mb-1">{t('catalog.itemName')}</label>
                <input
                  type="text"
                  placeholder={t('catalog.namePlaceholder')}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                />
              </div>

              <div>
                <label className="block text-slate-600 mb-1">{t('common.description')}</label>
                <textarea
                  rows="2"
                  placeholder={t('catalog.descPlaceholder')}
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                />
              </div>

              <div>
                <label className="block text-slate-600 mb-1">{t('catalog.preferredSupplier')}</label>
                <select
                  value={newSupplierId}
                  onChange={(e) => setNewSupplierId(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                >
                  <option value="">{t('catalog.noPreferred')}</option>
                  {catalogPreferredChoices.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}{s.status !== 'active' ? ` (${statusLabel(s.status)})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {lineTypeFromCategory(newCategory) === 'service' && (
                <div>
                  <label className="block text-slate-600 mb-1">{t('catalog.serviceBasis')}</label>
                  <select
                    value={newBasis}
                    onChange={(e) => setNewBasis(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  >
                    <option value="">{t('catalog.unitQuantity')}</option>
                    <option value="lump_sum">{serviceBasisLabel('lump_sum')}</option>
                    <option value="hours">{serviceBasisLabel('hours')}</option>
                    <option value="days">{serviceBasisLabel('days')}</option>
                  </select>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-slate-600 mb-1">{t('common.unitPrice')}</label>
                  <input
                    {...moneyInputProps}
                    placeholder={t('money.example')}
                    value={newPrice}
                    onChange={(e) => setNewPrice(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">{t('catalog.unit')}</label>
                  <input
                    type="text"
                    value={newUnit}
                    onChange={(e) => setNewUnit(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">{t('catalog.leadDays')}</label>
                  <input
                    type="number"
                    value={newLeadDays}
                    onChange={(e) => setNewLeadDays(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  />
                </div>
              </div>
              <p className="text-[10px] text-slate-400">{t('money.hint')}</p>
            </div>

            <div className="flex justify-end space-x-2 pt-3 border-t border-slate-200">
              <button onClick={() => setShowCatalogModal(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-xs font-semibold">
                {t('common.cancel')}
              </button>
              <button onClick={handleSaveCatalogItem} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-xs font-semibold">
                {editingCatalog ? t('catalog.saveChanges') : t('catalog.saveItem')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSupplierModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex justify-between items-center pb-3 border-b border-slate-200">
              <h3 className="text-base font-bold text-slate-900">
                {editingSupplier ? t('suppliers.edit') : t('suppliers.onboard')}
              </h3>
              <button onClick={() => setShowSupplierModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-600 mb-1">{t('suppliers.name')}</label>
                  <input
                    type="text"
                    placeholder={t('suppliers.namePlaceholder')}
                    value={supName}
                    onChange={(e) => setSupName(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">{t('suppliers.code')}</label>
                  <input
                    type="text"
                    placeholder={t('suppliers.codePlaceholder')}
                    value={supCode}
                    onChange={(e) => setSupCode(e.target.value)}
                    disabled={Boolean(editingSupplier)}
                    className={`w-full p-2 border border-slate-300 rounded-lg font-mono text-xs ${editingSupplier ? 'bg-slate-50 text-slate-500' : ''}`}
                  />
                  {editingSupplier && (
                    <p className="text-[10px] text-slate-400 mt-1">{t('suppliers.codeImmutable')}</p>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-slate-600 mb-1">{t('suppliers.contactPerson')}</label>
                <input
                  type="text"
                  placeholder={t('suppliers.contactPlaceholder')}
                  value={supContact}
                  onChange={(e) => setSupContact(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-600 mb-1">{t('common.email')}</label>
                  <input
                    type="email"
                    placeholder={t('suppliers.emailPlaceholder')}
                    value={supEmail}
                    onChange={(e) => setSupEmail(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">{t('common.phone')}</label>
                  <input
                    type="text"
                    placeholder={t('suppliers.phonePlaceholder')}
                    value={supPhone}
                    onChange={(e) => setSupPhone(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-600 mb-1">{t('common.address')}</label>
                <input
                  type="text"
                  placeholder={t('suppliers.addressPlaceholder')}
                  value={supAddress}
                  onChange={(e) => setSupAddress(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-600 mb-1">{t('suppliers.paymentTerms')}</label>
                  <select
                    value={supTerms}
                    onChange={(e) => setSupTerms(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  >
                    <option value="Net 15">{paymentTermLabel('Net 15')}</option>
                    <option value="Net 30">{paymentTermLabel('Net 30')}</option>
                    <option value="Net 45">{paymentTermLabel('Net 45')}</option>
                    <option value="Net 60">{paymentTermLabel('Net 60')}</option>
                  </select>
                </div>
                {editingSupplier && (
                  <div>
                    <label className="block text-slate-600 mb-1">{t('common.status')}</label>
                    <select
                      value={supStatus}
                      onChange={(e) => setSupStatus(e.target.value)}
                      className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                    >
                      <option value="active">{statusLabel('active')}</option>
                      <option value="under_review">{statusLabel('under_review')}</option>
                      <option value="inactive">{statusLabel('inactive')}</option>
                    </select>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-3 border-t border-slate-200">
              <button onClick={() => setShowSupplierModal(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-xs font-semibold">
                {t('common.cancel')}
              </button>
              <button onClick={handleSaveSupplier} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-xs font-semibold">
                {editingSupplier ? t('catalog.saveChanges') : t('suppliers.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
