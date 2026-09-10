import React, { useEffect, useState } from 'react';
import {
  Search,
  GitBranch,
  FileText,
  CheckSquare,
  ShoppingCart,
  PackageCheck,
  ClipboardCheck,
  FileSpreadsheet,
  CreditCard,
  ExternalLink,
  Clock,
  AlertCircle
} from 'lucide-react';
import { api } from '../api';
import { formatMoney } from '../money';

const STAGE_ICONS = {
  requisition: FileText,
  approvals: CheckSquare,
  purchase_orders: ShoppingCart,
  receiving: PackageCheck,
  invoice: FileSpreadsheet,
  ap: CreditCard
};

function formatWhen(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function humanize(value) {
  if (!value) return '—';
  return String(value).replace(/_/g, ' ');
}

function statusTone(status) {
  switch (status) {
    case 'complete':
    case 'approved':
    case 'converted_to_po':
    case 'received':
    case 'accepted':
    case 'paid':
    case 'perfect_match':
    case 'matched':
      return 'bg-emerald-100 text-emerald-800';
    case 'current':
    case 'pending':
    case 'pending_approval':
    case 'submitted':
    case 'approved_for_payment':
    case 'tolerated_match':
    case 'issued':
    case 'partially_received':
      return 'bg-amber-100 text-amber-800';
    case 'not_started':
    case 'waiting':
    case 'draft':
    case 'not_applicable':
      return 'bg-slate-100 text-slate-600';
    case 'rejected':
    case 'variance_flagged':
    case 'quantity_variance':
    case 'price_variance':
    case 'total_variance':
      return 'bg-rose-100 text-rose-800';
    default:
      return 'bg-slate-100 text-slate-700';
  }
}

function StatusPill({ status, label }) {
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full capitalize ${statusTone(status)}`}>
      {label || humanize(status)}
    </span>
  );
}

function eventIcon(kind) {
  switch (kind) {
    case 'requisition':
      return FileText;
    case 'approval':
      return CheckSquare;
    case 'purchase_order':
      return ShoppingCart;
    case 'goods_receipt':
      return PackageCheck;
    case 'service_entry_sheet':
      return ClipboardCheck;
    case 'invoice':
      return FileSpreadsheet;
    case 'exception':
      return FileSpreadsheet;
    case 'ap_event':
      return CreditCard;
    default:
      return Clock;
  }
}

export default function DocumentTrailView({ onNavigate, lookupQ }) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState({ requisitions: [], purchase_orders: [], invoices: [] });
  const [trail, setTrail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadSuggestions = async (term = '') => {
    try {
      const result = await api.searchDocumentTrail(term);
      setSuggestions(result);
    } catch (err) {
      console.error(err);
    }
  };

  const loadTrail = async (params) => {
    setLoading(true);
    setError('');
    try {
      const result = await api.getDocumentTrail(params);
      setTrail(result);
      if (result.requisition?.pr_number) {
        setQuery(result.requisition.pr_number);
      } else if (result.starting_point?.number) {
        setQuery(result.starting_point.number);
      }
    } catch (err) {
      setTrail(null);
      setError(err.message || 'Document trail not found');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSuggestions('');
    loadTrail({ q: lookupQ || 'PR-2026-001' });
  }, [lookupQ]);

  const handleSearch = (event) => {
    event.preventDefault();
    const term = query.trim();
    if (!term) {
      setError('Enter a PR number, PO number, or invoice number.');
      return;
    }
    loadTrail({ q: term });
  };

  const openTab = (tab, id) => {
    if (!tab) return;
    onNavigate?.(tab, id ? { focusId: id } : null);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">P2P Document Trail</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            One chronological chain for a buying journey: PR → approvals → PO(s) → GRN / SES → invoice → AP.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {['PR-2026-001', 'PR-2026-005', 'PR-2026-006'].map((number) => (
            <button
              key={number}
              type="button"
              onClick={() => loadTrail({ q: number })}
              className="text-[11px] font-semibold px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              {number}
            </button>
          ))}
        </div>
      </div>

      <form onSubmit={handleSearch} className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm space-y-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                loadSuggestions(e.target.value);
              }}
              placeholder="Search PR-2026-001, PO-2026-001, or INV-WED-9042"
              className="w-full pl-9 pr-3 py-2.5 text-sm rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
            />
          </div>
          <button
            type="submit"
            className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-sm"
          >
            Open trail
          </button>
        </div>
        {(suggestions.requisitions.length > 0 || suggestions.purchase_orders.length > 0) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Requisitions</div>
              <div className="space-y-1">
                {suggestions.requisitions.slice(0, 5).map((pr) => (
                  <button
                    key={`pr-${pr.id}`}
                    type="button"
                    onClick={() => loadTrail({ requisition_id: pr.id })}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 border border-transparent hover:border-slate-200 flex items-center justify-between"
                  >
                    <span className="font-mono font-bold text-slate-800">{pr.pr_number}</span>
                    <span className="text-slate-500">{pr.requester_name} · ${formatMoney(pr.total_amount)}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Purchase orders</div>
              <div className="space-y-1">
                {suggestions.purchase_orders.slice(0, 5).map((po) => (
                  <button
                    key={`po-${po.id}`}
                    type="button"
                    onClick={() => loadTrail({ po_id: po.id })}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 border border-transparent hover:border-slate-200 flex items-center justify-between"
                  >
                    <span className="font-mono font-bold text-slate-800">{po.po_number}</span>
                    <span className="text-slate-500">{po.supplier_name} · ${formatMoney(po.total_amount)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </form>

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-800 text-sm rounded-xl px-4 py-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {loading && !trail && (
        <div className="text-center text-slate-400 py-12 text-sm">Loading document trail...</div>
      )}

      {trail && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-5">
            <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600 mb-1">
                  Starting {humanize(trail.starting_point.type)}
                </div>
                <h3 className="text-lg font-bold text-slate-900 font-mono">
                  {trail.requisition?.pr_number || trail.starting_point.number}
                </h3>
                <p className="text-xs text-slate-500 mt-1 max-w-2xl">
                  {trail.requisition?.justification || 'Purchase order without a linked requisition.'}
                </p>
              </div>
              <div className="text-right">
                {trail.requisition && (
                  <>
                    <div className="text-xl font-extrabold text-slate-900">${formatMoney(trail.requisition.total_amount)}</div>
                    <div className="text-[11px] text-slate-500">
                      {trail.requisition.requester_name} · {trail.requisition.department_name}
                    </div>
                    <div className="mt-2"><StatusPill status={trail.requisition.status} /></div>
                  </>
                )}
                {trail.split && (
                  <div className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-700 bg-indigo-50 px-2 py-1 rounded-full">
                    <GitBranch className="w-3 h-3" />
                    Multi-supplier split
                  </div>
                )}
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              {trail.stages.map((stage) => {
                const Icon = STAGE_ICONS[stage.key] || Clock;
                return (
                  <div
                    key={stage.key}
                    className={`rounded-lg border px-3 py-2 ${
                      stage.status === 'not_started' || stage.status === 'not_applicable'
                        ? 'border-dashed border-slate-200 bg-slate-50/70'
                        : 'border-slate-200 bg-white'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
                      <Icon className="w-3.5 h-3.5" />
                      {stage.label}
                    </div>
                    <div className="mt-1.5">
                      <StatusPill
                        status={stage.status}
                        label={stage.status === 'not_started' ? 'Not started' : humanize(stage.status)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {trail.purchase_orders.length > 1 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {trail.purchase_orders.map((po) => (
                <div key={po.id} className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="font-mono font-bold text-slate-900">{po.po_number}</div>
                      <div className="text-xs text-slate-500">{po.supplier_name}</div>
                    </div>
                    <StatusPill status={po.status} />
                  </div>
                  <div className="mt-3 text-xs text-slate-600 space-y-1">
                    <div>Amount: <span className="font-semibold">${formatMoney(po.total_amount)}</span></div>
                    <div>GRN: {po.goods_receipts[0]?.grn_number || <span className="text-slate-400">not started</span>}</div>
                    <div>SES: {po.service_entry_sheets[0]?.ses_number || <span className="text-slate-400">not started</span>}</div>
                    <div>
                      Invoice: {po.invoices[0]?.invoice_number || <span className="text-slate-400">not started</span>}
                      {po.invoices[0] && (
                        <span className="ml-1 text-slate-400">({humanize(po.invoices[0].match_status)})</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => openTab('purchase_orders', po.id)}
                    className="mt-3 text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 inline-flex items-center gap-1"
                  >
                    Open PO <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-5">
            <h4 className="text-sm font-bold text-slate-900 mb-4">Chronological chain</h4>
            {trail.timeline.length === 0 ? (
              <div className="text-sm text-slate-400">No documents on this trail yet.</div>
            ) : (
              <ol className="relative border-l border-slate-200 ml-3 space-y-4">
                {trail.timeline.map((event) => {
                  const Icon = eventIcon(event.kind);
                  return (
                    <li key={event.id} className="ml-5">
                      <span className="absolute -left-3.5 flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-white">
                        <Icon className="w-3.5 h-3.5" />
                      </span>
                      <div className="bg-slate-50 rounded-xl border border-slate-200/80 p-3">
                        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono font-bold text-slate-900 text-sm">{event.number}</span>
                              <StatusPill status={event.status} />
                              {event.match_status && <StatusPill status={event.match_status} />}
                              {event.po_number && event.kind !== 'purchase_order' && (
                                <span className="text-[10px] font-semibold text-slate-500">{event.po_number}</span>
                              )}
                            </div>
                            <div className="text-xs font-semibold text-slate-700 mt-1">{event.title}</div>
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              {formatWhen(event.at)}
                              {event.actor_name ? ` · ${event.actor_name}` : ''}
                              {event.supplier_name ? ` · ${event.supplier_name}` : ''}
                            </div>
                            {event.details && (
                              <p className="text-[11px] text-slate-500 mt-1">{event.details}</p>
                            )}
                            {event.amount_cents != null && (
                              <div className="text-xs font-bold text-slate-800 mt-1">
                                ${formatMoney(event.amount_cents)}
                                {event.payable_total_cents != null && event.kind === 'invoice' && (
                                  <span className="ml-1 text-[11px] font-semibold text-amber-800">
                                    → Pay ${formatMoney(event.payable_total_cents)}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                          {event.tab && (
                            <button
                              type="button"
                              onClick={() => openTab(event.tab, event.focus_id || event.entity_id)}
                              className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 inline-flex items-center gap-1 self-start"
                            >
                              Open <ExternalLink className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      )}

      {!loading && !trail && !error && (
        <div className="bg-white rounded-xl border border-dashed border-slate-200 p-10 text-center text-sm text-slate-400">
          Search a PR or PO to see the timed document chain.
        </div>
      )}
    </div>
  );
}
