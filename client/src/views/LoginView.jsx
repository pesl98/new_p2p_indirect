import React, { useState } from 'react';
import { Lock, ShieldCheck, UserPlus } from 'lucide-react';
import { api } from '../api';
import { t, presentError } from '../i18n';

export default function LoginView({
  bootstrapNeeded,
  onAuthenticated,
  error: externalError,
  identityProvider = 'local',
  ssoReady = false,
  localLogin = true,
  ssoError = ''
}) {
  const [mode, setMode] = useState(bootstrapNeeded ? 'bootstrap' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(
    externalError
      ? presentError(externalError, 'errors.signInFailed')
      : ssoError
        ? presentError(ssoError, 'code.sso_failed')
        : ''
  );
  const showSso = ssoReady && (identityProvider === 'oidc' || identityProvider === 'saml');
  const showPassword = localLogin || bootstrapNeeded;

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const result = mode === 'bootstrap'
        ? await api.bootstrapAdmin({ name: name || 'Administrator', email, password })
        : await api.login(email, password);
      onAuthenticated(result.user);
    } catch (err) {
      setError(presentError(err, 'errors.signInFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center text-white shadow-md shadow-emerald-500/20">
            <span className="text-xl font-black tracking-tight">PF</span>
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900 tracking-tight">ProcureFlow</h1>
            <p className="text-xs text-slate-500">{t('shell.loginSubtitle')}</p>
          </div>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6">
          <div className="flex items-center space-x-2 mb-1">
            {mode === 'bootstrap' ? (
              <UserPlus className="w-5 h-5 text-emerald-600" />
            ) : (
              <Lock className="w-5 h-5 text-emerald-600" />
            )}
            <h2 className="text-lg font-bold text-slate-900">
              {mode === 'bootstrap' ? t('shell.createFirstAdmin') : t('common.signIn')}
            </h2>
          </div>
          <p className="text-xs text-slate-500 mb-5">
            {mode === 'bootstrap'
              ? t('shell.bootstrapHelp')
              : showSso
                ? t('shell.ssoHelp')
                : t('shell.passwordHelp')}
          </p>

          {error && (
            <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl px-3 py-2">
              {error}
            </div>
          )}

          {showSso && (
            <a
              href={identityProvider === 'saml' ? '/api/auth/saml/start' : '/api/auth/oidc/start'}
              className="mb-4 flex w-full items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-100"
            >
              {identityProvider === 'saml' ? t('shell.signInSaml') : t('shell.signInOidc')}
            </a>
          )}

          {showPassword ? (
          <form onSubmit={submit} className="space-y-3">
            {mode === 'bootstrap' && (
              <label className="block">
                <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">{t('common.name')}</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  placeholder={t('shell.namePlaceholder')}
                  autoComplete="name"
                />
              </label>
            )}
            <label className="block">
              <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">{t('common.email')}</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                placeholder={t('shell.emailPlaceholder')}
                autoComplete="username"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">{t('common.password')}</span>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                autoComplete={mode === 'bootstrap' ? 'new-password' : 'current-password'}
              />
            </label>
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white text-sm font-semibold rounded-lg py-2.5 transition-colors"
            >
              {submitting
                ? t('common.pleaseWait')
                : mode === 'bootstrap'
                  ? t('shell.createAdminSignIn')
                  : t('common.signIn')}
            </button>
          </form>
          ) : (
            !showSso && (
              <p className="text-sm text-slate-600">{t('shell.signInNotConfigured')}</p>
            )
          )}

          <div className="mt-5 flex items-start space-x-2 text-[11px] text-slate-400">
            <ShieldCheck className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <p>
              {t('shell.passwordHashedBefore')}<span className="font-mono">user_credentials</span>{t('shell.passwordHashedAfter')}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
