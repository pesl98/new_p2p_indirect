/**
 * Keep work alive after the HTTP response on Vercel (waitUntil).
 * On Vercel the platform helper from @vercel/functions is used unless the caller passes
 * its own waitUntil (tests do). Elsewhere the promise still runs, and a rejection is
 * logged by code only, never with the SMTP dialogue.
 */

import { waitUntil as vercelWaitUntil } from '@vercel/functions';

export function scheduleBackground(work, options = {}) {
  const promise = Promise.resolve()
    .then(work)
    .catch((error) => {
      console.error('background:', error?.code || error?.name || 'background_error');
    });
  const env = options.env || process.env;
  const onVercel = options.onVercel === true || String(env.VERCEL || '') === '1';
  if (onVercel) {
    const keepAlive = typeof options.waitUntil === 'function' ? options.waitUntil : vercelWaitUntil;
    try {
      keepAlive(promise);
    } catch (error) {
      // Outside a Vercel request context there is nothing to extend.
      console.error('background: waitUntil unavailable', error?.code || error?.name || 'waitUntil_error');
    }
  }
  return promise;
}
