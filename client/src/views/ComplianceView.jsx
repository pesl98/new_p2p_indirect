import React, { useEffect, useState } from 'react';
import { Download, ScrollText, ShieldAlert } from 'lucide-react';
import { api } from '../api';

const REPORTS = [
  { id: 'audit-trail', label: 'Audit trail' },
  { id: 'approval-policy', label: 'Approval & segregation' },
  { id: 'payment-support', label: 'Paid without support' },
  { id: 'verification', label: 'Verification' }
];

const EMPTY_FILTERS = {
  from: '',
  to: '',
  actor: '',
  entity_type: '',
  entity_id: '',
  action: ''
};

function canRead(role) {
  return role === 'admin' || role === 'finance';
}

export default function ComplianceView({ currentUser }) {
  const [reportId, setReportId] = useState('audit-trail');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);

  const load = async (nextReport, nextFilters) => {
    setLoading(true);
    setError('');
    try {
      const params = nextReport === 'audit-trail' ? nextFilters : {};
      const data = await api.getComplianceReport(nextReport, params);
      setReport(data);
    } catch (err) {
      setReport(null);
      setError(err.message || 'Failed to load the report');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!canRead(currentUser?.role)) return;
    load(reportId, applied);
  }, [currentUser?.role, reportId, applied]);

  if (!canRead(currentUser?.role)) {
    return (
      <div className="bg-white p-8 rounded-xl border border-slate-200/80 shadow-sm text-center">
        <ShieldAlert className="w-8 h-8 text-slate-300 mx-auto mb-3" />
        <h2 className="text-lg font-bold text-slate-900">Audit & compliance</h2>
        <p className="text-sm text-slate-500 mt-2 max-w-md mx-auto">
          Admin and finance can read these reports. Other roles are refused.
        </p>
      </div>
    );
  }

  const rows = reportId === 'audit-trail' ? (report?.rows || []) : (report?.findings || []);
  const summary = report?.summary;

  const exportCsv = async () => {
    setExporting(true);
    setError('');
    try {
      await api.exportComplianceCsv(reportId, reportId === 'audit-trail' ? applied : {});
    } catch (err) {
      setError(err.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
              <ScrollText className="w-5 h-5 text-emerald-700" />
              Audit & compliance
            </h2>
            <p className="text-xs text-slate-500 mt-1 max-w-3xl">
              Read-only reports for admin and finance. The audit trail joins procurement
              events, SSO evidence, and the hash-chained auth ledger. CSV export is itself
              written to that ledger. Filters do not accept a persona id.
            </p>
          </div>
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting || loading}
            className="inline-flex items-center space-x-1.5 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-xs font-semibold px-3 py-2 rounded-lg"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{exporting ? 'Exporting…' : 'Export CSV'}</span>
          </button>
        </div>

        <div className="flex flex-wrap gap-2 mt-4">
          {REPORTS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setReportId(item.id)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border ${
                reportId === item.id
                  ? 'bg-emerald-600 text-white border-emerald-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {reportId === 'audit-trail' && (
          <form
            className="grid grid-cols-2 md:grid-cols-6 gap-3 mt-4"
            onSubmit={(event) => {
              event.preventDefault();
              setApplied({ ...filters });
            }}
          >
            <label className="text-[11px] font-semibold text-slate-500">
              From
              <input
                type="date"
                value={filters.from}
                onChange={(event) => setFilters((prev) => ({ ...prev, from: event.target.value }))}
                className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-800"
              />
            </label>
            <label className="text-[11px] font-semibold text-slate-500">
              To
              <input
                type="date"
                value={filters.to}
                onChange={(event) => setFilters((prev) => ({ ...prev, to: event.target.value }))}
                className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-800"
              />
            </label>
            <label className="text-[11px] font-semibold text-slate-500">
              Actor
              <input
                value={filters.actor}
                onChange={(event) => setFilters((prev) => ({ ...prev, actor: event.target.value }))}
                placeholder="Name or user id"
                className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-800"
              />
            </label>
            <label className="text-[11px] font-semibold text-slate-500">
              Entity
              <input
                value={filters.entity_type}
                onChange={(event) => setFilters((prev) => ({ ...prev, entity_type: event.target.value }))}
                placeholder="invoice"
                className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-800"
              />
            </label>
            <label className="text-[11px] font-semibold text-slate-500">
              Entity id
              <input
                value={filters.entity_id}
                onChange={(event) => setFilters((prev) => ({ ...prev, entity_id: event.target.value }))}
                className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-800"
              />
            </label>
            <label className="text-[11px] font-semibold text-slate-500">
              Action
              <input
                value={filters.action}
                onChange={(event) => setFilters((prev) => ({ ...prev, action: event.target.value }))}
                placeholder="PAID"
                className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-800"
              />
            </label>
            <div className="md:col-span-6">
              <button
                type="submit"
                className="text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg"
              >
                Apply filters
              </button>
            </div>
          </form>
        )}
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 text-sm rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 text-xs text-slate-500 flex justify-between">
          <span>{loading ? 'Loading…' : `${rows.length} row${rows.length === 1 ? '' : 's'}`}</span>
          {summary && <span>{summary.count} finding{summary.count === 1 ? '' : 's'}</span>}
          {report?.total != null && reportId === 'audit-trail' && (
            <span>{report.total} matching</span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                {reportId === 'audit-trail' ? (
                  <>
                    <th className="text-left font-semibold px-4 py-2">When</th>
                    <th className="text-left font-semibold px-4 py-2">Source</th>
                    <th className="text-left font-semibold px-4 py-2">Action</th>
                    <th className="text-left font-semibold px-4 py-2">Actor</th>
                    <th className="text-left font-semibold px-4 py-2">Entity</th>
                    <th className="text-left font-semibold px-4 py-2">Details</th>
                  </>
                ) : (
                  <>
                    <th className="text-left font-semibold px-4 py-2">Code</th>
                    <th className="text-left font-semibold px-4 py-2">Document</th>
                    <th className="text-left font-semibold px-4 py-2">Message</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                    Nothing to show for this report.
                  </td>
                </tr>
              )}
              {reportId === 'audit-trail' && rows.map((row) => (
                <tr key={`${row.source}-${row.source_id}`} className="border-t border-slate-100">
                  <td className="px-4 py-2 whitespace-nowrap text-slate-600">{row.created_at}</td>
                  <td className="px-4 py-2 text-slate-600">{row.source}</td>
                  <td className="px-4 py-2 font-semibold text-slate-800">{row.action}</td>
                  <td className="px-4 py-2 text-slate-700">
                    {row.actor_name}
                    {row.actor_user_id != null ? ` (#${row.actor_user_id})` : ''}
                  </td>
                  <td className="px-4 py-2 text-slate-600">
                    {row.entity_type}{row.entity_id != null ? ` ${row.entity_id}` : ''}
                  </td>
                  <td className="px-4 py-2 text-slate-500 max-w-md truncate">{row.details}</td>
                </tr>
              ))}
              {reportId !== 'audit-trail' && rows.map((row, index) => (
                <tr key={`${row.code}-${row.entity_id || row.invoice_id || index}`} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-semibold text-rose-700 whitespace-nowrap">{row.code}</td>
                  <td className="px-4 py-2 text-slate-700 whitespace-nowrap">
                    {row.document_number || row.invoice_number || row.po_number || row.entity_type}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{row.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
