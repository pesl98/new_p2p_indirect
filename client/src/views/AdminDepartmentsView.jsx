import React, { useEffect, useMemo, useState } from 'react';
import { Building2, Save, Shield, UserCog } from 'lucide-react';
import { api } from '../api';
import { presentError, roleLabel, t } from '../i18n';

function sortEligible(eligible, departmentId) {
  return [...(eligible || [])].sort((a, b) => {
    const aIn = Number(a.department_id) === Number(departmentId) ? 0 : 1;
    const bIn = Number(b.department_id) === Number(departmentId) ? 0 : 1;
    if (aIn !== bIn) return aIn - bIn;
    return String(a.name).localeCompare(String(b.name));
  });
}

export default function AdminDepartmentsView({ currentUser }) {
  const [departments, setDepartments] = useState([]);
  const [eligible, setEligible] = useState([]);
  const [draft, setDraft] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [savedId, setSavedId] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const isAdmin = currentUser?.role === 'admin';

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const [depts, users] = await Promise.all([
        api.getDepartments(),
        api.getEligibleApprovers()
      ]);
      const list = Array.isArray(depts) ? depts : [];
      setDepartments(list);
      setEligible(Array.isArray(users) ? users : []);
      const nextDraft = {};
      list.forEach((d) => {
        nextDraft[d.id] = d.approver_user_id == null ? '' : String(d.approver_user_id);
      });
      setDraft(nextDraft);
    } catch (err) {
      setError(presentError(err, 'errors.departments'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAdmin) loadData();
  }, [isAdmin]);

  const missingCount = useMemo(
    () => departments.filter((d) => d.approver_user_id == null).length,
    [departments]
  );

  if (!isAdmin) {
    return (
      <div className="bg-white p-8 rounded-xl border border-slate-200/80 shadow-sm text-center">
        <UserCog className="w-8 h-8 text-slate-300 mx-auto mb-3" />
        <h2 className="text-lg font-bold text-slate-900">{t('admin.departments.gatedTitle')}</h2>
        <p className="text-sm text-slate-500 mt-2 max-w-md mx-auto">
          {t('admin.departments.gatedBody')}
        </p>
      </div>
    );
  }

  const isDirty = (dept) => {
    const current = dept.approver_user_id == null ? '' : String(dept.approver_user_id);
    return (draft[dept.id] ?? current) !== current;
  };

  const saveRow = async (dept) => {
    setSavingId(dept.id);
    setError('');
    setSavedId(null);
    try {
      const raw = draft[dept.id];
      const approver_user_id = raw === '' || raw == null ? null : Number(raw);
      const updated = await api.setDepartmentApprover(dept.id, {
        approver_user_id,
        actor_name: currentUser?.name || 'Elena Rostova'
      });
      setDepartments((prev) => prev.map((d) => (d.id === dept.id ? { ...d, ...updated } : d)));
      setDraft((prev) => ({
        ...prev,
        [dept.id]: updated.approver_user_id == null ? '' : String(updated.approver_user_id)
      }));
      setSavedId(dept.id);
    } catch (err) {
      setError(presentError(err, 'errors.departmentApprover'));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-slate-900 tracking-tight">{t('admin.departments.title')}</h2>
            <p className="text-xs text-slate-500 mt-0.5 max-w-2xl">
              {t('admin.departments.introBefore')}{' '}
              <span className="font-mono">role=approver</span>{' '}
              {t('admin.departments.introAfter')}
            </p>
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-wider bg-purple-50 text-purple-800 border border-purple-200 px-2.5 py-1 rounded-full whitespace-nowrap">
            {t('admin.departments.persona')}
          </span>
        </div>
        <p className="text-[11px] text-slate-400 mt-3">
          {t('admin.departments.demoAuth')}
        </p>
      </div>

      {missingCount > 0 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 text-xs rounded-xl px-4 py-3 flex items-start space-x-2">
          <Shield className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            {t(missingCount === 1 ? 'admin.departments.missingOne' : 'admin.departments.missingMany', { count: missingCount })}
          </span>
        </div>
      )}

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-12 text-center text-slate-400 text-xs">{t('admin.departments.loading')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px] font-bold">
                <tr>
                  <th className="px-4 py-3">{t('common.costCenter')}</th>
                  <th className="px-4 py-3">{t('admin.departments.currentHead')}</th>
                  <th className="px-4 py-3">{t('admin.departments.assign')}</th>
                  <th className="px-4 py-3 w-32"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {departments.map((dept) => {
                  const choices = sortEligible(eligible, dept.id);
                  const selected = draft[dept.id] ?? '';
                  const dirty = isDirty(dept);
                  const mappedUser = choices.find((u) => String(u.id) === String(dept.approver_user_id));
                  return (
                    <tr key={dept.id} className="hover:bg-slate-50/80">
                      <td className="px-4 py-3.5">
                        <div className="flex items-center space-x-2">
                          <Building2 className="w-3.5 h-3.5 text-slate-400" />
                          <div>
                            <div className="font-semibold text-slate-900">{dept.name}</div>
                            <div className="font-mono text-[10px] text-slate-400">{dept.code}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        {dept.approver_name ? (
                          <div>
                            <div className="font-medium text-slate-800">{dept.approver_name}</div>
                            <div className="text-[10px] text-slate-400">
                              {dept.approver_title || roleLabel(dept.approver_role)}
                              {dept.approver_role ? ` · ${roleLabel(dept.approver_role)}` : ''}
                            </div>
                          </div>
                        ) : (
                          <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">
                            {t('common.unassigned')}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3.5">
                        <select
                          value={selected}
                          onChange={(e) => setDraft((prev) => ({ ...prev, [dept.id]: e.target.value }))}
                          className="w-full max-w-xs bg-white border border-slate-300 rounded-lg py-1.5 px-2 text-xs font-medium text-slate-800 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                        >
                          <option value="">{t('admin.departments.unassignedLegacy')}</option>
                          {choices.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name} ({roleLabel(u.role)})
                              {u.department_code ? ` · ${u.department_code}` : ''}
                            </option>
                          ))}
                          {dept.approver_user_id && !mappedUser && (
                            <option value={dept.approver_user_id}>
                              {dept.approver_name || t('admin.departments.userFallback', { id: dept.approver_user_id })} ({t('admin.departments.current')})
                            </option>
                          )}
                        </select>
                      </td>
                      <td className="px-4 py-3.5">
                        <button
                          type="button"
                          disabled={!dirty || savingId === dept.id}
                          onClick={() => saveRow(dept)}
                          className={`inline-flex items-center space-x-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
                            dirty
                              ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm'
                              : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                          }`}
                        >
                          <Save className="w-3.5 h-3.5" />
                          <span>{savingId === dept.id ? t('common.saving') : savedId === dept.id && !dirty ? t('common.saved') : t('common.save')}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
