import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LOCALE,
  categoryLabel,
  getLocale,
  hasMessage,
  presentError,
  presentNotice,
  setLocale,
  statusLabel,
  t
} from './i18n.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(name) && !name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

describe('Dutch UI catalog', () => {
  test('default locale is nl-NL and t interpolates', () => {
    assert.equal(DEFAULT_LOCALE, 'nl-NL');
    assert.equal(getLocale(), 'nl-NL');
    assert.equal(setLocale('en-US'), 'nl-NL');
    assert.equal(t('common.save'), 'Opslaan');
    assert.equal(t('notice.partialBilling', { p1: '2', p2: '4 eenheden' }), 'Deelfacturatie: 2 van 4 eenheden gefactureerd.');
    assert.equal(statusLabel('draft'), 'Concept');
    assert.equal(categoryLabel('Office Supplies'), 'Kantoorbenodigdheden');
    assert.equal(categoryLabel('All'), 'Alle categorieën');
  });

  test('API codes and known sentences become Dutch, unknown text does not stay English', () => {
    assert.match(presentError('sso_not_configured'), /niet geconfigureerd/);
    assert.match(presentError({ message: 'Invalid email or password' }), /Ongeldig e-mailadres/);
    assert.equal(presentError('Supplier OfficePro is not active.'), 'Leverancier OfficePro is niet actief.');
    const unknown = presentError('Something went wrong in English');
    assert.equal(unknown, t('errors.requestRejected'));
    assert.doesNotMatch(unknown, /English/);
  });

  test('stored match and success sentences render in Dutch', () => {
    assert.match(
      presentNotice('Goods receipt recorded successfully'),
      /Goederenontvangst/
    );
    assert.match(
      presentNotice('Price discrepancy: Billed at € 10,00 vs authorized PO price € 8,00 (+25.00%).'),
      /Prijsafwijking/
    );
    assert.match(
      presentNotice('Exact match: 2 hours at € 10,00 matches PO & physical receipts.'),
      /2 uur/
    );
    assert.equal(presentNotice(''), t('notice.saved'));
    assert.equal(presentNotice('Unmapped server sentence'), t('notice.saved'));
  });

  test('every t() call in the client has a Dutch catalog entry', () => {
    const missing = [];
    for (const file of walk(here)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const match of src.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) {
        if (!hasMessage(match[1])) missing.push(`${path.relative(here, file)}: ${match[1]}`);
      }
    }
    assert.deepEqual(missing, []);
  });
});
