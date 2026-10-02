# ProcureFlow daily sprint log

Owner: Peter (`pesl98`). Program routed by Software Architect.

This file is the register for the daily sprint program. **Every future feature PR appends a row** to the sprint table below (number, title, merge SHA when known, date) and sets that sprint’s status.

## How we run dailies

Each day is one sprint with a single goal and, preferably, one pull request.

| Field | What to record |
| --- | --- |
| Date | The day the sprint opened (UTC). |
| Goal | One sentence. Stay inside that goal. |
| PR | Link to the pull request. Fill the number after the PR is opened. Leave the merge SHA blank until it merges. |
| Status | `done` when the PR is open and the sprint’s done-when list is met, waiting on Architect + Peter review. `blocked` when a dependency or decision stops the work. Do not merge from the sprint PR until that review. |

A sprint is not done because the code compiles. It is done when its own checklist is met and the row in this file points at the PR.

## Design principles (from Storycodes)

Different domain. Reuse the concepts on ProcureFlow. Do not port Storycodes or out-of-home features.

Use these from here on:

1. **Fail-closed controls live in the database and the server**, not only in the UI. Sprint 1 is already on this path: a hidden sidebar item is not an authorization boundary.
2. **Append-only decision and evidence** where money or compliance matters. Prefer verification-style reports that re-derive totals from immutable records. That feeds Sprint 3 (audit / compliance reporting).
3. **Role lenses without spoofable body ids.** The signed-in session is the actor (Sprint 1).
4. **Later integrations use scoped API keys and rate limits** (Partner-API style), not a shared persona. That is Sprint 4, not this PR.
5. **One database per customer** stays the isolation model. No shared-row `org_id`.

**Don’t port:** Storycodes Petri-everywhere, the always-302 resolver, or scan metrics.

## Product backlog

Peter’s order. Do not start a later item inside an earlier sprint’s PR.

1. **Full authorization rewrite** — Sprint 1 (this program’s first PR). End demo-open / body-persona auth. Session on all mutating and sensitive reads. No SSO in this sprint.
2. **SSO / SAML / OIDC** — plug into the existing `pf_session` cookie. `identityProvider` is `local` until then. Do not invent this in Sprint 1.
3. **Audit / compliance reporting**
4. **Integrations**
5. **Currency selection** — product usable in euros (display, format, and a tenant default of EUR; a picker only if multi-currency comes later). Today the docs and UI often show `$`. EUR should be first-class for Netherlands customers.
6. **Translation / i18n** — Dutch (Netherlands) UI so the product is useful for NL users.

Items 5 and 6 are backlog only. They are not part of Sprint 1.

## Recent history on `main` (before this program)

These merged feature PRs are context, not part of the daily program. The log below focuses on the new sprints.

| PR | Theme | Merge SHA | Date |
| --- | --- | --- | --- |
| [#42](https://github.com/pesl98/new_p2p_indirect/pull/42) | Service procurement (lump sum, hours, days) | `736f328` | on `main` |
| [#43](https://github.com/pesl98/new_p2p_indirect/pull/43) | Consignment stock, separate from owned GRN | `dfd83b7` | on `main` |
| [#44](https://github.com/pesl98/new_p2p_indirect/pull/44) | View PO document trail | `5560f8b` | on `main` |
| [#45](https://github.com/pesl98/new_p2p_indirect/pull/45) | Metered utilities and vendor-managed bulk | `71d0ee8` | on `main` |

## Sprint register

| Sprint | Date | Goal | PR | Title | Merge SHA | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-10-02 | Full authorization rewrite: session identity on the P2P API; no body persona spoofing; no SSO | [#46](https://github.com/pesl98/new_p2p_indirect/pull/46) | Sprint 1 — Full authorization rewrite | | done |

## Sprint 1 — Full authorization rewrite

**Date:** 2026-10-02

**Goal:** End demo-open / body-persona auth. The signed-in user is the actor on mutating routes and on sensitive reads (approvals inbox, buyer inbox, AP). Fail closed. Design the session so OIDC/SAML can mint the same cookie later. Do not build SSO here.

**PR:** https://github.com/pesl98/new_p2p_indirect/pull/46 (#46). Merge SHA stays blank until merge.

**Status:** done (awaiting Architect + Peter review; do not merge from this PR).

### Done when

- Unauthenticated calls that used to work with a persona id are rejected (401).
- The logged-in user’s identity drives approvals, the buyer inbox, and AP actions. A mismatched body id is 403.
- Seed/demo login is documented (below).
- Tests cover authorization on the critical routes.
- This file has the Sprint 1 row and the PR link.

### Seed / demo login

`npm run seed` is destructive. It reloads eight demo personas and sets the same password on each account.

| | |
| --- | --- |
| Password | `ProcureFlow!demo` |
| Example | `elena.rostova@company.com` / `ProcureFlow!demo` |
| Also | `alice.chen@company.com`, `bob.martinez@company.com`, `carol.zhang@company.com`, `david.miller@company.com`, `priya.nair@company.com`, `james.okonkwo@company.com`, `sofia.berg@company.com` |

Empty customer databases do not use that password. Bootstrap the first admin (`POST /api/auth/bootstrap` or `npm run bootstrap-admin`) and sign in with the password you chose.

`DEMO_PERSONA_SWITCHER=1` shows a header dropdown that signs in again with `ProcureFlow!demo`. It is off by default. It is not a way to skip the session.

### What the session covers

Public without a cookie: `GET /api/health`, `GET /api/auth/config`, `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/bootstrap`, `GET /api/auth/me` (401 when signed out).

Everything else under `/api` requires `pf_session`. Actor fields (`approver_id`, `requester_id`, `received_by`, `created_by`, `actor_name`, and the same kind of field on goods, services, consignment, utilities, bulk, contracts, and delegations) come from `req.user`.

Later SSO should resolve the IdP subject to a local `users.id` and call `signSessionToken`. `GET /api/auth/config` reports `identityProvider: "local"` until that sprint.
