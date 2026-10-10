/**
 * Sourcing mail (Sprint 8d). Mail is never a control: the copy-link panel and the portal work
 * with MAIL_PROVIDER unset, and a failed send is recorded, never rolled back into the business
 * write. Every send happens after the commit.
 *
 * The delivery record (sourcing_mail_log) holds the kind, the status, and the provider. It
 * never holds the message text, a link, or a token. The plaintext portal link exists only in
 * the message argument and the API response of publish and rotate.
 */

import { scheduleBackground } from './background.js';
import { loadMailConfig, mailIsConfigured, sendMail } from './mail/index.js';
import { utcIso } from './sourcingConfig.js';

export const MAIL_KINDS = Object.freeze([
  'invitation',
  'link_rotated',
  'deadline_extended',
  'cancelled',
  'qa_answer',
  'bid_receipt',
  'award_outcome'
]);

export function mailStatusOf(result) {
  return result?.status === 'sent' ? 'sent' : result?.status === 'failed' ? 'failed' : 'skipped';
}

/** Awaiting is the rule when nothing leaves the process (provider none, or a test transport). */
export function shouldAwaitMail(options = {}) {
  if (options.awaitMail === true) return true;
  if (options.awaitMail === false) return false;
  if (typeof options.mailTransport === 'function') return false;
  return !mailIsConfigured(loadMailConfig(options.env));
}

/** Run mail work after the response on Vercel, inline when nothing is sent over the network. */
export function runMailAfterCommit(work, options = {}) {
  if (shouldAwaitMail(options)) return work();
  scheduleBackground(work, options);
  return Promise.resolve(null);
}

export async function recordMail(db, eventId, rows, now = new Date()) {
  if (!rows.length) return;
  const stamp = utcIso(now);
  const tuples = rows.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
  await db.prepare(`
    INSERT INTO sourcing_mail_log (event_id, invitation_id, kind, status, provider, created_at)
    VALUES ${tuples}
  `).run(...rows.flatMap((row) => [
    eventId, row.invitation_id ?? null, row.kind, row.status, row.provider || 'none', stamp
  ]));
}

/**
 * Send each message, then write the delivery record in one INSERT. Failures are results,
 * never exceptions. `messages`: { invitation_id, kind, to, subject, text }.
 */
export async function sendSourcingMails(db, eventId, messages, options = {}) {
  const results = [];
  for (const message of messages) {
    let result;
    try {
      result = await sendMail({
        to: message.to,
        subject: message.subject,
        text: message.text,
        tag: `sourcing_${message.kind}`
      }, { transport: options.mailTransport, env: options.env, timeoutMs: options.mailTimeoutMs, config: options.mailConfig });
    } catch (error) {
      console.error('mail: send failed', error?.code || error?.name || 'mail_error');
      result = { status: 'failed', provider: 'unknown' };
    }
    results.push({
      invitation_id: message.invitation_id ?? null,
      kind: message.kind,
      status: mailStatusOf(result),
      provider: result?.provider || 'none'
    });
  }
  try {
    await recordMail(db, eventId, results, options.now);
  } catch (error) {
    // The mail went out (or failed) either way; a missing log row must not surface as an error.
    console.error('mail: delivery record failed', error?.code || error?.name || 'record_error');
  }
  return results;
}

/** Admin overview for the Integraties screen. No addresses, no text. */
export async function mailOverview(db, env = process.env) {
  const config = loadMailConfig(env);
  const counts = await db.prepare(`
    SELECT kind, status, COUNT(*) AS n FROM sourcing_mail_log GROUP BY kind, status
  `).all();
  const failures = await db.prepare(`
    SELECT l.kind, l.created_at, e.event_number
    FROM sourcing_mail_log l JOIN sourcing_events e ON e.id = l.event_id
    WHERE l.status = 'failed' ORDER BY l.id DESC LIMIT 10
  `).all();
  const invitations = await db.prepare(`
    SELECT delivery_status, COUNT(*) AS n FROM sourcing_invitations GROUP BY delivery_status
  `).all();
  return {
    provider: config.provider,
    configured: mailIsConfigured(config),
    invalid_provider: config.invalid,
    from_set: Boolean(config.from),
    smtp_url_set: Boolean(config.smtpUrl),
    copy_link_fallback: !mailIsConfigured(config),
    by_kind: counts.map((row) => ({ kind: row.kind, status: row.status, count: Number(row.n) })),
    invitation_delivery: invitations.map((row) => ({ status: row.delivery_status, count: Number(row.n) })),
    recent_failures: failures
  };
}

/* ---- message texts (Dutch first, English below; never a link or a token) ---- */

export function qaAnswerMessage(event, question, answer) {
  return {
    subject: `Antwoord op uw vraag over ${event.event_number}`,
    text: [
      `Er is een antwoord op een vraag over offerteaanvraag ${event.event_number}: ${event.title}.`,
      '',
      `Vraag: ${question}`,
      `Antwoord: ${answer}`,
      '',
      'Open uw persoonlijke link om het antwoord in het portaal te zien.',
      '',
      `An answer was given to a question about RFQ ${event.event_number}: ${event.title}.`,
      `Question: ${question}`,
      `Answer: ${answer}`
    ].join('\n')
  };
}

export function bidReceiptMessage(event, receipt) {
  return {
    subject: `Ontvangstbevestiging offerte ${event.event_number}`,
    text: [
      `Wij hebben uw offerte voor ${event.event_number} (${event.title}) ontvangen.`,
      `Revisie: ${receipt.revision}`,
      `Ingediend: ${receipt.submitted_at}`,
      `Referentie: ${String(receipt.content_sha256 || '').slice(0, 16)}`,
      'U kunt tot de sluitingstijd herzien of intrekken via uw persoonlijke link.',
      '',
      `We received your quote for ${event.event_number} (${event.title}). Revision ${receipt.revision}, submitted ${receipt.submitted_at}, reference ${String(receipt.content_sha256 || '').slice(0, 16)}.`
    ].join('\n')
  };
}

export function awardOutcomeMessage(event, awarded) {
  return awarded
    ? {
        subject: `Gunning ${event.event_number}`,
        text: [
          `Uw offerte voor ${event.event_number} (${event.title}) is gegund.`,
          'De inkoper neemt contact met u op. Een bestelling volgt via de gebruikelijke weg.',
          'Open uw persoonlijke link voor de uitkomst.',
          '',
          `Your quote for ${event.event_number} (${event.title}) has been awarded. Purchasing will contact you; an order follows.`
        ].join('\n')
      }
    : {
        subject: `Uitkomst ${event.event_number}`,
        text: [
          `Offerteaanvraag ${event.event_number} (${event.title}) is gegund. Uw offerte is dit keer niet gekozen.`,
          'Dank voor uw inschrijving.',
          '',
          `RFQ ${event.event_number} (${event.title}) has been awarded. Your quote was not selected this time. Thank you for bidding.`
        ].join('\n')
      };
}
