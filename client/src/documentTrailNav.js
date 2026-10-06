/** Default search when Document Trail is opened with no document in context. */
export const DEFAULT_DOCUMENT_TRAIL_QUERY = 'PR-2026-001';

/**
 * Navigation payload for the existing Document Trail view, scoped to one PO.
 * po_id is the lookup key; po_number is kept so the trail screen can show it.
 */
export function documentTrailLookupForPurchaseOrder(po) {
  const id = po?.id;
  if (id == null || id === '') {
    throw new Error('Purchase order id is required to open its document trail');
  }
  const lookup = { po_id: id };
  if (po.po_number) lookup.po_number = po.po_number;
  return lookup;
}

/**
 * Query string params for GET /api/document-trail.
 * A concrete document id/number wins over free-text `q`, matching the API.
 */
export function documentTrailQueryFromLookup(lookup, fallbackQ = DEFAULT_DOCUMENT_TRAIL_QUERY) {
  if (!lookup || typeof lookup !== 'object') {
    return { q: fallbackQ };
  }
  if (lookup.po_id != null && lookup.po_id !== '') {
    return { po_id: lookup.po_id };
  }
  if (lookup.po_number) {
    return { po_number: lookup.po_number };
  }
  if (lookup.requisition_id != null && lookup.requisition_id !== '') {
    return { requisition_id: lookup.requisition_id };
  }
  if (lookup.pr_number) {
    return { pr_number: lookup.pr_number };
  }
  if (lookup.q) {
    return { q: lookup.q };
  }
  return { q: fallbackQ };
}
