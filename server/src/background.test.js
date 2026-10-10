import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleBackground } from './background.js';

const CONTEXT = Symbol.for('@vercel/request-context');

describe('scheduleBackground', () => {
  test('on Vercel the platform waitUntil from @vercel/functions receives the work', async () => {
    const kept = [];
    globalThis[CONTEXT] = { get: () => ({ waitUntil: (promise) => kept.push(promise) }) };
    try {
      let ran = false;
      const promise = scheduleBackground(async () => { ran = true; }, { env: { VERCEL: '1' } });
      assert.equal(kept.length, 1);
      assert.equal(kept[0], promise);
      await promise;
      assert.equal(ran, true);
    } finally {
      delete globalThis[CONTEXT];
    }
  });

  test('an explicit waitUntil wins; off Vercel nothing is registered; failures are swallowed', async () => {
    const kept = [];
    globalThis[CONTEXT] = { get: () => ({ waitUntil: (promise) => kept.push(['platform', promise]) }) };
    try {
      scheduleBackground(async () => {}, { env: { VERCEL: '1' }, waitUntil: (promise) => kept.push(['own', promise]) });
      assert.deepEqual(kept.map((row) => row[0]), ['own']);
      scheduleBackground(async () => {}, { env: {} });
      assert.equal(kept.length, 1, 'not on Vercel');
      const failed = scheduleBackground(async () => { throw new Error('smtp said no'); }, { env: {} });
      await assert.doesNotReject(failed);
    } finally {
      delete globalThis[CONTEXT];
    }
  });

  test('on Vercel outside a request context it does not throw', async () => {
    delete globalThis[CONTEXT];
    await assert.doesNotReject(scheduleBackground(async () => {}, { env: { VERCEL: '1' } }));
  });
});
