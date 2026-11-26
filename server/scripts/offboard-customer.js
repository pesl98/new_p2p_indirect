#!/usr/bin/env node
/**
 * Offboard one customer: strip the per-target Vercel env list, dump the Turso
 * database outside this git checkout, then destroy that database.
 * Dry-run by default. --apply does not mutate unless --confirm-slug matches.
 * Never seeds. Never invents secrets. Never prints the dump. Does not delete
 * the Vercel project, does not destroy the preview database, and does not run
 * `turso db tokens invalidate`.
 *
 *   npm run offboard:customer -- --slug acme
 *   npm run offboard:customer -- --slug acme --apply --confirm-slug acme
 */
import { runOffboardCustomerCli } from '../src/offboardCustomer.js';

const code = await runOffboardCustomerCli({
  argv: process.argv.slice(2)
});
process.exit(code);
