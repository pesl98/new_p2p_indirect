import React, { useState, useEffect } from 'react';
import {
  FileCheck,
  Plus,
  Search,
  AlertTriangle,
  RefreshCw,
  Eye,
  X,
  CheckCircle2,
  Sparkles,
  ArrowRight
} from 'lucide-react';
import { api } from '../api';
import { t, presentError, statusLabel, categoryLabel } from '../i18n';
import { formatMoney, toCents, parseMajorAmount, moneyInputProps } from '../money';

const RENEWABLE = new Set(['active', 'expiring_soon']);

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

  const [supplierId, setSupplierId] = useState('');
  const [deptId, setDeptId] = useState(currentUser?.department_id ? String(currentUser.department_id) : '');
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
      setContracts(Array.isArray(contractList) ? contractList : []);
      setSuppliers(Array.isArray(sups) ? sups : []);
      setDepartments(Array.isArray(depts) ? depts : []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [category, statusFilter, search]);

  useEffect(() => {
    if (!supplierId && suppliers.length > 0) {
      setSupplierId(String(suppliers[0].id));
    }
  }, [suppliers, supplierId]);

  useEffect(() => {
    if (!deptId && (currentUser?.department_id || departments.length > 0)) {
      setDeptId(String(currentUser?.department_id || departments[0].id));
    }
  }, [departments, currentUser, deptId]);

  const handleCreateContract = async (e) => {
    e.preventDefault();
    if (!title.trim()) {
      alert(t('contracts.titleRequired'));
      return;
    }
    if (!supplierId || !deptId) {
      alert(t('contracts.supplierDeptRequired'));
      return;
    }
    if (annualValue === '' || parseMajorAmount(annualValue) == null) {
      alert(t('contracts.annualRequired'));
      return;
    }

    try {
      await api.createContract({
        supplier_id: Number(supplierId),
        department_id: Number(deptId),
        title: title.trim(),
        category: contractCat,
        start_date: startDate,
        end_date: endDate,
        notice_period_days: Number(noticeDays),
        annual_value_cents: toCents(annualValue),
        auto_renew: autoRenew ? 1 : 0,
        terms,
        actor_name: currentUser?.name,
        requester_id: currentUser?.id
      });
      setShowCreateModal(false);
      setTitle('');
      setAnnualValue('');
      setTerms('');
      await loadData();
      if (onDataChanged) onDataChanged();
    } catch (err) {
      alert(presentError(err, 'errors.contractCreate'));
    }
  };

  const handleRenewPR = async (contract) => {
    if (!RENEWABLE.has(contract.status)) {
      alert(t('contracts.cannotRenew', {
        number: contract.contract_number,
        status: statusLabel(contract.status)
      }));
      return;
    }
    setRenewingId(contract.id);
    try {
      const result = await api.renewContractPr(contract.id, {
        requester_id: currentUser?.id,
        actor_name: currentUser?.name,
        notes: t('contracts.renewNotes')
      });
      setRenewSuccess(result);
      await loadData();
      if (onDataChanged) onDataChanged();
    } catch (err) {
      alert(presentError(err, 'errors.contractRenew'));
    } finally {
      setRenewingId(null);
    }
  };

  const openDetail = async (contract) => {
    try {
      const detail = await api.getContractDetail(contract.id);
      setSelectedContract(detail);
    } catch (err) {
      alert(presentError(err, 'errors.requestRejected'));
    }
  };

  const expiringContracts = contracts.filter((c) => c.status === 'expiring_soon');

  const getStatusBadge = (status) => {
    switch (status) {
      case 'expiring_soon':
        return <span className="bg-amber-100 text-amber-800 text-xs px-2.5 py-1 rounded-full font-bold flex items-center space-x-1"><AlertTriangle className="w-3.5 h-3.5 mr-1 text-amber-600" />{statusLabel('expiring_soon')}</span>;
      case 'active':
        return <span className="bg-emerald-100 text-emerald-800 text-xs px-2.5 py-1 rounded-full font-bold flex items-center space-x-1"><CheckCircle2 className="w-3.5 h-3.5 mr-1 text-emerald-600" />{statusLabel('active')}</span>;
      case 'expired':
        return <span className="bg-rose-100 text-rose-800 text-xs px-2.5 py-1 rounded-full font-bold">{statusLabel('expired')}</span>;
      case 'cancelled':
        return <span className="bg-slate-100 text-slate-700 text-xs px-2.5 py-1 rounded-full font-bold">{statusLabel('cancelled')}</span>;
      default:
        return <span className="bg-slate-100 text-slate-700 text-xs px-2 py-0.5 rounded">{statusLabel(status)}</span>;
    }
  };

  const renewButton = (contract, className) => (
    <button
      onClick={() => handleRenewPR(contract)}
      disabled={renewingId === contract.id || !RENEWABLE.has(contract.status)}
      className={className}
      title={RENEWABLE.has(contract.status) ? t('contracts.renewTitle') : t('contracts.renewDisabled')}
    >
      <RefreshCw className={`w-3 h-3 ${renewingId === contract.id ? 'animate-spin' : ''}`} />
      <span>{renewingId === contract.id ? t('contracts.creating') : t('contracts.renew')}</span>
    </button>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <div className="flex items-center space-x-2 text-indigo-600 text-xs font-bold uppercase tracking-wider mb-0.5">
            <FileCheck className="w-4 h-4" />
            <span>{t('contracts.kicker')}</span>
          </div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">{t('contracts.title')}</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t('contracts.subtitle')}
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowCreateModal(true)}
            className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-sm transition-all flex items-center space-x-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>{t('contracts.register')}</span>
          </button>
        </div>
      </div>

      {expiringContracts.length > 0 && (
        <div className="bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-amber-500/10 border border-amber-300 rounded-xl p-4">
          <div className="flex items-start space-x-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-xs font-bold text-amber-900 uppercase tracking-wider">
                {expiringContracts.length === 1
                  ? t('contracts.renewalOne')
                  : t('contracts.renewalMany', { n: expiringContracts.length })}
              </h3>
              <p className="text-xs text-amber-800 mt-0.5 leading-relaxed">
                {t('contracts.renewalBody')}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {expiringContracts.map((c) => (
                  <div key={c.id} className="bg-white/90 border border-amber-200 px-3 py-1.5 rounded-lg text-xs flex items-center space-x-2 shadow-xs">
                    <span className="font-bold text-slate-900">{c.title}</span>
                    <span className="text-amber-700 font-mono font-bold">({t('contracts.daysLeft', { n: c.days_until_expiry })})</span>
                    {renewButton(c, 'px-2 py-0.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white rounded text-[10px] font-bold inline-flex items-center space-x-1')}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {renewSuccess && (
        <div className="bg-emerald-50 border border-emerald-300 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
            <div className="text-xs">
              <strong className="text-emerald-900 font-bold block">{t('contracts.renewCreated', { number: renewSuccess.pr_number })}</strong>
              <span className="text-emerald-800">
                {t('contracts.renewDetail', {
                  number: renewSuccess.pr_number,
                  amount: formatMoney(renewSuccess.total_amount_cents)
                })}
              </span>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={() => onNavigate('requisitions')}
              className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg text-xs font-bold flex items-center space-x-1"
            >
              <span>{t('contracts.viewRequisitions')}</span>
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

      <div className="flex flex-col sm:flex-row gap-3 bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm text-xs">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-3 top-3 text-slate-400" />
          <input
            type="text"
            placeholder={t('contracts.searchPlaceholder')}
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
          <option value="Software & Cloud">{categoryLabel('Software & Cloud')}</option>
          <option value="Consulting & Professional Services">{categoryLabel('Consulting & Professional Services')}</option>
          <option value="Facilities & MRO">{categoryLabel('Facilities & MRO')}</option>
          <option value="Marketing & Events">{categoryLabel('Marketing & Events')}</option>
        </select>
        <div className="flex items-center space-x-1 bg-slate-100 p-1 rounded-lg">
          {['all', 'expiring_soon', 'active', 'expired'].map((st) => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={`px-2.5 py-1 rounded text-[11px] font-semibold capitalize transition-colors ${
                statusFilter === st ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              {statusLabel(st)}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">{t('contracts.number')}</th>
                <th className="py-3 px-4">{t('contracts.titleSupplier')}</th>
                <th className="py-3 px-4">{t('common.category')}</th>
                <th className="py-3 px-4">{t('common.costCenter')}</th>
                <th className="py-3 px-4">{t('contracts.annualValue')}</th>
                <th className="py-3 px-4">{t('contracts.endNotice')}</th>
                <th className="py-3 px-4">{t('common.status')}</th>
                <th className="py-3 px-4 text-right">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">{t('contracts.loading')}</td>
                </tr>
              ) : contracts.length === 0 ? (
                <tr>
                  <td colSpan="8" className="py-8 text-center text-slate-400">{t('contracts.empty')}</td>
                </tr>
              ) : (
                contracts.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-slate-900">
                      {c.contract_number}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-bold text-slate-900">{c.title}</div>
                      <div className="text-[11px] text-slate-500">{c.supplier_name}</div>
                    </td>
                    <td className="py-3 px-4">
                      <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded text-[10px] font-medium">
                        {categoryLabel(c.category)}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-700 font-semibold">
                      {c.department_code}
                    </td>
                    <td className="py-3 px-4 font-extrabold text-slate-900 text-sm">
                      {formatMoney(c.annual_value_cents)}
                      <span className="text-[10px] text-slate-400 font-normal"> {t('contracts.perYear')}</span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-800">{c.end_date}</div>
                      <div className="text-[10px] text-slate-500">
                        {c.days_until_expiry > 0
                          ? (Number(c.days_until_expiry) === 1
                            ? t('contracts.daysRemainingOne')
                            : t('contracts.daysRemainingMany', { n: c.days_until_expiry }))
                          : t('contracts.passedExpiration')}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      {getStatusBadge(c.status)}
                    </td>
                    <td className="py-3 px-4 text-right space-x-2">
                      <button
                        onClick={() => openDetail(c)}
                        className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded text-[11px] font-semibold"
                        title={t('contracts.viewDetails')}
                      >
                        <Eye className="w-3.5 h-3.5 inline" />
                      </button>
                      {renewButton(c, 'px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white rounded text-[11px] font-bold shadow-xs inline-flex items-center space-x-1')}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedContract && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-slate-200 space-y-4 text-xs">
            <div className="flex justify-between items-start pb-3 border-b border-slate-200">
              <div>
                <div className="flex items-center space-x-2">
                  <h3 className="text-base font-bold text-slate-900">{selectedContract.title}</h3>
                  {getStatusBadge(selectedContract.status)}
                </div>
                <div className="text-slate-500 font-mono mt-0.5">{t('contracts.contractNumber', { number: selectedContract.contract_number })}</div>
              </div>
              <button onClick={() => setSelectedContract(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
              <div>
                <span className="text-slate-400 block text-[10px]">{t('common.supplier')}:</span>
                <span className="font-bold text-slate-900 text-sm">{selectedContract.supplier_name}</span>
                <div className="text-slate-500">{selectedContract.supplier_email}</div>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">{t('common.costCenter')}:</span>
                <span className="font-bold text-slate-900">{selectedContract.department_name} ({selectedContract.department_code})</span>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">{t('contracts.duration')}:</span>
                <span className="font-semibold text-slate-800">{selectedContract.start_date} ➔ {selectedContract.end_date}</span>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">{t('contracts.notice')}:</span>
                <span className="font-semibold text-slate-800">
                  {t(
                    Number(selectedContract.notice_period_days) === 1 ? 'contracts.noticeOne' : 'contracts.noticeMany',
                    { days: selectedContract.notice_period_days, date: selectedContract.notice_deadline }
                  )}
                </span>
              </div>
            </div>

            {selectedContract.terms && (
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-slate-700">
                <strong className="block text-[10px] text-slate-400 uppercase mb-1">{t('contracts.termsHeading')}:</strong>
                {selectedContract.terms}
              </div>
            )}

            {selectedContract.items?.length > 0 && (
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 text-[10px] uppercase text-slate-500">
                    <tr>
                      <th className="py-2 px-3">{t('common.line')}</th>
                      <th className="py-2 px-3">{t('common.qty')}</th>
                      <th className="py-2 px-3">{t('common.unitPrice')}</th>
                      <th className="py-2 px-3 text-right">{t('common.total')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedContract.items.map((item) => (
                      <tr key={item.id} className="border-t border-slate-100">
                        <td className="py-2 px-3">{item.description}</td>
                        <td className="py-2 px-3">{item.quantity}</td>
                        <td className="py-2 px-3">{formatMoney(item.unit_price)}</td>
                        <td className="py-2 px-3 text-right font-semibold">{formatMoney(item.total_price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex justify-between items-center pt-3 border-t border-slate-200">
              <div className="text-emerald-700 font-extrabold text-sm">
                {t('contracts.annualLabel')}: {formatMoney(selectedContract.annual_value_cents)}
              </div>
              <div className="flex space-x-2">
                <button onClick={() => setSelectedContract(null)} className="px-4 py-2 border border-slate-300 rounded-lg font-semibold">
                  {t('common.close')}
                </button>
                <button
                  onClick={() => {
                    handleRenewPR(selectedContract);
                    setSelectedContract(null);
                  }}
                  disabled={!RENEWABLE.has(selectedContract.status)}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white rounded-lg font-bold flex items-center space-x-1"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{t('contracts.generateRenewal')}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showCreateModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form onSubmit={handleCreateContract} className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-slate-200 space-y-4 text-xs">
            <div className="flex justify-between items-center pb-3 border-b border-slate-200">
              <h3 className="text-base font-bold text-slate-900">{t('contracts.createTitle')}</h3>
              <button type="button" onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-slate-600 mb-1 font-semibold">{t('contracts.contractTitle')}</label>
                <input
                  type="text"
                  placeholder={t('contracts.titlePlaceholder')}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 mb-1">{t('common.supplier')}</label>
                  <select
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs font-medium"
                    required
                  >
                    <option value="">{t('contracts.selectSupplier')}</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">{t('common.department')}</label>
                  <select
                    value={deptId}
                    onChange={(e) => setDeptId(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs font-medium"
                    required
                  >
                    <option value="">{t('contracts.selectDepartment')}</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>{d.name} ({d.code})</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 mb-1">{t('common.category')}</label>
                  <select
                    value={contractCat}
                    onChange={(e) => setContractCat(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                  >
                    <option value="Software & Cloud">{categoryLabel('Software & Cloud')}</option>
                    <option value="Consulting & Professional Services">{t('category.consultingServices')}</option>
                    <option value="Facilities & MRO">{categoryLabel('Facilities & MRO')}</option>
                    <option value="Office Supplies">{categoryLabel('Office Supplies')}</option>
                    <option value="Marketing & Events">{categoryLabel('Marketing & Events')}</option>
                    <option value="IT Hardware">{categoryLabel('IT Hardware')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">{t('contracts.annualValue')}</label>
                  <input
                    {...moneyInputProps}
                    value={annualValue}
                    onChange={(e) => setAnnualValue(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                    placeholder={t('money.annualExample')}
                    required
                  />
                </div>
              </div>
              <p className="text-[10px] text-slate-400">{t('money.hint')}</p>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-600 mb-1">{t('contracts.start')}</label>
                  <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg text-xs" required />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">{t('contracts.end')}</label>
                  <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg text-xs" required />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">{t('contracts.noticeDays')}</label>
                  <input type="number" min="0" step="1" value={noticeDays} onChange={(e) => setNoticeDays(e.target.value)} className="w-full p-2 border border-slate-300 rounded-lg text-xs" required />
                </div>
              </div>

              <div>
                <label className="block text-slate-600 mb-1">{t('contracts.termsLabel')}</label>
                <textarea
                  rows="2"
                  placeholder={t('contracts.termsPlaceholder')}
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
                  {t('contracts.autoRenew')}
                </label>
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-3 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 border border-slate-300 rounded-lg font-semibold"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold"
              >
                {t('contracts.save')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
