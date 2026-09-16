#!/usr/bin/env node
/**
 * Push TURSO_* + SESSION_SECRET to a linked Vercel project and redeploy.
 * Dry-run by default. Never invents secrets. Never seeds.
 *
 *   npm run vercel:customer -- --slug acme
 *   npm run vercel:customer -- --slug acme --apply
 */
import { runVercelCustomerCli } from '../src/vercelCustomer.js';

const code = await runVercelCustomerCli({
  argv: process.argv.slice(2)
});
process.exit(code);
