import React, { useEffect, useMemo, useState } from 'react';
import { Ban, KeyRound, Pencil, Plus, RotateCcw, Users } from 'lucide-react';
import { api } from '../api';
import { formatMoney, toCents, fromCents } from '../money';

const ROLES = ['requester', 'approver', 'procurement', 'finance', 'admin'];

function roleLabel(role) {
  switch (role) {
    case 'requester': return 'Requester';
    case 'approver': return 'Approver / Dept Head';
    case 'procurement': return 'Procurement';
    case 'finance': return 'Finance';
    case 'admin': return 'Admin / CFO';
    default: return role || '';
  }
}

function emptyForm() {
  return {
    name: '',
    email: '',
    role: 'requester',
    department_id: '',
    title: '',
    approval_limit_dollars: '',
    password: ''
  };
}

export default function AdminUsersView({ currentUser, sessionUser }) {
  const [users, setUsers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [passwordUser, setPasswordUser] = useState(null);
  const [newPassword, setNewPassword] = useState('');

  const canMutate = sessionUser?.role === 'admin';

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const [list, depts] = await Promise.all([
        api.getUsers('all'),
        api.getDepartments()
      ]);
      setUsers(Array.isArray(list) ? list : []);
      setDepartments(Array.isArray(depts) ? depts : []);
    } catch (err) {
      setError(err.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (currentUser?.role === 'admin') loadData();
  }, [currentUser?.role]);

  const inactiveCount = useMemo(
    () => users.filter((u) => u.status === 'inactive').length,
    [users]
  );

  const openCreate = () => {
    setForm(emptyForm());
    setModal('create');
  };

  const openEdit = (user) => {
    setForm({
      name: user.name || '',
      email: user.email || '',
      role: user.role || 'requester',
      department_id: user.department_id == null ? '' : String(user.department_id),
      title: user.title || '',
      approval_limit_dollars: user.approval_limit ? String(fromCents(user.approval_limit)) : '',
      password: ''
    });
    setModal({ type: 'edit', user });
  };

  const payloadFromForm = (includePassword) => {
    const data = {
      name: form.name,
      email: form.email,
      role: form.role,
      department_id: form.department_id === '' ? null : Number(form.department_id),
      title: form.title,
      approval_limit: form.approval_limit_dollars === '' ? 0 : toCents(form.approval_limit_dollars)
    };
    if (includePassword && form.password) data.password = form.password;
    return data;
  };

  const saveModal = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (modal === 'create') {
        await api.createUser(payloadFromForm(true));
      } else {
        await api.updateUser(modal.user.id, payloadFromForm(false));
      }
      setModal(null);
      await loadData();
    } catch (err) {
      setError(err.message || 'Failed to save user');
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (user) => {
    const next = user.status === 'inactive' ? 'active' : 'inactive';
    const label = next === 'inactive' ? 'Deactivate' : 'Reactivate';
    if (!window.confirm(`${label} ${user.name}? Historical PRs/POs keep their user FKs.`)) return;
    setError('');
    try {
      await api.updateUserStatus(user.id, next);
      await loadData();
    } catch (err) {
      setError(err.message || 'Failed to update status');
    }
  };

  const savePassword = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.setUserPassword(passwordUser.id, newPassword);
      setPasswordUser(null);
      setNewPassword('');
      await loadData();
    } catch (err) {
      setError(err.message || 'Failed to set password');
    } finally {
      setSaving(false);
    }
  };

  if (currentUser?.role !== 'admin') {
    return (
      <div className="bg-white p-8 rounded-xl border border-slate-200/80 shadow-sm text-center">
        <Users className="w-8 h-8 text-slate-300 mx-auto mb-3" />
        <h2 className="text-lg font-bold text-slate-900">User administration</h2>
        <p className="text-sm text-slate-500 mt-2 max-w-md mx-auto">
          Only the admin persona can open this screen. Sign in as an admin to create and edit users.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-slate-900 tracking-tight">Users</h2>
            <p className="text-xs text-slate-500 mt-0.5 max-w-2xl">
              Create employees in this customer database (name, unique email, role, department, title,
              approval limit in cents). Soft-deactivate instead of delete. Passwords are hashed; they
              never appear in API responses.
            </p>
          </div>
          <button
            type="button"
            onClick={openCreate}
            disabled={!canMutate}
            className="inline-flex items-center space-x-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white text-xs font-semibold px-3 py-2 rounded-lg"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New user</span>
          </button>
        </div>
        {!canMutate && (
          <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">
            Sign in as an admin to create or edit users. Mutating <span className="font-mono">/api/users</span> routes
            require a session admin (<span className="font-mono">req.user</span>), not the header persona switcher.
          </p>
        )}
        {inactiveCount > 0 && (
          <p className="text-[11px] text-slate-400 mt-2">{inactiveCount} inactive user{inactiveCount === 1 ? '' : 's'} listed below.</p>
        )}
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-12 text-center text-slate-400 text-xs">Loading users…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px] font-bold">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Department</th>
                  <th className="px-4 py-3">Limit</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 w-48"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((user) => (
                  <tr key={user.id} className={user.status === 'inactive' ? 'bg-slate-50/80' : 'hover:bg-slate-50/80'}>
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-900">{user.name}</div>
                      <div className="text-[10px] text-slate-400">{user.title || '—'}</div>
                    </td>
                    <td className="px-4 py-3.5 font-mono text-[11px] text-slate-600">{user.email}</td>
                    <td className="px-4 py-3.5">{roleLabel(user.role)}</td>
                    <td className="px-4 py-3.5">
                      {user.department_name || '—'}
                      {user.department_code ? (
                        <span className="block font-mono text-[10px] text-slate-400">{user.department_code}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3.5">${formatMoney(user.approval_limit || 0)}</td>
                    <td className="px-4 py-3.5">
                      <span className={`font-bold px-2 py-0.5 rounded-full text-[10px] ${
                        user.status === 'inactive' ? 'bg-slate-200 text-slate-700' : 'bg-emerald-100 text-emerald-800'
                      }`}>
                        {user.status === 'inactive' ? 'Inactive' : 'Active'}
                      </span>
                      {Number(user.has_password) === 1 && (
                        <span className="ml-1 text-[10px] text-slate-400">pw</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={!canMutate}
                          onClick={() => openEdit(user)}
                          className="inline-flex items-center space-x-1 text-[11px] font-semibold px-2 py-1 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                        >
                          <Pencil className="w-3 h-3" />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          disabled={!canMutate}
                          onClick={() => { setPasswordUser(user); setNewPassword(''); }}
                          className="inline-flex items-center space-x-1 text-[11px] font-semibold px-2 py-1 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                        >
                          <KeyRound className="w-3 h-3" />
                          <span>Password</span>
                        </button>
                        <button
                          type="button"
                          disabled={!canMutate}
                          onClick={() => toggleStatus(user)}
                          className="inline-flex items-center space-x-1 text-[11px] font-semibold px-2 py-1 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                        >
                          {user.status === 'inactive' ? <RotateCcw className="w-3 h-3" /> : <Ban className="w-3 h-3" />}
                          <span>{user.status === 'inactive' ? 'Reactivate' : 'Deactivate'}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <div className="fixed inset-0 z-40 bg-slate-900/40 flex items-center justify-center p-4">
          <form onSubmit={saveModal} className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-5 space-y-3">
            <h3 className="text-base font-bold text-slate-900">
              {modal === 'create' ? 'Create user' : `Edit ${modal.user.name}`}
            </h3>
            <label className="block text-xs">
              <span className="font-semibold text-slate-600">Name</span>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-slate-600">Email</span>
              <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs">
                <span className="font-semibold text-slate-600">Role</span>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
                  {ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
                </select>
              </label>
              <label className="block text-xs">
                <span className="font-semibold text-slate-600">Department</span>
                <select value={form.department_id} onChange={(e) => setForm({ ...form, department_id: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
                  <option value="">— None —</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>{d.code} · {d.name}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block text-xs">
              <span className="font-semibold text-slate-600">Title</span>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-slate-600">Approval limit (USD)</span>
              <input type="number" min="0" step="0.01" value={form.approval_limit_dollars}
                onChange={(e) => setForm({ ...form, approval_limit_dollars: e.target.value })}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
              <span className="text-[10px] text-slate-400">Stored as integer cents.</span>
            </label>
            {modal === 'create' && (
              <label className="block text-xs">
                <span className="font-semibold text-slate-600">Password (optional)</span>
                <input type="password" minLength={8} value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
              </label>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setModal(null)} className="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200">
                Cancel
              </button>
              <button type="submit" disabled={saving} className="text-xs font-semibold px-3 py-2 rounded-lg bg-emerald-600 text-white disabled:bg-emerald-400">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}

      {passwordUser && (
        <div className="fixed inset-0 z-40 bg-slate-900/40 flex items-center justify-center p-4">
          <form onSubmit={savePassword} className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5 space-y-3">
            <h3 className="text-base font-bold text-slate-900">Set password for {passwordUser.name}</h3>
            <input
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
              autoComplete="new-password"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setPasswordUser(null)} className="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200">
                Cancel
              </button>
              <button type="submit" disabled={saving} className="text-xs font-semibold px-3 py-2 rounded-lg bg-emerald-600 text-white disabled:bg-emerald-400">
                {saving ? 'Saving…' : 'Set password'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
