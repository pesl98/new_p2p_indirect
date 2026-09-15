/**
 * Create the first admin on an empty tenant database.
 *
 * Usage:
 *   node server/src/bootstrapAdmin.js --name "Ada Admin" --email ada@acme.com --password 'choose-a-long-password'
 *
 * Refuses if any users already exist. Auth is local to this SQLite/Turso DB.
 */

import { getDb } from './db.js';
import { loadAuthConfig } from './auth.js';
import { bootstrapFirstAdmin } from './usersService.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
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

const args = parseArgs(process.argv.slice(2));
const email = args.email;
const password = args.password;
const name = args.name || 'Administrator';
const title = args.title || 'Administrator';

if (!email || !password) {
  console.error('Usage: node server/src/bootstrapAdmin.js --email admin@customer.com --password \'...\' [--name "Ada Admin"]');
  process.exit(1);
}

const db = await getDb();
const config = loadAuthConfig();
try {
  const user = await bootstrapFirstAdmin(db, { name, email, password, title }, {
    bcryptRounds: config.bcryptRounds
  });
  console.log(`Created first admin: ${user.name} <${user.email}> (id=${user.id})`);
  console.log('Sign in at /login with that email and password. Credentials are stored hashed in this tenant DB only.');
} catch (error) {
  console.error(error.message);
  process.exit(error.statusCode === 409 ? 2 : 1);
}
