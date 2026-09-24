#!/usr/bin/env node
/**
 * Offboard one customer: strip Vercel Production+Preview customer env, then
 * destroy that Turso database. Dry-run by default.
 * --apply does not destroy unless --confirm-slug matches the normalized slug.
 * Never seeds. Never invents secrets. Does not delete the Vercel project.
 *
 *   npm run offboard:customer -- --slug acme
 *   npm run offboard:customer -- --slug acme --apply --confirm-slug acme
 */
import { runOffboardCustomerCli } from '../src/offboardCustomer.js';

const code = await runOffboardCustomerCli({
  argv: process.argv.slice(2)
});
process.exit(code);
