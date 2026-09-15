import React, { useState } from 'react';
import { Lock, ShieldCheck, UserPlus } from 'lucide-react';
import { api } from '../api';

export default function LoginView({ bootstrapNeeded, onAuthenticated, error: externalError }) {
  const [mode, setMode] = useState(bootstrapNeeded ? 'bootstrap' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(externalError || '');

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
      setError(err.message || 'Sign-in failed');
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
            <p className="text-xs text-slate-500">Indirect P2P · tenant sign-in</p>
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
              {mode === 'bootstrap' ? 'Create the first admin' : 'Sign in'}
            </h2>
          </div>
          <p className="text-xs text-slate-500 mb-5">
            {mode === 'bootstrap'
              ? 'This tenant database has no users yet. Create an admin account. Auth is local to this customer DB — not SSO.'
              : 'Use the email and password stored in this customer database. Session cookie is httpOnly.'}
          </p>

          {error && (
            <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl px-3 py-2">
              {error}
            </div>
          )}

          <form onSubmit={submit} className="space-y-3">
            {mode === 'bootstrap' && (
              <label className="block">
                <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">Name</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  placeholder="Ada Admin"
                  autoComplete="name"
                />
              </label>
            )}
            <label className="block">
              <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                placeholder="admin@customer.com"
                autoComplete="username"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">Password</span>
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
                ? 'Please wait…'
                : mode === 'bootstrap'
                  ? 'Create admin and sign in'
                  : 'Sign in'}
            </button>
          </form>

          <div className="mt-5 flex items-start space-x-2 text-[11px] text-slate-400">
            <ShieldCheck className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <p>
              Passwords are stored hashed (bcrypt) in <span className="font-mono">user_credentials</span>.
              Local demo seed password is documented in the README only.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
