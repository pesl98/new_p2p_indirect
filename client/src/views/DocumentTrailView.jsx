import React, { useEffect, useState } from 'react';
import {
  Search,
  GitBranch,
  FileText,
  CheckSquare,
  ShoppingCart,
  PackageCheck,
  Warehouse,
  Gauge,
  Cylinder,
  ClipboardCheck,
  FileSpreadsheet,
  CreditCard,
  ExternalLink,
  Clock,
  AlertCircle,
  FileEdit,
  Copy,
  FileCheck,
  Banknote
} from 'lucide-react';
import { api } from '../api';
import { documentTrailQueryFromLookup } from '../documentTrailNav';
import { t, presentError, statusLabel, formatDateTime } from '../i18n';
import { formatMoney } from '../money';

const STAGE_ICONS = {
  requisition: FileText,
  approvals: CheckSquare,
  purchase_orders: ShoppingCart,
  receiving: PackageCheck,
  invoice: FileSpreadsheet,
  ap: CreditCard
};

const STAGE_LABEL_KEYS = {
  Requisition: 'trail.stage.requisition',
  Approvals: 'trail.stage.approvals',
  'Purchase order': 'trail.stage.purchaseOrder',
  'GRN / SES': 'trail.stage.grnSes',
  'Consignment issue': 'trail.stage.consignment',
  'Utility reading': 'trail.stage.utility',
  'Bulk draw': 'trail.stage.bulk',
  Consumption: 'trail.stage.consumption',
  Invoice: 'trail.stage.invoice',
  'AP payment': 'trail.stage.ap'
};

const EVENT_TITLE_KEYS = {
  Requisition: 'trail.event.requisition',
  'Contract proposed': 'trail.event.contractProposed',
  'Contract use allowed': 'trail.event.contractAllowed',
  'Contract use refused': 'trail.event.contractRefused',
  'Contract link cleared': 'trail.event.contractCleared',
  'Purchase order': 'trail.event.purchaseOrder',
  'Change order applied': 'trail.event.changeOrder',
  'Consignment issue': 'trail.event.consignment',
  'Utility consumption': 'trail.event.utility',
  'Bulk draw': 'trail.event.bulk',
  'Goods receipt': 'trail.event.goodsReceipt',
  'Service entry sheet': 'trail.event.ses',
  'Vendor invoice': 'trail.event.invoice',
  'Exception accepted': 'trail.event.exceptionAccepted',
  'Exception rejected': 'trail.event.exceptionRejected',
  'Returned to buyer': 'trail.event.returned',
  'Invoice short-paid': 'trail.event.shortPay',
  'Buyer responded': 'trail.event.buyerResponded',
  'Duplicate suspected': 'trail.event.duplicateSuspected',
  'Duplicate cleared': 'trail.event.duplicateCleared',
  'Duplicate confirmed': 'trail.event.duplicateConfirmed',
  'Marked paid': 'trail.event.markedPaid',
  'AP approved for payment': 'trail.event.apApproved',
  'Payment run executed': 'trail.event.paymentRun'
};

function stageTitle(label) {
  const key = STAGE_LABEL_KEYS[label];
  return key ? t(key) : label;
}

function displayStatus(status) {
  if (status === 'recorded') return t('trail.statusRecorded');
  if (status === 'drawn') return t('trail.statusDrawn');
  return statusLabel(status);
}

function displayEventTitle(title) {
  if (!title) return '';
  const step = String(title).match(/^Approval step (\d+)(?![\s\S])/);
  if (step) return t('trail.event.approvalStep', { n: step[1] });
  const key = EVENT_TITLE_KEYS[title];
  return key ? t(key) : title;
}

function displayEventNumber(number) {
  const step = String(number ?? '').match(/^Step (\d+)(?![\s\S])/);
  if (step) return t('trail.stepNumber', { n: step[1] });
  return number;
}

function startingTypeLabel(type) {
  if (type === 'requisition') return t('trail.type.requisition');
  if (type === 'purchase_order') return t('trail.type.purchaseOrder');
  return statusLabel(type);
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
    case 'applied':
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
      {label || displayStatus(status)}
    </span>
  );
}

function eventIcon(kind) {
  switch (kind) {
    case 'requisition':
      return FileText;
    case 'contract_assignment':
      return FileCheck;
    case 'approval':
      return CheckSquare;
    case 'purchase_order':
      return ShoppingCart;
    case 'change_order':
      return FileEdit;
    case 'goods_receipt':
      return PackageCheck;
    case 'consignment_issue':
      return Warehouse;
    case 'utility_consumption':
      return Gauge;
    case 'bulk_draw':
      return Cylinder;
    case 'service_entry_sheet':
      return ClipboardCheck;
    case 'invoice':
      return FileSpreadsheet;
    case 'exception':
      return FileSpreadsheet;
    case 'duplicate':
      return Copy;
    case 'payment_run':
      return Banknote;
    case 'ap_event':
      return CreditCard;
    default:
      return Clock;
  }
}

export default function DocumentTrailView({ onNavigate, lookupQ, lookup }) {
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
      setError(presentError(err, 'errors.trail'));
    } finally {
      setLoading(false);
    }
  };

  const lookupKey = JSON.stringify(
    documentTrailQueryFromLookup(
      lookup && (
        lookup.po_id != null
        || lookup.po_number
        || lookup.requisition_id != null
        || lookup.pr_number
        || lookup.q
      )
        ? lookup
        : (lookupQ ? { q: lookupQ } : null)
    )
  );

  useEffect(() => {
    loadSuggestions('');
    loadTrail(JSON.parse(lookupKey));
  }, [lookupKey]);

  const handleSearch = (event) => {
    event.preventDefault();
    const term = query.trim();
    if (!term) {
      setError(t('trail.queryRequired'));
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
          <h2 className="text-xl font-bold text-slate-900 tracking-tight">{t('trail.title')}</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t('trail.subtitle')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {['PR-2026-001', 'PR-2026-005', 'PR-2026-006', 'PR-2026-008'].map((number) => (
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
              placeholder={t('trail.searchPlaceholder')}
              className="w-full pl-9 pr-3 py-2.5 text-sm rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
            />
          </div>
          <button
            type="submit"
            className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-sm"
          >
            {t('trail.openTrail')}
          </button>
        </div>
        {(suggestions.requisitions.length > 0 || suggestions.purchase_orders.length > 0) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">{t('trail.requisitions')}</div>
              <div className="space-y-1">
                {suggestions.requisitions.slice(0, 5).map((pr) => (
                  <button
                    key={`pr-${pr.id}`}
                    type="button"
                    onClick={() => loadTrail({ requisition_id: pr.id })}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 border border-transparent hover:border-slate-200 flex items-center justify-between"
                  >
                    <span className="font-mono font-bold text-slate-800">{pr.pr_number}</span>
                    <span className="text-slate-500">{pr.requester_name} · {formatMoney(pr.total_amount)}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">{t('trail.purchaseOrders')}</div>
              <div className="space-y-1">
                {suggestions.purchase_orders.slice(0, 5).map((po) => (
                  <button
                    key={`po-${po.id}`}
                    type="button"
                    onClick={() => loadTrail({ po_id: po.id })}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 border border-transparent hover:border-slate-200 flex items-center justify-between"
                  >
                    <span className="font-mono font-bold text-slate-800">{po.po_number}</span>
                    <span className="text-slate-500">{po.supplier_name} · {formatMoney(po.total_amount)}</span>
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
        <div className="text-center text-slate-400 py-12 text-sm">{t('trail.loading')}</div>
      )}

      {trail && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-5">
            <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600 mb-1">
                  {t('trail.starting', { type: startingTypeLabel(trail.starting_point.type) })}
                </div>
                <h3 className="text-lg font-bold text-slate-900 font-mono">
                  {trail.requisition?.pr_number || trail.starting_point.number}
                </h3>
                <p className="text-xs text-slate-500 mt-1 max-w-2xl">
                  {trail.requisition?.justification || t('trail.noRequisition')}
                </p>
                {trail.sourcing?.award_rfq_number && (
                  <p className="text-xs text-sky-800 mt-1">{t('trail.sourcing.award', { number: trail.sourcing.award_rfq_number })}</p>
                )}
                {trail.sourcing?.source_rfq_number && (
                  <p className="text-xs text-sky-800 mt-1">
                    {t(trail.sourcing.source_rfq_status === 'awarded' ? 'trail.sourcing.superseded' : 'trail.sourcing.inRfq', { number: trail.sourcing.source_rfq_number })}
                  </p>
                )}
              </div>
              <div className="text-right">
                {trail.requisition && (
                  <>
                    <div className="text-xl font-extrabold text-slate-900">{formatMoney(trail.requisition.total_amount)}</div>
                    <div className="text-[11px] text-slate-500">
                      {trail.requisition.requester_name} · {trail.requisition.department_name}
                    </div>
                    <div className="mt-2"><StatusPill status={trail.requisition.status} /></div>
                  </>
                )}
                {trail.split && (
                  <div className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-700 bg-indigo-50 px-2 py-1 rounded-full">
                    <GitBranch className="w-3 h-3" />
                    {t('trail.split')}
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
                      {stageTitle(stage.label)}
                    </div>
                    <div className="mt-1.5">
                      <StatusPill status={stage.status} />
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
                    <div>{t('common.amount')}: <span className="font-semibold">{formatMoney(po.total_amount)}</span></div>
                    <div>
                      {po.receiving?.goods === 'consignment' ? (
                        <>{t('trail.consignmentPrefix')} {po.consignment_issues?.[0]?.issue_number || t('trail.issued')} <span className="text-slate-400">({t('trail.noGrn')})</span></>
                      ) : po.receiving?.goods === 'utility' ? (
                        <>{t('trail.utilityPrefix')} {po.utility_consumptions?.[0]?.consumption_number || t('trail.recordedWord')} <span className="text-slate-400">({t('trail.noGrn')})</span></>
                      ) : po.receiving?.goods === 'bulk' ? (
                        <>{t('trail.bulkPrefix')} {po.bulk_draws?.[0]?.draw_number || t('trail.drawnWord')} <span className="text-slate-400">({t('trail.noGrn')})</span></>
                      ) : (
                        <>GRN: {po.goods_receipts[0]?.grn_number || <span className="text-slate-400">{t('trail.notStarted')}</span>}</>
                      )}
                    </div>
                    <div>SES: {po.service_entry_sheets[0]?.ses_number || <span className="text-slate-400">{t('trail.notStarted')}</span>}</div>
                    <div>
                      {t('trail.invoicePrefix')} {po.invoices[0]?.invoice_number || <span className="text-slate-400">{t('trail.notStarted')}</span>}
                      {po.invoices[0] && (
                        <span className="ml-1 text-slate-400">({statusLabel(po.invoices[0].match_status)})</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => openTab('purchase_orders', po.id)}
                    className="mt-3 text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 inline-flex items-center gap-1"
                  >
                    {t('trail.openPo')} <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-5">
            <h4 className="text-sm font-bold text-slate-900 mb-4">{t('trail.chain')}</h4>
            {trail.timeline.length === 0 ? (
              <div className="text-sm text-slate-400">{t('trail.emptyChain')}</div>
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
                              <span className="font-mono font-bold text-slate-900 text-sm">{displayEventNumber(event.number)}</span>
                              <StatusPill status={event.status} />
                              {event.match_status && <StatusPill status={event.match_status} />}
                              {event.po_number && event.kind !== 'purchase_order' && (
                                <span className="text-[10px] font-semibold text-slate-500">{event.po_number}</span>
                              )}
                            </div>
                            <div className="text-xs font-semibold text-slate-700 mt-1">{displayEventTitle(event.title)}</div>
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              {formatDateTime(event.at)}
                              {event.actor_name ? ` · ${event.actor_name}` : ''}
                              {event.supplier_name ? ` · ${event.supplier_name}` : ''}
                            </div>
                            {event.details && (
                              <p className="text-[11px] text-slate-500 mt-1">{event.details}</p>
                            )}
                            {event.amount_cents != null && (
                              <div className="text-xs font-bold text-slate-800 mt-1">
                                {formatMoney(event.amount_cents)}
                                {event.payable_total_cents != null && event.kind === 'invoice' && (
                                  <span className="ml-1 text-[11px] font-semibold text-amber-800">
                                    {t('trail.pay', { amount: formatMoney(event.payable_total_cents) })}
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
                              {t('trail.open')} <ExternalLink className="w-3 h-3" />
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
          {t('trail.empty')}
        </div>
      )}
    </div>
  );
}
