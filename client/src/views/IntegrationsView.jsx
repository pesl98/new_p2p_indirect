import React, { useEffect, useState } from 'react';
import { KeyRound, Plus, RefreshCw, RotateCcw } from 'lucide-react';
import { api } from '../api';

const SCOPES = [
  { id: 'vendors:write', label: 'Vendors write' },
  { id: 'catalog:write', label: 'Catalog write' },
  { id: 'export:read', label: 'Export read' }
];

function emptyForm() {
  return {
    name: '',
    scopes: ['vendors:write'],
    expires_at: '',
    rate_limit_per_minute: '60'
  };
}

function statusPill(status) {
  if (status === 'delivered') return 'bg-emerald-100 text-emerald-800';
  if (status === 'dead') return 'bg-rose-100 text-rose-800';
  return 'bg-amber-100 text-amber-800';
}

export default function IntegrationsView({ currentUser, sessionUser }) {
  const [keys, setKeys] = useState([]);
  const [events, setEvents] = useState([]);
  const [config, setConfig] = useState(null);
  const [outboxStatus, setOutboxStatus] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [revealedKey, setRevealedKey] = useState(null);

  const canMutate = sessionUser?.role === 'admin';

  const loadData = async (status = outboxStatus) => {
    setLoading(true);
    setError('');
    try {
      const [keyList, outbox, settings] = await Promise.all([
        api.getApiKeys(),
        api.getWebhookOutbox(status),
        api.getIntegrationConfig()
      ]);
      setKeys(Array.isArray(keyList) ? keyList : []);
      setEvents(Array.isArray(outbox?.events) ? outbox.events : []);
      setConfig(settings);
    } catch (err) {
      setError(err.message || 'Failed to load integrations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (currentUser?.role === 'admin') loadData('all');
  }, [currentUser?.role]);

  const toggleScope = (scope) => {
    setForm((current) => {
      const has = current.scopes.includes(scope);
      const scopes = has ? current.scopes.filter((item) => item !== scope) : [...current.scopes, scope];
      return { ...current, scopes };
    });
  };

  const createKey = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const created = await api.createApiKey({
        name: form.name,
        scopes: form.scopes,
        expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
        rate_limit_per_minute: Number(form.rate_limit_per_minute)
      });
      setRevealedKey(created.key);
      setForm(emptyForm());
      await loadData();
    } catch (err) {
      setError(err.message || 'Failed to create API key');
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (row) => {
    if (!window.confirm(`Revoke ${row.name} (${row.key_prefix}…)? Callers using it will get 401.`)) return;
    setError('');
    try {
      await api.revokeApiKey(row.id);
      await loadData();
    } catch (err) {
      setError(err.message || 'Failed to revoke API key');
    }
  };

  const replay = async (row) => {
    setError('');
    try {
      await api.replayWebhook(row.id);
      await loadData();
    } catch (err) {
      setError(err.message || 'Failed to replay webhook');
    }
  };

  const deliverPending = async () => {
    setError('');
    try {
      await api.dispatchWebhooks();
      await loadData();
    } catch (err) {
      setError(err.message || 'Failed to deliver webhooks');
    }
  };

  if (currentUser?.role !== 'admin') {
    return (
      <div className="bg-white p-8 rounded-xl border border-slate-200/80 shadow-sm text-center">
        <KeyRound className="w-8 h-8 text-slate-300 mx-auto mb-3" />
        <h2 className="text-lg font-bold text-slate-900">Integrations</h2>
        <p className="text-sm text-slate-500 mt-2 max-w-md mx-auto">
          Only an admin can issue API keys and inspect the webhook outbox.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <h2 className="text-xl font-bold text-slate-900 tracking-tight">Integrations</h2>
        <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">
          Machine clients use a scoped API key (<span className="font-mono">Authorization: Bearer pfk_…</span>).
          The plaintext is shown once and only a hash is stored. The key is the actor. It does not sign in as a user,
          and a <span className="font-mono">pf_session</span> cookie does not call the vendor, catalog, or export routes.
        </p>
        {config && (
          <p className="text-[11px] text-slate-600 mt-3">
            Webhook target {config.webhook_target_configured ? `configured (${config.webhook_target_host || 'host unavailable'})` : 'not configured'}.
            Signing secret {config.webhook_signing_secret_configured ? 'configured' : 'not configured'}.
            Set <span className="font-mono">WEBHOOK_TARGET_URL</span> and <span className="font-mono">WEBHOOK_SIGNING_SECRET</span> on this deployment. The secret is never returned.
          </p>
        )}
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      {revealedKey && (
        <div className="bg-amber-50 border border-amber-200 text-amber-950 text-xs rounded-xl px-4 py-3">
          <div className="font-semibold">Copy this API key now. It will not be shown again.</div>
          <code className="block mt-2 break-all font-mono text-[11px]">{revealedKey}</code>
          <button
            type="button"
            onClick={() => setRevealedKey(null)}
            className="mt-2 text-[11px] font-semibold underline"
          >
            I have stored it
          </button>
        </div>
      )}

      <form onSubmit={createKey} className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm space-y-3">
        <h3 className="text-sm font-bold text-slate-900">New API key</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="block text-xs">
            <span className="font-semibold text-slate-600">Name</span>
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="SAP vendor sync"
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-slate-600">Requests per minute</span>
            <input
              required
              type="number"
              min="1"
              max="6000"
              value={form.rate_limit_per_minute}
              onChange={(e) => setForm({ ...form, rate_limit_per_minute: e.target.value })}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-slate-600">Expires (optional)</span>
            <input
              type="datetime-local"
              value={form.expires_at}
              onChange={(e) => setForm({ ...form, expires_at: e.target.value })}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-3 text-xs">
          {SCOPES.map((scope) => (
            <label key={scope.id} className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={form.scopes.includes(scope.id)}
                onChange={() => toggleScope(scope.id)}
              />
              <span className="font-mono">{scope.id}</span>
            </label>
          ))}
        </div>
        <button
          type="submit"
          disabled={!canMutate || saving || form.scopes.length === 0}
          className="inline-flex items-center space-x-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white text-xs font-semibold px-3 py-2 rounded-lg"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{saving ? 'Creating…' : 'Create key'}</span>
        </button>
      </form>

      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-12 text-center text-slate-400 text-xs">Loading integrations…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px] font-bold">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Prefix</th>
                  <th className="px-4 py-3">Scopes</th>
                  <th className="px-4 py-3">Limit</th>
                  <th className="px-4 py-3">Last used</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {keys.length === 0 && (
                  <tr>
                    <td colSpan="7" className="px-4 py-8 text-center text-slate-400">No API keys yet.</td>
                  </tr>
                )}
                {keys.map((row) => (
                  <tr key={row.id} className={row.revoked_at ? 'bg-slate-50/80' : 'hover:bg-slate-50/80'}>
                    <td className="px-4 py-3.5 font-semibold text-slate-900">{row.name}</td>
                    <td className="px-4 py-3.5 font-mono text-[11px]">{row.key_prefix}…</td>
                    <td className="px-4 py-3.5 font-mono text-[11px]">{(row.scopes || []).join(', ')}</td>
                    <td className="px-4 py-3.5">{row.rate_limit_per_minute}/min</td>
                    <td className="px-4 py-3.5 text-slate-500">{row.last_used_at || '—'}</td>
                    <td className="px-4 py-3.5">
                      <span className={`font-bold px-2 py-0.5 rounded-full text-[10px] ${row.revoked_at ? 'bg-slate-200 text-slate-700' : 'bg-emerald-100 text-emerald-800'}`}>
                        {row.revoked_at ? 'Revoked' : 'Active'}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      {!row.revoked_at && (
                        <button
                          type="button"
                          disabled={!canMutate}
                          onClick={() => revoke(row)}
                          className="text-[11px] font-semibold px-2 py-1 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="px-4 py-3 flex items-center justify-between gap-3 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-900">Webhook outbox</h3>
          <div className="flex items-center gap-2">
            <select
              value={outboxStatus}
              onChange={(e) => {
                setOutboxStatus(e.target.value);
                loadData(e.target.value);
              }}
              className="border border-slate-300 rounded-lg px-2 py-1 text-xs"
            >
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="delivered">Delivered</option>
              <option value="dead">Dead letter</option>
            </select>
            <button
              type="button"
              onClick={deliverPending}
              className="inline-flex items-center space-x-1 text-[11px] font-semibold px-2 py-1 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Deliver pending</span>
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px] font-bold">
              <tr>
                <th className="px-4 py-3">Event</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Attempts</th>
                <th className="px-4 py-3">Next</th>
                <th className="px-4 py-3">Last error</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {events.length === 0 && (
                <tr>
                  <td colSpan="6" className="px-4 py-8 text-center text-slate-400">No webhook events.</td>
                </tr>
              )}
              {events.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3.5">
                    <div className="font-mono text-[11px]">{row.event_type}</div>
                    <div className="text-[10px] text-slate-400">{row.event_id}</div>
                  </td>
                  <td className="px-4 py-3.5">
                    <span className={`font-bold px-2 py-0.5 rounded-full text-[10px] ${statusPill(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3.5">{row.attempt_count}</td>
                  <td className="px-4 py-3.5 text-slate-500">{row.status === 'pending' ? row.next_attempt_at : '—'}</td>
                  <td className="px-4 py-3.5 text-slate-500 max-w-xs truncate">{row.last_error || '—'}</td>
                  <td className="px-4 py-3.5 text-right">
                    <button
                      type="button"
                      onClick={() => replay(row)}
                      className="inline-flex items-center space-x-1 text-[11px] font-semibold px-2 py-1 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Replay</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
