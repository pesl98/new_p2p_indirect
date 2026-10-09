/**
 * Mail is not a control. A missing or invalid provider skips the send
 * and the buyer still gets the copy-link panel. The plaintext token is
 * only in the message argument, never written here.
 */

import { sendWithNone } from './providers/none.js';
import { smtpSend } from './providers/smtp.js';

export function loadMailConfig(env = process.env) {
  const raw = String(env.MAIL_PROVIDER || 'none').trim().toLowerCase();
  const provider = raw === 'smtp' ? 'smtp' : 'none';
  return {
    provider: raw === 'smtp' || raw === '' || raw === 'none' ? provider : 'none',
    invalid: raw !== '' && raw !== 'none' && raw !== 'smtp',
    from: String(env.MAIL_FROM || '').trim(),
    replyTo: String(env.MAIL_REPLY_TO || '').trim(),
    smtpUrl: String(env.MAIL_SMTP_URL || '').trim()
  };
}

export function mailIsConfigured(config = loadMailConfig()) {
  return config.provider === 'smtp' && Boolean(config.from) && Boolean(config.smtpUrl);
}

/**
 * @returns {{ status: 'sent'|'skipped'|'failed', provider: string }}
 * `error` is a short code, never the SMTP dialogue.
 */
export async function sendMail(message, options = {}) {
  const config = options.config || loadMailConfig(options.env);
  if (config.invalid) {
    console.warn('mail: MAIL_PROVIDER is not none or smtp; skipping');
    return { status: 'skipped', provider: 'none' };
  }
  if (config.provider !== 'smtp') {
    return sendWithNone();
  }
  if (!config.from || !config.smtpUrl) {
    console.warn('mail: smtp is selected but MAIL_FROM or MAIL_SMTP_URL is missing; skipping');
    return { status: 'skipped', provider: 'smtp' };
  }
  const payload = {
    from: config.from,
    replyTo: config.replyTo || config.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    tag: message.tag || null
  };
  try {
    if (typeof options.transport === 'function') {
      await options.transport(payload);
    } else {
      await smtpSend(payload, config.smtpUrl);
    }
    return { status: 'sent', provider: 'smtp' };
  } catch (error) {
    console.error('mail: send failed', error?.code || error?.name || 'smtp_error');
    return { status: 'failed', provider: 'smtp' };
  }
}
