#!/usr/bin/env node
/**
 * Print DB mode, table count, and health for the configured customer DB.
 * Does not seed. Opens without applying schema so an empty file stays empty.
 *
 *   npm run db:status
 *   npm run db:status -- --turso --json
 */
import { runProvisionCli } from '../src/provision.js';

const code = await runProvisionCli({
  command: 'status',
  argv: process.argv.slice(2)
});
process.exit(code);
