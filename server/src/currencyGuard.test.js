import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/src');

function sourceFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(js|jsx)$/.test(name) && !name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

/**
 * A `$` is allowed only as the start of a template interpolation (`${`).
 * Currency display goes through formatMoney, which already includes the symbol.
 */
function currencyDollars(source) {
  const hits = [];
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let quote = null;
  let line = 1;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1] || '';
    if (c === '\n') line += 1;
    if (inLine) {
      if (c === '\n') inLine = false;
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (!quote && c === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (!quote && c === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    if (quote) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      else if (c === '$' && next !== '{') hits.push(line);
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      i += 1;
      continue;
    }
    if (c === '$' && next !== '{') hits.push(line);
    i += 1;
  }
  return hits;
}

describe('client currency guard', () => {
  test('client source does not hardcode a $ currency format or USD label', () => {
    const failures = [];
    for (const file of sourceFiles(clientSrc)) {
      const text = fs.readFileSync(file, 'utf8');
      const dollars = currencyDollars(text);
      if (dollars.length) {
        failures.push(`${path.relative(clientSrc, file)}: $ on line ${dollars.join(', ')}`);
      }
      if (/\bUSD\b/.test(text)) {
        failures.push(`${path.relative(clientSrc, file)}: USD`);
      }
      if (/Intl\.NumberFormat|toLocaleString\([^)]*currency/.test(text)) {
        failures.push(`${path.relative(clientSrc, file)}: local currency format`);
      }
    }
    assert.deepEqual(failures, []);
  });
});
