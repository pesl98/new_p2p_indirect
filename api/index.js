/**
 * Vercel Node Function entrypoint (must live under `api/`).
 *
 * CLI 59.x validates `vercel.json` `functions` keys against files in `api/`.
 * Root `app.js` is no longer a valid functions pattern (unmatched-function-pattern).
 *
 * Locally, `npm start` still uses `server/src/index.js` (listen on PORT).
 *
 * On Vercel (`VERCEL` / `VERCEL_ENV`):
 * - TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are required
 * - SQL goes over HTTP POST /v2/pipeline (no native libsql wheel)
 * - Missing Turso shows a configuration page instead of FUNCTION_INVOCATION_FAILED
 *
 * Static UI: `npm run build` copies `client/dist` → `public/` (Vercel CDN).
 * express.static is ignored on Vercel. `/api/*` is rewritten to this function.
 */

import { createApp, startupErrorApp } from '../server/src/app.js';

let app;
try {
  app = createApp();
} catch (error) {
  app = startupErrorApp(error);
}

export default app;
