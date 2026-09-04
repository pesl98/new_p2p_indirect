import React from 'react';
import { ShieldCheck, UserCheck, RefreshCw, Building2, Wallet } from 'lucide-react';
import { formatMoney } from '../money';

export default function Header({ users, currentUser, onSelectUser, onRefreshData }) {
  const getRoleBadge = (role) => {
    switch (role) {
      case 'requester':
        return <span className="bg-sky-100 text-sky-800 text-xs px-2.5 py-0.5 rounded-full font-medium border border-sky-200">Requester</span>;
      case 'approver':
        return <span className="bg-amber-100 text-amber-800 text-xs px-2.5 py-0.5 rounded-full font-medium border border-amber-200">Approver / Dept Head</span>;
      case 'procurement':
        return <span className="bg-indigo-100 text-indigo-800 text-xs px-2.5 py-0.5 rounded-full font-medium border border-indigo-200">Procurement Officer</span>;
      case 'finance':
        return <span className="bg-emerald-100 text-emerald-800 text-xs px-2.5 py-0.5 rounded-full font-medium border border-emerald-200">Finance & AP Lead</span>;
      case 'admin':
        return <span className="bg-purple-100 text-purple-800 text-xs px-2.5 py-0.5 rounded-full font-medium border border-purple-200">Executive / CFO</span>;
      default:
        return <span className="bg-slate-100 text-slate-800 text-xs px-2.5 py-0.5 rounded-full font-medium">User</span>;
    }
  };

  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Brand Logo & Name */}
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center text-white shadow-md shadow-emerald-500/20">
              <span className="text-xl font-black tracking-tight">PF</span>
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h1 className="text-lg font-bold text-slate-900 tracking-tight">ProcureFlow</h1>
                <span className="bg-slate-100 text-slate-600 text-[10px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded border border-slate-200">
                  Indirect P2P
                </span>
              </div>
              <p className="text-xs text-slate-500 hidden sm:block">
                Non-Production Procurement & 3-Way Match System
              </p>
            </div>
          </div>

          {/* Persona Switcher & Controls */}
          <div className="flex items-center space-x-4">
            <button
              onClick={onRefreshData}
              title="Refresh live data"
              className="p-2 text-slate-500 hover:text-emerald-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>

            {/* Active User / Persona Bar */}
            <div className="flex items-center bg-slate-50 border border-slate-200/80 rounded-xl p-1.5 pl-3 space-x-3 shadow-inner">
              <div className="text-right hidden md:block">
                <div className="text-xs font-semibold text-slate-900 flex items-center justify-end space-x-1">
                  <span>{currentUser?.name || 'Loading...'}</span>
                </div>
                <div className="text-[11px] text-slate-500 flex items-center justify-end space-x-1.5 mt-0.5">
                  <Building2 className="w-3 h-3 text-slate-400" />
                  <span>{currentUser?.department_name || 'Department'}</span>
                  {currentUser?.approval_limit > 0 && (
                    <>
                      <span className="text-slate-300">•</span>
                      <span className="text-emerald-700 font-medium">
                        Limit: ${formatMoney(currentUser.approval_limit)}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Persona Selector Dropdown */}
              <div className="relative">
                <select
                  value={currentUser?.id || ''}
                  onChange={(e) => {
                    const selected = users.find(u => u.id === Number(e.target.value));
                    if (selected) onSelectUser(selected);
                  }}
                  className="bg-white text-xs font-medium text-slate-800 border border-slate-300 rounded-lg py-1.5 px-2.5 pr-7 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 cursor-pointer shadow-sm"
                >
                  {users.map(u => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.role.toUpperCase()}) - {u.department_code}
                    </option>
                  ))}
                </select>
              </div>

              {currentUser && (
                <div className="hidden sm:block">
                  {getRoleBadge(currentUser.role)}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
