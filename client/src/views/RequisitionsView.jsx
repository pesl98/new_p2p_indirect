import React, { useState, useEffect } from 'react';
import { 
  Plus, 
  Search, 
  Filter, 
  ShoppingCart, 
  Trash2, 
  CheckCircle2, 
  Clock, 
  AlertCircle, 
  Send,
  Eye,
  Calendar,
  DollarSign,
  Building2,
  X,
  FileText
} from 'lucide-react';
import { api } from '../api';
import { formatMoney, toCents } from '../money';
import { lineTypeFromCategory, lineTypeLabel } from '../lineType';
import ConvertRequisitionModal from '../components/ConvertRequisitionModal';

export default function RequisitionsView({ currentUser, onNavigate, focusId }) {
  const [requisitions, setRequisitions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedPR, setSelectedPR] = useState(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [catalogItems, setCatalogItems] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [showConvertModal, setShowConvertModal] = useState(false);
  const [convertPrId, setConvertPrId] = useState(null);

  // Form state for new PR
  const [cartItems, setCartItems] = useState([]);
  const [justification, setJustification] = useState('');
  const [departmentId, setDepartmentId] = useState(currentUser?.department_id || 1);
  const [priority, setPriority] = useState('Medium');
  const [neededByDate, setNeededByDate] = useState(
    new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]
  );
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogCategory, setCatalogCategory] = useState('All');
  
  // Custom item inputs
  const [customDesc, setCustomDesc] = useState('');
  const [customCat, setCustomCat] = useState('Office Supplies');
  const [customPrice, setCustomPrice] = useState('');
  const [customQty, setCustomQty] = useState(1);
  const [customSupplierId, setCustomSupplierId] = useState(1);

  const loadData = async () => {
    setLoading(true);
    try {
      const [prs, catalog, depts, sups] = await Promise.all([
        api.getRequisitions(statusFilter === 'all' ? '' : statusFilter),
        api.getCatalog(),
        api.getDepartments(),
        api.getSuppliers()
      ]);
      setRequisitions(prs);
      setCatalogItems(catalog);
      setDepartments(depts);
      setSuppliers(Array.isArray(sups) ? sups : []);
      const activeSups = (Array.isArray(sups) ? sups : []).filter((s) => !s.status || s.status === 'active');
      if (activeSups.length && !activeSups.some((s) => Number(s.id) === Number(customSupplierId))) {
        setCustomSupplierId(activeSups[0].id);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [statusFilter]);

  useEffect(() => {
    if (focusId) {
      handleOpenDetail(focusId);
    }
  }, [focusId]);

  const handleOpenDetail = async (id) => {
    try {
      const detail = await api.getRequisitionDetail(id);
      setSelectedPR(detail);
    } catch (err) {
      console.error(err);
    }
  };

  const handleAddToCart = (catItem) => {
    const existingIndex = cartItems.findIndex(item => item.catalog_item_id === catItem.id);
    if (existingIndex >= 0) {
      const updated = [...cartItems];
      updated[existingIndex].quantity += 1;
      setCartItems(updated);
    } else {
      setCartItems([
        ...cartItems,
        {
          catalog_item_id: catItem.id,
          item_description: catItem.name,
          category: catItem.category,
          line_type: catItem.line_type || lineTypeFromCategory(catItem.category),
          quantity: 1,
          unit_price: catItem.unit_price,
          estimated_supplier_id: catItem.preferred_supplier_id
        }
      ]);
    }
  };

  const handleAddCustomItem = () => {
    if (!customDesc || !customPrice) return;
    setCartItems([
      ...cartItems,
      {
        catalog_item_id: null,
        item_description: customDesc,
        category: customCat,
        line_type: lineTypeFromCategory(customCat),
        quantity: Number(customQty) || 1,
        unit_price: toCents(customPrice),
        estimated_supplier_id: Number(customSupplierId)
      }
    ]);
    setCustomDesc('');
    setCustomPrice('');
    setCustomQty(1);
  };

  const handleRemoveFromCart = (index) => {
    setCartItems(cartItems.filter((_, i) => i !== index));
  };

  const calculateCartTotalCents = () => {
    return cartItems.reduce((sum, item) => sum + (Number(item.quantity) * Number(item.unit_price)), 0);
  };

  const handleSubmitRequisition = async (submitImmediately = false) => {
    if (cartItems.length === 0) {
      alert('Please add at least one line item.');
      return;
    }
    try {
      await api.createRequisition({
        requester_id: currentUser?.id || 1,
        department_id: departmentId,
        justification,
        needed_by_date: neededByDate,
        priority,
        items: cartItems,
        submitImmediately
      });
      setShowNewModal(false);
      setCartItems([]);
      setJustification('');
      loadData();
    } catch (err) {
      alert(err.message);
    }
  };

  const openConvert = (prId) => {
    setConvertPrId(prId);
    setShowConvertModal(true);
    setSelectedPR(null);
  };

  const handleSubmitDraft = async (prId) => {
    try {
      await api.submitRequisition(prId);
      loadData();
      if (selectedPR?.id === prId) {
        handleOpenDetail(prId);
      }
    } catch (err) {
      alert(err.message);
    }
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'draft':
        return <span className="bg-slate-100 text-slate-700 text-xs px-2.5 py-1 rounded-full font-medium">Draft</span>;
      case 'pending_approval':
        return <span className="bg-amber-100 text-amber-800 text-xs px-2.5 py-1 rounded-full font-medium flex items-center space-x-1"><Clock className="w-3 h-3 mr-1 inline" />Pending Approval</span>;
      case 'approved':
        return <span className="bg-emerald-100 text-emerald-800 text-xs px-2.5 py-1 rounded-full font-medium flex items-center space-x-1"><CheckCircle2 className="w-3 h-3 mr-1 inline" />Approved</span>;
      case 'converted_to_po':
        return <span className="bg-indigo-100 text-indigo-800 text-xs px-2.5 py-1 rounded-full font-medium">Converted to PO</span>;
      case 'rejected':
        return <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-medium">Rejected</span>;
      default:
        return <span className="bg-slate-100 text-slate-800 text-xs px-2 py-0.5 rounded">{status}</span>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header with Title and Create Button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">Purchase Requisitions (PR)</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Create, track, and route non-production purchasing requests through multi-tier authorization.
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowNewModal(true)}
            className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-sm transition-all flex items-center space-x-2"
          >
            <Plus className="w-4 h-4" />
            <span>Create Requisition</span>
          </button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center space-x-2 border-b border-slate-200 pb-3 overflow-x-auto text-xs font-medium">
        {['all', 'draft', 'pending_approval', 'approved', 'converted_to_po', 'rejected'].map(tab => (
          <button
            key={tab}
            onClick={() => setStatusFilter(tab)}
            className={`px-3 py-1.5 rounded-lg capitalize whitespace-nowrap transition-colors ${
              statusFilter === tab
                ? 'bg-slate-900 text-white font-semibold'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {tab.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      {/* Requisitions Table */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">PR #</th>
                <th className="py-3 px-4">Requester</th>
                <th className="py-3 px-4">Cost Center</th>
                <th className="py-3 px-4">Total Amount</th>
                <th className="py-3 px-4">Priority</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Date Needed</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">Loading requisitions...</td>
                </tr>
              ) : requisitions.length === 0 ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">No requisitions found.</td>
                </tr>
              ) : (
                requisitions.map((pr) => (
                  <tr key={pr.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-slate-900">
                      {pr.pr_number}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-900">{pr.requester_name}</div>
                      <div className="text-[11px] text-slate-400">{pr.requester_email}</div>
                    </td>
                    <td className="py-3 px-4">
                      <span className="font-semibold text-slate-800">{pr.department_name}</span>
                      <span className="text-[10px] text-slate-400 ml-1">({pr.department_code})</span>
                    </td>
                    <td className="py-3 px-4 font-bold text-slate-900 text-sm">
                      ${formatMoney(pr.total_amount)}
                    </td>
                    <td className="py-3 px-4">
                      <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                        pr.priority === 'High' || pr.priority === 'Urgent'
                          ? 'bg-rose-100 text-rose-700'
                          : 'bg-slate-100 text-slate-600'
                      }`}>
                        {pr.priority}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {getStatusBadge(pr.status)}
                    </td>
                    <td className="py-3 px-4 text-slate-500">
                      {pr.needed_by_date}
                    </td>
                    <td className="py-3 px-4 text-right space-x-2">
                      <button
                        onClick={() => handleOpenDetail(pr.id)}
                        className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded"
                        title="View PR Details"
                      >
                        <Eye className="w-4 h-4 inline" />
                      </button>
                      {pr.status === 'draft' && (
                        <button
                          onClick={() => handleSubmitDraft(pr.id)}
                          className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[11px] font-semibold"
                          title="Submit for Approval"
                        >
                          Submit
                        </button>
                      )}
                      {pr.status === 'approved' && (
                        <button
                          onClick={() => openConvert(pr.id)}
                          className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-[11px] font-semibold"
                          title="Convert to PO with per-line supplier assignment"
                        >
                          Convert to PO
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* New Requisition Modal */}
      {showNewModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl border border-slate-200">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900">New Purchase Requisition</h3>
                <p className="text-xs text-slate-500">Indirect procurement for non-production goods and services</p>
              </div>
              <button 
                onClick={() => setShowNewModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body: Two columns (Catalog / Custom on Left, Cart & Header info on Right) */}
            <div className="grid grid-cols-1 md:grid-cols-2 flex-1 overflow-hidden">
              {/* Left Column: Catalog Browser & Ad-hoc Creator */}
              <div className="p-5 border-r border-slate-200 overflow-y-auto space-y-4">
                <div className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                  Browse Indirect Catalog
                </div>

                <div className="flex space-x-2">
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-3 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search items, software, services..."
                      value={catalogSearch}
                      onChange={(e) => setCatalogSearch(e.target.value)}
                      className="w-full text-xs pl-8 pr-3 py-2 border border-slate-200 rounded-lg focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                  <select
                    value={catalogCategory}
                    onChange={(e) => setCatalogCategory(e.target.value)}
                    className="text-xs border border-slate-200 rounded-lg px-2 py-2"
                  >
                    <option value="All">All Categories</option>
                    <option value="IT Hardware">IT Hardware</option>
                    <option value="Software & Cloud">Software & Cloud</option>
                    <option value="Office Supplies">Office Supplies</option>
                    <option value="Facilities & MRO">Facilities & MRO</option>
                    <option value="Consulting & Professional Services">Consulting</option>
                  </select>
                </div>

                {/* Catalog Item Cards */}
                <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                  {catalogItems
                    .filter(item => {
                      if (item.status && item.status !== 'active') return false;
                      const matchSearch = item.name.toLowerCase().includes(catalogSearch.toLowerCase()) || item.sku.toLowerCase().includes(catalogSearch.toLowerCase());
                      const matchCat = catalogCategory === 'All' || item.category === catalogCategory;
                      return matchSearch && matchCat;
                    })
                    .map(item => (
                      <div key={item.id} className="p-3 border border-slate-100 rounded-lg hover:border-emerald-300 hover:bg-emerald-50/30 transition-all flex items-center justify-between">
                        <div className="flex-1 pr-2">
                          <div className="text-xs font-bold text-slate-900">{item.name}</div>
                          <div className="text-[10px] text-slate-500 line-clamp-1">{item.description}</div>
                          <div className="text-[11px] font-bold text-emerald-700 mt-1">
                            ${formatMoney(item.unit_price)} <span className="text-[10px] font-normal text-slate-400">/ {item.unit}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleAddToCart(item)}
                          className="px-2.5 py-1 bg-slate-900 hover:bg-emerald-600 text-white text-[11px] font-semibold rounded-md shadow-sm transition-colors"
                        >
                          + Add
                        </button>
                      </div>
                    ))}
                </div>

                {/* Ad-Hoc / Custom Service or Non-Catalog Item Section */}
                <div className="pt-4 border-t border-slate-200">
                  <div className="text-xs font-bold text-slate-800 uppercase tracking-wider mb-2">
                    Or Enter Non-Catalog Item / Service
                  </div>
                  <div className="space-y-2 text-xs">
                    <input
                      type="text"
                      placeholder="Item or service description (e.g. Q4 Security Audit)"
                      value={customDesc}
                      onChange={(e) => setCustomDesc(e.target.value)}
                      className="w-full p-2 border border-slate-200 rounded-lg text-xs"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={customCat}
                        onChange={(e) => setCustomCat(e.target.value)}
                        className="p-2 border border-slate-200 rounded-lg text-xs"
                      >
                        <option value="IT Hardware">IT Hardware</option>
                        <option value="Software & Cloud">Software & Cloud</option>
                        <option value="Office Supplies">Office Supplies</option>
                        <option value="Facilities & MRO">Facilities & MRO</option>
                        <option value="Consulting & Professional Services">Consulting/Services</option>
                      </select>
                      <select
                        value={customSupplierId}
                        onChange={(e) => setCustomSupplierId(e.target.value)}
                        className="p-2 border border-slate-200 rounded-lg text-xs"
                      >
                        {suppliers.filter((s) => !s.status || s.status === 'active').map(s => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="number"
                        placeholder="Unit Price ($)"
                        value={customPrice}
                        onChange={(e) => setCustomPrice(e.target.value)}
                        className="p-2 border border-slate-200 rounded-lg text-xs"
                      />
                      <input
                        type="number"
                        placeholder="Quantity"
                        value={customQty}
                        min="1"
                        onChange={(e) => setCustomQty(e.target.value)}
                        className="p-2 border border-slate-200 rounded-lg text-xs"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={handleAddCustomItem}
                      className="w-full py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold rounded-lg text-xs transition-colors"
                    >
                      + Add Custom Item
                    </button>
                  </div>
                </div>
              </div>

              {/* Right Column: Requisition Header & Cart */}
              <div className="p-5 overflow-y-auto flex flex-col justify-between space-y-4">
                <div className="space-y-3">
                  <div className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                    Requisition Parameters
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <label className="block text-slate-500 mb-1">Cost Center / Dept</label>
                      <select
                        value={departmentId}
                        onChange={(e) => setDepartmentId(Number(e.target.value))}
                        className="w-full p-2 border border-slate-200 rounded-lg font-medium"
                      >
                        {departments.map(d => (
                          <option key={d.id} value={d.id}>{d.name} ({d.code})</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-slate-500 mb-1">Date Needed</label>
                      <input
                        type="date"
                        value={neededByDate}
                        onChange={(e) => setNeededByDate(e.target.value)}
                        className="w-full p-2 border border-slate-200 rounded-lg font-medium"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-500 text-xs mb-1">Business Justification</label>
                    <textarea
                      rows="2"
                      placeholder="Explain business need (e.g. Necessary for new team member onboarding)..."
                      value={justification}
                      onChange={(e) => setJustification(e.target.value)}
                      className="w-full p-2 text-xs border border-slate-200 rounded-lg"
                    />
                  </div>

                  {/* Selected Cart Items */}
                  <div className="pt-2">
                    <div className="flex justify-between items-center text-xs font-bold text-slate-800 mb-2">
                      <span>Line Items ({cartItems.length})</span>
                      <span className="text-emerald-700 font-extrabold text-sm">
                        Total: ${formatMoney(calculateCartTotalCents())}
                      </span>
                    </div>

                    {cartItems.length === 0 ? (
                      <div className="border border-dashed border-slate-200 rounded-xl p-6 text-center text-slate-400 text-xs">
                        No items added yet. Select items from the catalog on the left.
                      </div>
                    ) : (
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        {cartItems.map((item, idx) => (
                          <div key={idx} className="p-2.5 bg-slate-50 border border-slate-200/80 rounded-lg flex items-center justify-between text-xs">
                            <div className="flex-1 pr-2">
                              <div className="font-semibold text-slate-900">
                                {item.item_description}
                                <span className={`ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${item.line_type === 'service' ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-600'}`}>
                                  {lineTypeLabel(item)}
                                </span>
                              </div>
                              <div className="text-[11px] text-slate-500">
                                {item.quantity} × ${formatMoney(item.unit_price)} = ${formatMoney(item.quantity * item.unit_price)}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleRemoveFromCart(idx)}
                              className="text-slate-400 hover:text-rose-600 p-1"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Modal Footer Buttons */}
                <div className="pt-4 border-t border-slate-200 flex items-center justify-end space-x-2">
                  <button
                    type="button"
                    onClick={() => setShowNewModal(false)}
                    className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSubmitRequisition(false)}
                    className="px-4 py-2 bg-slate-800 text-white rounded-lg text-xs font-semibold hover:bg-slate-700"
                  >
                    Save as Draft
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSubmitRequisition(true)}
                    className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-xs font-semibold hover:bg-emerald-500 flex items-center space-x-1.5 shadow-sm"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Submit for Approval</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Requisition Detail & Approval Trail Modal */}
      {selectedPR && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div>
                <div className="flex items-center space-x-2">
                  <h3 className="text-lg font-mono font-bold text-slate-900">{selectedPR.pr_number}</h3>
                  {getStatusBadge(selectedPR.status)}
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Requested by {selectedPR.requester_name} ({selectedPR.department_name})
                </p>
              </div>
              <button 
                onClick={() => setSelectedPR(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-6 text-xs">
              {/* Business Justification */}
              <div className="bg-slate-50 rounded-xl p-4 border border-slate-200">
                <div className="font-bold text-slate-700 uppercase tracking-wider text-[11px] mb-1">
                  Business Justification
                </div>
                <p className="text-slate-800 leading-relaxed">{selectedPR.justification}</p>
                <div className="flex items-center space-x-4 mt-3 pt-3 border-t border-slate-200 text-slate-500">
                  <span>Priority: <strong className="text-slate-800">{selectedPR.priority}</strong></span>
                  <span>Needed by: <strong className="text-slate-800">{selectedPR.needed_by_date}</strong></span>
                  <span>Total Cost: <strong className="text-emerald-700 text-sm font-bold">${formatMoney(selectedPR.total_amount)}</strong></span>
                </div>
              </div>

              {/* Line items */}
              <div>
                <div className="font-bold text-slate-800 uppercase tracking-wider text-[11px] mb-2">
                  Requested Line Items ({selectedPR.items?.length || 0})
                </div>
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-100/70 border-b border-slate-200 text-slate-600 font-semibold">
                      <tr>
                        <th className="py-2.5 px-3">Description</th>
                        <th className="py-2.5 px-3">Category</th>
                        <th className="py-2.5 px-3">Supplier</th>
                        <th className="py-2.5 px-3">Qty</th>
                        <th className="py-2.5 px-3">Unit Price</th>
                        <th className="py-2.5 px-3 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedPR.items?.map(item => (
                        <tr key={item.id}>
                          <td className="py-2 px-3 font-medium text-slate-900">
                            {item.item_description}
                            <span className={`ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${item.line_type === 'service' || lineTypeFromCategory(item.category) === 'service' ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-600'}`}>
                              {lineTypeLabel(item)}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-slate-500">{item.category}</td>
                          <td className="py-2 px-3 text-slate-600">
                            {item.resolved_supplier_name || item.estimated_supplier_name || item.catalog_preferred_supplier_name || (
                              <span className="text-rose-600">Unassigned</span>
                            )}
                          </td>
                          <td className="py-2 px-3">{item.quantity}</td>
                          <td className="py-2 px-3">${formatMoney(item.unit_price)}</td>
                          <td className="py-2 px-3 text-right font-bold text-slate-900">${formatMoney(item.total_price)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {(selectedPR.purchase_orders?.length > 0 || selectedPR.purchase_order) && (
                <div>
                  <div className="font-bold text-slate-800 uppercase tracking-wider text-[11px] mb-2">
                    Linked Purchase Orders
                    {selectedPR.purchase_orders?.length > 1 ? ` (${selectedPR.purchase_orders.length} split)` : ''}
                  </div>
                  <div className="space-y-2">
                    {(selectedPR.purchase_orders?.length ? selectedPR.purchase_orders : [selectedPR.purchase_order]).map((po) => (
                      <div key={po.id} className="p-3 border border-indigo-200 bg-indigo-50/40 rounded-xl flex items-center justify-between">
                        <div>
                          <div className="font-mono font-bold text-slate-900">{po.po_number}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            {po.supplier_name || 'Supplier'} · ${formatMoney(po.total_amount)} · {po.status}
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            setSelectedPR(null);
                            onNavigate('purchase_orders');
                          }}
                          className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-[11px] font-semibold"
                        >
                          View POs
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Multi-Tier Approval Chain */}
              <div>
                <div className="font-bold text-slate-800 uppercase tracking-wider text-[11px] mb-2">
                  Multi-Tier Approval Routing Trail
                </div>
                {selectedPR.approvals?.length === 0 ? (
                  <p className="text-slate-400">No approval steps generated yet (Requisition is still draft).</p>
                ) : (
                  <div className="space-y-2">
                    {selectedPR.approvals?.map(app => (
                      <div key={app.id} className="p-3 border border-slate-200 rounded-xl flex items-center justify-between">
                        <div>
                          <div className="font-semibold text-slate-900">
                            Tier {app.step_order}: {app.approver_name} ({app.approver_title})
                          </div>
                          {app.comments && (
                            <div className="text-[11px] text-slate-500 italic mt-0.5">
                              "{app.comments}"
                            </div>
                          )}
                        </div>
                        <div>
                          {app.status === 'approved' && (
                            <span className="bg-emerald-100 text-emerald-800 text-[11px] font-bold px-2.5 py-1 rounded-full">
                              Approved
                            </span>
                          )}
                          {app.status === 'pending' && (
                            <span className="bg-amber-100 text-amber-800 text-[11px] font-bold px-2.5 py-1 rounded-full">
                              Pending Action
                            </span>
                          )}
                          {app.status === 'rejected' && (
                            <span className="bg-rose-100 text-rose-800 text-[11px] font-bold px-2.5 py-1 rounded-full">
                              Rejected
                            </span>
                          )}
                          {app.status === 'waiting' && (
                            <span className="bg-slate-100 text-slate-600 text-[11px] font-bold px-2.5 py-1 rounded-full">
                              Waiting (prior step)
                            </span>
                          )}
                          {app.status === 'skipped' && (
                            <span className="bg-slate-100 text-slate-500 text-[11px] font-bold px-2.5 py-1 rounded-full">
                              Skipped
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="p-4 border-t border-slate-200 flex justify-end space-x-2">
              {selectedPR.status === 'approved' && (
                <button
                  onClick={() => openConvert(selectedPR.id)}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold"
                >
                  Convert to PO
                </button>
              )}
              <button
                onClick={() => setSelectedPR(null)}
                className="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showConvertModal && (
        <ConvertRequisitionModal
          currentUser={currentUser}
          approvedPRs={requisitions.filter((pr) => pr.status === 'approved')}
          suppliers={suppliers}
          initialRequisitionId={convertPrId}
          onClose={() => {
            setShowConvertModal(false);
            setConvertPrId(null);
          }}
          onConverted={() => {
            loadData();
          }}
          onViewPurchaseOrder={(poId) => {
            setShowConvertModal(false);
            setConvertPrId(null);
            onNavigate('purchase_orders', { focusId: poId });
          }}
        />
      )}
    </div>
  );
}
