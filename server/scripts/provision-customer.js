#!/usr/bin/env node
/**
 * Empty-customer path: schema migrate, optional first-admin bootstrap.
 * Never seeds. Turso CLI stays human; Vercel env + redeploy is
 * `npm run vercel:customer`.
 *
 *   npm run provision:customer
 *   npm run provision:customer -- --email admin@acme.test --password '…'
 */
import { runCustomerProvisionCli } from '../src/provisionCustomer.js';

const code = await runCustomerProvisionCli({
  argv: process.argv.slice(2)
});
process.exit(code);
