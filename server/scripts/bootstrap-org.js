#!/usr/bin/env node
/**
 * Idempotent org skeleton for an empty customer DB.
 * Schema first (db:migrate), then default cost centers + FY budgets.
 * Never seeds and never creates users.
 *
 *   npm run bootstrap-org
 *   npm run bootstrap-org -- --json
 *   npm run provision:customer -- --with-org
 */
import { runBootstrapOrgCli } from '../src/bootstrapOrg.js';

const code = await runBootstrapOrgCli({
  argv: process.argv.slice(2)
});
process.exit(code);
