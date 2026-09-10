import React, { useEffect, useMemo, useState } from 'react';
import { Ban, CalendarRange, Shield, UserCheck } from 'lucide-react';
import { api } from '../api';

export const DELEGATION_ROLES = ['approver', 'procurement', 'finance', 'admin'];

function formatWindow(starts, ends) {
  if (!starts && !ends) return 'Open-ended while active';
  const startLabel = starts ? String(starts).slice(0, 10) : 'Open start';
  const endLabel = ends ? String(ends).slice(0, 10) : 'Open end';
  return `${startLabel} → ${endLabel}`;
}

function statusBadge(row) {
  if (Number(row.active) !== 1) {
    return (
      <span className="text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
        Revoked
      </span>
    );
  }
  if (Number(row.covering_now) === 1) {
    return (
      <span className="text-[10px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
        Active now
      </span>
    );
  }
  if (row.starts_at && String(row.starts_at) > new Date().toISOString()) {
    return (
      <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">
        Scheduled
      </span>
    );
  }
  return (
    <span className="text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
      Expired
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
      setError(err.message || 'Failed to load delegations');
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
      setError('Pick a delegator and a substitute approver.');
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
      setError(err.message || 'Failed to create delegation');
    } finally {
      setSaving(false);
    }
  };

  const handleRevoke = async (row) => {
    if (!window.confirm(`Revoke ${row.delegator_name} → ${row.delegate_name}? Pending steps return to the mapped approver only.`)) {
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
      setError(err.message || 'Failed to revoke delegation');
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-slate-900 tracking-tight">Approval Delegations</h2>
            <p className="text-xs text-slate-500 mt-0.5 max-w-2xl">
              Assign a temporary substitute so sequential approval steps do not stall while the
              mapped head is away. The stored step approver is unchanged — the delegate sees the
              pending inbox item and may decide it. Waiting steps stay waiting.
            </p>
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-wider bg-violet-50 text-violet-800 border border-violet-200 px-2.5 py-1 rounded-full whitespace-nowrap">
            Out of office
          </span>
        </div>
        <p className="text-[11px] text-slate-400 mt-3">
          Demo auth is the header switcher only (no JWT). Create for yourself as delegator;
          Elena can manage any pair. Soft-revoke keeps history — no hard delete.
        </p>
      </div>

      {incomingCovering.length > 0 && (
        <div className="bg-violet-50 border border-violet-200 text-violet-900 text-xs rounded-xl px-4 py-3 flex items-start space-x-2">
          <UserCheck className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>
            You are covering for{' '}
            <strong>{incomingCovering.map((row) => row.delegator_name).join(', ')}</strong>.
            Their current pending steps appear in your Approvals Inbox with a “Delegated from” badge.
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
          <span>{isAdmin ? 'Create a delegation (any pair)' : 'Delegate my approvals'}</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          {isAdmin && (
            <label className="block text-slate-700 font-medium">
              Delegator (away)
              <select
                value={delegatorId}
                onChange={(e) => setDelegatorId(e.target.value)}
                className="mt-1 w-full bg-white border border-slate-300 rounded-lg py-1.5 px-2 text-xs font-medium text-slate-800 focus:ring-2 focus:ring-emerald-500"
              >
                <option value="">— Select person —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-slate-700 font-medium">
            Substitute approver
            <select
              value={delegateId}
              onChange={(e) => setDelegateId(e.target.value)}
              className="mt-1 w-full bg-white border border-slate-300 rounded-lg py-1.5 px-2 text-xs font-medium text-slate-800 focus:ring-2 focus:ring-emerald-500"
            >
              <option value="">— Select delegate —</option>
              {delegateChoices.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
              ))}
            </select>
          </label>
          <label className="block text-slate-700 font-medium">
            Starts (optional)
            <input
              type="date"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className="mt-1 w-full bg-white border border-slate-300 rounded-lg py-1.5 px-2 text-xs font-medium text-slate-800 focus:ring-2 focus:ring-emerald-500"
            />
          </label>
          <label className="block text-slate-700 font-medium">
            Ends (optional)
            <input
              type="date"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              className="mt-1 w-full bg-white border border-slate-300 rounded-lg py-1.5 px-2 text-xs font-medium text-slate-800 focus:ring-2 focus:ring-emerald-500"
            />
          </label>
          <label className="block text-slate-700 font-medium md:col-span-2">
            Reason (optional)
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Out of office, travel, coverage…"
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
            {saving ? 'Saving…' : 'Create delegation'}
          </button>
        </div>
      </form>

      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900">
            {isAdmin ? 'All delegations' : 'My delegations'}
          </h3>
          <span className="text-[11px] text-slate-400">{rows.length} record{rows.length === 1 ? '' : 's'}</span>
        </div>
        {loading ? (
          <div className="py-12 text-center text-slate-400 text-xs">Loading delegations…</div>
        ) : rows.length === 0 ? (
          <div className="py-12 text-center text-slate-500 text-xs">
            No delegations yet. Create one above so a substitute can clear your pending step.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px] font-bold">
                <tr>
                  <th className="px-4 py-3">Delegator</th>
                  <th className="px-4 py-3">Delegate</th>
                  <th className="px-4 py-3">Window</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3 w-28"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/80">
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-900">{row.delegator_name}</div>
                      <div className="text-[10px] text-slate-400">{row.delegator_title || row.delegator_role}</div>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-900">{row.delegate_name}</div>
                      <div className="text-[10px] text-slate-400">{row.delegate_title || row.delegate_role}</div>
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
                          <span>{revokingId === row.id ? 'Revoking…' : 'Revoke'}</span>
                        </button>
                      ) : Number(row.active) === 1 ? (
                        <span className="text-[10px] text-slate-400">Incoming</span>
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
          Fail-closed: cannot delegate to yourself, both users must exist, and revoke only works on an
          active row. Expired or revoked windows are ignored by the inbox and decide API.
        </span>
      </div>
    </div>
  );
}
