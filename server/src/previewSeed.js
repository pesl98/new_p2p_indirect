/**
 * Idempotent demo load for a Preview database.
 * The destructive wipe stays in seed.js (`npm run seed`). This path inserts
 * the same demo rows only when the database has no users and no departments.
 */

import { assertDeployableConfig } from './dbConfig.js';
import { DEMO_ADMIN_EMAIL, insertDemoData } from './seed.js';

export async function previewSeedState(db) {
  const users = await db.prepare('SELECT COUNT(*) AS n FROM users').get();
  const depts = await db.prepare('SELECT COUNT(*) AS n FROM departments').get();
  const demo = await db.prepare(
    'SELECT id FROM users WHERE lower(email) = lower(?)'
  ).get(DEMO_ADMIN_EMAIL);
  const userCount = Number(users?.n || 0);
  const deptCount = Number(depts?.n || 0);
  if (demo) return { state: 'seeded', userCount, deptCount };
  if (userCount > 0 || deptCount > 0) return { state: 'occupied', userCount, deptCount };
  return { state: 'empty', userCount, deptCount };
}

export async function seedPreviewDatabase(db) {
  const state = await previewSeedState(db);
  if (state.state === 'seeded') {
    return { action: 'skipped', state };
  }
  if (state.state === 'occupied') {
    const error = new Error(
      'Refusing to seed: this database has users or departments and is not the demo tenant.'
    );
    error.code = 'preview_seed_refused';
    throw error;
  }
  await insertDemoData(db);
  return { action: 'seeded', state: await previewSeedState(db) };
}

export function assertPreviewSeedTarget(config) {
  assertDeployableConfig(config);
  if (config.vercelEnv !== 'preview' || !config.previewDatabase) {
    const error = new Error(
      'db:seed:preview only runs when VERCEL_ENV=preview and TURSO_PREVIEW_DATABASE_URL '
      + 'points at a different database than production.'
    );
    error.code = 'preview_seed_target';
    throw error;
  }
  return config;
}
