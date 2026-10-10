import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { t, presentError, statusLabel } from '../i18n';
import { formatMoney } from '../money';

export default function SourcingAward({ detail, evaluation, currentUser, onReload, onError }) {
  const [award, setAward] = useState(null);
  const [type, setType] = useState('full');
  const [picks, setPicks] = useState({});
  const [fullBid, setFullBid] = useState('');
  const [reason, setReason] = useState('');
  const [reassignUser, setReassignUser] = useState('');
  const [reassignReason, setReassignReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [poProgress, setPoProgress] = useState(null);

  const load = async () => {
    try {
      setAward((await api.getSourcingAward(detail.id)).award);
    } catch (err) {
      onError(presentError(err, 'errors.sourcing'));
    }
  };
  useEffect(() => { load(); }, [detail.id, detail.status]);

  const matrix = evaluation?.matrix;
  const bids = (matrix?.bids || []).filter((bid) => bid.status === 'submitted');
  const isOwner = Number(currentUser?.id) === Number(detail.owner_user_id);
  const canPropose = (isOwner || currentUser?.role === 'admin') && detail.status === 'evaluated'
    && (!award || award.status === 'rejected');
  const ownerConflict = (evaluation?.evaluators || []).some(
    (row) => Number(row.user_id) === Number(detail.owner_user_id) && row.coi_status === 'conflict_declared'
  );

  const run = async (work) => {
    setBusy(true);
    onError('');
    try {
      await work();
      await onReload();
      await load();
    } catch (err) {
      onError(presentError(err, 'errors.sourcingSave'));
    } finally {
      setBusy(false);
    }
  };

  // The server works for about 10 seconds per request and says what is left; ask again until done.
  const createPos = () => run(async () => {
    setPoProgress(null);
    let result = await api.createSourcingPurchaseOrders(detail.id);
    for (let round = 0; result.done === false && round < 50; round += 1) {
      setPoProgress({ remaining: result.remaining.length });
      result = await api.createSourcingPurchaseOrders(detail.id);
    }
    setPoProgress(null);
  });

  const publishOutcome = () => run(() => api.publishSourcingOutcome(detail.id));

  const propose = () => run(() => api.proposeSourcingAward(detail.id, type === 'full'
    ? { award_type: 'full', bid_id: Number(fullBid), reason }
    : {
        award_type: 'split',
        lines: (matrix?.lines || []).map((line) => ({ event_line_id: line.id, bid_id: Number(picks[line.id]) })),
        reason
      }));

  return (
    <div className="space-y-4">
      {ownerConflict && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
          <p>{t('sourcing.award.conflictOwner')}</p>
          {currentUser?.role === 'admin' && (
            <div className="flex flex-wrap gap-2">
              <input className="border border-slate-200 rounded px-2 py-1 w-24" placeholder="User ID" value={reassignUser} onChange={(e) => setReassignUser(e.target.value)} />
              <input className="border border-slate-200 rounded px-2 py-1 flex-1" placeholder={t('sourcing.award.reassignReason')} value={reassignReason} onChange={(e) => setReassignReason(e.target.value)} />
              <button type="button" disabled={busy} className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold"
                onClick={() => run(() => api.reassignSourcingOwner(detail.id, { user_id: Number(reassignUser), reason: reassignReason }))}>
                {t('sourcing.award.reassign')}
              </button>
            </div>
          )}
        </div>
      )}

      {award && (
        <div className="rounded-lg border border-slate-200 p-3 space-y-2">
          <p className="font-semibold">{t('sourcing.award.status')}: {t(`sourcing.award.${award.status}`)}</p>
          {award.prices_hidden
            ? <p className="text-slate-500">{t('sourcing.award.pricesHidden')}</p>
            : <p>{t('sourcing.award.total')}: {formatMoney(award.total_cents)} · {award.is_lowest ? t('sourcing.award.isLowest') : t('sourcing.award.notLowest')}</p>}
          {award.reason && <p className="text-slate-600">{award.reason}</p>}
          {award.requisition && <p>{t('sourcing.award.requisition')}: <span className="font-mono">{award.requisition.pr_number}</span> ({statusLabel(award.requisition.status)})</p>}
          <ul className="list-disc ml-5">
            {award.lines.map((line) => (
              <li key={line.event_line_id}>
                {line.line_no}. {line.description}
                {!award.prices_hidden && <>: {line.supplier_name} · {formatMoney(line.unit_price_cents)} × {line.quantity} = {formatMoney(line.line_total_cents)}</>}
              </li>
            ))}
          </ul>
          <p className="font-semibold">{t('sourcing.award.chain')}</p>
          <ul className="list-disc ml-5">
            {award.approvals.map((step) => (
              <li key={step.step_order}>{step.step_order}. {step.approver_name} · {statusLabel(step.status)}</li>
            ))}
          </ul>
          {award.purchase_orders.length > 0 && (
            <>
              <p className="font-semibold">{t('sourcing.award.pos')}</p>
              <ul className="list-disc ml-5">
                {award.purchase_orders.map((po) => (
                  <li key={po.id}><span className="font-mono">{po.po_number}</span>{!award.prices_hidden && <> · {po.supplier_name} · {formatMoney(po.total_amount)}</>}</li>
                ))}
              </ul>
            </>
          )}
          {detail.status === 'awarded' && award.requisition?.status !== 'converted_to_po' && (currentUser?.role === 'procurement' || currentUser?.role === 'admin') && (
            <button type="button" disabled={busy} onClick={createPos}
              className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold">
              {t('sourcing.award.createPos')}
            </button>
          )}
          {detail.status === 'awarded' && (currentUser?.role === 'procurement' || currentUser?.role === 'admin') && (
            detail.outcome_published_at
              ? <p className="text-slate-600">{t('sourcing.award.outcomePublished')}</p>
              : (
                <div className="space-y-1">
                  <button type="button" disabled={busy} onClick={publishOutcome}
                    className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold">
                    {t('sourcing.award.publishOutcome')}
                  </button>
                  <p className="text-xs text-slate-500">{t('sourcing.award.outcomeHint')}</p>
                </div>
              )
          )}
          {poProgress && <p className="text-slate-600">{t('sourcing.award.posProgress', { n: poProgress.remaining })}</p>}
        </div>
      )}

      {canPropose && matrix && (
        <div className="rounded-lg border border-slate-200 p-3 space-y-3">
          <p className="font-semibold">{t('sourcing.award.title')}</p>
          <div className="flex gap-4">
            <label><input type="radio" checked={type === 'full'} onChange={() => setType('full')} /> {t('sourcing.award.full')}</label>
            <label><input type="radio" checked={type === 'split'} onChange={() => setType('split')} /> {t('sourcing.award.split')}</label>
          </div>
          {type === 'full' ? (
            <select className="border border-slate-200 rounded px-2 py-1" value={fullBid} onChange={(e) => setFullBid(e.target.value)}>
              <option value="">{t('sourcing.award.supplier')}</option>
              {bids.filter((bid) => bid.complete).map((bid) => (
                <option key={bid.bid_id} value={bid.bid_id}>{bid.supplier_name} · {formatMoney(bid.total_cents)}</option>
              ))}
            </select>
          ) : (
            matrix.lines.map((line) => (
              <div key={line.id} className="flex items-center gap-2">
                <span className="w-56">{line.line_no}. {line.description}</span>
                <select className="border border-slate-200 rounded px-2 py-1" value={picks[line.id] || ''} onChange={(e) => setPicks({ ...picks, [line.id]: e.target.value })}>
                  <option value="">{t('sourcing.award.supplier')}</option>
                  {bids.filter((bid) => bid.lines.some((row) => Number(row.event_line_id) === Number(line.id) && row.quoted)).map((bid) => {
                    const cell = bid.lines.find((row) => Number(row.event_line_id) === Number(line.id));
                    return <option key={bid.bid_id} value={bid.bid_id}>{bid.supplier_name} · {formatMoney(cell.unit_price_cents)}</option>;
                  })}
                </select>
              </div>
            ))
          )}
          <textarea className="w-full border border-slate-200 rounded px-2 py-1" rows={2} placeholder={t('sourcing.award.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
          <button type="button" disabled={busy} onClick={propose} className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold">
            {t('sourcing.award.propose')}
          </button>
        </div>
      )}
      {!award && !canPropose && <p className="text-slate-500">{t('sourcing.award.notReady')}</p>}
    </div>
  );
}
