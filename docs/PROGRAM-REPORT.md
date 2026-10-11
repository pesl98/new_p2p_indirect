# ProcureFlow program report

This is the account of what has been delivered in [pesl98/new_p2p_indirect](https://github.com/pesl98/new_p2p_indirect), written from the repository: `git log` on `main`, the merged pull requests, and the manuals listed below. It does not add product behavior.

Dates are the author dates of the squash-merge commits (`git log`, timezone `+0200`). Each SHA in the Architect program was checked with `git rev-parse` against `main` at `a41ec42a327afe2c0d28211c7e9a17d3343450a5` (Sprint 6, PR #52). Test counts are the figures written in those pull-request bodies. They were not re-run at the historical commits.

The day-by-day register is [SPRINT-LOG.md](SPRINT-LOG.md). Operator procedure stays in [DEPLOY_MANUAL.md](DEPLOY_MANUAL.md).

| If you need… | Go here |
| --- | --- |
| How to deploy, update, and remove one customer | [DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) |
| What the product does, with honest limits | [SYSTEM_MANUAL.md](SYSTEM_MANUAL.md) |
| Click-by-click install | [CUSTOMER_ONBOARDING.md](CUSTOMER_ONBOARDING.md) |
| Env tables, Auth API, rollback | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Control model (match, approvals, budgets) | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Sprint register and design principles | [SPRINT-LOG.md](SPRINT-LOG.md) |
| Feature walkthroughs on the seeded demo | [README.md](../README.md) |
| Env key names, no secret values | [`.env.example`](../.env.example) |

---

## 1. Overview

ProcureFlow is a full-lifecycle **indirect procure-to-pay** application for non-production goods and services: IT hardware and software, office supplies, facilities and MRO, consulting, SaaS subscriptions, marketing, and similar operating expense. The first commit on `main` is `309f1d45378fdc5fb93a525007edbe20807ea1d5` (2026-09-04), “feat: complete non-production procurement system (React + SQLite)”. Everything after that is a merge onto that base.

**Stack** (from the root and package manifests, and from [SYSTEM_MANUAL.md §1](SYSTEM_MANUAL.md#1-what-procureflow-is)):

| Layer | What it is |
| --- | --- |
| Client | React 18 and Vite. One SPA tab switcher in `client/src/App.jsx`. There is no React Router. |
| API | Node.js (engines `>=18`) and Express 4. Factory in `server/src/app.js`. Local listen is `server/src/index.js` on `PORT` (default 5000). |
| Vercel | One Node function, `api/index.js`, default-exports the Express app. `vercel.json` builds the client into `public/` and rewrites `/api/*` to that function. |
| Local database | SQLite via `better-sqlite3` when both `TURSO_*` variables are unset. Default file `server/data/procurement.db`. |
| Customer database | Turso, classic libSQL, over HTTP `POST /v2/pipeline`. The app does not load a native libsql addon. |
| Identity | bcrypt password hashes in `user_credentials`. Optional OIDC (`openid-client`) or SAML (`@node-saml/node-saml`). Both mint the same httpOnly cookie. |
| Money | Integer cents. Display goes through `shared/currency.js`. Default currency EUR, locale `nl-NL`. |

**Deployment model.** One customer gets one Vercel project and one Turso database. The usual names are `procureflow-<slug>` for both. Schema and application code are shared. Data is not. There is no shared-row `org_id`. Pointing two projects at the same Turso URL merges those customers.

The operator commands are `npm run onboard:customer` and `npm run offboard:customer` (dry-run unless `--apply`; offboard also requires `--confirm-slug`). Onboard chains Turso database creation, the Vercel project and link, Production and Preview env, a wait until that Production deployment is Ready, then schema, the org skeleton, and the first admin. Offboard removes only `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `SESSION_SECRET` from Production and Preview, then runs `turso db destroy`. It leaves the Vercel project. The stepped commands (`turso:customer`, `vercel:customer`, `provision:customer`) do the same work one piece at a time. Procedure: [DEPLOY_MANUAL.md §1](DEPLOY_MANUAL.md#1-architecture-of-a-deployment) and [§6](DEPLOY_MANUAL.md#6-new-customer).

The buying path the software actually implements is the lifecycle in [SYSTEM_MANUAL.md §1](SYSTEM_MANUAL.md#1-what-procureflow-is): draft requisition, sequential approval, budget commit on final approve, one purchase order per supplier, optional change order, then goods receipt or service acceptance (or a consignment, utility, or bulk payable that is not a goods receipt), vendor invoice, dual match, exception and duplicate handling, AP approval, aging, and a payment run or mark-paid. Contracts can propose a renewal requisition. What is explicitly not built is listed in [SYSTEM_MANUAL.md §2](SYSTEM_MANUAL.md#2-what-procureflow-is-not) and [§11](SYSTEM_MANUAL.md#11-out-of-scope).

---

## 2. Timeline of merged work

`git log` on `main` is a sequence of squash merges. Subjects below are those commit subjects. Short SHAs are the prefixes from that log.

### 2.1 Product already on `main` before the customer-install CLIs

These commits are the procure-to-pay core. Detail lives in [README.md](../README.md) and [ARCHITECTURE.md](ARCHITECTURE.md). This table is only the merge record. `git log` shows no merge whose subject contains `#1`, `#2`, or `#5`.

| PR | Subject | SHA | Date |
| --- | --- | --- | --- |
| — | Complete non-production procurement system (React + SQLite) | `309f1d45` | 2026-09-04 |
| [#3](https://github.com/pesl98/new_p2p_indirect/pull/3) | Store money as cents and correct 3-way match | `cb0834b6` | 2026-09-04 |
| [#4](https://github.com/pesl98/new_p2p_indirect/pull/4) | Sequential role-based approval routing | `51fd1b7a` | 2026-09-04 |
| [#6](https://github.com/pesl98/new_p2p_indirect/pull/6) | Receiving and budget controls, plus architecture docs | `1d4ff2ed` | 2026-09-04 |
| [#7](https://github.com/pesl98/new_p2p_indirect/pull/7) | Service entry sheets and SES-backed match for service lines | `a4e5b0ed` | 2026-09-05 |
| [#8](https://github.com/pesl98/new_p2p_indirect/pull/8) | Multi-supplier PO split (one issued PO per vendor) | `e42bc004` | 2026-09-06 |
| [#9](https://github.com/pesl98/new_p2p_indirect/pull/9) | P2P document trail / lifecycle overview | `047a75d2` | 2026-09-06 |
| [#10](https://github.com/pesl98/new_p2p_indirect/pull/10) | Deploy on Vercel with Turso (SQL-over-HTTP) | `392f586e` | 2026-09-06 |
| [#11](https://github.com/pesl98/new_p2p_indirect/pull/11) | Fix Vercel unmatched-function-pattern (entry moved to `api/`) | `66cdedff` | 2026-09-06 |
| [#12](https://github.com/pesl98/new_p2p_indirect/pull/12) | Fix Turso schema split dropping the departments `CREATE` | `3770c9d4` | 2026-09-06 |
| [#13](https://github.com/pesl98/new_p2p_indirect/pull/13) | Fix create/save purchase requisition on Turso HTTP | `d66208ff` | 2026-09-06 |
| [#14](https://github.com/pesl98/new_p2p_indirect/pull/14) | Invoice Exception Workbench | `c8777054` | 2026-09-08 |
| [#15](https://github.com/pesl98/new_p2p_indirect/pull/15) | Convert-requisition UI with per-line supplier remapping | `a6227fab` | 2026-09-08 |
| [#16](https://github.com/pesl98/new_p2p_indirect/pull/16) | Supplier and catalog edit and deactivate | `419c263d` | 2026-09-08 |
| [#17](https://github.com/pesl98/new_p2p_indirect/pull/17) | Invoice short-pay on the Exception Workbench | `0633f6ac` | 2026-09-09 |
| [#18](https://github.com/pesl98/new_p2p_indirect/pull/18) | Fix Turso init parse error from comment semicolons | `56394e92` | 2026-09-09 |
| [#19](https://github.com/pesl98/new_p2p_indirect/pull/19) | Org-admin maintenance for department step-1 approvers | `cf47644c` | 2026-09-09 |
| [#20](https://github.com/pesl98/new_p2p_indirect/pull/20) | Buyer Inbox for invoices returned to the requester | `57da0de4` | 2026-09-10 |
| [#21](https://github.com/pesl98/new_p2p_indirect/pull/21) | Approval delegation / out-of-office substitute | `3109bb28` | 2026-09-11 |
| [#22](https://github.com/pesl98/new_p2p_indirect/pull/22) | PO change orders / revisions | `8d6757dd` | 2026-09-12 |
| [#23](https://github.com/pesl98/new_p2p_indirect/pull/23) | AP payment aging / payables queue | `53625c35` | 2026-09-13 |
| [#24](https://github.com/pesl98/new_p2p_indirect/pull/24) | Duplicate invoice detection | `c048bbe5` | 2026-09-14 |
| [#25](https://github.com/pesl98/new_p2p_indirect/pull/25) | SaaS and vendor contract renewal hub | `e5ccb9eb` | 2026-09-14 |
| [#26](https://github.com/pesl98/new_p2p_indirect/pull/26) | Auto-assign PRs to matching contracts; approver allow/refuse | `0c062ea5` | 2026-09-14 |
| [#27](https://github.com/pesl98/new_p2p_indirect/pull/27) | Preserve an explicit no-contract choice on draft submission | `6e7bb6bb` | 2026-09-15 |
| [#28](https://github.com/pesl98/new_p2p_indirect/pull/28) | AP payment run / batch ACH payment proposal | `455a6aaa` | 2026-09-15 |

### 2.2 Customer install, system manual, and offboard (#29–#40)

[SPRINT-LOG.md](SPRINT-LOG.md) treats this as history before the Architect program. The merge subjects and, where the pull request stated one, the test count, are below.

| PR | What merged | SHA | Date | Tests in the PR body |
| --- | --- | --- | --- | --- |
| [#29](https://github.com/pesl98/new_p2p_indirect/pull/29) | Isolated database per tenant, plus migrate/status CLI | `a66342fe` | 2026-09-15 | not stated in this report’s sources |
| [#30](https://github.com/pesl98/new_p2p_indirect/pull/30) | Admin user management and per-tenant session auth | `476b2ae8` | 2026-09-15 | not stated |
| [#31](https://github.com/pesl98/new_p2p_indirect/pull/31) | Post-provision smoke checks and the empty-tenant path | `358b0b35` | 2026-09-16 | not stated |
| [#32](https://github.com/pesl98/new_p2p_indirect/pull/32) | New-customer onboarding / deploy runbook | `a7235b2e` | 2026-09-16 | not stated |
| [#33](https://github.com/pesl98/new_p2p_indirect/pull/33) | `vercel:customer` for Production and Preview env, then redeploy | `885856bb` | 2026-09-17 | not stated |
| [#34](https://github.com/pesl98/new_p2p_indirect/pull/34) | `bootstrap-org` for empty-tenant cost centers | `cc28491c` | 2026-09-18 | not stated |
| [#35](https://github.com/pesl98/new_p2p_indirect/pull/35) | System manual for operators (`docs/SYSTEM_MANUAL.md`) | `20303855` | 2026-09-18 | not stated (docs; the PR says no application code) |
| [#36](https://github.com/pesl98/new_p2p_indirect/pull/36) | `turso:customer`: create or reuse the DB, mint a database token, print exports | `ecae9e3a` | 2026-09-20 | 389 passed |
| [#37](https://github.com/pesl98/new_p2p_indirect/pull/37) | `onboard:customer`: one command chaining Turso, Vercel env, and provision | `4e817051` | 2026-09-21 | the PR says to run `npm test`; it does not record a count |
| [#38](https://github.com/pesl98/new_p2p_indirect/pull/38) | `vercel project add` and `vercel link` from the CLI when the checkout is not already linked | `fb8517c3` | 2026-09-22 | 421 passing |
| [#39](https://github.com/pesl98/new_p2p_indirect/pull/39) | Wait until Production `readyState` is READY before onboard smoke | `7f37e4de` | 2026-09-23 | 431 passed, 0 failed |
| [#40](https://github.com/pesl98/new_p2p_indirect/pull/40) | `offboard:customer`: strip the three customer env vars, then `turso db destroy` | `5266a633` | 2026-09-24 | 451 passing |

What those later PRs say, and what the manuals still describe:

- **#35** added `docs/SYSTEM_MANUAL.md` as the operator entry point after #34, and linked it from the README, architecture, onboarding, and deployment docs. The manual’s opening sentence still says it describes `main` after PR #34. Later sections were updated through SSO, audit, integrations, and EUR (see section 5).
- **#36** added `npm run turso:customer`. Dry-run by default. `--apply` creates or reuses `procureflow-<slug>` as classic libSQL (it refuses `--tursodb`), prints the URL and a database token, and mints `SESSION_SECRET` unless that variable is already exported. It does not destroy an existing database.
- **#37** added `npm run onboard:customer`, which calls the Turso, Vercel, and provision CLIs in process. Dry-run prints the plan and invents no secrets. `--with-org` is on for this orchestrator. `--seed` and `--tursodb` are refused. At merge, a checkout that was not linked to the Vercel project stopped for a human `vercel link`.
- **#38** closed that gap. `vercel:customer --apply` runs `vercel project add` and `vercel link --yes --project`. An existing project is reused. A checkout linked to a different project fails closed. `vercel project add` does not connect GitHub; production deploy is from the laptop.
- **#39** polls `vercel inspect <deployment> --json` until `readyState` is `READY` (default 4 minutes, `VERCEL_READY_TIMEOUT_MS`). `onboard:customer --apply --smoke` can then hit the hostname that just finished building.
- **#40** added `npm run offboard:customer`. `--apply` does nothing destructive unless `--confirm-slug` equals the normalized slug. It removes only the three customer env vars, then `turso db destroy`. It does not delete the Vercel project (`vercel project rm` on the CLI that was checked, 59.26.0, has no `--yes`). It does not seed. The PR’s own file, `server/src/offboardCustomer.test.js`, is described as 20 tests inside the 451 total.

### 2.3 Feature PRs in the sprint log’s recent-history table (#42–#45)

[SPRINT-LOG.md](SPRINT-LOG.md) lists these as context, not as daily-program sprints. The same table also lists #41; that manual merged later and is in section 2.4, which matches `git log` order.

| PR | Theme | SHA | Date | Tests in the PR body |
| --- | --- | --- | --- | --- |
| [#42](https://github.com/pesl98/new_p2p_indirect/pull/42) | Service procurement (lump sum, hours, days) | `736f3287b8e5c7431de8d4740ec8a1252d14042b` | 2026-09-29 | 458 passed |
| [#43](https://github.com/pesl98/new_p2p_indirect/pull/43) | Consignment stock, separate from owned GRN | `dfd83b7278b75aeb8d6a2f9ea3127e1f3ba733b8` | 2026-09-30 | 465 passing |
| [#44](https://github.com/pesl98/new_p2p_indirect/pull/44) | Document trail control on the View PO screen | `5560f8beafd3bd1d6afe29e226cda8dbf91a76e5` | 2026-10-01 | 469 passed |
| [#45](https://github.com/pesl98/new_p2p_indirect/pull/45) | Metered utilities and vendor-managed bulk | `71d0ee81497bf88dd6e38558f737569f8f3be85b` | 2026-10-01 | 472 passed |

- **#42.** A service line can set `service_basis` to `lump_sum`, `hours`, or `days`. Quantity stays a whole number and money stays integer cents. Omitting the basis keeps the older unit quantity (seats and licenses). Services are rejected on a goods receipt and closed on a service entry sheet. Invoice match uses accepted quantity. Seed examples named in the PR: `PR-2026-005` / `PO-2026-003` / `SES-2026-001`, and draft `PR-2026-011`.
- **#43.** Consignment is supplier-owned stock at the buyer site. Receipt `CSN-YYYY-NNN` increases on-hand for a supplier, a goods catalog item, and a free-text location. There is no location master. Issue `CSI-YYYY-NNN` decreases on-hand and creates a draw-down PO (`order_source = consignment`, `quantity_consumed` set, `quantity_received` left at 0). A goods receipt against that line is rejected. Match uses the drawn quantity.
- **#44.** The View Purchase Order screen gained a Document trail button that opens the existing trail with the PO id already on the screen. Other trail lookups were unchanged. The new test file named in the PR is `client/src/documentTrailNav.test.js`.
- **#45.** A utility arrangement (`UTA-YYYY-NNN`) plus a reading (`UCN-YYYY-NNN`) opens a payable (`settlement_kind = utility`). A vessel (`BVL-YYYY-NNN`) has a measured level; a fill (`BFL-`) only raises it; a draw (`BDR-`) lowers it and opens a payable (`settlement_kind = bulk`). Quantity is integer milli-units (`quantity_scale = 1000`). No goods-receipt row is inserted. Change orders are refused on these payables. Discrete consignment and service entry sheets were left as they were.

### 2.4 Architect-led sprint program

Owner recorded in [SPRINT-LOG.md](SPRINT-LOG.md): Peter (`pesl98`). The program is one sprint per day, one goal, preferably one pull request. Each SHA below matches `git rev-parse` on `main`.

| Work | PR | Merge SHA | Date |
| --- | --- | --- | --- |
| Sprint 1 — authorization rewrite | [#46](https://github.com/pesl98/new_p2p_indirect/pull/46) | `e6bdf1ea7ba144c12a95da4cabeebd9430def42a` | 2026-10-05 |
| Sprint 2 — SSO (OIDC / SAML) | [#47](https://github.com/pesl98/new_p2p_indirect/pull/47) | `9bbd4fbf83ce5277a18435d2693d91aa58b755da` | 2026-10-06 |
| Sprint 3 — audit and compliance | [#48](https://github.com/pesl98/new_p2p_indirect/pull/48) | `4472b2725a70f7743a978ecfb5cdd02488aca72e` | 2026-10-06 |
| Deploy and operations manual | [#41](https://github.com/pesl98/new_p2p_indirect/pull/41) | `d3e8b656b0a8e398e4782319e6960e467803e665` | 2026-10-06 |
| Sprint 4 — integrations | [#49](https://github.com/pesl98/new_p2p_indirect/pull/49) | `d050d330ef7c8c58080d2f102053a6838a69e7ab` | 2026-10-06 |
| Sprint 5 — EUR currency | [#50](https://github.com/pesl98/new_p2p_indirect/pull/50) | `8a025b4ff35e6eee3346cadec8ee13b12b288850` | 2026-10-06 |
| Sprint 6 — Dutch (NL) i18n | [#52](https://github.com/pesl98/new_p2p_indirect/pull/52) | `a41ec42a327afe2c0d28211c7e9a17d3343450a5` | 2026-10-07 |

#41 is a documentation PR. It merged after Sprint 3 and before Sprint 4, which is why it sits in this list rather than with #42–#45. Sprint 6 is the tip of `main` at the SHA above.

---

## 3. Per sprint

### Sprint 1 — full authorization rewrite ([#46](https://github.com/pesl98/new_p2p_indirect/pull/46))

**Goal.** End demo-open and body-persona authentication. The signed-in user is the actor. Fail closed. Leave a cookie that a later identity provider can mint. Do not build SSO in this sprint.

**What was built.**

- Cookie `pf_session`, HMAC-SHA256 with `SESSION_SECRET`, not a JWT library. Lifetime 7 days. `HttpOnly`, `SameSite=Lax`, `Secure` when `VERCEL` is set or `NODE_ENV=production`.
- Public without a session: `GET /api/health`, and `/api/auth/*` (`GET /api/auth/config`, `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/bootstrap`, `GET /api/auth/me`). `GET /api/auth/me` returns 401 when signed out.
- Every other `/api` route requires the cookie (401). Actor fields (`approver_id`, `requester_id`, `received_by`, `created_by`, `actor_name`, and the same kind of field on goods, services, consignment, utilities, bulk, contracts, and delegations) come from `req.user`. A body or query id that names someone else is 403.
- AP approve, mark paid, exception resolve, duplicate resolve, aging, and payment runs require `finance` or `admin`. User administration and department-head assignment require `admin`.
- `GET /api/auth/config` reported `identityProvider: "local"`. No SSO routes.
- Seed login, documented in the sprint log: `npm run seed` (destructive) sets password `ProcureFlow!demo` on the eight demo personas. `DEMO_PERSONA_SWITCHER=1` shows a header dropdown that signs in again with that password. It does not skip the session. Empty customer databases do not use that password.

**Design decisions.** The session is the actor, so a hidden sidebar item is not an authorization boundary (principle 1 and 3 in section 4). The cookie format was chosen so Sprint 2 could call `signSessionToken` without a second identity header. Local development may fall back to the insecure default `procureflow-dev-insecure-session-secret` and log a warning; a customer deploy is supposed to set `SESSION_SECRET`.

**Security.** Unauthenticated business calls are 401. A mismatched persona id is 403. Inactive users cannot log in (403). `DELETE /api/users/:id` is 405. Password hashes are bcrypt and are not returned by the API.

**Tests at merge.** The PR body records `npm test` — 481 passing.

### Sprint 2 — SSO / SAML / OIDC ([#47](https://github.com/pesl98/new_p2p_indirect/pull/47))

**Goal.** An OIDC or SAML callback mints the same `pf_session` cookie. Missing or invalid SSO configuration fails closed. Local password login keeps working where it is configured.

**What was built.**

- `identityProvider` is `local` (default), `oidc`, or `saml`.
- OIDC routes: `GET /api/auth/oidc/start` and the callback at `{APP_BASE_URL}/api/auth/oidc/callback` (override with `OIDC_REDIRECT_URI`). Library: `openid-client`. Authorization code, PKCE S256, `state`, `nonce`, and ID-token signature via issuer JWKS (`enableNonRepudiationChecks`), plus issuer, audience, and expiry.
- SAML routes: `GET /api/auth/saml/start`, `POST` ACS at `{APP_BASE_URL}/api/auth/saml/acs`, metadata at `GET /api/auth/saml/metadata`. Library: `@node-saml/node-saml`. SP-initiated only.
- Tables: `user_identities` (provider + subject), `tenant_settings` (singleton `id = 1`: `sso_provisioning`, `sso_default_role`), `sso_login_events`, `sso_assertion_uses`, and single-use `sso_requests` (deleted when the attempt finishes).
- Admin settings: `GET` and `PUT /api/auth/sso-settings`. The login page shows the SSO link when `ssoReady` is true.
- Env vars are per deployment. The full tables are [DEPLOYMENT.md §2.1](DEPLOYMENT.md#21-sso-oidc-or-saml-per-customer) and [SYSTEM_MANUAL.md §3](SYSTEM_MANUAL.md#sso-oidc-or-saml). `vercel:customer` does not write them.

**Design decisions.**

- One customer, one deployment, one database. IdP endpoints and secrets stay in environment variables. The database stores only the provisioning switch (default off) and the default role (default `requester`).
- Mapping order: `user_identities` first; otherwise a case-insensitive `users.email` match. OIDC requires `email_verified` for that match. A signed SAML email counts as verified. The first verified email match stores the subject. A subject already linked to a different user is `403 sso_identity_conflict`. Inactive users are rejected.
- Unknown users are `403 sso_user_unknown` unless `SSO_PROVISIONING=1` or an admin sets provisioning. Just-in-time users get the configured role, never a role from an IdP claim, the callback query, or a `role` field on the settings body. Approval limit is 0. No password is stored. The first admin is still bootstrap, because the default JIT role is `requester`.
- `LOCAL_LOGIN` defaults on. `LOCAL_LOGIN=0` returns `403 local_login_disabled` and does not open an unsigned path.
- At least one of assertion signature or response signature must be required. `SAML_WANT_ASSERTIONS_SIGNED` defaults true; `SAML_WANT_RESPONSE_SIGNED` defaults false. Both false fails closed. This app also requires `Recipient` to equal the ACS URL and records the assertion id.
- RelayState is not a redirect target. The browser returns to `APP_BASE_URL` `/`.

**Security.** `oidc` or `saml` with missing or invalid IdP settings leaves `ssoReady` false: start and callback return `503 sso_not_configured` and set no cookie. A JSON client gets that status; a browser, when `APP_BASE_URL` is set, is sent to `/?sso_error=sso_not_configured`. An unknown provider value does the same and does not fall through to a persona. An unreachable OIDC issuer returns `503 sso_idp_unavailable` and sets no cookie. Bad state, nonce, signature, audience, expiry, recipient, and replay are rejected. `sso_login_events` and `sso_assertion_uses` are append-only inserts. Sprint 1’s cookie rule is unchanged: business APIs without `pf_session` are 401.

**Tests at merge.** The PR body records **499 passed, 0 failed**.

### Sprint 3 — audit and compliance reporting ([#48](https://github.com/pesl98/new_p2p_indirect/pull/48))

**Goal.** An auditable trail for auth, SSO, and the procurement decisions that move money, plus compliance reports an admin or finance user can query and export. Fail closed for everyone else.

**What was built.**

- Append-only triggers (`BEFORE UPDATE` / `BEFORE DELETE` with `RAISE(ABORT, …)`) on `audit_logs`, `sso_login_events`, `sso_assertion_uses`, and the new `compliance_audit_events`.
- Hash chain on `compliance_audit_events` only: `prev_hash` is `GENESIS` on the first row, otherwise the previous `row_hash`. `row_hash` is a SHA-256 hex digest of that link plus a canonical JSON payload, computed in the server. A trigger rejects a broken link or a digest that is not 64 hex characters.
- New ledger actions include local login success and failure, inactive and disabled login, logout, bootstrap, user create / update / status / password (password redacted), SSO settings changes, JIT user create, and `COMPLIANCE_EXPORT`.
- Reports, admin and finance only, `GET /api/compliance/:report` and `?format=csv`:
  - `audit-trail` — union of the four sources, oldest first. Filters: `from`, `to`, `actor`, `entity_type`, `entity_id`, `action`. Default limit 500, max 2000.
  - `approval-policy` — detective segregation findings (listed in section 5).
  - `payment-support` — paid invoices missing approval or receipt, and a paid PO whose requisition was never approved.
  - `verification` — re-derived totals, plus the hash chain.
- Sidebar **Audit & Compliance** for `finance` and `admin`.
- `npm run db:migrate`, or the next process start, applies the table and triggers (`CREATE TABLE IF NOT EXISTS`, `CREATE TRIGGER IF NOT EXISTS`). No separate SQL file.

**Design decisions.**

- Procurement decisions stay in `audit_logs`. SSO attempts stay in `sso_login_events`. Assertion ids stay in `sso_assertion_uses`. The trail report reads them in place. It does not copy SSO rows.
- `audit_logs` is not hash-chained. Many call sites already insert it, historical rows have no digest, and SQLite and Turso HTTP do not share a SHA-256 function the trigger could call. Tamper of those rows is still blocked by the update/delete triggers.
- `sso_requests` stay deletable. They are single-use login state, not evidence. Local password login is not written into `sso_login_events` (that table’s provider check is only `oidc` or `saml`).
- There is no sixth `auditor` role. Finance is the existing control lens.
- Segregation findings are detective. They do not add a new block on submit, receive, or pay.
- CSV is built first. `COMPLIANCE_EXPORT` is appended only after `toCsv()` returns a string, so a crash while building the file does not record an export that never left the server. The export row appears on the next query.
- Demo seed inserts absolute `audit_logs` timestamps, because those rows can no longer be updated.

**Security.** New compliance rows take `actor_user_id` and `actor_name` from `req.user`. A failed local login has no session: the actor name is the presented email, and the user id is the matching account when one exists. A body `actor_name` is ignored. Bootstrap attributes the first admin to the user just created. JIT provisioning attributes `USER_CREATED` to that new user; the login itself remains an `sso_login_events` row. Requester, approver, and procurement get 403. No cookie is 401. The verification report recomputes the digest.

**Tests at merge.** The PR body records **509 passed, 0 failed**.

### Deploy and operations manual ([#41](https://github.com/pesl98/new_p2p_indirect/pull/41))

**Goal.** One operator manual for a customer install: deploy, SSO, audit, update, and offboard, using the commands that exist in `package.json`.

**What was built.** `docs/DEPLOY_MANUAL.md`. The branch merged `main` at the Sprint 3 SHA and kept main’s text in the conflicted docs, then pointed README, architecture, onboarding, deployment, the system manual, and `scripts/provision-customer.md` at the new manual. CLI `--help` text points at it. `server/package.json` gained an `offboard:customer` script the root script already called. No CLI flag was added.

The manual’s own summary of coverage: the customer commands; Sprint 1 session auth; Sprint 2 SSO env and fail-closed behavior; Sprint 3 append-only triggers, the hash chain, and the verification report as the ops health check. It states that `offboard:customer` still removes only the three database secrets and leaves SSO env vars on the project.

**Tests at merge.** The PR body records **509 passed, 0 failed** (same count as Sprint 3; this PR did not add product tests).

### Sprint 4 — integrations ([#49](https://github.com/pesl98/new_p2p_indirect/pull/49))

**Goal.** Plug one deployment into an external ERP, AP, and catalog system: scoped API keys, idempotent vendor and catalog upserts, signed webhooks with a durable outbox, and a pull export. No SSO changes. No EUR (that was Sprint 5) and no Dutch UI.

**What was built.**

- Tables: `api_keys`, `api_key_rate_windows`, `integration_entity_links`, `integration_idempotency`, `webhook_outbox`. Created by `npm run db:migrate` or the next process start.
- Admin session routes (`pf_session`, role `admin`): `POST/GET /api/integrations/keys`, `POST /api/integrations/keys/:id/revoke`, `GET /api/integrations/config`, `GET /api/integrations/outbox`, `POST /api/integrations/outbox/dispatch`, `POST /api/integrations/outbox/:id/replay`.
- Machine routes (`Authorization: Bearer pfk_…`): `POST /api/integrations/vendors` (`vendors:write`), `POST /api/integrations/catalog` (`catalog:write`), `GET /api/integrations/exports/invoices` and `GET /api/integrations/exports/payment-runs` (`export:read`).
- UI: **Administration → Integrations** (key shown once; outbox with status, attempts, last error, replay, and deliver pending).
- Env, not stored and not written by the customer CLIs: `WEBHOOK_TARGET_URL`, `WEBHOOK_SIGNING_SECRET`.
- Events enqueued in the same transaction as the business write: `po.issued`, `receipt.posted` (goods receipt, not a service entry), `invoice.approved`, `payment_run.created`, `payment_run.paid`.

**Design decisions.**

- Partner-API style, not a shared persona (principle 4). Shipped scopes are only the three above. There is no `invoices:write`.
- Key material is `pfk_` plus 32 random bytes. The database stores SHA-256 hex. `key_prefix` is the first 12 characters. Revoke sets `revoked_at`. Rows are not deleted. The plaintext is returned once.
- Rate limit: fixed one-minute window in `api_key_rate_windows`, default 60, admin-set from 1 to 6000. Over the limit is 429. The window is per key in that customer’s database, so it holds across serverless instances.
- Machine routes ignore the cookie. A key does not open the rest of `/api`. That split is intentional.
- Idempotency: the external id is the entity key (`UNIQUE(entity_type, external_id)`). `Idempotency-Key` replays the first successful response for that key and body. The same key with a different body is 409.
- Catalog `unit_price` is integer cents. Preferred vendor is `preferred_supplier_external_id` after the vendor upsert. Supplier `code` is immutable after create. Omitted optional fields are cleared to their defaults on update, so the caller sends the full record.
- Webhook header `X-ProcureFlow-Signature: t=<unix>,v1=<hex>` is HMAC-SHA256 of `${t}.${rawBody}`. Receivers should reject a timestamp more than 5 minutes off and dedupe on `evt_<outbox id>`. A retry is a new signature for the same event id, because the timestamp is the send time.
- Outbox status `pending`, `delivered`, or `dead`. Five attempts. Backoff after a failure is 30s, 2m, 10m, 1h. A missing URL or secret does not burn attempts. Replay resets the attempt count. `npm start` retries every 30 seconds and returns immediately when `VERCEL` is set. On Vercel the write attempts once; later retries are **Deliver pending**, replay, or the next business event’s sweep. `vercel.json` has no cron.
- At Sprint 4, export JSON `currency` was hardcoded `USD`. Sprint 5 replaced that. Amounts are cents. Each pull appends `INTEGRATION_EXPORT`.

**Security.** Missing, malformed, unknown, revoked, or expired key: 401. Wrong scope: 403. Over the limit: 429. Integration writes use `actor_name` = the key’s name, `actor_role` = `integration`, `actor_user_id` = null. A body `user_id`, `actor_name`, `created_by`, or similar is 400. Key create, key revoke, and webhook replay use the admin session. The signing secret is never stored and never returned. `GET /api/integrations/config` returns two booleans and the target host. Audit tables stay append-only. Non-admin key management is 403. No cookie on the admin routes is 401.

**Tests at merge.** The PR body records **518 passed, 0 failed**, including `server/src/integrations.test.js`.

**Left out of the PR, on purpose** (from the PR body, “not stubbed”): inbound supplier invoices through match and exceptions; ERP-specific adapters (SAP, NetSuite, and so on); service-entry webhooks; overlapping signing secrets during rotation; a Vercel cron for the outbox; treating single-invoice mark-paid as `payment_run.paid`; EUR currency and Dutch UI. The currency item shipped in Sprint 5. The others are still open (section 7).

### Sprint 5 — EUR currency ([#50](https://github.com/pesl98/new_p2p_indirect/pull/50))

**Goal.** Make EUR the deployment currency so a Netherlands customer is not shown hardcoded USD or `$`. One shared formatter. One `CURRENCY` setting. No Dutch UI translation and no foreign exchange.

**What was built.**

- `shared/currency.js`, used by `client/src/money.js` and `server/src/money.js`.
- `server/src/currencyConfig.js`: `CURRENCY` load, `CurrencyConfigError`, `withDeploymentCurrency`. Boot check in `createApp`. `GET /api/auth/config` and `GET /api/health` return `currency`.
- Server-generated money text that used a `$` plus `formatCents` now uses `formatMoney` (approvals, match, invoices, exceptions, duplicates, change orders, contracts, payment runs, document trail, requisitions, bootstrap-org, seed copy).
- Outbound `currency` on invoice and payment-run export JSON, a trailing `currency` column on the payment-run CSV, `currency` on money-bearing webhook payloads, and `currency` on the compliance verification JSON and CSV. The invoice CSV already had the column; the value follows `CURRENCY`. The audit-trail CSV header is unchanged. `receipt.posted` has no amount and no `currency` field.
- Documented in `.env.example`, `DEPLOYMENT.md`, `DEPLOY_MANUAL.md`, `SYSTEM_MANUAL.md`, `ARCHITECTURE.md`, `CUSTOMER_ONBOARDING.md`, and the README. The customer CLIs do not set `CURRENCY`.

**Design decisions.**

- Stored amounts stay integer cents. EUR and USD both use two decimal places, so switching `CURRENCY` does not convert or rescale. No migration.
- Locale is `nl-NL` for every allowlisted currency. UI strings stay English. EUR renders as `€ 1.295,00` (the space after the symbol is U+00A0; the docs use a normal space). USD in that locale is `US$ 1.295,00`. Rounding is half away from zero, then the grouped major and two-digit minor are written from integers. Null and non-finite amounts format as zero. `formatCents` stays a symbol-free dot-decimal (`749.00`) for non-display use.
- `CURRENCY` unset or blank is EUR. `eur` and `usd` are accepted and uppercased. Anything else throws `CurrencyConfigError` (`currency_misconfigured`, HTTP 503) at boot and does not silently fall back. The client reads `currency` from `GET /api/auth/config` and fails closed to EUR if that value is missing or not on the allowlist. There is no picker and no FX. Numeric inputs stay dot-decimal major units. Dutch comma entry is Sprint 6.
- SSO, `pf_session`, the append-only ledger, and the webhook dispatcher were left unchanged. No email sender exists in the repo to update.

**Security.** A bad `CURRENCY` refuses to boot (503) instead of formatting as EUR. The client does not invent a currency off the allowlist. Cent field names and values on the API are unchanged, so an ERP that already read cents still can. The new `currency` field tells that ERP which code those cents belong to.

**Tests at merge.** The PR body records **526 passed, 0 failed** (112 suites): formatter cases, a client `$` / `USD` guard, export and webhook currency, and `CURRENCY` validation including boot 503 for `GBP`.

### Sprint 6 — Dutch (NL) i18n ([#52](https://github.com/pesl98/new_p2p_indirect/pull/52))

**Goal.** Make the user-facing UI Dutch (Netherlands) so an NL customer can work in the product, with a catalog the team can extend, and accept comma decimals on amount fields.

**Merge.** `a41ec42a327afe2c0d28211c7e9a17d3343450a5` on 2026-10-07. `git rev-parse` on `main` matches that SHA. The commit subject is “Sprint 6 — Dutch (NL) i18n (#52)”.

**What was built.**

- The React UI is Dutch, locale `nl-NL`: login, navigation, dashboards, requisitions, approvals, purchase orders, receipts, invoices, payments, and the admin and settings screens that already exist. `html lang` is `nl-NL`.
- Strings live in a message catalog. `client/src/i18n.js` loads `client/src/i18n/nl-NL.js`, which is merged from `client/src/i18n/parts/`. `t('key', { name })` replaces `{name}`. `useI18n()` in `client/src/useI18n.js` subscribes to `setLocale` so a later locale can re-render. Only `nl-NL` is registered. An unknown locale falls back to `nl-NL`. There is no language picker.
- Amount fields accept a Dutch comma decimal. On the client, `parseMajorAmount` / `toCents` treat comma as the decimal separator and dot as thousands (`1.295,50` → 129550 cents). A single dot with one or two fractional digits still parses (`749.00`). `formatMajorInput` shows `1.295,50` in the field. Quantity, meter, and capacity inputs are not money.
- `presentError` maps known API sentences and machine codes to Dutch. Anything else becomes a Dutch fallback. The API response itself is unchanged. `presentNotice` translates success banners and match findings on display. The stored sentence is not rewritten.

**Design decisions.**

- Catalog, not a framework. The app had no i18n library.
- What stays English, on purpose: persona names, emails, document numbers, category and status values sent to the API, scope names, and text already stored in the database (audit details, justifications, seed descriptions). Actor-name fallbacks written onto the ledger stay the previous English strings so audit rows do not change shape.
- Stored values stay integer cents. `formatMoney` and `shared/currency.js` are unchanged from Sprint 5 (display locale `nl-NL`, default EUR). Server `toCents` is unchanged.
- Left alone: SSO, `pf_session`, the append-only ledger, integration routes, `CURRENCY`, the webhook drain, and the Sprint 5 icon follow-ups.

**Security.** No change to session auth, SSO fail-closed behavior, the hash chain, or scoped API keys. API machine codes stay English. The UI maps them. A role is still never taken from an IdP claim.

**Tests at merge.** The PR body records **535 pass, 0 fail** (114 suites, 0 skipped).

---

### Sprint 8d — sourcing hardening (in review)

Mail after commit for Q&A answers, bid receipts and award outcomes (copy link stays the default), a buyer-controlled outcome page in the supplier portal, `sourcing:read` / `sourcing:write` API keys with sealing, an optional `CRON_SECRET` tick, a CORS allowlist, demo RFQs in `npm run seed`, and the go-live checklist in the deploy manual. See [SPRINT-LOG.md](SPRINT-LOG.md) for decisions.

## 4. Design principles in force

From [SPRINT-LOG.md](SPRINT-LOG.md), “Design principles (from Storycodes)”. Different domain. The concepts are reused. Storycodes itself, and out-of-home features, are not ported.

1. **Fail-closed controls live in the database and the server**, not only in the UI. A hidden sidebar item is not an authorization boundary. Sprint 1 put the session on the API. Later sprints kept that: bad SSO config mints no cookie, a bad `CURRENCY` refuses to boot, an API key without the scope is 403, and append-only triggers abort `UPDATE` and `DELETE`.
2. **Append-only decision and evidence** where money or compliance matters. Prefer verification-style reports that re-derive totals from immutable records. That is Sprint 3’s verification report, and Sprint 4’s integration writes on the same ledgers.
3. **Role lenses without spoofable body ids.** The signed-in session is the actor (Sprint 1). Integration writes are the exception, and there the actor is the API key, not a body user id.
4. **Later integrations use scoped API keys and rate limits**, not a shared persona. That is Sprint 4.
5. **One database per customer** stays the isolation model. No shared-row `org_id`.

**Do not port:** Storycodes Petri-everywhere, the always-302 resolver, or scan metrics.

Peter’s backlog order, still the rule for future work: do not start a later item inside an earlier sprint’s pull request. The six items are authorization, SSO, audit, integrations, currency, and Dutch (Netherlands) UI. All six are merged.

---

## 5. Current system state

`main` at the Sprint 6 merge (`a41ec42a327afe2c0d28211c7e9a17d3343450a5`) includes the product in section 2.1, the customer CLIs, service procurement, consignment, the View PO document-trail button, metered utilities and bulk, session auth, SSO, compliance reports, integrations, the deploy manual, EUR as the default currency, and a Dutch `nl-NL` UI.

### 5.1 Roles and access

Five roles, the `users.role` check: `requester`, `approver`, `procurement`, `finance`, `admin`. `users.approval_limit` is stored and shown. Approval routing does not use it. Chains come from the requisition total and `server/src/approvalPolicy.js`.

Thresholds, in cents of the deployment currency (default EUR):

| PR total | Chain |
| --- | --- |
| ≤ € 1.000,00 (`APPROVAL_TIER2_CENTS` = 100000) | Department head (`departments.approver_user_id`, else `role=approver` in that department) |
| > € 1.000,00 and ≤ € 10.000,00 | Department head, then `procurement` |
| > € 10.000,00 (`APPROVAL_TIER3_CENTS` = 1000000) | Department head, then procurement, then `finance` or `admin` if no finance user exists |

Steps are sequential. Only the current step is `pending`. A body `approver_id` that names someone else is rejected. A delegate may decide the current step without rewriting the stored approver.

API gates from `server/src/requestActor.js` and the route modules (the sidebar map is [SYSTEM_MANUAL.md §4](SYSTEM_MANUAL.md#4-screens-sidebar-map)):

| Action | Who |
| --- | --- |
| Any business `/api` route that is not health, `/api/auth/*`, or an integration machine route | Signed-in session. Otherwise 401. |
| Create and edit requisitions, purchase orders, receipts, catalog, contracts, and the other screens marked “Everyone” | Any signed-in role. Catalog edits are not limited to `procurement`. |
| Decide an approval step | The signed-in user must be the current pending approver, or an active delegate covering now. Otherwise 403. |
| Buyer Inbox | The signed-in requester (and that user’s department). The sidebar entry is requester-only. |
| Delegations | A non-admin may open or revoke a window only where they are the delegator. An admin may manage any pair. Sidebar: approver, procurement, finance, admin. |
| AP approve, mark paid, exception resolve, duplicate resolve, aging, payment runs | `finance` or `admin`. |
| Audit and compliance reports, including CSV | `finance` or `admin`. |
| Users, department-head assignment, API keys, webhook outbox, SSO settings | `admin`. |
| `DELETE` on users, suppliers, and catalog | 405. Deactivate is a status change. |

`GET /api/auth/sso-settings` is admin-only even though the `/api/auth/*` prefix is otherwise public; that route checks the session itself.

A few README feature sections, and one architecture sentence about contract APIs, still say “APIs stay demo-open (no JWT)”. That wording is older than Sprint 1. The code requires `pf_session` on those routes. Treat [ARCHITECTURE.md](ARCHITECTURE.md) authentication paragraph and [SYSTEM_MANUAL.md §3](SYSTEM_MANUAL.md#3-personas-and-authentication) as the current description.

### 5.2 Auth methods

| Method | When | Result |
| --- | --- | --- |
| Local email + password | `LOCAL_LOGIN` on (default). `POST /api/auth/login`. | Sets `pf_session`. `403 local_login_disabled` when local login is off. |
| First admin | Empty `users` table. `POST /api/auth/bootstrap` or `npm run bootstrap-admin`. | One admin. Refuses (CLI exit 2) if any user exists. |
| OIDC | `IDENTITY_PROVIDER=oidc` and the IdP env is valid. | Same cookie. See Sprint 2. |
| SAML | `IDENTITY_PROVIDER=saml` and the IdP env is valid. | Same cookie. SP-initiated. |
| Demo switcher | `DEMO_PERSONA_SWITCHER=1` after `npm run seed`. | Signs in again as a seeded user with `ProcureFlow!demo`. Off by default. The customer CLIs never set it. |
| API key | `Authorization: Bearer pfk_…` on the four machine routes only. | Not a user session. See section 5.4. |

`GET /api/auth/config` is public and reports `auth`, `identityProvider`, `ssoReady`, `localLogin`, `demoPersonaSwitcher`, `bootstrapNeeded`, and (since Sprint 5) `currency`.

### 5.3 Audit and compliance reports

Detail: [SYSTEM_MANUAL.md §5.13](SYSTEM_MANUAL.md#513-audit-and-compliance-reports). Operator use: [DEPLOY_MANUAL.md §8.7](DEPLOY_MANUAL.md#87-audit-and-compliance).

| Report | Path | What it flags |
| --- | --- | --- |
| Audit trail | `GET /api/compliance/audit-trail` | Union of `audit_logs`, `sso_login_events`, `sso_assertion_uses`, and `compliance_audit_events`. |
| Approval and segregation | `GET /api/compliance/approval-policy` | `self_approval`, `wrong_approver`, `missing_approval_step`, `unexpected_approval_step`, `policy_unresolved`, `sod_requester_receiver`, `sod_approver_receiver`, `sod_ap_overlap`. |
| Paid without support | `GET /api/compliance/payment-support` | Paid invoice with no approval audit, paid standard PO missing a goods receipt or an accepted service entry, paid PO whose requisition has no approved step. Consignment, utility, and bulk payables are not flagged for a missing GRN. |
| Verification | `GET /api/compliance/verification` | Header vs line totals for POs, requisitions, invoices, and payment runs, plus `hash_chain_prev_mismatch` / `hash_chain_digest_mismatch`. An empty chain is valid. JSON includes top-level `currency`. |

Append-only is the database trigger, not a convention. CSV is `?format=csv`. Exports are logged as `COMPLIANCE_EXPORT` after the file is built.

The trail query loads the four tables and filters in JavaScript (`queryAuditTrail` in `server/src/complianceReports.js`). `sod_ap_overlap` matches `audit_logs.actor_name` to `users.name`, because that table has no user id. Both are recorded as open gaps in section 7.

### 5.4 Integration endpoints and scopes

Detail: [SYSTEM_MANUAL.md §5.14](SYSTEM_MANUAL.md#514-integrations) and [DEPLOY_MANUAL.md §8.8](DEPLOY_MANUAL.md#88-integrations).

| Method | Path | Who |
| --- | --- | --- |
| `POST` | `/api/integrations/keys` | admin session |
| `GET` | `/api/integrations/keys` | admin session |
| `POST` | `/api/integrations/keys/:id/revoke` | admin session |
| `GET` | `/api/integrations/config` | admin session (booleans and host only) |
| `GET` | `/api/integrations/outbox` | admin session |
| `POST` | `/api/integrations/outbox/dispatch` | admin session |
| `POST` | `/api/integrations/outbox/:id/replay` | admin session |
| `POST` | `/api/integrations/vendors` | `vendors:write` |
| `POST` | `/api/integrations/catalog` | `catalog:write` |
| `GET` | `/api/integrations/exports/invoices` | `export:read` |
| `GET` | `/api/integrations/exports/payment-runs` | `export:read` |

Invoice export defaults to `approved_for_payment` (`paid` optional). Payment-run export defaults to `executed` (`draft` or `all`). `?format=csv` or `Accept: text/csv`. Amounts are cents. JSON `currency` is the deployment code.

### 5.5 Webhook events

| Event | When | Money fields |
| --- | --- | --- |
| `po.issued` | PO issue | Cent amounts, plus `currency` |
| `receipt.posted` | Goods receipt posted | No amount, so no `currency` |
| `invoice.approved` | Invoice approved for payment | Cent amounts, plus `currency` |
| `payment_run.created` | Payment run created | Cent amounts, plus `currency` |
| `payment_run.paid` | Payment run executed | Cent amounts, plus `currency` |

Signature, retry, and the Vercel drain limit are in Sprint 4 above. Single-invoice mark-paid is not a `payment_run.paid` event. Service-entry acceptance is not a webhook.

### 5.6 Currency

| Setting | Behavior |
| --- | --- |
| `CURRENCY` unset or blank | EUR |
| `EUR`, `eur`, `USD`, `usd` | That code, uppercased |
| Anything else | Process refuses to boot, HTTP 503 `currency_misconfigured` |

Display locale `nl-NL`. No in-app currency picker and no language picker. No foreign exchange. Stored columns stay integer cents. The Sprint 5 formatter is unchanged: `formatMoney` and `shared/currency.js` still format with locale `nl-NL` and default EUR. `createApp` loads the code once onto the app. `formatMoney` in `server/src/money.js` still calls `deploymentCurrency()`, which reads the environment again on each call. The client applies `GET /api/auth/config` via `setDisplayCurrency`, and falls back to EUR if the code is missing or not allowlisted (`client/src/money.js`, `client/src/App.jsx`).

### 5.6.1 UI language

The user-facing UI is Dutch (`nl-NL`) through the message catalog (`t()` / `useI18n()`). There is no picker. Unknown locales fall back to `nl-NL`. Amount fields accept a Dutch comma decimal (`1.295,50`); stored values remain integer cents. Seed and demo names, emails, document numbers, and text already stored in the database stay English. That residual English is intentional (Sprint 6 decisions). API responses stay as they were; the client maps known sentences and codes to Dutch on display.

### 5.7 Environment variables

The customer CLIs write only three variables, and only to Production and Preview: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SESSION_SECRET`. Everything else is set by hand on that project, or is injected by Vercel, or is only for the operator laptop.

Column-by-column notes, including which values are secret:

- [DEPLOY_MANUAL.md §3](DEPLOY_MANUAL.md#3-environment-variables) — the operator table (database, session, smoke, CLI paths, webhooks, currency).
- [DEPLOY_MANUAL.md §3.1](DEPLOY_MANUAL.md#31-sso-and-login-flags-the-clis-do-not-write) — SSO and login decisions.
- [DEPLOYMENT.md §2](DEPLOYMENT.md#2-set-connection-env), [§2.1](DEPLOYMENT.md#21-sso-oidc-or-saml-per-customer), and [§2.2](DEPLOYMENT.md#22-integrations-api-keys-and-webhooks-per-customer).
- [SYSTEM_MANUAL.md §3](SYSTEM_MANUAL.md#sso-oidc-or-saml) and [§8](SYSTEM_MANUAL.md#8-runtime-entrypoints-env-short).
- Names with no secret values: [`.env.example`](../.env.example).

Names those pages document:

| Group | Names |
| --- | --- |
| Database | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `PROCUREMENT_DB_PATH`, `PROCUREFLOW_LIBSQL_HTTP` |
| Session | `SESSION_SECRET`, `BCRYPT_ROUNDS`, `DEMO_PERSONA_SWITCHER`, `LOCAL_LOGIN` |
| SSO | `IDENTITY_PROVIDER`, `APP_BASE_URL`, `SSO_PROVISIONING`, `SSO_DEFAULT_ROLE`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, `OIDC_SCOPES`, `OIDC_ALLOW_INSECURE`, `SAML_ENTRY_POINT`, `SAML_IDP_CERT`, `SAML_IDP_ISSUER`, `SAML_SP_ENTITY_ID`, `SAML_ACS_URL`, `SAML_AUDIENCE`, `SAML_WANT_ASSERTIONS_SIGNED`, `SAML_WANT_RESPONSE_SIGNED`, `SAML_ALLOW_INSECURE` |
| Integrations | `WEBHOOK_TARGET_URL`, `WEBHOOK_SIGNING_SECRET` |
| Currency | `CURRENCY` |
| Process | `PORT`, `NODE_ENV`, `VERCEL`, `VERCEL_ENV` |
| Operator CLIs and smoke | `BASE_URL`, `SMOKE_EMAIL`, `SMOKE_PASSWORD`, `SMOKE_TIMEOUT_MS`, `VERCEL_READY_TIMEOUT_MS`, `TURSO_CLI`, `VERCEL_CLI` |

`VERCEL` and `VERCEL_ENV` are set by Vercel. Do not set `PROCUREMENT_DB_PATH` on Vercel. There is no `CRON_SECRET` in the current tree.

---

## 6. Operating it

Commands below are the entry points. The flags, the order of destructive steps, and the failure cases are in the deploy manual. Do not treat this section as a second copy.

**Onboard a customer.** Dry-run, then apply. [DEPLOY_MANUAL.md §6.1](DEPLOY_MANUAL.md#61-one-command-preferred). Shorter click path: [CUSTOMER_ONBOARDING.md §0](CUSTOMER_ONBOARDING.md#0-preferred-one-command-orchestrator).

```bash
npm run onboard:customer -- --slug <customer>
npm run onboard:customer -- --slug <customer> --apply --email … --password '…' --smoke
```

That creates or reuses the Turso database, ensures and links `procureflow-<slug>`, writes the three secrets to Production and Preview, waits until Production is Ready, migrates, inserts the five cost centers (`--with-org` is the default; `--no-org` skips them), and bootstraps the first admin. It does not seed. It does not set SSO, webhook, or `CURRENCY` variables. GitHub auto-deploy is still a one-time dashboard connection: `vercel project add` does not connect the Git repository.

**Bootstrap the first admin.** Included in the apply command above when `--email` and `--password` are passed. On an existing empty database: [DEPLOY_MANUAL.md §6.3](DEPLOY_MANUAL.md#63-empty-tenant-demo-seed-and-the-first-admin). UI **Create the first admin**, or `npm run bootstrap-admin`. Password length is at least 8 characters. This is not `npm run seed`.

**Configure SSO.** [DEPLOY_MANUAL.md §8.6](DEPLOY_MANUAL.md#86-configure-sso-for-this-customer). Set the IdP variables on that project’s Production and Preview, register the redirect or ACS URL, redeploy, and confirm `ssoReady: true` on `GET /api/auth/config`. Leave provisioning off until you mean to create unknown users. The role never comes from the IdP.

**Issue API keys.** [DEPLOY_MANUAL.md §8.8](DEPLOY_MANUAL.md#88-integrations), “Issue a key”. Sign in as admin, open **Administration → Integrations** (or `POST /api/integrations/keys`), copy `pfk_…` once, and store it outside the database. The list shows the prefix only. Revoke does not delete the row.

**Configure webhooks.** Same section, “Configure webhooks”. Generate a 32-byte hex secret, set `WEBHOOK_TARGET_URL` and `WEBHOOK_SIGNING_SECRET` on Production and Preview, redeploy. Confirm with `GET /api/integrations/config` (host and booleans only). On Vercel, a failed delivery waits for **Deliver pending**, replay, or the next business event. There is no platform cron.

**Run migrations.** [DEPLOY_MANUAL.md §4.3](DEPLOY_MANUAL.md#43-schema-on-an-empty-database) and [§7](DEPLOY_MANUAL.md#7-updating-existing-customers). `npm run db:migrate` (add `--turso` when the shell points at Turso) applies `schema.sql` and the additive migrations, including the compliance triggers and the integration tables. The next process start does the same. `npm run db:status` prints mode, table count, and user count, and does not apply schema. A git push does not migrate a customer database. Do not pass `--seed` on a live tenant.

**Run the verification report.** [DEPLOY_MANUAL.md §8.7](DEPLOY_MANUAL.md#87-audit-and-compliance). Sign in as admin or finance and open **Audit & Compliance → Verification**, or `GET /api/compliance/verification` with the session cookie. A healthy result has an empty findings list. An empty hash chain is valid. There is no npm script for this report. CSV is `?format=csv` and appends `COMPLIANCE_EXPORT` after the file is built.

**Offboard.** [DEPLOY_MANUAL.md §9](DEPLOY_MANUAL.md#9-offboarding).

```bash
npm run offboard:customer -- --slug <customer>
npm run offboard:customer -- --slug <customer> --apply --confirm-slug <customer>
```

`--confirm-slug` must equal the normalized slug. The command strips the three database secrets, then destroys the Turso database. It leaves the Vercel project and any SSO, webhook, and `CURRENCY` variables. It does not revoke the Turso token inside Turso. Audit rows cannot be deleted with SQL; destroying the database is how that customer’s evidence goes away. Delete the empty project in the dashboard if it should not remain.

---

## 7. Known gaps and backlog

These items are not done. Where the current code was checked, the file is named. They are not a commitment that a later pull request has already specified the patch.

### #52 follow-ups still open

Confirmed on `main` at `a41ec42a327afe2c0d28211c7e9a17d3343450a5`. GitHub review comments on PR #52 were empty when this report was updated (the Codex review bot reported a usage limit). These are the Architect follow-ups still visible in the tree, not quotes from a review thread.

- **Stale comment in `shared/currency.js`.** The file header still says “UI strings stay English until Sprint 6.” Sprint 6 shipped the Dutch catalog and did not change this formatter. The comment is leftover.
- **Residual demo and seed English is intentional.** Persona names, emails, document numbers, and text stored by the seed (audit details, justifications, descriptions) stay English, as the Sprint 6 decisions record. That is not an unfinished translation of the UI chrome.

### Webhook cron / drain

Not built. `vercel.json` has no `crons` key. `startLocalWebhookDispatcher` in `server/src/webhookOutbox.js` returns immediately when `VERCEL` is set. `npm start` sweeps every 30 seconds only off Vercel. The PR #49 body says the same thing: delivery on serverless is the inline attempt plus the admin sweep.

The follow-up to record, which is **not** described in a merged pull request or in the code, is: an authenticated drain that accepts a `CRON_SECRET` bearer, a `vercel.json` cron every 1–5 minutes, and optionally `waitUntil` for the first dispatch. Until that exists, operators use **Deliver pending** and replay ([DEPLOY_MANUAL.md §8.8](DEPLOY_MANUAL.md#88-integrations)).

### #49 nits still visible in the code

Confirmed against the tree at the Sprint 5 merge. GitHub review comments on PR #49 were empty when this report was written (the Codex review bot reported a usage limit), so these are code observations, not quotes from a review thread.

- **Rate limit runs before the scope check.** `authenticateIntegrationKey` in `server/src/apiKeys.js` calls `consumeRateLimit` and then checks `scopes`. An out-of-scope key still consumes the minute window. The follow-up is to reject the scope first.
- **Concurrent upserts on the same `external_id`.** `saveLink` in `server/src/integrationConnectors.js` selects, then inserts. `integration_entity_links` has `UNIQUE(entity_type, external_id)`, so two creates racing on a new id can fail the second insert instead of updating one row. There is no retry around that unique violation.
- **No minimum entropy for `WEBHOOK_SIGNING_SECRET`.** `loadIntegrationConfig` treats any non-empty trimmed string as ready. The manuals tell the operator to use a 32-byte hex string. The process does not enforce that length.
- **Tests.** `server/src/integrations.test.js` sends a bearer key to `GET /api/suppliers` and expects 401, and it calls `GET /api/purchase-orders` with no cookie and expects 401. It does not send a bearer token to `/api/purchase-orders`. Idempotency is tested as a sequential replay and a 409 on a different body. Concurrent idempotency is not tested. The PR body said both purchase-order bearer and suppliers bearer were covered; the purchase-order case in the file is the unauthenticated call.

### #50 nits still visible in the code

Same caveat: no review-thread text was available on PR #50. The code at the merge still shows these.

- **`DollarSign` icons in five views.** `client/src/views/DashboardView.jsx`, `RequisitionsView.jsx`, `BudgetsView.jsx`, `ApprovalsView.jsx`, and `InvoicesMatchingView.jsx` still import lucide-react `DollarSign`. Amount text goes through `formatMoney`. The icon component was not switched.
- **Resolve currency once at boot.** `createApp` stores the code on the request. `formatMoney` in `server/src/money.js` calls `deploymentCurrency()` on every format, which reads `process.env` again.
- **HTTP USD override and client fallback tests.** `server/src/currency.test.js` checks `loadCurrencyConfig({ CURRENCY: 'usd' })` and `withDeploymentCurrency` in process. It does not boot an app with `CURRENCY=USD` and assert an HTTP export or health body. Client fallback to EUR lives in `setDisplayCurrency` and the `App.jsx` config load; this report did not find a test that drives that fallback through the client.
- **Cosmetic `*_dollars` names.** `client/src/views/AdminUsersView.jsx` still uses `approval_limit_dollars` for the major-unit form field. `toCents(dollars)` in `server/src/money.js` uses the same word for a major-unit argument. `server/src/money.test.js` describes `toCents` as converting dollars. These are names, not a second currency.

### Left out of PR #49

From that pull request’s “Follow-ups left out” list, still not in the code unless noted:

- Inbound supplier invoices through the existing match and exception flow. `invoices:write` does not exist.
- ERP-specific adapters (SAP, NetSuite, and so on).
- Service-entry webhooks. `receipt.posted` is a goods receipt.
- Also listed there, and still true: overlapping signing secrets during rotation, a Vercel cron (see above), and single-invoice mark-paid as a webhook. EUR shipped in #50. Dutch UI shipped in #52.

### Deferred #48 nits

- **SQL-side audit-trail filters.** `queryAuditTrail` selects every row from the four evidence tables, then applies `from`, `to`, actor, entity, and action in JavaScript, then slices to the limit. The filters are not `WHERE` clauses.
- **`sod_ap_overlap` is a name-only match.** `server/src/complianceReports.js` compares `audit_logs.actor_name` to `users.name` (trimmed, case-insensitive). Two people with the same name collapse. The system manual states this limit: `audit_logs` stores the session name, not a user id.

### Other limits already written down

[SYSTEM_MANUAL.md §11](SYSTEM_MANUAL.md#11-out-of-scope) and [ARCHITECTURE.md — Known demo limits](ARCHITECTURE.md#known-demo-limits-out-of-scope) are the longer list: no SCIM, no OCR or PDF invoice capture, no NACHA file, no foreign exchange, no create-department UI, fiscal year 2026 hardcoded in budget queries, no transitive delegation, no platform cron for renewals or aging. Those pages are the source. This report does not restate every line.

The system manual’s first paragraph still says it describes `main` after PR #34. Sections 3, 5.13, 5.14, and 6 were updated later. Use those sections, and this report, for the sprint program.
