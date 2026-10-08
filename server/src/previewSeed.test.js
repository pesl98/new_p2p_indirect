import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryDatabase } from './db.js';
import { loadDbConfig } from './dbConfig.js';
import { assertPreviewSeedTarget, previewSeedState, seedPreviewDatabase } from './previewSeed.js';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts/seed-preview.js');

describe('preview demo seed', () => {
  test('empty database loads the demo tenant once', async () => {
    const db = await createMemoryDatabase();
    assert.equal((await previewSeedState(db)).state, 'empty');
    const first = await seedPreviewDatabase(db);
    assert.equal(first.action, 'seeded');
    assert.equal(first.state.state, 'seeded');
    const users = await db.prepare('SELECT COUNT(*) AS n FROM users').get();
    assert.equal(Number(users.n), 8);
    const elena = await db.prepare(
      `SELECT role FROM users WHERE email = 'elena.rostova@company.com'`
    ).get();
    assert.equal(elena.role, 'admin');
    const second = await seedPreviewDatabase(db);
    assert.equal(second.action, 'skipped');
    assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n), 8);
    db.close();
  });

  test('a database that already has departments is refused', async () => {
    const db = await createMemoryDatabase();
    await db.prepare(`INSERT INTO departments (code, name) VALUES (?, ?)`).run('OPS', 'Operations');
    await assert.rejects(
      () => seedPreviewDatabase(db),
      (error) => error.code === 'preview_seed_refused'
    );
    assert.equal(await db.prepare('SELECT id FROM users WHERE email = ?').get('elena.rostova@company.com'), undefined);
    db.close();
  });

  test('the command refuses unless the process is aimed at a preview database', () => {
    const blocked = loadDbConfig({
      VERCEL: '1',
      VERCEL_ENV: 'production',
      TURSO_DATABASE_URL: 'libsql://prod.turso.io',
      TURSO_AUTH_TOKEN: 'prod-token'
    });
    assert.throws(
      () => assertPreviewSeedTarget(blocked),
      (error) => error.code === 'preview_seed_target'
    );
    const preview = loadDbConfig({
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      TURSO_DATABASE_URL: 'libsql://prod.turso.io',
      TURSO_AUTH_TOKEN: 'prod-token',
      TURSO_PREVIEW_DATABASE_URL: 'libsql://preview.turso.io',
      TURSO_PREVIEW_AUTH_TOKEN: 'preview-token'
    });
    assert.equal(assertPreviewSeedTarget(preview).previewDatabase, true);
    const previewOnly = loadDbConfig({
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      TURSO_PREVIEW_DATABASE_URL: 'libsql://preview.turso.io',
      TURSO_PREVIEW_AUTH_TOKEN: 'preview-token'
    });
    assert.equal(assertPreviewSeedTarget(previewOnly).previewDatabase, true);
  });

  test('the CLI exits before opening a database when preview is not configured', async () => {
    const env = { ...process.env };
    for (const key of [
      'VERCEL',
      'VERCEL_ENV',
      'TURSO_DATABASE_URL',
      'TURSO_AUTH_TOKEN',
      'TURSO_PREVIEW_DATABASE_URL',
      'TURSO_PREVIEW_AUTH_TOKEN',
      'TURSO_PRODUCTION_DATABASE_URL',
      'ALLOW_PREVIEW_PRODUCTION_DATABASE'
    ]) {
      delete env[key];
    }
    const { code, stderr } = await runNode(scriptPath, [], env);
    assert.equal(code, 1);
    assert.match(stderr, /VERCEL_ENV=preview/);
  });
});

function runNode(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}
