import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { t, presentError } from '../i18n';
import { formatMoney } from '../money';

function Money({ cents }) {
  return <>{cents == null ? '–' : formatMoney(cents)}</>;
}

export default function SourcingEvaluation({ detail, evaluation, currentUser, onReload, onError, formatTime = (value) => value }) {
  const [note, setNote] = useState('');
  const [scores, setScores] = useState({});
  const [override, setOverride] = useState('');
  const [blockers, setBlockers] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const mine = {};
    for (const row of evaluation?.my_scores || []) mine[row.bid_id] = String(row.quality_score);
    setScores(mine);
  }, [evaluation]);

  if (!evaluation) return <p className="text-slate-500">{t('common.loading')}</p>;
  const matrix = evaluation.matrix;
  const isOwner = Number(currentUser?.id) === Number(evaluation.owner_user_id);
  const canFinish = (isOwner || currentUser?.role === 'admin') && evaluation.status === 'closed';
  const canScore = evaluation.my_coi_status === 'none_declared' && evaluation.status === 'closed';
  const canDeclare = (evaluation.my_coi_status !== null || isOwner) && ['published', 'closed'].includes(evaluation.status);

  const run = async (work) => {
    setBusy(true);
    onError('');
    try {
      await work();
      await onReload();
    } catch (err) {
      onError(presentError(err, 'errors.sourcingSave'));
      if (Array.isArray(err?.blockers)) setBlockers(err.blockers);
    } finally {
      setBusy(false);
    }
  };

  const declare = (status) => run(() => api.declareSourcingCoi(detail.id, { status, note }));
  const saveScores = () => run(() => api.recordSourcingScores(detail.id, {
    scores: Object.entries(scores)
      .filter(([, value]) => value !== '')
      .map(([bidId, value]) => ({ bid_id: Number(bidId), quality_score: Number(value) }))
  }));
  const finish = () => run(async () => {
    setBlockers([]);
    await api.completeSourcingEvaluation(detail.id, { override_reason: override });
  });

  return (
    <div className="space-y-4">
      {evaluation.sealed && (
        <div className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-3">
          <p className="font-semibold">{t('sourcing.comparison.sealedTitle')}</p>
          <p className="mt-1">{t('sourcing.comparison.sealedBody', { time: formatTime(evaluation.deadline_at) })}</p>
          {evaluation.prices_hidden && <p className="mt-1">{t('sourcing.eval.coiPending')}</p>}
        </div>
      )}

      {canDeclare && (
        <div className="rounded-lg border border-slate-200 p-3 space-y-2">
          <p className="font-semibold">{t('sourcing.eval.coi')}</p>
          {evaluation.my_coi_status === 'none_declared' && <p>{t('sourcing.eval.coiYouNone')}</p>}
          {evaluation.my_coi_status === 'conflict_declared' && <p>{t('sourcing.eval.coiYouConflict')}</p>}
          <input
            className="w-full border border-slate-200 rounded px-2 py-1"
            placeholder={t('sourcing.eval.coiNote')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => declare('none_declared')} className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold">
              {t('sourcing.eval.coiNone')}
            </button>
            <button type="button" disabled={busy} onClick={() => declare('conflict_declared')} className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-xs font-semibold">
              {t('sourcing.eval.coiConflict')}
            </button>
          </div>
        </div>
      )}

      {matrix && (
        <>
          <div className="overflow-x-auto">
            <p className="font-semibold mb-1">{t('sourcing.eval.matrix')}</p>
            <table className="min-w-full text-sm border border-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left px-2 py-1">{t('sourcing.eval.line')}</th>
                  {matrix.bids.map((bid) => (
                    <th key={bid.bid_id} className="text-right px-2 py-1">
                      {bid.supplier_name}
                      {!bid.complete && <span className="block text-xs font-normal text-amber-700">{t('sourcing.eval.incomplete')}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.lines.map((line) => (
                  <tr key={line.id} className="border-t border-slate-100">
                    <td className="px-2 py-1">{line.line_no}. {line.description} × {line.quantity}</td>
                    {matrix.bids.map((bid) => {
                      const cell = bid.lines.find((row) => Number(row.event_line_id) === Number(line.id));
                      return (
                        <td key={bid.bid_id} className={`px-2 py-1 text-right ${cell?.is_line_lowest ? 'font-bold text-emerald-700' : ''}`}>
                          {cell?.quoted ? <Money cents={cell.unit_price_cents} /> : <span className="text-slate-400">{t('sourcing.eval.notQuoted')}</span>}
                          {cell?.is_line_lowest && <span className="block text-xs">{t('sourcing.eval.lowest')}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
                  <td className="px-2 py-1">{t('sourcing.comparison.total')}</td>
                  {matrix.bids.map((bid) => (
                    <td key={bid.bid_id} className={`px-2 py-1 text-right ${bid.is_lowest_complete_total ? 'text-emerald-700' : ''}`}>
                      <Money cents={bid.total_cents} />
                      {bid.is_lowest_complete_total && <span className="block text-xs">{t('sourcing.eval.lowestTotal')}</span>}
                    </td>
                  ))}
                </tr>
                <tr className="border-t border-slate-100">
                  <td className="px-2 py-1">{t('sourcing.eval.leadTime')}</td>
                  {matrix.bids.map((bid) => <td key={bid.bid_id} className="px-2 py-1 text-right">{bid.lead_time_days ?? '–'}</td>)}
                </tr>
              </tbody>
            </table>
          </div>

          <div className="overflow-x-auto">
            <p className="font-semibold mb-1">{t('sourcing.eval.scores')}</p>
            <table className="min-w-full text-sm border border-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left px-2 py-1">{t('sourcing.award.supplier')}</th>
                  <th className="text-right px-2 py-1">{t('sourcing.eval.price')}</th>
                  <th className="text-right px-2 py-1">{t('sourcing.eval.lead')}</th>
                  <th className="text-right px-2 py-1">{t('sourcing.eval.quality')}</th>
                  <th className="text-right px-2 py-1">{t('sourcing.eval.total')}</th>
                  <th className="text-right px-2 py-1">{t('sourcing.eval.rank')}</th>
                  {canScore && <th className="text-right px-2 py-1">{t('sourcing.eval.yourScore')}</th>}
                </tr>
              </thead>
              <tbody>
                {matrix.bids.map((bid) => (
                  <tr key={bid.bid_id} className="border-t border-slate-100">
                    <td className="px-2 py-1">{bid.supplier_name}</td>
                    <td className="px-2 py-1 text-right">{bid.price_score ?? '–'}</td>
                    <td className="px-2 py-1 text-right">{bid.lead_score ?? '–'}</td>
                    <td className="px-2 py-1 text-right">{bid.quality_score ?? '–'}</td>
                    <td className="px-2 py-1 text-right font-semibold">{bid.total_score ?? '–'}</td>
                    <td className="px-2 py-1 text-right">{bid.rank ?? '–'}</td>
                    {canScore && (
                      <td className="px-2 py-1 text-right">
                        <input
                          type="number" min="0" max="10" step="1"
                          className="w-16 border border-slate-200 rounded px-1 text-right"
                          value={scores[bid.bid_id] ?? ''}
                          onChange={(e) => setScores({ ...scores, [bid.bid_id]: e.target.value })}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {canScore && (
              <button type="button" disabled={busy} onClick={saveScores} className="mt-2 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold">
                {t('sourcing.eval.save')}
              </button>
            )}
            <details className="mt-2 text-xs text-slate-600">
              <summary className="cursor-pointer font-semibold">{t('sourcing.eval.how')}</summary>
              <ul className="list-disc ml-5 mt-1 space-y-1">
                <li>{t('sourcing.eval.howPrice')}</li>
                <li>{t('sourcing.eval.howLead')}</li>
                <li>{t('sourcing.eval.howQuality')}</li>
                <li>{t('sourcing.eval.howTotal')}</li>
              </ul>
            </details>
          </div>
        </>
      )}

      {canFinish && (
        <div className="rounded-lg border border-slate-200 p-3 space-y-2">
          {blockers.map((code) => (
            <p key={code} className="text-amber-700">{t(`sourcing.eval.blocked.${code}`)}</p>
          ))}
          {blockers.length > 0 && (
            <input
              className="w-full border border-slate-200 rounded px-2 py-1"
              placeholder={t('sourcing.eval.override')}
              value={override}
              onChange={(e) => setOverride(e.target.value)}
            />
          )}
          <button type="button" disabled={busy} onClick={finish} className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold">
            {t('sourcing.eval.finish')}
          </button>
        </div>
      )}
    </div>
  );
}
