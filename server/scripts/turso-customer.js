#!/usr/bin/env node
/**
 * Create or reuse one classic libSQL Turso DB per customer and print
 * TURSO_* + SESSION_SECRET exports. Dry-run by default. Never seeds.
 * Never calls Vercel. Never destroys a database.
 *
 *   npm run turso:customer -- --slug acme
 *   npm run turso:customer -- --slug acme --apply
 */
import { runTursoCustomerCli } from '../src/tursoCustomer.js';

const code = await runTursoCustomerCli({
  argv: process.argv.slice(2)
});
process.exit(code);
