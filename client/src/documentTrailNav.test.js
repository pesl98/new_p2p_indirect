import test from 'node:test';
import assert from 'node:assert/strict';
import {
  documentTrailLookupForPurchaseOrder,
  documentTrailQueryFromLookup
} from './documentTrailNav.js';

test('View PO opens the document trail for that purchase order', () => {
  const lookup = documentTrailLookupForPurchaseOrder({ id: 42, po_number: 'PO-2026-130' });
  assert.deepEqual(lookup, { po_id: 42, po_number: 'PO-2026-130' });
  assert.deepEqual(documentTrailQueryFromLookup(lookup), { po_id: 42 });
});

test('document trail lookup requires the purchase order id', () => {
  assert.throws(
    () => documentTrailLookupForPurchaseOrder({ po_number: 'PO-2026-130' }),
    /Purchase order id is required/
  );
});

test('existing document trail entry points still search by q', () => {
  assert.deepEqual(documentTrailQueryFromLookup({ q: 'INV-WED-9042' }), { q: 'INV-WED-9042' });
  assert.deepEqual(documentTrailQueryFromLookup(null), { q: 'PR-2026-001' });
});

test('a purchase order id is preferred over a free-text trail query', () => {
  assert.deepEqual(
    documentTrailQueryFromLookup({ po_id: 7, po_number: 'PO-2026-002', q: 'PR-2026-001' }),
    { po_id: 7 }
  );
});
