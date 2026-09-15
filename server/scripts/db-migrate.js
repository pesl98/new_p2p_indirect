#!/usr/bin/env node
/**
 * Apply schema.sql + existing migrations to the configured customer DB.
 * Does not seed unless `--seed` (destructive demo wipe).
 *
 *   npm run db:migrate
 *   npm run db:migrate -- --seed
 *   npm run db:migrate -- --turso --json
 */
import { runProvisionCli } from '../src/provision.js';

const code = await runProvisionCli({
  command: 'migrate',
  argv: process.argv.slice(2)
});
process.exit(code);
