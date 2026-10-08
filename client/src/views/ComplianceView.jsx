import React, { useEffect, useState } from 'react';
import { Download, ScrollText, ShieldAlert } from 'lucide-react';
import { api } from '../api';
import { presentError, t } from '../i18n';

const REPORTS = [
  { id: 'audit-trail', labelKey: 'admin.compliance.auditTrail' },
  { id: 'approval-policy', labelKey: 'admin.compliance.approvalPolicy' },
  { id: 'payment-support', labelKey: 'admin.compliance.paymentSupport' },
  { id: 'verification', labelKey: 'admin.compliance.verification' }
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
      setError(presentError(err, 'errors.compliance'));
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
        <h2 className="text-lg font-bold text-slate-900">{t('admin.compliance.gatedTitle')}</h2>
        <p className="text-sm text-slate-500 mt-2 max-w-md mx-auto">
          {t('admin.compliance.gatedBody')}
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
      setError(presentError(err, 'errors.exportFailed'));
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
              {t('admin.compliance.title')}
            </h2>
            <p className="text-xs text-slate-500 mt-1 max-w-3xl">
              {t('admin.compliance.intro')}
            </p>
          </div>
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting || loading}
            className="inline-flex items-center space-x-1.5 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-xs font-semibold px-3 py-2 rounded-lg"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{exporting ? t('admin.compliance.exporting') : t('common.exportCsv')}</span>
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
              {t(item.labelKey)}
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
              {t('common.from')}
              <input
                type="date"
                value={filters.from}
                onChange={(event) => setFilters((prev) => ({ ...prev, from: event.target.value }))}
                className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-800"
              />
            </label>
            <label className="text-[11px] font-semibold text-slate-500">
              {t('common.to')}
              <input
                type="date"
                value={filters.to}
                onChange={(event) => setFilters((prev) => ({ ...prev, to: event.target.value }))}
                className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-800"
              />
            </label>
            <label className="text-[11px] font-semibold text-slate-500">
              {t('common.actor')}
              <input
                value={filters.actor}
                onChange={(event) => setFilters((prev) => ({ ...prev, actor: event.target.value }))}
                placeholder={t('admin.compliance.actorPlaceholder')}
                className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-800"
              />
            </label>
            <label className="text-[11px] font-semibold text-slate-500">
              {t('common.entity')}
              <input
                value={filters.entity_type}
                onChange={(event) => setFilters((prev) => ({ ...prev, entity_type: event.target.value }))}
                placeholder={t('admin.compliance.entityPlaceholder')}
                className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-800"
              />
            </label>
            <label className="text-[11px] font-semibold text-slate-500">
              {t('admin.compliance.entityId')}
              <input
                value={filters.entity_id}
                onChange={(event) => setFilters((prev) => ({ ...prev, entity_id: event.target.value }))}
                className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-800"
              />
            </label>
            <label className="text-[11px] font-semibold text-slate-500">
              {t('common.action')}
              <input
                value={filters.action}
                onChange={(event) => setFilters((prev) => ({ ...prev, action: event.target.value }))}
                placeholder={t('admin.compliance.actionPlaceholder')}
                className="mt-1 w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-800"
              />
            </label>
            <div className="md:col-span-6">
              <button
                type="submit"
                className="text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg"
              >
                {t('admin.compliance.apply')}
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
          <span>{loading ? t('common.loading') : t(rows.length === 1 ? 'admin.compliance.rowOne' : 'admin.compliance.rowMany', { count: rows.length })}</span>
          {summary && <span>{t(summary.count === 1 ? 'admin.compliance.findingOne' : 'admin.compliance.findingMany', { count: summary.count })}</span>}
          {report?.total != null && reportId === 'audit-trail' && (
            <span>{t(report.total === 1 ? 'admin.compliance.matchOne' : 'admin.compliance.matchMany', { count: report.total })}</span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                {reportId === 'audit-trail' ? (
                  <>
                    <th className="text-left font-semibold px-4 py-2">{t('common.when')}</th>
                    <th className="text-left font-semibold px-4 py-2">{t('common.source')}</th>
                    <th className="text-left font-semibold px-4 py-2">{t('common.action')}</th>
                    <th className="text-left font-semibold px-4 py-2">{t('common.actor')}</th>
                    <th className="text-left font-semibold px-4 py-2">{t('common.entity')}</th>
                    <th className="text-left font-semibold px-4 py-2">{t('common.details')}</th>
                  </>
                ) : (
                  <>
                    <th className="text-left font-semibold px-4 py-2">{t('common.code')}</th>
                    <th className="text-left font-semibold px-4 py-2">{t('common.document')}</th>
                    <th className="text-left font-semibold px-4 py-2">{t('common.message')}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                    {t('admin.compliance.empty')}
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
