import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

describe('Vercel functions entrypoint', () => {
  test('functions keys match files under api/ and include schema.sql', () => {
    const vercelPath = path.join(repoRoot, 'vercel.json');
    const config = JSON.parse(fs.readFileSync(vercelPath, 'utf8'));
    const functions = config.functions || {};
    const keys = Object.keys(functions);

    assert.ok(keys.length > 0, 'vercel.json must declare at least one function');
    for (const key of keys) {
      assert.match(
        key,
        /^api\//,
        `functions key "${key}" must live under api/ (CLI 59 unmatched-function-pattern)`
      );
      if (!key.includes('*')) {
        assert.ok(
          fs.existsSync(path.join(repoRoot, key)),
          `functions key "${key}" must match a committed file`
        );
      }
      assert.equal(functions[key].includeFiles, 'server/src/schema.sql');
    }

    assert.ok(fs.existsSync(path.join(repoRoot, 'api/index.js')));
    assert.ok(fs.existsSync(path.join(repoRoot, 'server/src/schema.sql')));
  });
});
