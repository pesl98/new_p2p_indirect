/**
 * RFQ status machine. Pure: no database, no clock except values the caller passes.
 * Every status change goes through assertTransition, then a conditional UPDATE.
 * A miss is 409 event_state_changed. Unknown edges fail closed.
 *
 * Extending a deadline stays `published` and is not a transition.
 * Proposing an award stays `evaluated` until the award requisition is fully
 * approved (Sprint 8c). Sprint 8a only performs draft → cancelled.
 */

export const SOURCING_STATUSES = Object.freeze([
  'draft',
  'published',
  'closed',
  'evaluated',
  'awarded',
  'cancelled'
]);

/** One hour. A draft cannot be published with a closer deadline. */
export const PUBLISH_LEAD_MS = 60 * 60 * 1000;

const EDGES = Object.freeze({
  draft: new Set(['published', 'cancelled']),
  published: new Set(['closed', 'cancelled']),
  closed: new Set(['evaluated', 'cancelled']),
  evaluated: new Set(['awarded', 'cancelled']),
  awarded: new Set(),
  cancelled: new Set()
});

export class SourcingStatusError extends Error {
  constructor(message, code = 'invalid_transition', statusCode = 409) {
    super(message);
    this.name = 'SourcingStatusError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function canTransition(from, to) {
  return Boolean(EDGES[from]?.has(to));
}

/**
 * Fail closed. Same-status, unknown status, and edges that are not in the
 * graph all throw. Callers still have to UPDATE ... WHERE status = from.
 */
export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new SourcingStatusError(
      `Cannot move an RFQ from ${from || 'unknown'} to ${to || 'unknown'}.`,
      'invalid_transition',
      409
    );
  }
}

/**
 * Publish rules from the status diagram. Returns machine codes, empty when
 * the draft may move to published. Sprint 8b performs that move; 8a only
 * checks the rules.
 */
export function publishBlockers(event, { now = new Date(), lineCount = 0, invitationCount = 0 } = {}) {
  const blockers = [];
  if (!event || event.status !== 'draft') blockers.push('event_not_draft');
  if (!Number.isInteger(lineCount) || lineCount < 1) blockers.push('publish_needs_line');
  if (!Number.isInteger(invitationCount) || invitationCount < 1) blockers.push('publish_needs_invitation');
  const weights = Number(event?.weight_price) + Number(event?.weight_lead_time) + Number(event?.weight_quality);
  if (weights !== 100) blockers.push('weights_invalid');
  const deadline = event?.deadline_at ? Date.parse(event.deadline_at) : NaN;
  const instant = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(deadline) || !Number.isFinite(instant)) {
    blockers.push('deadline_too_soon');
  } else if (deadline <= instant) {
    blockers.push('deadline_in_the_past');
  } else if (deadline < instant + PUBLISH_LEAD_MS) {
    blockers.push('deadline_too_soon');
  }
  return blockers;
}
