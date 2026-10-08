import React, { useEffect, useState } from 'react';
import { KeyRound, Plus, RefreshCw, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { presentError, statusLabel, t } from '../i18n';

const SCOPES = ['vendors:write', 'catalog:write', 'export:read', 'invoices:write'];

const SCOPE_LABEL_KEYS = {
  'vendors:write': 'admin.integrations.scope.vendorsWrite',
  'catalog:write': 'admin.integrations.scope.catalogWrite',
  'export:read': 'admin.integrations.scope.exportRead',
  'invoices:write': 'admin.integrations.scope.invoicesWrite'
};

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
      setError(presentError(err, 'errors.integrations'));
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
      setError(presentError(err, 'errors.apiKeyCreate'));
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (row) => {
    if (!window.confirm(t('admin.integrations.confirmRevoke', { name: row.name, prefix: row.key_prefix }))) return;
    setError('');
    try {
      await api.revokeApiKey(row.id);
      await loadData();
    } catch (err) {
      setError(presentError(err, 'errors.apiKeyRevoke'));
    }
  };

  const replay = async (row) => {
    setError('');
    try {
      await api.replayWebhook(row.id);
      await loadData();
    } catch (err) {
      setError(presentError(err, 'errors.replay'));
    }
  };

  const deliverPending = async () => {
    setError('');
    try {
      await api.dispatchWebhooks();
      await loadData();
    } catch (err) {
      setError(presentError(err, 'errors.dispatch'));
    }
  };

  if (currentUser?.role !== 'admin') {
    return (
      <div className="bg-white p-8 rounded-xl border border-slate-200/80 shadow-sm text-center">
        <KeyRound className="w-8 h-8 text-slate-300 mx-auto mb-3" />
        <h2 className="text-lg font-bold text-slate-900">{t('admin.integrations.gatedTitle')}</h2>
        <p className="text-sm text-slate-500 mt-2 max-w-md mx-auto">
          {t('admin.integrations.gatedBody')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <h2 className="text-xl font-bold text-slate-900 tracking-tight">{t('admin.integrations.title')}</h2>
        <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">
          {t('admin.integrations.introBefore')}
          <span className="font-mono">Authorization: Bearer pfk_…</span>
          {t('admin.integrations.introMid')}{' '}
          <span className="font-mono">pf_session</span>
          {t('admin.integrations.introAfter')}
        </p>
        {config && (
          <p className="text-[11px] text-slate-600 mt-3">
            {t('admin.integrations.webhookTarget')}{' '}
            {config.webhook_target_configured
              ? t('admin.integrations.configuredHost', { host: config.webhook_target_host || t('admin.integrations.hostUnavailable') })
              : t('admin.integrations.notConfigured')}.{' '}
            {t('admin.integrations.signingSecret')}{' '}
            {config.webhook_signing_secret_configured ? t('admin.integrations.configured') : t('admin.integrations.notConfigured')}.{' '}
            {t('admin.integrations.setEnvBefore')}{' '}
            <span className="font-mono">WEBHOOK_TARGET_URL</span>{' '}
            {t('admin.integrations.setEnvMid')}{' '}
            <span className="font-mono">WEBHOOK_SIGNING_SECRET</span>{' '}
            {t('admin.integrations.setEnvAfter')}
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
          <div className="font-semibold">{t('admin.integrations.copyOnce')}</div>
          <code className="block mt-2 break-all font-mono text-[11px]">{revealedKey}</code>
          <button
            type="button"
            onClick={() => setRevealedKey(null)}
            className="mt-2 text-[11px] font-semibold underline"
          >
            {t('admin.integrations.stored')}
          </button>
        </div>
      )}

      <form onSubmit={createKey} className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm space-y-3">
        <h3 className="text-sm font-bold text-slate-900">{t('admin.integrations.newKey')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="block text-xs">
            <span className="font-semibold text-slate-600">{t('common.name')}</span>
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t('admin.integrations.namePlaceholder')}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-xs">
            <span className="font-semibold text-slate-600">{t('admin.integrations.perMinute')}</span>
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
            <span className="font-semibold text-slate-600">{t('admin.integrations.expiresOptional')}</span>
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
            <label key={scope} className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={form.scopes.includes(scope)}
                onChange={() => toggleScope(scope)}
              />
              <span className="font-mono">{scope}</span>
              <span className="text-slate-500">{t(SCOPE_LABEL_KEYS[scope])}</span>
            </label>
          ))}
        </div>
        <button
          type="submit"
          disabled={!canMutate || saving || form.scopes.length === 0}
          className="inline-flex items-center space-x-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white text-xs font-semibold px-3 py-2 rounded-lg"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{saving ? t('admin.integrations.creating') : t('admin.integrations.createKey')}</span>
        </button>
      </form>

      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-12 text-center text-slate-400 text-xs">{t('admin.integrations.loading')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px] font-bold">
                <tr>
                  <th className="px-4 py-3">{t('common.name')}</th>
                  <th className="px-4 py-3">{t('admin.integrations.prefix')}</th>
                  <th className="px-4 py-3">{t('admin.integrations.scopes')}</th>
                  <th className="px-4 py-3">{t('admin.integrations.limit')}</th>
                  <th className="px-4 py-3">{t('admin.integrations.lastUsed')}</th>
                  <th className="px-4 py-3">{t('common.status')}</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {keys.length === 0 && (
                  <tr>
                    <td colSpan="7" className="px-4 py-8 text-center text-slate-400">{t('admin.integrations.emptyKeys')}</td>
                  </tr>
                )}
                {keys.map((row) => (
                  <tr key={row.id} className={row.revoked_at ? 'bg-slate-50/80' : 'hover:bg-slate-50/80'}>
                    <td className="px-4 py-3.5 font-semibold text-slate-900">{row.name}</td>
                    <td className="px-4 py-3.5 font-mono text-[11px]">{row.key_prefix}…</td>
                    <td className="px-4 py-3.5 font-mono text-[11px]">{(row.scopes || []).join(', ')}</td>
                    <td className="px-4 py-3.5">{t('admin.integrations.rate', { n: row.rate_limit_per_minute })}</td>
                    <td className="px-4 py-3.5 text-slate-500">{row.last_used_at || '—'}</td>
                    <td className="px-4 py-3.5">
                      <span className={`font-bold px-2 py-0.5 rounded-full text-[10px] ${row.revoked_at ? 'bg-slate-200 text-slate-700' : 'bg-emerald-100 text-emerald-800'}`}>
                        {row.revoked_at ? t('admin.integrations.revoked') : statusLabel('active')}
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
                          {t('admin.integrations.revoke')}
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
          <h3 className="text-sm font-bold text-slate-900">{t('admin.integrations.outbox')}</h3>
          <div className="flex items-center gap-2">
            <select
              value={outboxStatus}
              onChange={(e) => {
                setOutboxStatus(e.target.value);
                loadData(e.target.value);
              }}
              className="border border-slate-300 rounded-lg px-2 py-1 text-xs"
            >
              <option value="all">{statusLabel('all')}</option>
              <option value="pending">{statusLabel('pending')}</option>
              <option value="delivered">{statusLabel('delivered')}</option>
              <option value="dead">{statusLabel('dead')}</option>
            </select>
            <button
              type="button"
              onClick={deliverPending}
              className="inline-flex items-center space-x-1 text-[11px] font-semibold px-2 py-1 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw className="w-3 h-3" />
              <span>{t('admin.integrations.deliverPending')}</span>
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px] font-bold">
              <tr>
                <th className="px-4 py-3">{t('admin.integrations.event')}</th>
                <th className="px-4 py-3">{t('common.status')}</th>
                <th className="px-4 py-3">{t('admin.integrations.attempts')}</th>
                <th className="px-4 py-3">{t('common.next')}</th>
                <th className="px-4 py-3">{t('admin.integrations.lastError')}</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {events.length === 0 && (
                <tr>
                  <td colSpan="6" className="px-4 py-8 text-center text-slate-400">{t('admin.integrations.emptyEvents')}</td>
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
                      {statusLabel(row.status)}
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
                      <span>{t('admin.integrations.replay')}</span>
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
