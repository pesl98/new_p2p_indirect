import React, { useState, useEffect } from 'react';
import { Store, BookOpen, Plus, Search, Filter, Star, Phone, Mail, MapPin, X } from 'lucide-react';
import { api } from '../api';
import { formatMoney, toCents } from '../money';
import { lineTypeLabel } from '../lineType';

export default function VendorsCatalogView() {
  const [subTab, setSubTab] = useState('catalog'); // 'catalog' | 'suppliers'
  const [catalog, setCatalog] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');

  // Modals
  const [showAddCatalog, setShowAddCatalog] = useState(false);
  const [showAddSupplier, setShowAddSupplier] = useState(false);

  // New Catalog Item Form
  const [newSKU, setNewSKU] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newCategory, setNewCategory] = useState('IT Hardware');
  const [newUnit, setNewUnit] = useState('each');
  const [newPrice, setNewPrice] = useState('');
  const [newSupplierId, setNewSupplierId] = useState(1);
  const [newLeadDays, setNewLeadDays] = useState(3);

  // New Supplier Form
  const [supName, setSupName] = useState('');
  const [supCode, setSupCode] = useState('');
  const [supContact, setSupContact] = useState('');
  const [supEmail, setSupEmail] = useState('');
  const [supPhone, setSupPhone] = useState('');
  const [supAddress, setSupAddress] = useState('');
  const [supTerms, setSupTerms] = useState('Net 30');

  const loadData = async () => {
    setLoading(true);
    try {
      const [cat, sups] = await Promise.all([
        api.getCatalog(category, search),
        api.getSuppliers()
      ]);
      setCatalog(cat);
      setSuppliers(sups);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [category, search]);

  const handleCreateCatalogItem = async () => {
    if (!newSKU || !newName || !newPrice) {
      alert('Please provide SKU, item name, and price.');
      return;
    }
    try {
      await api.createCatalogItem({
        sku: newSKU,
        name: newName,
        description: newDesc,
        category: newCategory,
        unit: newUnit,
        unit_price: toCents(newPrice),
        preferred_supplier_id: Number(newSupplierId),
        lead_time_days: Number(newLeadDays)
      });
      setShowAddCatalog(false);
      setNewSKU('');
      setNewName('');
      setNewDesc('');
      setNewPrice('');
      loadData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleCreateSupplier = async () => {
    if (!supName || !supCode) {
      alert('Please provide supplier name and code.');
      return;
    }
    try {
      await api.createSupplier({
        name: supName,
        code: supCode,
        contact_person: supContact,
        email: supEmail,
        phone: supPhone,
        address: supAddress,
        payment_terms: supTerms
      });
      setShowAddSupplier(false);
      setSupName('');
      setSupCode('');
      setSupContact('');
      setSupEmail('');
      loadData();
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Suppliers & Catalog Management</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Maintain approved supplier directories and pre-negotiated non-production item catalogs.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          {subTab === 'catalog' ? (
            <button
              onClick={() => setShowAddCatalog(true)}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-sm transition-all flex items-center space-x-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>Add Catalog Item</span>
            </button>
          ) : (
            <button
              onClick={() => setShowAddSupplier(true)}
              className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-sm transition-all flex items-center space-x-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>Onboard Supplier</span>
            </button>
          )}
        </div>
      </div>

      {/* Sub-tabs */}
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
          <span>Non-Production Catalog ({catalog.length})</span>
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
          <span>Approved Suppliers ({suppliers.length})</span>
        </button>
      </div>

      {/* CATALOG SUB-TAB */}
      {subTab === 'catalog' && (
        <div className="space-y-4">
          {/* Search & Category Filter */}
          <div className="flex flex-col sm:flex-row gap-3 bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm text-xs">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 absolute left-3 top-3 text-slate-400" />
              <input
                type="text"
                placeholder="Search catalog by SKU, product name, or description..."
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
              <option value="All">All Categories</option>
              <option value="IT Hardware">IT Hardware</option>
              <option value="Software & Cloud">Software & Cloud</option>
              <option value="Office Supplies">Office Supplies</option>
              <option value="Facilities & MRO">Facilities & MRO</option>
              <option value="Consulting & Professional Services">Consulting & Professional Services</option>
            </select>
          </div>

          {/* Catalog Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {catalog.map(item => (
              <div key={item.id} className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between text-[11px] mb-1">
                    <span className="font-mono text-slate-400 font-bold">{item.sku}</span>
                    <span className="flex items-center gap-1">
                      <span className={`font-bold px-2 py-0.5 rounded-full text-[10px] ${item.line_type === 'service' ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-700'}`}>
                        {lineTypeLabel(item)}
                      </span>
                      <span className="bg-slate-100 text-slate-700 font-medium px-2 py-0.5 rounded text-[10px]">
                        {item.category}
                      </span>
                    </span>
                  </div>
                  <h3 className="text-sm font-bold text-slate-900 mt-1">{item.name}</h3>
                  <p className="text-xs text-slate-500 mt-1 line-clamp-2 leading-relaxed">{item.description}</p>
                </div>

                <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                  <div>
                    <span className="text-[10px] text-slate-400 block">Negotiated Price</span>
                    <div className="text-base font-extrabold text-emerald-700">
                      ${formatMoney(item.unit_price)}
                      <span className="text-[10px] text-slate-400 font-normal"> / {item.unit}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] text-slate-400 block">Lead Time</span>
                    <span className="font-semibold text-slate-700">{item.lead_time_days} days</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SUPPLIERS SUB-TAB */}
      {subTab === 'suppliers' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {suppliers.map(sup => (
            <div key={sup.id} className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col justify-between space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-mono font-bold text-slate-400 text-xs">{sup.code}</span>
                  <div className="flex items-center text-amber-500 text-xs font-bold space-x-1">
                    <Star className="w-3.5 h-3.5 fill-current" />
                    <span>{sup.rating || '5.0'}</span>
                  </div>
                </div>
                <h3 className="text-base font-bold text-slate-900">{sup.name}</h3>
                <div className="space-y-1 mt-2 text-xs text-slate-600">
                  <div className="flex items-center space-x-2">
                    <span className="text-slate-400 font-medium">Contact:</span>
                    <span>{sup.contact_person || 'Representative'}</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Mail className="w-3.5 h-3.5 text-slate-400" />
                    <span>{sup.email}</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Phone className="w-3.5 h-3.5 text-slate-400" />
                    <span>{sup.phone}</span>
                  </div>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                <div>
                  <span className="text-[10px] text-slate-400 block">Standard Terms</span>
                  <span className="font-semibold text-slate-800">{sup.payment_terms}</span>
                </div>
                <div className="text-right">
                  <span className="text-[10px] text-slate-400 block">PO Orders</span>
                  <span className="font-bold text-indigo-700">{sup.total_pos || 0} POs</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Catalog Modal */}
      {showAddCatalog && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex justify-between items-center pb-3 border-b border-slate-200">
              <h3 className="text-base font-bold text-slate-900">Add Non-Production Item</h3>
              <button onClick={() => setShowAddCatalog(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-600 mb-1">SKU</label>
                  <input
                    type="text"
                    placeholder="e.g. SKU-HW-099"
                    value={newSKU}
                    onChange={(e) => setNewSKU(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Category</label>
                  <select
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  >
                    <option value="IT Hardware">IT Hardware</option>
                    <option value="Software & Cloud">Software & Cloud</option>
                    <option value="Office Supplies">Office Supplies</option>
                    <option value="Facilities & MRO">Facilities & MRO</option>
                    <option value="Consulting & Professional Services">Consulting</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-600 mb-1">Item / Service Name</label>
                <input
                  type="text"
                  placeholder="e.g. 27-inch 4K Monitor"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                />
              </div>

              <div>
                <label className="block text-slate-600 mb-1">Description</label>
                <textarea
                  rows="2"
                  placeholder="Detailed specifications..."
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-600 mb-1">Unit Price ($)</label>
                  <input
                    type="number"
                    placeholder="499.00"
                    value={newPrice}
                    onChange={(e) => setNewPrice(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Lead Time (Days)</label>
                  <input
                    type="number"
                    value={newLeadDays}
                    onChange={(e) => setNewLeadDays(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-3 border-t border-slate-200">
              <button onClick={() => setShowAddCatalog(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-xs font-semibold">
                Cancel
              </button>
              <button onClick={handleCreateCatalogItem} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-xs font-semibold">
                Save Item
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Supplier Modal */}
      {showAddSupplier && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex justify-between items-center pb-3 border-b border-slate-200">
              <h3 className="text-base font-bold text-slate-900">Onboard Approved Supplier</h3>
              <button onClick={() => setShowAddSupplier(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-600 mb-1">Supplier Name</label>
                  <input
                    type="text"
                    placeholder="e.g. OfficePro Inc"
                    value={supName}
                    onChange={(e) => setSupName(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Supplier Code</label>
                  <input
                    type="text"
                    placeholder="e.g. SUP-OPI"
                    value={supCode}
                    onChange={(e) => setSupCode(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg font-mono text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-600 mb-1">Contact Person</label>
                <input
                  type="text"
                  placeholder="Account Executive Name"
                  value={supContact}
                  onChange={(e) => setSupContact(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-600 mb-1">Email</label>
                  <input
                    type="email"
                    placeholder="orders@supplier.com"
                    value={supEmail}
                    onChange={(e) => setSupEmail(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Phone</label>
                  <input
                    type="text"
                    placeholder="+1 555 123-4567"
                    value={supPhone}
                    onChange={(e) => setSupPhone(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-600 mb-1">Payment Terms</label>
                <select
                  value={supTerms}
                  onChange={(e) => setSupTerms(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                >
                  <option value="Net 15">Net 15</option>
                  <option value="Net 30">Net 30</option>
                  <option value="Net 45">Net 45</option>
                  <option value="Net 60">Net 60</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-3 border-t border-slate-200">
              <button onClick={() => setShowAddSupplier(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-xs font-semibold">
                Cancel
              </button>
              <button onClick={handleCreateSupplier} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-xs font-semibold">
                Save Supplier
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
