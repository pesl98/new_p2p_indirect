/**
 * Keep work alive after the HTTP response on Vercel (waitUntil).
 * Tests pass waitUntil. Elsewhere the promise still runs, and a rejection
 * is logged without the SMTP dialogue.
 */

export function scheduleBackground(work, options = {}) {
  const promise = Promise.resolve()
    .then(work)
    .catch((error) => {
      console.error('background:', error?.code || error?.name || 'background_error');
    });
  const env = options.env || process.env;
  const onVercel = options.onVercel === true || String(env.VERCEL || '') === '1';
  if (onVercel && typeof options.waitUntil === 'function') {
    options.waitUntil(promise);
  } else if (onVercel && typeof options.waitUntil !== 'function') {
    import('@vercel/functions')
      .then((mod) => {
        if (typeof mod.waitUntil === 'function') mod.waitUntil(promise);
      })
      .catch(() => {});
  }
  return promise;
}
