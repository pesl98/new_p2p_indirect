/**
 * Readable Turso/Vercel configuration pages instead of FUNCTION_INVOCATION_FAILED.
 */

import { TURSO_REQUIRED_MSG } from './dbConfig.js';

export function wantsJson(req) {
  const accept = String(req.headers?.accept || '');
  const path = req.path || req.url || '';
  return path.startsWith('/api') || accept.includes('application/json');
}

export function configErrorHtml(message) {
  const detail = String(message)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ProcureFlow — configuration</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 42rem;
           margin: 3rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
    code { background: #f4f4f4; padding: 0.1em 0.35em; border-radius: 4px; }
    h1 { font-size: 1.5rem; }
  </style>
</head>
<body>
  <h1>ProcureFlow</h1>
  <p>${detail}</p>
  <h2>Set these on Vercel</h2>
  <ol>
    <li>Project → Settings → Environment Variables</li>
    <li><code>TURSO_DATABASE_URL</code> — from <code>turso db show … --url</code></li>
    <li><code>TURSO_AUTH_TOKEN</code> — from <code>turso db tokens create …</code> (database token, not an org JWT)</li>
    <li>Enable <strong>Production</strong> and <strong>Preview</strong> (or All Environments)</li>
    <li>Redeploy this Preview after saving — env changes do not apply to an old deploy</li>
  </ol>
</body>
</html>`;
}

export function sendConfigError(req, res, error, statusCode = 503) {
  const message = error?.message || TURSO_REQUIRED_MSG;
  const status = error?.statusCode || statusCode;
  if (wantsJson(req)) {
    return res.status(status).json({
      error: error?.name || 'TursoConfigError',
      detail: message
    });
  }
  return res.status(status).type('html').send(configErrorHtml(message));
}

export function mountConfigErrorApp(app, message, statusCode = 503) {
  const handler = (req, res) => {
    sendConfigError(req, res, { message, name: 'TursoConfigError', statusCode }, statusCode);
  };
  app.use(handler);
  return app;
}
