#!/usr/bin/env node
/**
 * HTTP smoke against a running customer deploy (local or Vercel).
 *
 *   npm run smoke
 *   npm run smoke -- --base-url https://<customer>.vercel.app
 *   BASE_URL=http://127.0.0.1:5000 npm run smoke
 */
import { runSmokeCli } from '../src/smoke.js';

const code = await runSmokeCli({
  argv: process.argv.slice(2)
});
process.exit(code);
