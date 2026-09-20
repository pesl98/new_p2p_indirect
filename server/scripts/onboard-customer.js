#!/usr/bin/env node
/**
 * One-command customer onboard: Turso + Vercel env + empty-tenant provision.
 * Dry-run by default. Never seeds. Never invents Turso secrets.
 *
 *   npm run onboard:customer -- --slug acme
 *   npm run onboard:customer -- --slug acme --apply --email admin@acme.test --password '…'
 */
import { runOnboardCustomerCli } from '../src/onboardCustomer.js';

const code = await runOnboardCustomerCli({
  argv: process.argv.slice(2)
});
process.exit(code);
