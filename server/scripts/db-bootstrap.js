#!/usr/bin/env node
/**
 * Non-destructive org import: departments, users, budgets from JSON.
 * Does not seed and does not drop tables.
 *
 *   npm run db:bootstrap -- --file scripts/customer-org.example.json
 */
import { runBootstrapCli } from '../src/bootstrap.js';

const code = await runBootstrapCli({
  argv: process.argv.slice(2)
});
process.exit(code);
