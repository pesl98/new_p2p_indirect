/**
 * Readable Turso/Vercel configuration pages instead of FUNCTION_INVOCATION_FAILED.
 */

import { TURSO_REQUIRED_MSG } from './dbConfig.js';

export function wantsJson(req) {
  const accept = String(req.headers?.accept || '');
  const path = req.path || req.url || '';
  return path.startsWith('/api') || accept.includes('application/json');
}

function escapeHtml(message) {
  return String(message)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function previewDbSteps() {
  return `<h2>Preview needs its own database</h2>
  <ol>
    <li>Create <code>procureflow-&lt;slug&gt;-preview</code> in the same Turso group and location as production.</li>
    <li>On the Vercel <strong>Preview</strong> environment set <code>TURSO_PREVIEW_DATABASE_URL</code> and <code>TURSO_PREVIEW_AUTH_TOKEN</code>.</li>
    <li>A preview URL and token are enough. Set <code>TURSO_PRODUCTION_DATABASE_URL</code> (no token) when you also have the production URL on Preview, so the host can be compared. <code>vercel:customer</code> copies <code>TURSO_DATABASE_URL</code> and <code>TURSO_AUTH_TOKEN</code> onto Preview; those are compared and are not the preview connection.</li>
    <li>The preview host must not be the production host. Scheme (<code>libsql</code>, <code>https</code>, <code>http</code>, <code>wss</code>), path, and query are ignored. A legacy <code>name.turso.io</code> host and a regional <code>name.aws-….turso.io</code> host are the same database. The preview token must not equal the production token when that token is present.</li>
    <li>Redeploy the Preview. <code>ALLOW_PREVIEW_PRODUCTION_DATABASE=allow</code> is ignored when a valid preview database is set. It serves production only when Preview has no valid database of its own.</li>
  </ol>`;
}

export function configErrorHtml(message, { code } = {}) {
  const detail = escapeHtml(message);
  const steps = code === 'currency_misconfigured'
    ? `<h2>Currency</h2>
  <ol>
    <li>Project → Settings → Environment Variables</li>
    <li><code>CURRENCY</code> — <code>EUR</code> (default) or <code>USD</code>. Leave it unset for EUR.</li>
    <li>An unknown value refuses to boot. It does not fall back, and it does not convert stored cents.</li>
    <li>Enable <strong>Production</strong> and <strong>Preview</strong> (or All Environments)</li>
    <li>Redeploy after saving — env changes do not apply to an old deploy</li>
  </ol>`
    : (code === 'preview_db_unconfigured'
      || code === 'preview_db_matches_production'
      || code === 'preview_db_token_matches_production')
    ? previewDbSteps()
    : `<h2>Set these on Vercel</h2>
  <ol>
    <li>Project → Settings → Environment Variables</li>
    <li><code>TURSO_DATABASE_URL</code> — from <code>turso db show … --url</code></li>
    <li><code>TURSO_AUTH_TOKEN</code> — from <code>turso db tokens create …</code> (database token, not an org JWT)</li>
    <li>Enable <strong>Production</strong> and <strong>Preview</strong> (or All Environments)</li>
    <li>Redeploy this Preview after saving — env changes do not apply to an old deploy</li>
  </ol>`;
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
  ${steps}
</body>
</html>`;
}

export function sendConfigError(req, res, error, statusCode = 503) {
  const message = error?.message || TURSO_REQUIRED_MSG;
  const status = error?.statusCode || statusCode;
  if (wantsJson(req)) {
    const body = {
      error: error?.name || 'TursoConfigError',
      detail: message
    };
    if (error?.code) body.code = error.code;
    return res.status(status).json(body);
  }
  return res.status(status).type('html').send(configErrorHtml(message, { code: error?.code }));
}

export function mountConfigErrorApp(app, message, statusCode = 503, meta = {}) {
  const handler = (req, res) => {
    sendConfigError(req, res, {
      message,
      name: meta.name || 'TursoConfigError',
      code: meta.code,
      statusCode
    }, statusCode);
  };
  app.use(handler);
  return app;
}
