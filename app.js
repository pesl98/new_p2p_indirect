/**
 * Vercel Express entrypoint.
 *
 * Vercel detects `app.js` at the repo root (or src/) and deploys the default
 * export as a single Fluid Function. Locally, `node server/src/index.js`
 * still listens on PORT.
 *
 * On Vercel (`VERCEL` / `VERCEL_ENV`):
 * - TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are required
 * - SQL goes over HTTP POST /v2/pipeline (no native libsql wheel)
 * - Missing Turso shows a configuration page instead of FUNCTION_INVOCATION_FAILED
 *
 * Static UI: `npm run build` copies `client/dist` → `public/` (Vercel CDN).
 * express.static is ignored on Vercel.
 */

import { createApp, startupErrorApp } from './server/src/app.js';

let app;
try {
  app = createApp();
} catch (error) {
  app = startupErrorApp(error);
}

export default app;
