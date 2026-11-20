import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { seedRefusal } from './seed.js';

const CUSTOMER_URL = 'libsql://procureflow-customer.example.test';
const PREVIEW_URL = 'libsql://procureflow-customer-preview.example.test';
const TOKEN = 'x'.repeat(24);

describe('destructive seed refuses a remote database', () => {
  test('a Turso shell is refused and the message does not contain the values', () => {
    const env = {
      TURSO_DATABASE_URL: CUSTOMER_URL,
      TURSO_AUTH_TOKEN: TOKEN
    };
    const message = seedRefusal(env, ['node', 'seed.js']);
    assert.match(message, /TURSO_DATABASE_URL/);
    assert.match(message, /TURSO_AUTH_TOKEN/);
    assert.equal(message.includes(CUSTOMER_URL), false);
    assert.equal(message.includes(TOKEN), false);
    assert.equal(message.includes('libsql'), false);
    assert.equal(seedRefusal(env, ['node', 'seed.js', '--force']), null);
  });

  test('preview variables and VERCEL are refused without printing values', () => {
    const preview = seedRefusal({
      TURSO_PREVIEW_DATABASE_URL: PREVIEW_URL,
      TURSO_PREVIEW_AUTH_TOKEN: TOKEN
    }, ['node', 'seed.js']);
    assert.match(preview, /TURSO_PREVIEW_DATABASE_URL/);
    assert.equal(preview.includes(PREVIEW_URL), false);
    assert.equal(preview.includes(TOKEN), false);

    const vercel = seedRefusal({ VERCEL: '1' }, ['node', 'seed.js']);
    assert.match(vercel, /Preview or Vercel/);
    assert.equal(seedRefusal({}, ['node', 'seed.js']), null);
    assert.equal(seedRefusal({
      TURSO_DATABASE_URL: '   ',
      TURSO_AUTH_TOKEN: ''
    }, ['node', 'seed.js']), null);
  });

  test('production-comparison URL and the preview hatch are refused without printing values', () => {
    const prodUrl = 'libsql://procureflow-customer-prod.example.test';
    const byUrl = seedRefusal({ TURSO_PRODUCTION_DATABASE_URL: prodUrl }, ['node', 'seed.js']);
    assert.match(byUrl, /TURSO_PRODUCTION_DATABASE_URL/);
    assert.equal(byUrl.includes(prodUrl), false);
    const hatch = seedRefusal({ ALLOW_PREVIEW_PRODUCTION_DATABASE: 'allow' }, ['node', 'seed.js']);
    assert.match(hatch, /ALLOW_PREVIEW_PRODUCTION_DATABASE/);
    assert.equal(hatch.includes('allow'), false);
  });
});
