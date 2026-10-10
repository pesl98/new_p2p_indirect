import React, { useEffect, useMemo, useState } from 'react';
import { formatMoney, toCents } from '../money';
import { portalEn, portalNl } from '../i18n/parts/portal.js';

const catalogs = { nl: portalNl, en: portalEn };

function portalText(lang, key) {
  return catalogs[lang]?.[key] || catalogs.nl[key] || key;
}

function readToken() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const fromHash = params.get('t');
  if (fromHash) {
    sessionStorage.setItem('pf_portal_token', fromHash);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return fromHash;
  }
  return sessionStorage.getItem('pf_portal_token') || '';
}

function formatWhen(value, lang) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'nl-NL', {
    timeZone: 'Europe/Amsterdam',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

async function portalFetch(token, path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`/api/portal${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const error = new Error(body?.error || 'Portal request failed');
    error.code = body?.code;
    throw error;
  }
  return body;
}

export default function PortalApp() {
  const [lang, setLang] = useState(() => sessionStorage.getItem('pf_portal_lang') === 'en' ? 'en' : 'nl');
  const [token] = useState(readToken);
  const [view, setView] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState([]);
  const [validity, setValidity] = useState('');
  const [lead, setLead] = useState('');
  const [note, setNote] = useState('');
  const [question, setQuestion] = useState('');
  const [declineReason, setDeclineReason] = useState('');
  const label = (key) => portalText(lang, key);

  const load = async () => {
    const next = await portalFetch(token, '');
    setView(next);
    const bidLines = new Map((next.bid?.lines || []).map((line) => [line.event_line_id, line]));
    setLines(next.event.lines.map((line) => {
      const existing = bidLines.get(line.id);
      return {
        event_line_id: line.id,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit_of_measure,
        quoted: existing ? existing.quoted : true,
        price: existing?.unit_price_cents ? String(existing.unit_price_cents / 100).replace('.', ',') : '',
        lead: existing?.lead_time_days ?? '',
        comment: existing?.comment || ''
      };
    }));
    setValidity(next.bid?.validity_until || '');
    setLead(next.bid?.default_lead_time_days ?? '');
    setNote(next.bid?.supplier_note || '');
  };

  useEffect(() => {
    document.documentElement.lang = lang === 'en' ? 'en' : 'nl';
    sessionStorage.setItem('pf_portal_lang', lang);
  }, [lang]);

  useEffect(() => {
    if (!token) return;
    load().catch((err) => setError(err.message));
  }, [token]);

  const closed = view && (view.event.status === 'cancelled' || Date.parse(view.event.deadline_at) <= Date.parse(view.server_now));
  const canWrite = view && !closed && !view.invitation.declined_at && view.event.status === 'published';

  const total = useMemo(() => lines.reduce((sum, line) => {
    if (!line.quoted) return sum;
    const cents = toCents(String(line.price || '').trim());
    if (cents == null) return sum;
    return sum + cents * Number(line.quantity || 0);
  }, 0), [lines]);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => run(async () => {
    const payload = {
      submission_id: crypto.randomUUID(),
      validity_until: validity || null,
      default_lead_time_days: lead === '' ? null : Number(lead),
      supplier_note: note,
      lines: lines.map((line) => {
        if (!line.quoted) return { event_line_id: line.event_line_id, quoted: false, comment: line.comment };
        const cents = toCents(String(line.price || '').trim());
        if (cents == null) throw new Error(label('price'));
        return {
          event_line_id: line.event_line_id,
          quoted: true,
          unit_price_cents: cents,
          lead_time_days: line.lead === '' ? null : Number(line.lead),
          comment: line.comment
        };
      })
    };
    await portalFetch(token, '/bids', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  });

  if (!token) {
    return <main className="max-w-xl mx-auto p-8 text-sm">{label('missing')}</main>;
  }
  if (!view) {
    return <main className="max-w-xl mx-auto p-8 text-sm">{error || label('loading')}</main>;
  }

  return (
    <main className="max-w-3xl mx-auto p-4 sm:p-8 space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">{view.customer_name}</p>
          <h1 className="text-2xl font-bold text-slate-900">{label('title')}</h1>
          <p className="text-sm text-slate-600">{view.event.event_number} · {view.event.title}</p>
        </div>
        <div className="flex gap-2" aria-label={label('language')}>
          {['nl', 'en'].map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => setLang(code)}
              className={`px-3 py-1 rounded-full text-xs font-semibold ${lang === code ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200'}`}
            >
              {code.toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">{error}</p>}
      {view.event.status === 'cancelled' && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          {label('cancelled')} {view.event.cancel_reason}
        </p>
      )}
      {view.event.status !== 'cancelled' && closed && (
        <p className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">{label('closed')}</p>
      )}
      {view.invitation.declined_at && <p className="text-sm text-slate-600">{label('declined')}</p>}
      {view.outcome && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm space-y-2">
          <h2 className="font-semibold">{label('outcomeTitle')}</h2>
          <p>{view.outcome.awarded ? label('outcomeAwarded') : label('outcomeNotAwarded')}</p>
          {view.outcome.awarded && view.outcome.lines?.length > 0 && (
            <>
              <p className="font-semibold">{label('outcomeLines')}</p>
              <ul className="list-disc ml-5">
                {view.outcome.lines.map((line, index) => (
                  <li key={index}>
                    {line.description} · {line.quantity} × {formatMoney(line.unit_price_cents)} = {formatMoney(line.line_total_cents)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm space-y-1">
        <p>{label('deadline')}: {formatWhen(view.event.deadline_at, lang)}</p>
        <p>{label('now')}: {formatWhen(view.server_now, lang)}</p>
        {view.event.description && <p className="pt-2 whitespace-pre-wrap">{view.event.description}</p>}
      </section>

      {view.event.files?.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-semibold">{label('buyerFiles')}</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {view.event.files.map((file) => (
              <li key={file.id}>
                <button type="button" className="text-indigo-700 font-semibold" onClick={() => downloadFile(token, file)}>
                  {file.filename}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
        <h2 className="font-semibold">{label('lines')}</h2>
        {lines.map((line, index) => (
          <div key={line.event_line_id} className="border-t border-slate-100 pt-3 text-sm space-y-2">
            <p className="font-medium">{line.description}</p>
            <p className="text-slate-500">{label('quantity')}: {line.quantity} {line.unit}</p>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={!line.quoted}
                disabled={!canWrite}
                onChange={(event) => setLines(lines.map((row, i) => i === index ? { ...row, quoted: !event.target.checked } : row))}
              />
              {label('notOffered')}
            </label>
            {line.quoted && (
              <label className="block">
                {label('price')}
                <input
                  className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5"
                  value={line.price}
                  disabled={!canWrite}
                  onChange={(event) => setLines(lines.map((row, i) => i === index ? { ...row, price: event.target.value } : row))}
                />
              </label>
            )}
          </div>
        ))}
        <p className="text-sm">{label('total')}: {formatMoney(total)}</p>
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <label>
            {label('validity')}
            <input className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5" type="date" value={validity} disabled={!canWrite} onChange={(event) => setValidity(event.target.value)} />
          </label>
          <label>
            {label('lead')}
            <input className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5" value={lead} disabled={!canWrite} onChange={(event) => setLead(event.target.value)} />
          </label>
        </div>
        <label className="block text-sm">
          {label('note')}
          <textarea className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5" value={note} disabled={!canWrite} onChange={(event) => setNote(event.target.value)} />
        </label>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={submit} className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-semibold">
              {view.bid ? label('revise') : label('submit')}
            </button>
            {view.bid?.status === 'submitted' && (
              <button type="button" disabled={busy} onClick={() => run(() => portalFetch(token, '/bids/withdraw', { method: 'POST' }))} className="px-4 py-2 border border-slate-300 rounded-lg text-sm">
                {label('withdraw')}
              </button>
            )}
          </div>
        )}
        {view.bid?.content_sha256 && (
          <p className="text-xs text-slate-500 break-all">{label('receipt')} · {label('revision')} {view.bid.revision} · {view.bid.content_sha256}</p>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm space-y-2">
        <h2 className="font-semibold">{label('files')}</h2>
        <ul>
          {(view.bid?.files || []).map((file) => (
            <li key={file.id} className="flex gap-3 py-1">
              <button type="button" className="text-indigo-700 font-semibold" onClick={() => downloadFile(token, file)}>{file.filename}</button>
              {canWrite && (
                <button type="button" className="text-rose-700" onClick={() => run(() => portalFetch(token, `/files/${file.id}/remove`, { method: 'POST' }))}>
                  {label('remove')}
                </button>
              )}
            </li>
          ))}
        </ul>
        {canWrite && (
          <input type="file" accept="application/pdf,.pdf" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            run(async () => {
              const bytes = await file.arrayBuffer();
              await portalFetch(token, '/files', {
                method: 'POST',
                headers: { 'Content-Type': 'application/pdf', 'X-Filename': file.name },
                body: bytes
              });
            });
          }} />
        )}
      </section>

      {view.event.qa_enabled && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm space-y-2">
          <h2 className="font-semibold">{label('questions')}</h2>
          {(view.questions || []).map((row) => (
            <article key={row.id} className="border-t border-slate-100 pt-2">
              <p>{row.own ? label('own') : label('shared')}: {row.question}</p>
              {row.answer && <p className="text-slate-600">{label('answer')}: {row.answer}</p>}
            </article>
          ))}
          {canWrite && (
            <form onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                await portalFetch(token, '/questions', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ question })
                });
                setQuestion('');
              });
            }} className="flex gap-2">
              <input className="flex-1 rounded border border-slate-200 px-2 py-1.5" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={label('ask')} />
              <button type="submit" className="px-3 py-1.5 bg-slate-900 text-white rounded-lg text-sm">{label('send')}</button>
            </form>
          )}
        </section>
      )}

      {canWrite && (
        <section className="text-sm flex flex-wrap gap-2 items-end">
          <label className="flex-1">
            {label('declineReason')}
            <input className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5" value={declineReason} onChange={(event) => setDeclineReason(event.target.value)} />
          </label>
          <button type="button" className="px-3 py-2 text-rose-800" onClick={() => run(() => portalFetch(token, '/decline', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: declineReason })
          }))}>
            {label('decline')}
          </button>
        </section>
      )}
    </main>
  );
}

async function downloadFile(token, file) {
  const response = await fetch(`/api/portal/files/${file.id}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) return;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename || 'attachment.pdf';
  link.click();
  URL.revokeObjectURL(url);
}
