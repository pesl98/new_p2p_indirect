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
5. **Currency selection** — Sprint 5. One deployment currency, default EUR, shared formatter, locale `nl-NL`. No in-app picker and no foreign exchange.
6. **Translation / i18n** — Dutch (Netherlands) UI so the product is useful for NL users. Sprint 6. It was not part of Sprint 5.

Item 6 is Sprint 6 (below). A docs-only program report (PR #51) may still be open. This sprint does not depend on it and does not wait for it.

## Recent history on `main` (before this program)

These merged feature PRs are context, not part of the daily program. The log below focuses on the new sprints.

| PR | Theme | Merge SHA | Date |
| --- | --- | --- | --- |
| [#41](https://github.com/pesl98/new_p2p_indirect/pull/41) | Deploy and operations manual | `d3e8b656` | on `main` |
| [#42](https://github.com/pesl98/new_p2p_indirect/pull/42) | Service procurement (lump sum, hours, days) | `736f328` | on `main` |
| [#43](https://github.com/pesl98/new_p2p_indirect/pull/43) | Consignment stock, separate from owned GRN | `dfd83b7` | on `main` |
| [#44](https://github.com/pesl98/new_p2p_indirect/pull/44) | View PO document trail | `5560f8b` | on `main` |
| [#45](https://github.com/pesl98/new_p2p_indirect/pull/45) | Metered utilities and vendor-managed bulk | `71d0ee8` | on `main` |

## Sprint register

| Sprint | Date | Goal | PR | Title | Merge SHA | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-10-02 | Full authorization rewrite: session identity on the P2P API; no body persona spoofing; no SSO | [#46](https://github.com/pesl98/new_p2p_indirect/pull/46) | Sprint 1 — Full authorization rewrite | `e6bdf1ea7ba144c12a95da4cabeebd9430def42a` | merged |
| 2 | 2026-10-05 | SSO / SAML / OIDC: a validated IdP callback mints the same `pf_session` cookie | [#47](https://github.com/pesl98/new_p2p_indirect/pull/47) | Sprint 2 — SSO / SAML / OIDC | `9bbd4fbf83ce5277a18435d2693d91aa58b755da` | merged |
| 3 | 2026-10-06 | Audit and compliance reporting: append-only evidence and verification-style reports | [#48](https://github.com/pesl98/new_p2p_indirect/pull/48) | Sprint 3 — Audit and compliance reporting | `4472b2725a70f7743a978ecfb5cdd02488aca72e` | merged |
| 4 | 2026-10-06 | Integrations: scoped API keys, master-data upserts, signed webhooks, and ERP export | [#49](https://github.com/pesl98/new_p2p_indirect/pull/49) | Sprint 4 — Integrations | `d050d330ef7c8c58080d2f102053a6838a69e7ab` | merged |
| 5 | 2026-10-06 | EUR as the deployment currency: one shared formatter, `CURRENCY` env, currency code on outbound money | [#50](https://github.com/pesl98/new_p2p_indirect/pull/50) | Sprint 5 — EUR currency | `8a025b4ff35e6eee3346cadec8ee13b12b288850` | merged |
| 6 | 2026-10-07 | Dutch (Netherlands) UI: message catalog, default locale `nl-NL`, comma decimal amount entry | [#52](https://github.com/pesl98/new_p2p_indirect/pull/52) | Sprint 6 — Dutch (NL) i18n | | in progress |

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

**PR:** https://github.com/pesl98/new_p2p_indirect/pull/47 (#47).

**Merge SHA:** `9bbd4fbf83ce5277a18435d2693d91aa58b755da` (squash-merged).

**Status:** merged.

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

Provisioning (optional, default off): `SSO_PROVISIONING=1` and/or an admin `PUT /api/auth/sso-settings` with `{ "provisioning": true, "defaultRole": "requester" }`. `sso_provisioning` and `sso_default_role` are aliases. A bad role, a bad flag, or disagreeing aliases is rejected and does not change the row. `SSO_DEFAULT_ROLE` overrides the stored role when it is a valid role.

## Sprint 3 — Audit and compliance reporting

**Date:** 2026-10-06

**Goal:** An auditable trail for auth, SSO, and the procurement decisions that move money, plus compliance reports an admin or finance user can query and export. Fail closed for everyone else.

**PR:** https://github.com/pesl98/new_p2p_indirect/pull/48 (#48).

**Merge SHA:** `4472b2725a70f7743a978ecfb5cdd02488aca72e` (squash-merged).

**Status:** merged.

### Done when

- `audit_logs`, `sso_login_events`, and `sso_assertion_uses` reject UPDATE and DELETE in the database. Local auth, user/role changes, SSO settings, JIT user create, and CSV exports are appended to `compliance_audit_events` with a SHA-256 hash chain the database links.
- Reports cover the audit trail (date, actor, entity, action), approval-policy / segregation of duties, paid documents missing approval or receipt, and a verification report that re-derives totals from line records.
- Admin and finance can read and export. Requester, approver, and procurement are 403. No cookie is 401. Exports are logged. Actor fields come from the session.
- Docs name the migration (`npm run db:migrate` / process start applies the new table and triggers). Tests cover append-only, the session actor, access, each report, and CSV.
- Sprint 1 and Sprint 2 behavior stays: business APIs without `pf_session` are 401, and SSO evidence is read in place rather than copied.

### Decisions

- **Reuse the sound tables.** P2P decisions stay in `audit_logs`. SSO attempts stay in `sso_login_events`. Assertion ids stay in `sso_assertion_uses`. The audit-trail report unions them with `compliance_audit_events`. It does not duplicate SSO rows.
- **Append-only is a trigger.** `BEFORE UPDATE` and `BEFORE DELETE` call `RAISE(ABORT, …)` on those four tables. `sso_requests` stays deletable; it is single-use login state, not evidence.
- **Hash chain only on the new ledger.** Each `compliance_audit_events` row stores `prev_hash` (`GENESIS` on the first row, otherwise the previous `row_hash`) and a SHA-256 hex digest of that link plus a canonical JSON payload. A trigger rejects a broken link or a digest that is not 64 hex characters. The verification report recomputes the digest. `audit_logs` is not hash-chained: many call sites already insert it, historical rows have no digest, and SQLite/Turso HTTP have no shared SHA-256 function to enforce the digest inside the trigger. Tamper of those rows is still blocked by the UPDATE/DELETE triggers.
- **Actor.** New compliance rows take `actor_user_id` and `actor_name` from `req.user` only. A failed local login has no session, so the actor name is the presented email and the user id is the matching account when one exists; a body `actor_name` is ignored. Bootstrap attributes the first admin to the user just created, because no session existed yet. JIT SSO provisioning attributes `USER_CREATED` to that new user; the login itself remains an `sso_login_events` row.
- **Who can read.** `admin` and `finance`. Finance is the existing control lens for payables and segregation. There is no sixth `auditor` role. Procurement, approvers, and requesters fail closed. Reports are read-only; CSV export is the only write, and it appends `COMPLIANCE_EXPORT`.
- **Reports.** See the PR body and [SYSTEM_MANUAL.md](SYSTEM_MANUAL.md). Segregation findings are detective. They do not add a new block on every P2P route.
- **Existing databases.** `npm run db:migrate`, or the next process start, runs `schema.sql`. `CREATE TABLE IF NOT EXISTS` and `CREATE TRIGGER IF NOT EXISTS` add the ledger and the guards. No manual SQL. Demo `npm run seed` still wipes and reloads; it inserts audit timestamps directly because `audit_logs` can no longer be updated.

## Sprint 4 — Integrations

**Date:** 2026-10-06

**Goal:** Customer-facing integrations that plug one ProcureFlow deployment into an external ERP/AP and catalog system: scoped API keys, idempotent vendor and catalog upserts, signed webhooks with a durable outbox, and a pull export. No SSO changes. No EUR (Sprint 5) and no Dutch i18n (Sprint 6).

**PR:** https://github.com/pesl98/new_p2p_indirect/pull/49 (#49).

**Merge SHA:** `d050d330ef7c8c58080d2f102053a6838a69e7ab` (squash-merged).

**Status:** merged.

### Done when

- Admins create, list, and revoke scoped API keys with `pf_session`. The plaintext is shown once. The database stores SHA-256 only. Each key has scopes, an optional expiry, last-used, and a per-key rate limit.
- A missing, invalid, revoked, expired, or out-of-scope key is 401/403. The key is the actor (a named integration principal). It never impersonates a user and a body user id is rejected. Vendor, catalog, and export routes do not accept `pf_session` instead of a key. A key does not open business APIs.
- Vendor and catalog upserts are keyed by external id, idempotent, validated, and written to `audit_logs` and `compliance_audit_events` under that principal. Key create and revoke are on the compliance ledger under the admin session.
- Webhooks for PO issued, goods receipt posted, invoice approved, and payment run created or paid are HMAC-SHA256 signed with a timestamp, queued in `webhook_outbox`, retried with backoff, dead-lettered, and replayable by an admin.
- Approved invoices and payment runs can be pulled as JSON or CSV with `export:read`.
- Webhook URL and signing secret are environment variables on that customer’s deployment. The secret is never stored or returned.
- Docs name the migration and the operator steps. Tests cover the list above. Sprint 1–3 behavior stays: business APIs without a cookie are 401, and the audit tables stay append-only.

### Decisions

- **Partner-API style, not a shared persona.** Principle 4. Scopes shipped: `vendors:write`, `catalog:write`, `export:read`. There is no `invoices:write`. Inbound supplier invoices are a follow-up (see the PR). They are not stubbed.
- **Key storage.** `pfk_` plus 32 random bytes. `api_keys.key_hash` is SHA-256 hex. `key_prefix` is the first 12 characters, for the admin list. Revoke sets `revoked_at`. Rows are not deleted.
- **Rate limit.** Fixed one-minute window in `api_key_rate_windows`, default 60 requests, admin-set from 1 to 6000. Over the limit is 429. The window is per key, in that customer’s database, so it holds across serverless instances.
- **Machine routes ignore the cookie.** `POST /api/integrations/vendors`, `POST /api/integrations/catalog`, and `GET /api/integrations/exports/*` require `Authorization: Bearer pfk_…`. Admin routes (`/api/integrations/keys`, `/api/integrations/outbox`, `/api/integrations/config`) require `pf_session` and role `admin`. That split is intentional.
- **Actor.** Integration writes use `actor_name` = the key’s name, `actor_role` = `integration`, `actor_user_id` = null. A body `user_id`, `actor_name`, `created_by`, or similar is 400. Admin key create/revoke and webhook replay use the session admin, the same way Sprint 3 user changes do.
- **Idempotency.** The external id is the entity key (repeat upsert updates one row). `Idempotency-Key` replays the first successful response for that key and body. The same key with a different body is 409.
- **Upsert shape.** Money is integer cents (`unit_price`). Catalog preferred vendor is `preferred_supplier_external_id`, after the vendor upsert. Supplier `code` is immutable after create. Omitted optional vendor/catalog fields are cleared to their defaults on update, so the same JSON is the same row. Send the full record.
- **Webhooks.** Events: `po.issued`, `receipt.posted` (goods receipt, not a service entry), `invoice.approved`, `payment_run.created`, `payment_run.paid`. Header `X-ProcureFlow-Signature: t=<unix>,v1=<hex>` is HMAC-SHA256 of `${t}.${rawBody}` using `WEBHOOK_SIGNING_SECRET`. Receivers should reject a timestamp more than 5 minutes off and dedupe on `evt_<outbox id>`. The timestamp is the send time, so a retry is a new signature for the same event id.
- **Outbox.** Inserted in the same transaction as the business write. Status `pending`, then `delivered` or `dead`. Five attempts. Backoff after a failure is 30s, 2m, 10m, 1h. A missing URL or secret does not burn attempts. Replay (admin) resets the attempt count and tries again. `npm start` retries every 30 seconds. On Vercel the write attempts once, and later retries run from **Deliver pending**, replay, or the next business event’s sweep. There is no platform cron.
- **Config.** `WEBHOOK_TARGET_URL` and `WEBHOOK_SIGNING_SECRET` are environment variables on that one deployment (Production and Preview). `vercel:customer` does not set them. They are not in the database. `GET /api/integrations/config` returns booleans and the target host only.
- **Export.** `GET /api/integrations/exports/invoices` defaults to `approved_for_payment` (`paid` optional). `GET /api/integrations/exports/payment-runs` defaults to `executed` (`draft` or `all`). `?format=csv` or `Accept: text/csv`. Amounts are cents. At Sprint 4, JSON `currency` was hardcoded `USD`. Sprint 5 replaces that value with the deployment currency (default `EUR`) and adds `currency` on money-bearing webhook payloads. Each pull appends `INTEGRATION_EXPORT` on the compliance ledger.
- **Existing databases.** `npm run db:migrate`, or the next process start, creates the five new tables (`CREATE TABLE IF NOT EXISTS`). No hand-written SQL. SSO is unchanged.

## Sprint 5 — EUR currency

**Date:** 2026-10-06

**Goal:** Make EUR the deployment currency so a Netherlands customer is not shown hardcoded USD or `$`. One shared formatter. One `CURRENCY` setting. No Dutch UI translation (Sprint 6) and no foreign exchange.

**PR:** https://github.com/pesl98/new_p2p_indirect/pull/50 (#50).

**Merge SHA:** `8a025b4ff35e6eee3346cadec8ee13b12b288850` (squash-merged).

**Status:** merged.

### Done when

- Money on screen, in server-generated text, in seed copy, and in the manuals formats through one shared formatter. The default currency is EUR. Locale is `nl-NL`.
- `CURRENCY` is optional, allowlisted (`EUR`, `USD`), and refuses to boot on any other value. Unset means EUR.
- Stored amounts stay integer cents. No migration and no rescale. EUR and USD both use two decimal places.
- Integration export JSON, payment-run CSV, money-bearing webhook payloads, and the compliance verification report carry an explicit `currency` code. Existing cent fields stay. `receipt.posted` is unchanged (no amount).
- SSO, `pf_session` fail-closed auth, the append-only compliance ledger, and the webhook dispatcher/drain are unchanged.
- Tests cover the formatter, a client `$` guard, export and webhook currency, and config validation. `npm test` is green.
- This row points at the PR.

### Decisions

- **Storage.** Columns are already integer cents (`unit_price`, `total_amount`, budgets, invoice totals, `price_variance`, `approval_limit`, `annual_value_cents`, payment-run snapshots). The API still returns cents. Because EUR and USD both have two decimal minor units, switching `CURRENCY` does not convert or rescale stored values. No migration.
- **Formatter.** `shared/currency.js` is the only display path (`formatMoney` on the client and the server). Locale is `nl-NL` for every allowlisted currency, so a Netherlands customer sees `€ 1.295,00` (the space after the symbol is U+00A0). USD in that locale is `US$ 1.295,00`. Rounding is half away from zero, then the grouped major and two-digit minor are written from integers so large amounts do not depend on binary floats. Null and non-finite amounts format as zero. `formatCents` stays a symbol-free dot-decimal (`749.00`) for non-display use.
- **Config.** `CURRENCY` unset or blank is EUR. `eur` / `usd` are accepted and uppercased. Anything else throws `CurrencyConfigError` (`currency_misconfigured`, HTTP 503) at boot and does not silently fall back. The client reads `currency` from `GET /api/auth/config` and fails closed to EUR if that value is missing or not on the allowlist. `GET /api/health` also returns `currency`. There is no picker and no FX. Numeric inputs stay dot-decimal major units; Dutch comma entry is Sprint 6.
- **Outbound data.** Invoice and payment-run export JSON `currency` is the deployment code (it was hardcoded `USD`). The invoice CSV already had a `currency` column; the value follows `CURRENCY` and the column position is unchanged. The payment-run CSV gains `currency` as the last column. Webhook payloads that already include cent amounts (`po.issued`, `invoice.approved`, `payment_run.created`, `payment_run.paid`) gain `currency`. `receipt.posted` has no money fields and no `currency` field. The compliance verification JSON gains top-level `currency`; its CSV gains a trailing `currency` column. The audit-trail CSV header is unchanged. Cent field names and values are unchanged.
- **Left alone.** SSO, session auth, append-only ledger triggers, integration route behavior, and the webhook outbox dispatcher/drain. No email sender exists to update.

## Sprint 6 — Dutch (NL) i18n

**Date:** 2026-10-07

**Goal:** Make the user-facing UI Dutch (Netherlands) so an NL customer can work in the product, with a catalog the team can extend, and accept comma decimals on amount fields.

**PR:** https://github.com/pesl98/new_p2p_indirect/pull/52 (#52, draft).

**Merge SHA:** (blank until merge).

**Status:** in progress.

A docs-only program report (PR #51) may still be open. This sprint does not depend on it and does not change `PROGRAM-REPORT.md`.

### Done when

- Login, navigation, dashboards, requisitions, approvals, purchase orders, receipts, invoices, payments, and the existing admin and settings screens are Dutch.
- English is not the primary copy on those surfaces. Seed and demo names and emails stay. API machine codes stay English and the UI maps them to Dutch.
- Strings live in a message catalog with `t()` and `useI18n()`. Default locale is `nl-NL`. There is no language picker.
- Amount fields accept `1.295,50`. Stored values stay integer cents. `formatMoney` and `shared/currency.js` stay as Sprint 5 left them.
- SSO, `pf_session`, the compliance ledger, integrations, and the Sprint 5 currency tests still pass. `npm test` is green.
- This row points at the PR.

### Decisions

- **Catalog, not a framework.** The app had no i18n library. `client/src/i18n.js` loads `client/src/i18n/nl-NL.js` (merged from `client/src/i18n/parts/`). `t('key', { name })` replaces `{name}`. `useI18n()` subscribes to `setLocale` so a later locale can re-render. Only `nl-NL` is registered. An unknown locale falls back to `nl-NL`. `html lang` is `nl-NL`.
- **What stays English.** Persona names, emails, document numbers, category and status values sent to the API, scope names, and text already stored in the database (audit details, justifications, seed descriptions). Actor-name fallbacks written onto the ledger stay the previous English strings so audit rows do not change shape.
- **Errors.** `presentError` maps known API sentences and machine codes (`sso_not_configured`, `Invalid email or password`, and the same kind of message) to Dutch. Anything else becomes a Dutch fallback. The API response itself is unchanged.
- **Notices.** Success banners and match findings the server still writes in English are translated on display by `presentNotice`. Unmapped text becomes a Dutch fallback. The stored sentence is not rewritten.
- **Amounts.** `parseMajorAmount` / `toCents` on the client: comma is the decimal separator, dot is thousands (`1.295,50` → 129550 cents). A single dot with one or two fractional digits still parses (`749.00`) so a paste does not become zero. `1.295` is one thousand two hundred ninety-five. Empty or invalid text is 0, as before. `formatMajorInput` shows `1.295,50` in the field. Quantity, meter, and capacity inputs are not money and stay as they were. Server `toCents` and `shared/currency.js` are unchanged.
- **Left alone.** SSO, session auth, the append-only ledger, integration routes, `CURRENCY`, webhook drain, and the Sprint 5 icon follow-ups.
