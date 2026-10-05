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
2. **SSO / SAML / OIDC** — Sprint 2. An OIDC or SAML callback mints the same `pf_session` cookie. `identityProvider` is `local`, `oidc`, or `saml`.
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
| 1 | 2026-10-02 | Full authorization rewrite: session identity on the P2P API; no body persona spoofing; no SSO | [#46](https://github.com/pesl98/new_p2p_indirect/pull/46) | Sprint 1 — Full authorization rewrite | `e6bdf1ea7ba144c12a95da4cabeebd9430def42a` | merged |
| 2 | 2026-10-05 | SSO / SAML / OIDC: a validated IdP callback mints the same `pf_session` cookie | [#47](https://github.com/pesl98/new_p2p_indirect/pull/47) | Sprint 2 — SSO / SAML / OIDC | | done |

## Sprint 1 — Full authorization rewrite

**Date:** 2026-10-02

**Goal:** End demo-open / body-persona auth. The signed-in user is the actor on mutating routes and on sensitive reads (approvals inbox, buyer inbox, AP). Fail closed. Design the session so OIDC/SAML can mint the same cookie later. Do not build SSO here.

**PR:** https://github.com/pesl98/new_p2p_indirect/pull/46 (#46).

**Merge SHA:** `e6bdf1ea7ba144c12a95da4cabeebd9430def42a` (squash-merged).

**Status:** merged.

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

That callback is Sprint 2 (below). Sprint 1’s cookie format is unchanged.

## Sprint 2 — SSO / SAML / OIDC

**Date:** 2026-10-05

**Goal:** An OIDC or SAML login callback mints the same `pf_session` cookie Sprint 1 uses. Missing or invalid SSO configuration fails closed. Local password login keeps working where it is configured.

**PR:** https://github.com/pesl98/new_p2p_indirect/pull/47 (#47). Merge SHA stays blank until merge.

**Status:** done (awaiting Architect + Peter review; do not merge from this PR).

### Done when

- `identityProvider` can be `local`, `oidc`, or `saml`.
- A mapped user’s OIDC or SAML callback sets `pf_session`. Unknown users are rejected unless an admin explicitly enables provisioning.
- Bad state, nonce, signature, audience, expiry, recipient, and replay are rejected. Missing SSO config mints no session.
- Sprint 1 still fails closed: business APIs without the cookie are 401.
- Deploy and onboarding docs say how to configure OIDC and SAML for one customer.
- This row points at the PR.

### Decisions

- **One customer, one deployment, one database.** IdP endpoints and secrets are environment variables on that deployment. `tenant_settings` (singleton `id = 1`) stores only `sso_provisioning` (default off) and `sso_default_role` (default `requester`). Secrets are not written to the database.
- **User mapping.** Look up `user_identities` (`provider`, `subject`) first. If that row exists, the linked user signs in (inactive users are rejected). Otherwise match `users.email` case-insensitively. OIDC requires `email_verified` true for that match. A signed SAML email is treated as verified. The first verified email match stores the subject. A subject already linked to a different user is rejected (`sso_identity_conflict`).
- **Unknown users are rejected** (`403 sso_user_unknown`) unless provisioning is explicitly on: `SSO_PROVISIONING=1` or an admin sets `tenant_settings.sso_provisioning`. Just-in-time users get the configured default role, never a role from an IdP claim, the callback query, or a `role` field on the settings body. The role is `SSO_DEFAULT_ROLE` when that value is one of the five roles, otherwise the tenant row, otherwise `requester`. Approval limit is 0. No password is stored. An invalid provisioning flag or default role does not disable SSO for mapped users; a provision attempt then fails closed (`sso_provisioning_misconfigured`).
- **Same cookie.** Success calls `signSessionToken` and sets `pf_session`. There is no second identity header. Browser clients redirect to `APP_BASE_URL` `/`. RelayState is not used as a redirect.
- **Local passwords stay.** `LOCAL_LOGIN` defaults on. `LOCAL_LOGIN=0` disables `POST /api/auth/login` (`403 local_login_disabled`) and does not open an unauthenticated path. Demo seed remains any seeded email plus `ProcureFlow!demo`. The first admin on an empty database is still `POST /api/auth/bootstrap`, because the JIT default role is `requester`.
- **Validation libraries.** OIDC uses `openid-client` (authorization code, PKCE S256, state, nonce, and `enableNonRepudiationChecks` so the ID token signature is checked against the issuer JWKS, plus issuer, audience, and expiry). SAML uses `@node-saml/node-saml` (signature, audience, `NotOnOrAfter`, `InResponseTo`). This app also requires the assertion `Recipient` to equal the ACS URL and records the assertion id. SP-initiated only. At least one of assertion signature or response signature must be required. `SAML_WANT_ASSERTIONS_SIGNED` defaults true; `SAML_WANT_RESPONSE_SIGNED` defaults false.
- **Evidence, not Sprint 3.** `sso_login_events` and `sso_assertion_uses` are append-only inserts. There is no audit report API. `sso_requests` are single-use and deleted when the attempt finishes.
- **Fail closed.** `IDENTITY_PROVIDER` unset or `local` is password login. `oidc` or `saml` with a missing or invalid IdP setting leaves `ssoReady` false: start and callback return `503 sso_not_configured` and set no cookie. An unknown provider value does the same and does not fall through to a persona.

### Configure one customer

Set these on that customer’s deployment only. Full tables: [DEPLOYMENT.md](DEPLOYMENT.md) and [SYSTEM_MANUAL.md](SYSTEM_MANUAL.md).

OIDC: `IDENTITY_PROVIDER=oidc`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `APP_BASE_URL`. Optional `OIDC_REDIRECT_URI` (default `{APP_BASE_URL}/api/auth/oidc/callback`) and `OIDC_SCOPES` (default `openid email profile`; must include `openid`). Register the redirect URI on the IdP.

SAML: `IDENTITY_PROVIDER=saml`, `SAML_ENTRY_POINT`, `SAML_IDP_CERT`, `SAML_IDP_ISSUER`, `SAML_SP_ENTITY_ID`, `APP_BASE_URL`. Optional `SAML_ACS_URL` (default `{APP_BASE_URL}/api/auth/saml/acs`) and `SAML_AUDIENCE` (default entity id). Give the IdP `GET /api/auth/saml/metadata`.

Provisioning (optional, default off): `SSO_PROVISIONING=1` and/or an admin `PUT /api/auth/sso-settings` with `{ "provisioning": true, "defaultRole": "requester" }`. `SSO_DEFAULT_ROLE` overrides the stored role when it is a valid role.
