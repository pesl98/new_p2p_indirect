#!/usr/bin/env node
/**
 * Load the demo tenant into the configured Preview database.
 * Refuses unless VERCEL_ENV=preview and the preview URL is not the production URL.
 * A second run does not wipe or duplicate. This is not `npm run seed`.
 *
 *   VERCEL_ENV=preview \
 *   TURSO_PREVIEW_DATABASE_URL=libsql://… \
 *   TURSO_PREVIEW_AUTH_TOKEN=… \
 *   TURSO_PRODUCTION_DATABASE_URL=libsql://… \
 *   npm run db:seed:preview
 */
import { loadDbConfig } from '../src/dbConfig.js';
import { openDatabase } from '../src/db.js';
import { assertPreviewSeedTarget, seedPreviewDatabase } from '../src/previewSeed.js';

const config = loadDbConfig();
try {
  assertPreviewSeedTarget(config);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const db = await openDatabase(config);
try {
  const result = await seedPreviewDatabase(db);
  if (result.action === 'skipped') {
    console.log('Preview database already has the demo tenant. Nothing changed.');
  } else {
    console.log('Preview database loaded the demo tenant.');
  }
} finally {
  if (typeof db.close === 'function') db.close();
}
