import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, FileUp, X } from 'lucide-react';
import { api } from '../api';
import { formatMajorInput, formatMoney, moneyInputProps, toCents } from '../money';
import { isLowConfidence } from '../../../shared/invoiceConfidence.js';
import { presentError, statusLabel, t } from '../i18n';

const EMPTY_DRAFT = {
  vendor_name: '',
  supplier_id: '',
  invoice_number: '',
  invoice_date: '',
  due_date: '',
  po_number: '',
  po_id: '',
  currency: '',
  net: '',
  vat: '',
  gross: '',
  lines: []
};

function draftFrom(proposal) {
  const working = proposal?.working || {};
  return {
    vendor_name: working.vendor_name || '',
    supplier_id: working.supplier_id ?? '',
    invoice_number: working.invoice_number || '',
    invoice_date: working.invoice_date || '',
    due_date: working.due_date || '',
    po_number: working.po_number || '',
    po_id: working.po_id ?? '',
    currency: working.currency || '',
    net: working.net_cents == null ? '' : formatMajorInput(working.net_cents),
    vat: working.vat_cents == null ? '' : formatMajorInput(working.vat_cents),
    gross: working.gross_cents == null ? '' : formatMajorInput(working.gross_cents),
    lines: (working.lines || []).map((line) => ({
      description: line.description || '',
      quantity: line.quantity ?? '',
      unit_price: line.unit_price_cents == null ? '' : formatMajorInput(line.unit_price_cents),
      po_item_id: line.po_item_id ?? ''
    }))
  };
}

function payloadFrom(draft) {
  return {
    vendor_name: draft.vendor_name || null,
    supplier_id: draft.supplier_id === '' ? null : Number(draft.supplier_id),
    invoice_number: draft.invoice_number || null,
    invoice_date: draft.invoice_date || null,
    due_date: draft.due_date || null,
    po_number: draft.po_number || null,
    po_id: draft.po_id === '' ? null : Number(draft.po_id),
    currency: draft.currency || null,
    net_cents: draft.net === '' ? null : toCents(draft.net),
    vat_cents: draft.vat === '' ? null : toCents(draft.vat),
    gross_cents: draft.gross === '' ? null : toCents(draft.gross),
    lines: draft.lines.map((line) => ({
      description: line.description || null,
      quantity: line.quantity === '' ? null : Number(line.quantity),
      unit_price_cents: line.unit_price === '' ? null : toCents(line.unit_price),
      po_item_id: line.po_item_id === '' ? null : Number(line.po_item_id)
    }))
  };
}

function fieldClass(highlight) {
  return highlight
    ? 'border-amber-400 bg-amber-50'
    : 'border-slate-200 bg-white';
}

function Field({ label, highlight, children }) {
  return (
    <label className="block text-xs text-slate-600">
      <span className="flex items-center justify-between mb-1">
        <span>{label}</span>
        {highlight ? (
          <span className="text-[10px] font-semibold text-amber-800">{t('payables.inbox.lowConfidence')}</span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

export default function InvoiceProposalsView({ onDataChanged }) {
  const [config, setConfig] = useState(null);
  const [queue, setQueue] = useState('proposed');
  const [proposals, setProposals] = useState([]);
  const [pageOffset, setPageOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [options, setOptions] = useState({ suppliers: [], purchase_orders: [], po_items: [] });
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [savedDraft, setSavedDraft] = useState('');
  const [preview, setPreview] = useState(null);
  const [reason, setReason] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const selected = proposals.find((row) => row.id === selectedId) || null;
  const dirty = useMemo(() => JSON.stringify(draft) !== savedDraft, [draft, savedDraft]);
  const open = selected?.status === 'proposed';

  async function load(nextQueue = queue, keepId = selectedId, nextOffset = 0) {
    const [cfg, list] = await Promise.all([
      api.getInvoiceProposalConfig(),
      api.listInvoiceProposals(nextQueue, { limit: 50, offset: nextOffset })
    ]);
    setConfig(cfg);
    setProposals(list.proposals || []);
    setPageOffset(Number(list.offset) || 0);
    setHasMore(Boolean(list.has_more));
    const still = (list.proposals || []).some((row) => row.id === keepId);
    setSelectedId(still ? keepId : (list.proposals?.[0]?.id ?? null));
    return cfg;
  }

  useEffect(() => {
    let cancelled = false;
    load().catch((err) => {
      if (!cancelled) setError(presentError(err));
    });
    api.getInvoiceProposalOptions().then((rows) => {
      if (!cancelled) setOptions(rows);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selected) {
      setDraft(EMPTY_DRAFT);
      setSavedDraft(JSON.stringify(EMPTY_DRAFT));
      setPreview(null);
      return;
    }
    const next = draftFrom(selected);
    setDraft(next);
    setSavedDraft(JSON.stringify(next));
    setPreview(selected.preview || null);
    setReason('');
    setOverrideReason('');
  }, [selectedId, selected?.updated_at]);

  function lineHighlight(index, key) {
    const field = selected?.fields?.lines?.[index]?.[key];
    return isLowConfidence(field?.confidence);
  }

  function setLine(index, key, value) {
    setDraft((prev) => ({
      ...prev,
      lines: prev.lines.map((line, i) => (i === index ? { ...line, [key]: value } : line))
    }));
  }

  async function onUpload(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length || !config?.enabled) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      let lastId = selectedId;
      for (const file of files) {
        const created = await api.uploadInvoiceProposal(file);
        lastId = created.proposal.id;
      }
      await load('proposed', lastId);
      setQueue('proposed');
      setNotice(t('payables.inbox.uploaded', { count: String(files.length) }));
    } catch (err) {
      setError(presentError(err));
    } finally {
      setBusy(false);
    }
  }

  async function refreshPreview() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.previewInvoiceProposal(selected.id, {
        ...payloadFrom(draft),
        override_reason: overrideReason.trim() || undefined
      });
      setPreview(result.preview);
    } catch (err) {
      setError(presentError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onApprove() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const reasonText = overrideReason.trim();
      const result = dirty
        ? await api.postInvoiceProposal(selected.id, {
          ...payloadFrom(draft),
          override_reason: reasonText || undefined
        })
        : await api.approveInvoiceProposal(selected.id, reasonText);
      setNotice(t('payables.inbox.posted', {
        invoice: result.invoice?.invoiceId ?? result.proposal?.posted_invoice_id
      }));
      if (onDataChanged) onDataChanged();
      await load(queue, null);
    } catch (err) {
      setError(presentError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onReject() {
    if (!selected) return;
    if (!reason.trim()) {
      setError(t('code.rejection_reason_required'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.rejectInvoiceProposal(selected.id, reason.trim());
      setNotice(t('payables.inbox.rejected'));
      await load(queue, null);
    } catch (err) {
      setError(presentError(err));
    } finally {
      setBusy(false);
    }
  }

  const poItems = options.po_items.filter((item) => String(item.po_id) === String(draft.po_id));
  const inputClass = 'w-full rounded-lg border px-2 py-1.5 text-sm text-slate-900';
  const supplierGuess = ['suggested', 'from_po', 'ambiguous'].includes(selected?.vendor_match?.status);
  const poGuess = ['suggested', 'ambiguous'].includes(selected?.po_match?.status);
  const blockers = preview?.blockers || [];
  const totalsOnly = blockers.length > 0 && blockers.every((code) => code === 'lines_net_mismatch' || code === 'gross_mismatch');
  const needsOverride = totalsOnly && !overrideReason.trim();

  return (
    <div className="p-6 space-y-4" data-testid="finance-inbox">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{t('payables.inbox.title')}</h1>
          <p className="text-sm text-slate-600 mt-1 max-w-3xl">{t('payables.inbox.lead')}</p>
        </div>
        <label className={`inline-flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-lg border ${config?.enabled ? 'bg-white border-slate-200 text-slate-800 cursor-pointer' : 'bg-slate-100 border-slate-200 text-slate-400'}`}>
          <FileUp className="w-4 h-4" />
          {t('payables.inbox.upload')}
          <input
            data-testid="proposal-upload"
            type="file"
            accept="application/pdf,.pdf"
            multiple
            className="hidden"
            disabled={!config?.enabled || busy}
            onChange={onUpload}
          />
        </label>
      </div>

      {config && !config.enabled ? (
        <div data-testid="proposal-disabled" className="bg-amber-50 border border-amber-200 text-amber-950 text-sm rounded-xl px-4 py-3">
          {t('payables.inbox.disabled')}
        </div>
      ) : null}
      {error ? <div className="bg-rose-50 border border-rose-200 text-rose-900 text-sm rounded-xl px-4 py-3">{error}</div> : null}
      {notice ? <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm rounded-xl px-4 py-3">{notice}</div> : null}

      <div className="flex gap-2 text-xs">
        {['proposed', 'posted', 'rejected'].map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => {
              setQueue(status);
              load(status, null).catch((err) => setError(presentError(err)));
            }}
            className={`px-3 py-1.5 rounded-full border ${queue === status ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200'}`}
          >
            {t(`payables.inbox.queue.${status}`)}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[16rem_1fr] gap-4">
        <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-[70vh] overflow-auto">
          {proposals.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">{t('payables.inbox.empty')}</p>
          ) : proposals.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => setSelectedId(row.id)}
              className={`w-full text-left px-3 py-3 ${row.id === selectedId ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}
            >
              <div className="text-sm font-medium text-slate-900">{row.working?.invoice_number || row.filename}</div>
              <div className="text-xs text-slate-500">{row.working?.vendor_name || t('payables.inbox.unknownVendor')}</div>
              {row.low_confidence_fields?.length ? (
                <div className="text-[10px] text-amber-800 mt-1">{t('payables.inbox.needsReview')}</div>
              ) : null}
            </button>
          ))}
          {pageOffset > 0 || hasMore ? (
            <div className="flex justify-between gap-2 p-2">
              <button
                type="button"
                disabled={busy || pageOffset <= 0}
                onClick={() => load(queue, null, Math.max(0, pageOffset - 50)).catch((err) => setError(presentError(err)))}
                className="px-2 py-1 rounded border border-slate-200 text-xs disabled:opacity-40"
              >
                {t('payables.inbox.prevPage')}
              </button>
              <button
                type="button"
                disabled={busy || !hasMore}
                onClick={() => load(queue, null, pageOffset + 50).catch((err) => setError(presentError(err)))}
                className="px-2 py-1 rounded border border-slate-200 text-xs disabled:opacity-40"
              >
                {t('payables.inbox.nextPage')}
              </button>
            </div>
          ) : null}
        </div>

        {selected ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <iframe
              title={t('payables.inbox.pdf')}
              src={`/api/invoice-proposals/${selected.id}/pdf`}
              className="w-full min-h-[70vh] bg-slate-100 border border-slate-200 rounded-xl"
            />
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label={t('payables.inbox.vendor')} highlight={isLowConfidence(selected.fields?.vendor_name?.confidence)}>
                  <input data-low-confidence={isLowConfidence(selected.fields?.vendor_name?.confidence) ? 'true' : 'false'} className={`${inputClass} ${fieldClass(isLowConfidence(selected.fields?.vendor_name?.confidence))}`} value={draft.vendor_name} disabled={!open} onChange={(e) => setDraft({ ...draft, vendor_name: e.target.value })} />
                </Field>
                <Field label={t('payables.inbox.supplier')} highlight={supplierGuess}>
                  <select data-low-confidence={supplierGuess ? 'true' : 'false'} className={`${inputClass} ${fieldClass(supplierGuess)}`} value={draft.supplier_id} disabled={!open} onChange={(e) => setDraft({ ...draft, supplier_id: e.target.value })}>
                    <option value="">{t('payables.inbox.choose')}</option>
                    {options.suppliers.map((row) => (
                      <option key={row.id} value={row.id}>{row.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label={t('payables.inbox.invoiceNumber')} highlight={isLowConfidence(selected.fields?.invoice_number?.confidence)}>
                  <input data-low-confidence={isLowConfidence(selected.fields?.invoice_number?.confidence) ? 'true' : 'false'} className={`${inputClass} ${fieldClass(isLowConfidence(selected.fields?.invoice_number?.confidence))}`} value={draft.invoice_number} disabled={!open} onChange={(e) => setDraft({ ...draft, invoice_number: e.target.value })} />
                </Field>
                <Field label={t('payables.inbox.poNumber')} highlight={isLowConfidence(selected.fields?.po_number?.confidence)}>
                  <input className={`${inputClass} ${fieldClass(isLowConfidence(selected.fields?.po_number?.confidence))}`} value={draft.po_number} disabled={!open} onChange={(e) => setDraft({ ...draft, po_number: e.target.value })} />
                </Field>
                <Field label={t('payables.inbox.po')} highlight={poGuess}>
                  <select data-low-confidence={poGuess ? 'true' : 'false'} className={`${inputClass} ${fieldClass(poGuess)}`} value={draft.po_id} disabled={!open} onChange={(e) => setDraft({ ...draft, po_id: e.target.value })}>
                    <option value="">{t('payables.inbox.choose')}</option>
                    {options.purchase_orders.map((row) => (
                      <option key={row.id} value={row.id}>{row.po_number}</option>
                    ))}
                  </select>
                </Field>
                <Field label={t('payables.inbox.currency')} highlight={isLowConfidence(selected.fields?.currency?.confidence)}>
                  <input className={`${inputClass} ${fieldClass(isLowConfidence(selected.fields?.currency?.confidence))}`} value={draft.currency} disabled={!open} onChange={(e) => setDraft({ ...draft, currency: e.target.value })} />
                </Field>
                <Field label={t('payables.inbox.invoiceDate')} highlight={isLowConfidence(selected.fields?.invoice_date?.confidence)}>
                  <input type="date" className={`${inputClass} ${fieldClass(isLowConfidence(selected.fields?.invoice_date?.confidence))}`} value={draft.invoice_date} disabled={!open} onChange={(e) => setDraft({ ...draft, invoice_date: e.target.value })} />
                </Field>
                <Field label={t('payables.inbox.dueDate')} highlight={isLowConfidence(selected.fields?.due_date?.confidence)}>
                  <input data-low-confidence={isLowConfidence(selected.fields?.due_date?.confidence) ? 'true' : 'false'} type="date" className={`${inputClass} ${fieldClass(isLowConfidence(selected.fields?.due_date?.confidence))}`} value={draft.due_date} disabled={!open} onChange={(e) => setDraft({ ...draft, due_date: e.target.value })} />
                </Field>
                <Field label={t('payables.inbox.net')} highlight={isLowConfidence(selected.fields?.net_cents?.confidence)}>
                  <input {...moneyInputProps} className={`${inputClass} ${fieldClass(isLowConfidence(selected.fields?.net_cents?.confidence))}`} value={draft.net} disabled={!open} onChange={(e) => setDraft({ ...draft, net: e.target.value })} />
                </Field>
                <Field label={t('payables.inbox.vat')} highlight={isLowConfidence(selected.fields?.vat_cents?.confidence)}>
                  <input {...moneyInputProps} className={`${inputClass} ${fieldClass(isLowConfidence(selected.fields?.vat_cents?.confidence))}`} value={draft.vat} disabled={!open} onChange={(e) => setDraft({ ...draft, vat: e.target.value })} />
                </Field>
                <Field label={t('payables.inbox.gross')} highlight={isLowConfidence(selected.fields?.gross_cents?.confidence)}>
                  <input {...moneyInputProps} className={`${inputClass} ${fieldClass(isLowConfidence(selected.fields?.gross_cents?.confidence))}`} value={draft.gross} disabled={!open} onChange={(e) => setDraft({ ...draft, gross: e.target.value })} />
                </Field>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-700">{t('payables.inbox.lines')}</div>
                {draft.lines.map((line, index) => (
                  <div key={index} className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                    <input className={`${inputClass} ${fieldClass(lineHighlight(index, 'description'))}`} value={line.description} disabled={!open} onChange={(e) => setLine(index, 'description', e.target.value)} />
                    <input className={`${inputClass} ${fieldClass(lineHighlight(index, 'quantity'))}`} value={line.quantity} disabled={!open} onChange={(e) => setLine(index, 'quantity', e.target.value)} />
                    <input {...moneyInputProps} className={`${inputClass} ${fieldClass(lineHighlight(index, 'unit_price_cents'))}`} value={line.unit_price} disabled={!open} onChange={(e) => setLine(index, 'unit_price', e.target.value)} />
                    <select className={inputClass} value={line.po_item_id} disabled={!open} onChange={(e) => setLine(index, 'po_item_id', e.target.value)}>
                      <option value="">{t('payables.inbox.lineUnmapped')}</option>
                      {poItems.map((item) => (
                        <option key={item.id} value={item.id}>{item.description}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 space-y-1">
                <div className="font-semibold text-slate-900">{t('payables.inbox.preview')}</div>
                {preview?.ready ? (
                  <>
                    <div>{t('payables.inbox.match')}: {statusLabel(preview.match?.match_status) || preview.match?.match_status}</div>
                    <div>{t('payables.inbox.invoiceStatus')}: {statusLabel(preview.match?.status) || preview.match?.status}</div>
                    <div>{t('payables.inbox.duplicate')}: {statusLabel(preview.duplicate_status)}</div>
                    <div>{t('payables.inbox.total')}: {formatMoney(preview.total_amount)}</div>
                    {preview.exception?.queued ? <div className="text-rose-800">{t('payables.inbox.exception')}</div> : null}
                    {preview.gross_check === 'mismatch' ? <div className="text-amber-800">{t('payables.inbox.grossMismatch')}</div> : null}
                  </>
                ) : (
                  <div>{t('payables.inbox.notReady')}: {(preview?.blockers || []).map((code) => t(`code.${code}`)).join(', ')}</div>
                )}
                {selected.vendor_match?.suggestions?.length ? (
                  <div>{t('payables.inbox.vendorSuggestions')}: {selected.vendor_match.suggestions.map((row) => row.name).join(', ')}</div>
                ) : null}
                {selected.po_match?.suggestions?.length ? (
                  <div>{t('payables.inbox.poSuggestions')}: {selected.po_match.suggestions.map((row) => row.po_number).join(', ')}</div>
                ) : null}
              </div>

              {open && totalsOnly ? (
                <label className="block text-xs text-amber-900">
                  <span className="block mb-1">{t('payables.inbox.overrideReason')}</span>
                  <input
                    data-testid="proposal-override-reason"
                    className="w-full rounded-lg border border-amber-300 bg-amber-50 px-2 py-1.5 text-sm text-slate-900"
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                  />
                </label>
              ) : null}

              {open ? (
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={busy} onClick={refreshPreview} className="px-3 py-2 text-xs rounded-lg border border-slate-300 bg-white">{t('payables.inbox.refreshPreview')}</button>
                  <button type="button" disabled={busy || dirty || needsOverride} onClick={onApprove} className="inline-flex items-center gap-1 px-3 py-2 text-xs rounded-lg bg-emerald-600 text-white disabled:opacity-40">
                    <Check className="w-3.5 h-3.5" /> {t('payables.inbox.approve')}
                  </button>
                  <button type="button" disabled={busy || !dirty || needsOverride} onClick={onApprove} className="px-3 py-2 text-xs rounded-lg bg-slate-900 text-white disabled:opacity-40">{t('payables.inbox.editPost')}</button>
                  <input className="flex-1 min-w-[12rem] rounded-lg border border-slate-200 px-2 py-1.5 text-sm" placeholder={t('payables.inbox.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
                  <button type="button" disabled={busy} onClick={onReject} className="inline-flex items-center gap-1 px-3 py-2 text-xs rounded-lg border border-rose-300 text-rose-800 bg-white">
                    <X className="w-3.5 h-3.5" /> {t('payables.inbox.reject')}
                  </button>
                </div>
              ) : (
                <div className="text-xs text-slate-600 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {selected.status === 'rejected'
                    ? t('payables.inbox.rejectedReason', { reason: selected.rejected_reason || '' })
                    : t('payables.inbox.postedInvoice', { invoice: selected.posted_invoice_id })}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="text-sm text-slate-500">{t('payables.inbox.pick')}</div>
        )}
      </div>
    </div>
  );
}
