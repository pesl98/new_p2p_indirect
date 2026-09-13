import React, { useState, useEffect } from 'react';
import { 
  FileCheck, 
  Plus, 
  Search, 
  AlertTriangle, 
  RefreshCw, 
  Calendar, 
  DollarSign, 
  Clock, 
  Eye, 
  X, 
  Building2, 
  CheckCircle2, 
  Sparkles,
  ArrowRight
} from 'lucide-react';
import { api } from '../api';
import { formatMoney } from '../money';

export default function ContractsView({ currentUser, onNavigate, onDataChanged }) {
  const [contracts, setContracts] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [selectedContract, setSelectedContract] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [renewingId, setRenewingId] = useState(null);
  const [renewSuccess, setRenewSuccess] = useState(null);

  // New Contract Form
  const [supplierId, setSupplierId] = useState(1);
  const [deptId, setDeptId] = useState(currentUser?.department_id || 1);
  const [title, setTitle] = useState('');
  const [contractCat, setContractCat] = useState('Software & Cloud');
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0]);
  const [noticeDays, setNoticeDays] = useState(30);
  const [annualValue, setAnnualValue] = useState('');
  const [autoRenew, setAutoRenew] = useState(true);
  const [terms, setTerms] = useState('');

  const loadData = async () => {
    setLoading(true);
    try {
      const [contractList, sups, depts] = await Promise.all([
        api.getContracts(category === 'All' ? '' : category, statusFilter === 'all' ? '' : statusFilter, search),
        api.getSuppliers(),
        api.getDepartments()
      ]);
      setContracts(contractList);
      setSuppliers(sups);
      setDepartments(depts);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [category, statusFilter, search]);

  const handleCreateContract = async (e) => {
    e.preventDefault();
    if (!title || !annualValue) {
      alert('Please provide title and annual value.');
      return;
    }

    try {
      await api.createContract({
        supplier_id: Number(supplierId),
        department_id: Number(deptId),
        title,
        category: contractCat,
        start_date: startDate,
        end_date: endDate,
        notice_period_days: Number(noticeDays),
        annual_value_cents: Math.round(Number(annualValue) * 100),
        auto_renew: autoRenew ? 1 : 0,
        terms
      });
      setShowCreateModal(false);
      setTitle('');
      setAnnualValue('');
      setTerms('');
      await loadData();
      if (onDataChanged) onDataChanged();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleRenewPR = async (contract) => {
    setRenewingId(contract.id);
    try {
      const result = await api.renewContractPR(contract.id, {
        requester_id: currentUser?.id || 1,
        notes: `Generated via Contract Renewal Hub for FY 2027 cycle.`
      });
      setRenewSuccess(result);
      await loadData();
      if (onDataChanged) onDataChanged();
    } catch (err) {
      alert(err.message);
    } finally {
      setRenewingId(null);
    }
  };

  const expiringContracts = contracts.filter(c => c.status === 'expiring_soon');

  const getStatusBadge = (status) => {
    switch (status) {
      case 'expiring_soon':
        return <span className="bg-amber-100 text-amber-800 text-xs px-2.5 py-1 rounded-full font-bold flex items-center space-x-1"><AlertTriangle className="w-3.5 h-3.5 mr-1 text-amber-600" />Expiring Soon</span>;
      case 'active':
        return <span className="bg-emerald-100 text-emerald-800 text-xs px-2.5 py-1 rounded-full font-bold flex items-center space-x-1"><CheckCircle2 className="w-3.5 h-3.5 mr-1 text-emerald-600" />Active</span>;
      case 'expired':
        return <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-bold">Expired</span>;
      case 'cancelled':
        return <span className="bg-slate-100 text-slate-700 text-xs px-2.5 py-1 rounded-full font-bold">Cancelled</span>;
      default:
        return <span className="bg-slate-100 text-slate-700 text-xs px-2 py-0.5 rounded">{status}</span>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <div className="flex items-center space-x-2 text-indigo-600 text-xs font-bold uppercase tracking-wider mb-0.5">
            <FileCheck className="w-4 h-4" />
            <span>Indirect Contract Management</span>
          </div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">SaaS & Vendor Contracts Hub</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Monitor recurring subscriptions, prevent unwanted auto-renewals, and execute 1-click renewal purchase requisitions.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowCreateModal(true)}
            className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-sm transition-all flex items-center space-x-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>Register Contract</span>
          </button>
        </div>
      </div>

      {/* Renewal Notice Alerts Banner */}
      {expiringContracts.length > 0 && (
        <div className="bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-amber-500/10 border border-amber-300 rounded-xl p-4">
          <div className="flex items-start space-x-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-xs font-bold text-amber-900 uppercase tracking-wider">
                Renewal Action Required ({expiringContracts.length} contract{expiringContracts.length > 1 ? 's' : ''} within notice window)
              </h3>
              <p className="text-xs text-amber-800 mt-0.5 leading-relaxed">
                The following non-production contracts are approaching expiration or auto-renewal deadlines. Generate renewal requisitions now to ensure uninterrupted service:
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {expiringContracts.map(c => (
                  <div key={c.id} className="bg-white/90 border border-amber-200 px-3 py-1.5 rounded-lg text-xs flex items-center space-x-2 shadow-xs">
                    <span className="font-bold text-slate-900">{c.title}</span>
                    <span className="text-amber-700 font-mono font-bold">({c.days_until_expiry}d left)</span>
                    <button
                      onClick={() => handleRenewPR(c)}
                      disabled={renewingId === c.id}
                      className="px-2 py-0.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[10px] font-bold inline-flex items-center space-x-1"
                    >
                      <Sparkles className="w-3 h-3" />
                      <span>{renewingId === c.id ? 'Generating...' : 'Renew PR'}</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Success Notification Modal */}
      {renewSuccess && (
        <div className="bg-emerald-50 border border-emerald-300 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
            <div className="text-xs">
              <strong className="text-emerald-900 font-bold block">{renewSuccess.message}</strong>
              <span className="text-emerald-800">
                Requisition <strong>{renewSuccess.pr_number}</strong> created with multi-tier approval routing for ${formatMoney(renewSuccess.total_amount_cents)}.
              </span>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={() => onNavigate('requisitions')}
              className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg text-xs font-bold flex items-center space-x-1"
            >
              <span>View in Requisitions</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setRenewSuccess(null)}
              className="p-1 text-slate-400 hover:text-slate-600"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Filters Bar */}
      <div className="flex flex-col sm:flex-row gap-3 bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm text-xs">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-3 top-3 text-slate-400" />
          <input
            type="text"
            placeholder="Search contracts by title, supplier, or contract #..."
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
          <option value="Software & Cloud">Software & Cloud</option>
          <option value="Consulting & Professional Services">Consulting & Professional Services</option>
          <option value="Facilities & MRO">Facilities & MRO</option>
          <option value="Marketing & Events">Marketing & Events</option>
        </select>
        <div className="flex items-center space-x-1 bg-slate-100 p-1 rounded-lg">
          {['all', 'expiring_soon', 'active', 'expired'].map(st => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={`px-2.5 py-1 rounded text-[11px] font-semibold capitalize transition-colors ${
                statusFilter === st ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              {st.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </div>

      {/* Contracts Table */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">Contract #</th>
                <th className="py-3 px-4">Title & Supplier</th>
                <th className="py-3 px-4">Category</th>
                <th className="py-3 px-4">Cost Center</th>
                <th className="py-3 px-4">Annual Value (ACV)</th>
                <th className="py-3 px-4">End Date / Notice</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">Loading vendor contracts...</td>
                </tr>
              ) : contracts.length === 0 ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">No contracts found.</td>
                </tr>
              ) : (
                contracts.map(c => (
                  <tr key={c.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-slate-900">
                      {c.contract_number}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-bold text-slate-900">{c.title}</div>
                      <div className="text-[11px] text-slate-500 flex items-center space-x-1.5">
                        <span>{c.supplier_name}</span>
                        {c.supplier_tier === 'preferred' && (
                          <span className="text-amber-600 text-[10px] font-bold">⭐ Preferred</span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded text-[10px] font-medium">
                        {c.category}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-700 font-semibold">
                      {c.department_code}
                    </td>
                    <td className="py-3 px-4 font-extrabold text-slate-900 text-sm">
                      ${formatMoney(c.annual_value_cents)}
                      <span className="text-[10px] text-slate-400 font-normal"> / yr</span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-800">{c.end_date}</div>
                      <div className="text-[10px] text-slate-500">
                        {c.days_until_expiry > 0 ? `${c.days_until_expiry} days remaining` : 'Passed expiration'}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      {getStatusBadge(c.status)}
                    </td>
                    <td className="py-3 px-4 text-right space-x-2">
                      <button
                        onClick={() => setSelectedContract(c)}
                        className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded text-[11px] font-semibold"
                        title="View Details"
                      >
                        <Eye className="w-3.5 h-3.5 inline" />
                      </button>
                      <button
                        onClick={() => handleRenewPR(c)}
                        disabled={renewingId === c.id}
                        className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[11px] font-bold shadow-xs inline-flex items-center space-x-1"
                        title="Generate Renewal Purchase Requisition"
                      >
                        <RefreshCw className={`w-3 h-3 ${renewingId === c.id ? 'animate-spin' : ''}`} />
                        <span>{renewingId === c.id ? 'Creating...' : 'Renew PR'}</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Contract Detail Modal */}
      {selectedContract && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-slate-200 space-y-4 text-xs">
            <div className="flex justify-between items-start pb-3 border-b border-slate-200">
              <div>
                <div className="flex items-center space-x-2">
                  <h3 className="text-base font-bold text-slate-900">{selectedContract.title}</h3>
                  {getStatusBadge(selectedContract.status)}
                </div>
                <div className="text-slate-500 font-mono mt-0.5">Contract #{selectedContract.contract_number}</div>
              </div>
              <button onClick={() => setSelectedContract(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
              <div>
                <span className="text-slate-400 block text-[10px]">Supplier:</span>
                <span className="font-bold text-slate-900 text-sm">{selectedContract.supplier_name}</span>
                <div className="text-slate-500">{selectedContract.supplier_email}</div>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">Cost Center:</span>
                <span className="font-bold text-slate-900">{selectedContract.department_name} ({selectedContract.department_code})</span>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">Contract Duration:</span>
                <span className="font-semibold text-slate-800">{selectedContract.start_date} ➔ {selectedContract.end_date}</span>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">Notice Window / Deadline:</span>
                <span className="font-semibold text-slate-800">{selectedContract.notice_period_days} days (Notice by {selectedContract.notice_deadline})</span>
              </div>
            </div>

            {selectedContract.terms && (
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-slate-700">
                <strong className="block text-[10px] text-slate-400 uppercase mb-1">Contract Terms & Renewal Clause:</strong>
                {selectedContract.terms}
              </div>
            )}

            <div className="flex justify-between items-center pt-3 border-t border-slate-200">
              <div className="text-emerald-700 font-extrabold text-sm">
                Annual ACV: ${formatMoney(selectedContract.annual_value_cents)}
              </div>
              <div className="flex space-x-2">
                <button onClick={() => setSelectedContract(null)} className="px-4 py-2 border border-slate-300 rounded-lg font-semibold">
                  Close
                </button>
                <button
                  onClick={() => {
                    handleRenewPR(selectedContract);
                    setSelectedContract(null);
                  }}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold flex items-center space-x-1"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Generate Renewal PR</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Register Contract Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form onSubmit={handleCreateContract} className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-slate-200 space-y-4 text-xs">
            <div className="flex justify-between items-center pb-3 border-b border-slate-200">
              <h3 className="text-base font-bold text-slate-900">Register Vendor Contract / SaaS Agreement</h3>
              <button type="button" onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-slate-600 mb-1 font-semibold">Contract Title</label>
                <input
                  type="text"
                  placeholder="e.g. GitHub Enterprise Annual Cloud Seat Agreement"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 mb-1">Supplier</label>
                  <select
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs font-medium"
                  >
                    {suppliers.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Department</label>
                  <select
                    value={deptId}
                    onChange={(e) => setDeptId(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs font-medium"
                  >
                    {departments.map(d => (
                      <option key={d.id} value={d.id}>{d.name} ({d.code})</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 mb-1">Category</label>
                  <select
                    value={contractCat}
                    onChange={(e) => setContractCat(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  >
                    <option value="Software & Cloud">Software & Cloud</option>
                    <option value="Consulting & Professional Services">Consulting/Services</option>
                    <option value="Facilities & MRO">Facilities & MRO</option>
                    <option value="Marketing & Events">Marketing & Events</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-600 mb-1 font-semibold">Annual Value ($)</label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="9000.00"
                    value={annualValue}
                    onChange={(e) => setAnnualValue(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs font-bold"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-600 mb-1">Start Date</label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                    required
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">End Date</label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                    required
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">Notice Days</label>
                  <input
                    type="number"
                    value={noticeDays}
                    onChange={(e) => setNoticeDays(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-600 mb-1">Special Terms / Cancellation Clause</label>
                <textarea
                  rows="2"
                  placeholder="e.g. Renews automatically for 12 months unless notice given 30 days prior..."
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                />
              </div>

              <div className="flex items-center space-x-2 pt-1">
                <input
                  type="checkbox"
                  id="autoRenew"
                  checked={autoRenew}
                  onChange={(e) => setAutoRenew(e.target.checked)}
                  className="rounded text-indigo-600 focus:ring-indigo-500"
                />
                <label htmlFor="autoRenew" className="text-slate-700 font-medium">
                  Contract includes auto-renewal clause by default
                </label>
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-3 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 border border-slate-300 rounded-lg font-semibold"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold"
              >
                Save Contract
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
