import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { formatMoneyAmount, roundCents } from '../../shared/currency.js';
import { createApp } from './app.js';
import {
  CurrencyConfigError,
  deploymentCurrency,
  loadCurrencyConfig,
  withDeploymentCurrency
} from './currencyConfig.js';
import { formatMoney } from './money.js';

const EURO = '\u20ac';
const NBSP = '\u00a0';

function euro(rest) {
  return `${EURO}${NBSP}${rest}`;
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address();
        await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve());
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

describe('EUR formatter', () => {
  test('formats euros, negatives, zero, and large amounts from cents', () => {
    assert.equal(formatMoneyAmount(129500), euro('1.295,00'));
    assert.equal(formatMoneyAmount(0), euro('0,00'));
    assert.equal(formatMoneyAmount(-50), euro('-0,50'));
    assert.equal(formatMoneyAmount(50), euro('0,50'));
    assert.equal(formatMoneyAmount(100000000000), euro('1.000.000.000,00'));
    assert.equal(formatMoney(74900), euro('749,00'));
  });

  test('rounds half away from zero before formatting', () => {
    assert.equal(roundCents(1.5), 2);
    assert.equal(roundCents(1.4), 1);
    assert.equal(roundCents(-1.5), -2);
    assert.equal(roundCents(-1.4), -1);
    assert.equal(roundCents(Number.NaN), 0);
    assert.equal(formatMoneyAmount(1.5), euro('0,02'));
    assert.equal(formatMoneyAmount(1.4), euro('0,01'));
    assert.equal(formatMoneyAmount(-1.5), euro('-0,02'));
    assert.equal(formatMoneyAmount(null), euro('0,00'));
  });

  test('USD uses the same Dutch locale and does not rescale cents', () => {
    assert.equal(formatMoneyAmount(129500, { currency: 'USD' }), `US$${NBSP}1.295,00`);
    assert.equal(formatMoney(100, 'USD'), `US$${NBSP}1,00`);
  });
});

describe('CURRENCY env', () => {
  test('unset or blank defaults to EUR', () => {
    assert.deepEqual(loadCurrencyConfig({}), { currency: 'EUR', locale: 'nl-NL' });
    assert.deepEqual(loadCurrencyConfig({ CURRENCY: '  ' }), { currency: 'EUR', locale: 'nl-NL' });
    assert.equal(loadCurrencyConfig({ CURRENCY: 'eur' }).currency, 'EUR');
    assert.equal(loadCurrencyConfig({ CURRENCY: 'usd' }).currency, 'USD');
    assert.equal(deploymentCurrency({}), 'EUR');
  });

  test('a value outside the allowlist is rejected', () => {
    assert.throws(
      () => loadCurrencyConfig({ CURRENCY: 'GBP' }),
      (error) => error instanceof CurrencyConfigError
        && error.statusCode === 503
        && error.code === 'currency_misconfigured'
        && /EUR, USD/.test(error.message)
        && /GBP/.test(error.message)
    );
    assert.throws(() => loadCurrencyConfig({ CURRENCY: 'EURO' }), CurrencyConfigError);
  });

  test('bad CURRENCY refuses to boot instead of formatting as EUR', async () => {
    const app = createApp({ env: { CURRENCY: 'GBP' } });
    await withServer(app, async (base) => {
      const page = await fetch(`${base}/`);
      const html = await page.text();
      assert.equal(page.status, 503);
      assert.match(html, /CURRENCY/);
      assert.match(html, /EUR/);
      assert.equal(html.includes('TURSO_DATABASE_URL'), false);

      const api = await fetch(`${base}/api/health`, { headers: { Accept: 'application/json' } });
      const body = await api.json();
      assert.equal(api.status, 503);
      assert.equal(body.error, 'CurrencyConfigError');
      assert.match(body.detail, /GBP/);
    });
  });

  test('withDeploymentCurrency adds EUR and keeps an explicit code', () => {
    assert.equal(withDeploymentCurrency({ total_amount_cents: 100 }, {}).currency, 'EUR');
    assert.equal(withDeploymentCurrency({ currency: 'USD', total_amount_cents: 100 }, {}).currency, 'USD');
    assert.equal(withDeploymentCurrency({ total_amount_cents: 100 }, { CURRENCY: 'USD' }).currency, 'USD');
  });
});
