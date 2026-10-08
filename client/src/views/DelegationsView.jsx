import React, { useEffect, useMemo, useState } from 'react';
import { Ban, CalendarRange, Shield, UserCheck } from 'lucide-react';
import { api } from '../api';
import { presentError, roleLabel, t } from '../i18n';

export const DELEGATION_ROLES = ['approver', 'procurement', 'finance', 'admin'];

function formatWindow(starts, ends) {
  if (!starts && !ends) return t('admin.delegations.openEnded');
  const startLabel = starts ? String(starts).slice(0, 10) : t('admin.delegations.openStart');
  const endLabel = ends ? String(ends).slice(0, 10) : t('admin.delegations.openEnd');
  return `${startLabel} → ${endLabel}`;
}

function statusBadge(row) {
  if (Number(row.active) !== 1) {
    return (
      <span className="text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
        {t('admin.delegations.revoked')}
      </span>
    );
  }
  if (Number(row.covering_now) === 1) {
    return (
      <span className="text-[10px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
        {t('admin.delegations.activeNow')}
      </span>
    );
  }
  if (row.starts_at && String(row.starts_at) > new Date().toISOString()) {
    return (
      <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">
        {t('admin.delegations.scheduled')}
      </span>
    );
  }
  return (
    <span className="text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
      {t('status.expired')}
    </span>
  );
}

export default function DelegationsView({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [revokingId, setRevokingId] = useState(null);
  const isAdmin = currentUser?.role === 'admin';

  const [delegatorId, setDelegatorId] = useState('');
  const [delegateId, setDelegateId] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [reason, setReason] = useState('');

  const loadData = async () => {
    if (!currentUser?.id) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [userList, delegations] = await Promise.all([
        api.getUsers(),
        isAdmin
          ? api.getDelegations()
          : api.getDelegations({ user_id: currentUser.id })
      ]);
      setUsers(Array.isArray(userList) ? userList : []);
      setRows(Array.isArray(delegations) ? delegations : []);
    } catch (err) {
      setError(presentError(err, 'errors.delegations'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setDelegatorId(isAdmin ? '' : String(currentUser?.id || ''));
    setDelegateId('');
    setStartsAt('');
    setEndsAt('');
    setReason('');
    loadData();
  }, [currentUser?.id, isAdmin]);

  const incomingCovering = useMemo(
    () => rows.filter((row) =>
      Number(row.delegate_user_id) === Number(currentUser?.id)
      && Number(row.covering_now) === 1
    ),
    [rows, currentUser?.id]
  );

  const delegateChoices = users.filter((u) => String(u.id) !== String(delegatorId || currentUser?.id));

  const canRevoke = (row) => {
    if (Number(row.active) !== 1) return false;
    if (isAdmin) return true;
    return Number(row.delegator_user_id) === Number(currentUser?.id);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    const fromId = isAdmin ? delegatorId : currentUser?.id;
    if (!fromId || !delegateId) {
      setError(t('admin.delegations.pickBoth'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.createDelegation({
        delegator_user_id: Number(fromId),
        delegate_user_id: Number(delegateId),
        starts_at: startsAt || null,
        ends_at: endsAt || null,
        reason: reason.trim() || null,
        actor_name: currentUser?.name,
        created_by_user_id: currentUser?.id
      });
      setDelegateId('');
      setStartsAt('');
      setEndsAt('');
      setReason('');
      if (isAdmin) setDelegatorId('');
      await loadData();
    } catch (err) {
      setError(presentError(err, 'errors.delegationCreate'));
    } finally {
      setSaving(false);
    }
  };

  const handleRevoke = async (row) => {
    if (!window.confirm(t('admin.delegations.confirmRevoke', { from: row.delegator_name, to: row.delegate_name }))) {
      return;
    }
    setRevokingId(row.id);
    setError('');
    try {
      await api.revokeDelegation(row.id, {
        actor_name: currentUser?.name,
        actor_user_id: currentUser?.id
      });
      await loadData();
    } catch (err) {
      setError(presentError(err, 'errors.delegationRevoke'));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-slate-900 tracking-tight">{t('admin.delegations.title')}</h2>
            <p className="text-xs text-slate-500 mt-0.5 max-w-2xl">
              {t('admin.delegations.intro')}
            </p>
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-wider bg-violet-50 text-violet-800 border border-violet-200 px-2.5 py-1 rounded-full whitespace-nowrap">
            {t('admin.delegations.ooo')}
          </span>
        </div>
        <p className="text-[11px] text-slate-400 mt-3">
          {t('admin.delegations.demoAuth')}
        </p>
      </div>

      {incomingCovering.length > 0 && (
        <div className="bg-violet-50 border border-violet-200 text-violet-900 text-xs rounded-xl px-4 py-3 flex items-start space-x-2">
          <UserCheck className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            {t('admin.delegations.coveringBefore')}{' '}
            <strong>{incomingCovering.map((row) => row.delegator_name).join(', ')}</strong>
            {t('admin.delegations.coveringAfter')}
          </span>
        </div>
      )}

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      <form onSubmit={handleCreate} className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-5 space-y-4">
        <div className="flex items-center space-x-2 text-sm font-semibold text-slate-900">
          <CalendarRange className="w-4 h-4 text-slate-400" />
          <span>{isAdmin ? t('admin.delegations.createAny') : t('admin.delegations.delegateMine')}</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          {isAdmin && (
            <label className="block text-slate-700 font-medium">
              {t('admin.delegations.delegatorAway')}
              <select
                value={delegatorId}
                onChange={(e) => setDelegatorId(e.target.value)}
                className="mt-1 w-full bg-white border border-slate-300 rounded-lg py-1.5 px-2 text-xs font-medium text-slate-800 focus:ring-2 focus:ring-emerald-500"
              >
                <option value="">{t('admin.delegations.selectPerson')}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name} ({roleLabel(u.role)})</option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-slate-700 font-medium">
            {t('admin.delegations.substitute')}
            <select
              value={delegateId}
              onChange={(e) => setDelegateId(e.target.value)}
              className="mt-1 w-full bg-white border border-slate-300 rounded-lg py-1.5 px-2 text-xs font-medium text-slate-800 focus:ring-2 focus:ring-emerald-500"
            >
              <option value="">{t('admin.delegations.selectDelegate')}</option>
              {delegateChoices.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({roleLabel(u.role)})</option>
              ))}
            </select>
          </label>
          <label className="block text-slate-700 font-medium">
            {t('admin.delegations.startsOptional')}
            <input
              type="date"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className="mt-1 w-full bg-white border border-slate-300 rounded-lg py-1.5 px-2 text-xs font-medium text-slate-800 focus:ring-2 focus:ring-emerald-500"
            />
          </label>
          <label className="block text-slate-700 font-medium">
            {t('admin.delegations.endsOptional')}
            <input
              type="date"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              className="mt-1 w-full bg-white border border-slate-300 rounded-lg py-1.5 px-2 text-xs font-medium text-slate-800 focus:ring-2 focus:ring-emerald-500"
            />
          </label>
          <label className="block text-slate-700 font-medium md:col-span-2">
            {t('common.reason')} ({t('common.optional')})
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('admin.delegations.reasonPlaceholder')}
              className="mt-1 w-full bg-white border border-slate-300 rounded-lg py-1.5 px-2 text-xs font-medium text-slate-800 focus:ring-2 focus:ring-emerald-500"
            />
          </label>
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold shadow-sm disabled:opacity-60"
          >
            {saving ? t('common.saving') : t('admin.delegations.create')}
          </button>
        </div>
      </form>

      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900">
            {isAdmin ? t('admin.delegations.all') : t('admin.delegations.mine')}
          </h3>
          <span className="text-[11px] text-slate-400">{t(rows.length === 1 ? 'admin.delegations.recordOne' : 'admin.delegations.recordMany', { count: rows.length })}</span>
        </div>
        {loading ? (
          <div className="py-12 text-center text-slate-400 text-xs">{t('admin.delegations.loading')}</div>
        ) : rows.length === 0 ? (
          <div className="py-12 text-center text-slate-500 text-xs">
            {t('admin.delegations.empty')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px] font-bold">
                <tr>
                  <th className="px-4 py-3">{t('admin.delegations.delegator')}</th>
                  <th className="px-4 py-3">{t('admin.delegations.delegate')}</th>
                  <th className="px-4 py-3">{t('admin.delegations.window')}</th>
                  <th className="px-4 py-3">{t('common.status')}</th>
                  <th className="px-4 py-3">{t('common.reason')}</th>
                  <th className="px-4 py-3 w-28"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/80">
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-900">{row.delegator_name}</div>
                      <div className="text-[10px] text-slate-400">{row.delegator_title || roleLabel(row.delegator_role)}</div>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-900">{row.delegate_name}</div>
                      <div className="text-[10px] text-slate-400">{row.delegate_title || roleLabel(row.delegate_role)}</div>
                    </td>
                    <td className="px-4 py-3.5 text-slate-600">{formatWindow(row.starts_at, row.ends_at)}</td>
                    <td className="px-4 py-3.5">{statusBadge(row)}</td>
                    <td className="px-4 py-3.5 text-slate-600 max-w-xs truncate">{row.reason || '—'}</td>
                    <td className="px-4 py-3.5">
                      {canRevoke(row) ? (
                        <button
                          type="button"
                          disabled={revokingId === row.id}
                          onClick={() => handleRevoke(row)}
                          className="inline-flex items-center space-x-1 text-xs font-semibold px-3 py-1.5 rounded-lg bg-white border border-rose-200 text-rose-700 hover:bg-rose-50"
                        >
                          <Ban className="w-3.5 h-3.5" />
                          <span>{revokingId === row.id ? t('admin.delegations.revoking') : t('admin.delegations.revoke')}</span>
                        </button>
                      ) : Number(row.active) === 1 ? (
                        <span className="text-[10px] text-slate-400">{t('admin.delegations.incoming')}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-slate-50 border border-slate-200 text-slate-600 text-[11px] rounded-xl px-4 py-3 flex items-start space-x-2">
        <Shield className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <span>
          {t('admin.delegations.failClosed')}
        </span>
      </div>
    </div>
  );
}
