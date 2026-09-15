/**
 * Create the first admin on an empty tenant database.
 *
 * Usage:
 *   node server/src/bootstrapAdmin.js --name "Ada Admin" --email ada@acme.com --password 'choose-a-long-password'
 *
 * Refuses if any users already exist. Auth is local to this SQLite/Turso DB.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAuthConfig } from './auth.js';
import { openDatabase } from './db.js';
import { assertCustomerDbConfig } from './provision.js';
import { bootstrapFirstAdmin } from './usersService.js';

export const BOOTSTRAP_USAGE =
  'Usage: node server/src/bootstrapAdmin.js --email admin@customer.com --password \'...\' [--name "Ada Admin"]';

function write(stream, text) {
  if (!stream) return;
  if (typeof stream.write === 'function') stream.write(text);
}

export function parseBootstrapArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

export function isMainModule(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(path.resolve(argv1)).href;
  } catch {
    return false;
  }
}

export async function runBootstrapAdminCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  openDatabaseFn = openDatabase
} = {}) {
  const args = parseBootstrapArgs(argv);
  if (args.help === true || args.h === true) {
    write(stdout, `${BOOTSTRAP_USAGE}\n`);
    return 0;
  }
  const email = args.email;
  const password = args.password;
  const name = args.name || 'Administrator';
  const title = args.title || 'Administrator';

  if (!email || !password || email === true || password === true) {
    write(stderr, `${BOOTSTRAP_USAGE}\n`);
    return 1;
  }

  try {
    const dbConfig = assertCustomerDbConfig(env);
    const db = await openDatabaseFn(dbConfig);
    const config = loadAuthConfig(env);
    const user = await bootstrapFirstAdmin(db, { name, email, password, title }, {
      bcryptRounds: config.bcryptRounds
    });
    write(stdout, `Created first admin: ${user.name} <${user.email}> (id=${user.id})\n`);
    write(stdout, 'Sign in at /login with that email and password. Credentials are stored hashed in this tenant DB only.\n');
    return 0;
  } catch (error) {
    write(stderr, `${error.message || error}\n`);
    return error.statusCode === 409 ? 2 : 1;
  }
}

if (isMainModule()) {
  process.exit(await runBootstrapAdminCli());
}
