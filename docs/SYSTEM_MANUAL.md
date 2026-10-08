# ProcureFlow system manual

**Audience:** owner / operator who needs (1) the **exact shipped capabilities** and (2) **how to stand up a new customer**.

This is the single entry point. It describes what is implemented in code on `main` after [PR #34](https://github.com/pesl98/new_p2p_indirect/pull/34). It does **not** invent Coupa/Ariba-parity features.

| If you need… | Go here |
| --- | --- |
| Click-by-click new-customer runbook (Turso → Vercel → first login) | **[CUSTOMER_ONBOARDING.md](CUSTOMER_ONBOARDING.md)** |
| Env tables, Auth API, Vercel internals, rollback | **[DEPLOYMENT.md](DEPLOYMENT.md)** |
| Copy-paste operator checklist | [`scripts/provision-customer.md`](../scripts/provision-customer.md) |
| Control-model detail (match math, contract scoring, tests) | **[ARCHITECTURE.md](ARCHITECTURE.md)** |
| Env key names (no secrets) | [`.env.example`](../.env.example) |
| Feature walkthroughs on the seeded demo | [README.md](../README.md) |

---

## 1. What ProcureFlow is

ProcureFlow is a **full-lifecycle indirect Procure-to-Pay (P2P)** app for non-production goods and services: IT hardware/software, office supplies, facilities/MRO, consulting, SaaS subscriptions, marketing, and similar opex.

**Stack**

- **Client:** React (Vite). SPA tabs, not a multi-route router.
- **API:** Node.js / Express (`server/src/app.js`).
- **Local DB:** SQLite via `better-sqlite3` when both `TURSO_*` vars are omitted (`PROCUREMENT_DB_PATH`, gitignored under `server/data/`).
- **Customer / Vercel DB:** Turso (classic libSQL) over **HTTP** (`POST /v2/pipeline`). No native libsql `.so`.
- **Money:** integer **cents** of the deployment currency everywhere in SQLite and the API (default EUR; `CURRENCY=USD` does not rescale). Display uses `formatMoney` (`nl-NL`). Amount fields accept a Dutch comma decimal (`1.295,50`); stored values stay cents.
- **UI language:** Dutch (Netherlands), locale `nl-NL`. There is no language picker. Catalog: `client/src/i18n/`.

**Isolation:** **one database per customer** (one Turso DB or one SQLite file) **and** one Vercel project per customer. Schema and application code are shared; **data is not**. There is **no** shared-row `org_id` (or equivalent) multi-tenancy. Pointing two deploys at the same Turso URL **merges** those customers.

**Path:** this is a **demo-to-customer** product. The same git repo is deployed per tenant. Empty-tenant provision is the customer path; `npm run seed` is the laptop/training wipe.

**Lifecycle (what the software actually does)**

```
Draft PR → Submit → Sequential approvals → budget commit on final approve
        → Convert to PO(s) (one issued PO per resolved supplier)
        → Optional PO change order / revision
        → Goods: GRN          ──┐
        → Services: SES accept ─┴→ Vendor invoice (manual) → dual match
        → Consignment: supplier-owned on-hand → issue creates a draw-down PO (no GRN) → invoice matches drawn qty
        → Utilities: arrangement → measured reading → payable PO (no GRN) → invoice matches consumed qty
        → Bulk: container/silo level → measured draw → payable PO (no GRN) → invoice matches drawn qty
        → Exception workbench (hard failures; optional return_to_buyer → Buyer Inbox)
        → Duplicate suspects (soft hold) → AP approve → AP Aging → Payment run / Mark paid
        (parallel) Contracts hub → 1-click renewal PR → sequential approvals
        New PR create/submit may auto-propose a matching contract; approver allows or refuses
```

---

## 2. What ProcureFlow is not

Do not promise these. They are **not** in the code:

- Enterprise Coupa / SAP Ariba / Oracle Fusion replacement
- SCIM (OIDC and SAML login are optional per customer; see [§3](#3-personas-and-authentication))
- Shared-row multi-tenancy (`org_id` on every table)
- Email invoice capture, UBL/Peppol, or posting a PDF without a person reviewing it (PDF proposals are [§5.15](#515-pdf-invoice-proposals))
- Bank NACHA / ACH file export, remittance portal, early-pay discount calendar, foreign exchange or an in-app currency picker (one `CURRENCY` per deployment, default EUR)
- CLM, e-sign, vendor portal, successor `CNT-` rows, auto-extend of `end_date`
- Create-department or create-budget UI
- Full segregation of duties enforced on every API route (Sprint 3 reports violations; it does not block every write)
- Platform cron. A long-running `npm start` retries the webhook outbox every 30 seconds. Vercel does not. See [§5.14](#514-integrations).
- Native mobile apps
- Production MRP / warehouse WMS (bins, picks, cycle counts). Consignment on-hand is tracked; it is not a WMS.

Honest limits are listed again in [§11 Out of scope](#11-out-of-scope).

---

## 3. Personas and authentication

### Roles (`users.role` CHECK)

| Role | Typical job | UI notes |
| --- | --- | --- |
| `requester` | Creates PRs, responds in **Buyer Inbox** | Buyer Inbox sidebar only for this role |
| `approver` | Department head / step-1 | **Delegations** sidebar |
| `procurement` | Strategic sourcing (Carol in the demo) | Convert PR → PO, change orders, Vendors & Catalog, contracts; **Delegations** |
| `finance` | AP / controller (David in the demo) | **Duplicate Suspects**, **AP Aging**, **Payment Runs**, **Audit & Compliance**; **Delegations** |
| `admin` | Org admin / CFO (Elena in the demo) | **Administration → Users**, **Department Approvers**, and **Integrations**; **Audit & Compliance**; same AP queues as finance |

These five values are the only allowed roles. Additional people are created in **Administration → Users** (session admin), not by inventing new role strings.

`users.approval_limit` is stored as integer cents and shown in the header. **Approval routing does not use it.** Chains are built from **PR total** vs fixed thresholds plus **department-head mapping** and **role** (`server/src/approvalPolicy.js`).

### Session auth (customer default)

- Email + password. bcrypt hashes live in `user_credentials` (never returned by the API).
- httpOnly cookie `pf_session` (HMAC-SHA256, not a JWT library). TTL **7 days**. `SameSite=Lax`, `Secure` when `VERCEL` or `NODE_ENV=production`.
- `SESSION_SECRET` signs the cookie. **Required** on customer / Vercel deploys. Local/dev falls back to an insecure default and logs a warning.
- Password policy: **≥ 8 characters**.
- Inactive users (`users.status = inactive`) cannot log in (403).

| Endpoint | Purpose |
| --- | --- |
| `GET /api/auth/config` | Public: `{ auth, identityProvider, ssoReady, localLogin, demoPersonaSwitcher, bootstrapNeeded }` |
| `POST /api/auth/login` | `{ email, password }` → cookie. `403 local_login_disabled` when `LOCAL_LOGIN=0` |
| `POST /api/auth/logout` | Clears cookie |
| `GET /api/auth/me` | Session user or 401 |
| `POST /api/auth/bootstrap` | First admin on an **empty** `users` table only |

### SSO (OIDC or SAML)

Optional, per customer. The callback mints the same `pf_session` cookie. It does not add another identity header. `identityProvider` is `local` (default), `oidc`, or `saml`.

IdP endpoints and secrets are **environment variables on that customer’s deployment**. The database row `tenant_settings` (`id = 1`) stores only whether unknown users may be created (`sso_provisioning`, default **off**) and the role those users get (`sso_default_role`, default **`requester`**). Do not put a client secret or IdP certificate in the database.

Missing or invalid IdP settings leave `ssoReady` false. `GET /api/auth/oidc/start`, the OIDC callback, and the SAML start/ACS routes then return **503** `sso_not_configured` and set **no** cookie. They do not fall back to a persona or to an unsigned login. Password login still works unless `LOCAL_LOGIN=0`.

**Mapping.** `user_identities` (`provider` + `subject`) is checked first. Otherwise the verified email is matched to `users.email` (case-insensitive) and the subject is stored. OIDC requires `email_verified`. A signed SAML email counts as verified. Unknown users are **rejected** (`403 sso_user_unknown`) unless provisioning is on. The new user’s role is `SSO_DEFAULT_ROLE` when that env value is one of the five roles, otherwise the tenant row, otherwise `requester`. A role claim, query parameter, or `role` field on the settings body is ignored. Inactive users are rejected. An empty tenant still needs bootstrap for an admin: the default JIT role is `requester`.

**OIDC** (`IDENTITY_PROVIDER=oidc`). Confidential authorization-code client. The server sends PKCE S256, `state`, and `nonce`, and checks the ID token signature (issuer JWKS), issuer, audience, and expiry.

| Variable | Required | Notes |
| --- | --- | --- |
| `OIDC_ISSUER` | Yes | HTTPS issuer. `http` only with `OIDC_ALLOW_INSECURE=1` (local tests). |
| `OIDC_CLIENT_ID` | Yes | |
| `OIDC_CLIENT_SECRET` | Yes | Confidential client. Not stored in the DB. |
| `APP_BASE_URL` | Yes | This customer’s origin, e.g. `https://procureflow-acme.vercel.app`. Post-login redirect is this origin’s `/`. |
| `OIDC_REDIRECT_URI` | No | Default `{APP_BASE_URL}/api/auth/oidc/callback`. Register this exact URL on the IdP. |
| `OIDC_SCOPES` | No | Default `openid email profile`. Must include `openid`. |

**SAML** (`IDENTITY_PROVIDER=saml`). SP-initiated only. Signature, audience, `Recipient` (must equal the ACS URL), `NotOnOrAfter`, and `InResponseTo` are checked. Assertion ids are single-use.

| Variable | Required | Notes |
| --- | --- | --- |
| `SAML_ENTRY_POINT` | Yes | HTTPS IdP SSO URL. `http` only with `SAML_ALLOW_INSECURE=1`. |
| `SAML_IDP_CERT` | Yes | IdP signing certificate: PEM, `\n` escapes, or bare base64. |
| `SAML_IDP_ISSUER` | Yes | Must match the assertion issuer. |
| `SAML_SP_ENTITY_ID` | Yes | SP entity id. Default SAML audience. |
| `APP_BASE_URL` | Yes | Same as OIDC. |
| `SAML_ACS_URL` | No | Default `{APP_BASE_URL}/api/auth/saml/acs`. |
| `SAML_AUDIENCE` | No | Defaults to `SAML_SP_ENTITY_ID`. |
| `SAML_WANT_ASSERTIONS_SIGNED` | No | Default `true`. |
| `SAML_WANT_RESPONSE_SIGNED` | No | Default `false`. Setting **both** false fails closed. |

Give the IdP `GET /api/auth/saml/metadata`. Login starts at `GET /api/auth/saml/start`. The login page shows the SSO link when `ssoReady` is true.

**Provisioning (default off).** Either set `SSO_PROVISIONING=1` or, as an admin, `PUT /api/auth/sso-settings` with `{ "provisioning": true, "defaultRole": "requester" }`. `sso_provisioning` and `sso_default_role` are aliases for those two fields. `defaultRole` must be `requester`, `approver`, `procurement`, `finance`, or `admin`. A bad flag, an unknown role, or aliases that disagree is rejected (400) and the row is left unchanged. A `role` field on the body is ignored. `GET /api/auth/sso-settings` is admin-only (the `/api/auth/*` middleware is public; this route checks the session itself). `SSO_DEFAULT_ROLE` overrides the stored role when it is valid. A bad env flag or role does not turn SSO off for people who already have accounts; creating an unknown user then fails closed.

**Local login.** Leave `LOCAL_LOGIN` unset (default on). Seed/demo: any seeded email and `ProcureFlow!demo`. Set `LOCAL_LOGIN=0` only when this customer should use the IdP alone.

Successful and failed SSO attempts are inserted into `sso_login_events`. Assertion ids go to `sso_assertion_uses`. Both tables reject `UPDATE` and `DELETE` (database triggers). Compliance reports read them in place. Local password login is a separate append-only ledger (`compliance_audit_events`) because this table’s provider check is only `oidc` or `saml`.

**Enforced on session (`req.user`):** every `/api` route except health and `/api/auth/*` requires a signed-in user. Mutating `/api/users` and department-head assignment require `role=admin`. AP approve, mark paid, exceptions, duplicates, aging, and payment runs require `finance` or `admin`. Approvals and the buyer inbox are scoped to the signed-in user. A body persona id that names someone else is 403. `DELETE /api/users/:id` is **405**.

### Optional demo persona switcher

Set `DEMO_PERSONA_SWITCHER=1` (or `true` / `yes`) to show a header dropdown. Choosing a person **signs in again** with the seed password `ProcureFlow!demo`. It does not change identity without a session. Default is **off**. `npm run vercel:customer` **never** sets this flag. Live customers use the login page.

`GET /api/users` requires a session. The directory is what the dropdown lists after you are signed in.

### Seeded demo personas (training DB only)

Created **only** by `npm run seed` (destructive). Same demo password for all — see [§13](#13-demo-seed-vs-empty-tenant). Do **not** use these accounts on a live tenant.

| Name | Email | Role |
| --- | --- | --- |
| Alice Chen | `alice.chen@company.com` | requester |
| Bob Martinez | `bob.martinez@company.com` | approver (Marketing head) |
| Carol Zhang | `carol.zhang@company.com` | procurement |
| David Miller | `david.miller@company.com` | finance |
| Elena Rostova | `elena.rostova@company.com` | admin |
| Priya Nair | `priya.nair@company.com` | approver (IT head) |
| James Okonkwo | `james.okonkwo@company.com` | approver (Facilities head) |
| Sofia Berg | `sofia.berg@company.com` | approver (HR head) |

---

## 4. Screens (sidebar map)

The SPA is a tab switcher (`client/src/App.jsx`). There is no React Router.

| Sidebar | Who sees it | What it is |
| --- | --- | --- |
| Dashboard & Spend | Everyone | KPIs, spend by category/supplier, FY 2026 budget bars, recent `audit_logs` |
| Requisitions (PR) | Everyone | Catalog + ad-hoc PR, submit, contract override, convert |
| Approvals Inbox | Everyone (inbox filtered by persona id) | Current **pending** step only |
| Delegations | `approver` / `procurement` / `finance` / `admin` | OOO substitute |
| Purchase Orders (PO) | Everyone | Convert, print (`window.print`), change order, status |
| Goods Receipt (GRN) | Everyone | Company-owned goods lines only |
| Consignment Stock | Everyone | Supplier-owned whole units; free-text location; issue creates a draw-down PO |
| Metered Utilities | Everyone | Water, electricity, gas billed by measured consumption; no GRN |
| Vendor-Managed Bulk | Everyone | Container or silo level; measured draw opens a payable; no GRN |
| Service Entry (SES) | Everyone | Service lines: draft → submitted → accepted/rejected |
| Invoices & Matching | Everyone | Manual invoice against a PO; match matrix; approve / mark paid |
| **Finance inbox** | `finance` + `admin` | Upload a supplier-invoice PDF, review the OCR proposal, post or reject |
| Exception Workbench | Everyone | Hard dual-match failures |
| Duplicate Suspects | `finance` + `admin` | Likely-duplicate soft holds |
| Buyer Inbox | `requester` only | Invoices AP parked with `return_to_buyer` |
| AP Aging | `finance` + `admin` | Approved payables by due date |
| Payment Runs | `finance` + `admin` | Draft `PAY-YYYY-NNN` → execute |
| **Audit & Compliance** | `finance` + `admin` | Trail, segregation of duties, paid-without-support, verification; CSV export |
| Document trail | Everyone | PR → PO(s) → GRN/SES → invoice chain from FKs + audit |
| Budgets & Cost Centers | Everyone | Read-only FY 2026 allocated / committed / actual / remaining |
| Contracts & Renewals | Everyone | Agreements + 1-click renewal PR |
| Suppliers & Catalog | Everyone | Create / edit / soft-deactivate |
| **Administration → Department Approvers** | `admin` only | Map step-1 head; does **not** create departments |
| **Administration → Users** | `admin` only | Create / edit / password / soft-deactivate |
| **Administration → Integrations** | `admin` only | API keys (shown once) and the webhook outbox |

---

## 5. Capability catalog

Each subsection is **what ships**, then **known limits**. Seed document numbers (PR-2026-001, INV-TSG-11029, …) are training data on a wiped demo DB, not product features.

### 5.1 Catalog and suppliers

**Shipped**

- Create, list, edit suppliers (`POST/GET/PATCH /api/suppliers`). Unique `code` is **immutable** after create. Status: `active` | `inactive` | `under_review`. Default payment terms `Net 30`.
- Create, list, edit catalog items (`POST/GET/PATCH /api/catalog`). Unique `sku`. Status: `active` | `inactive`. Categories (schema CHECK):
  - IT Hardware, Office Supplies, Facilities & MRO → default **goods**
  - Software & Cloud, Consulting & Professional Services, Marketing & Events, Travel & Subscriptions → default **service**
  - Explicit `line_type` on create wins. Stored type is what GRN / SES / match use.
- Soft-deactivate only. `DELETE` returns **405**. Historical PR/PO/invoice/GRN/SES FKs are kept (no cascade delete).
- Requisition browse and buyer pickers default to **active** catalog (`GET /api/catalog`). Admin Vendors screen uses `?status=all`. Supplier list returns all (active first); pickers pass `?status=active`.
- Unique code/sku conflict → **409**. Assigning an inactive / `under_review` supplier as a **new** catalog preferred vendor → **400**. Deactivating a supplier that is still preferred on active catalog items **succeeds** with a `warnings[]` note.
- New PR lines cannot use an inactive catalog item or inactive `estimated_supplier_id`. Convert-to-PO cannot issue to an inactive supplier (remap first).
- Master-data field edits are **not** written to `audit_logs` (that table is for P2P lifecycle events).

**Limits**

- APIs are demo-open (no session gate). UI is available to every logged-in / switched persona.
- Not a Coupa master-data migration, punch-out, or supplier portal.
- Empty customer: no suppliers or catalog until someone creates them in **Suppliers & Catalog**.

### 5.2 Requisitions (catalog + ad-hoc)

**Shipped**

- Draft PR with catalog lines and/or ad-hoc/custom lines. Numbered `PR-YYYY-NNN` (MAX-suffix). Cost center, needed-by, justification, priority (`Low` | `Medium` | `High` | `Urgent`).
- Line money: `qty × unit_price` in integer cents. Quantities are whole units. A service line may be a lump sum, hours, or days (see [§5.5](#55-grn--ses--dual-match)).
- Submit (`POST /api/requisitions/:id/submit`) inserts the sequential approval chain (`insertApprovalChain`). Status: `draft` → `pending_approval` (schema CHECK also lists `submitted`; the API writes `pending_approval`).
- **Contract auto-assign** (`server/src/contractAssignment.js`) after lines exist on create, and on submit of a draft still in `contract_use_status = none`. Fail-soft: a matcher exception **never** blocks PR create.

`source_contract_id` is a nullable integer (not a SQLite FK). `contract_use_status`:

| Status | Meaning |
| --- | --- |
| `none` | No link yet. Submit of a draft in this state **may still auto-match**. |
| `skipped` | Requester opted out (create “None — ad-hoc”, `skip_contract_match`, or draft clear). Submit **must not rematch**. |
| `proposed` | Auto-match, explicit pick, or 1-click renewal. Approver has not decided. |
| `allowed` | Approver allowed that contract. FK kept. |
| `refused` | Approver refused. FK **kept for audit**; PR continues as ad-hoc. |

Draft override: `PATCH /api/requisitions/:id/contract` (`source_contract_id` or null → `skipped`). Draft only.

Matching (eligible contracts are computed `active` or `expiring_soon`): score supplier on any line (+100), majority vendor (+20), category overlap (+40), catalog-item overlap (+50). Assign when there is any supplier match, catalog overlap, or a **unique** category match. Ambiguous category-only → unassigned. Ties: top score, then nearest `end_date`, then highest ACV, then lowest id. Explicit `source_contract_id` is fail-closed if missing / not assignable.

**Limits**

- Submit fails closed with no mapped department head (and no `role=approver` fallback in that department) or missing FY budget.
- Carrying `source_contract_id` onto the PO at convert is **out of scope**.
- Ad-hoc create may still default `estimated_supplier_id`; convert itself does not invent a vendor.

### 5.3 Sequential approvals, thresholds, department heads, OOO

**Shipped — routing** (`server/src/approvalPolicy.js`)

Thresholds (`APPROVAL_TIER2_CENTS` = € 1.000,00 / `APPROVAL_TIER3_CENTS` = € 10.000,00):

| PR total | Chain |
| --- | --- |
| ≤ € 1.000,00 | Department head |
| > € 1.000,00 and ≤ € 10.000,00 | Dept head, then `role=procurement` |
| > € 10.000,00 | Dept head, then procurement, then `role=finance` (or `role=admin` if no finance user) |

Step 1 = `departments.approver_user_id` if set (any role), else first `role=approver` in the PR’s department, else HTTP 400 (“assign a head in Org Admin”). Later steps resolve by **role**, not hardcoded user ids.

Steps are **sequential, not parallel**:

- Step 1 is `pending`; later steps are `waiting`.
- Only the current pending step can be decided. Waiting steps do **not** appear in the inbox.
- Approve a non-final step → next `waiting` becomes `pending`.
- Reject → remaining `waiting`/`pending` set to `skipped`, PR `rejected`, **no** budget movement.

**Contract-use gate:** if status is still `proposed`, approve **must** send `allow_contract_use` true/false. Omit → HTTP 400 (no silent allow). Refuse does **not** reject the PR. Rejecting the PR does not require a contract choice. Later steps do not re-prompt. Delegates may decide contract use.

**Budget commit** happens only on the **final** approve: `budgets.committed_amount += PR total`. Remaining = `total_budget − committed − actual` (cents). If remaining < PR total → **400**, no approve. Optional `override_budget: true` force-commits and writes `BUDGET_OVERRIDE` (demo / finance exception). Intermediate steps may still be approved when remaining is insufficient; the check runs at commit time. Fiscal year in queries is **2026**.

**Department heads (org admin)**

- `GET /api/departments`, `GET /api/departments/eligible-approvers`, `PUT /api/departments/:id/approver` (or `PATCH` with `approver_user_id`).
- `approver_user_id: null` clears the mapping (legacy role lookup). Existing submitted chains are **not** rewritten. Audit: `APPROVER_ASSIGNED` / `APPROVER_CLEARED`.
- UI: **Administration → Department Approvers** (`role=admin` only). APIs are demo-open. There is **no** create-department or create-budget HTTP/UI — use `npm run bootstrap-org`.

**Approval delegation (OOO)** (`approval_delegations`)

- Direct substitute only: `delegator_user_id` → `delegate_user_id`, optional `starts_at` / `ends_at` (date-only `YYYY-MM-DD` = start/end of that UTC day), `active` soft-revoke.
- Inbox: pending steps assigned to the viewer **or** pending steps whose mapped approver has a covering delegation to the viewer.
- Decide: mapped `approver_id` **or** that covering delegate. Stored `approval_requests.approver_id` is **not** rewritten when a delegation is created.
- Fail-closed: cannot delegate to self; both users must exist; revoke only when active. No transitive chains.
- Audit: `DELEGATION_CREATED` / `DELEGATION_REVOKED`; decide-by-delegate appends “Delegated from …” on the requisition audit row.
- UI: **Delegations** for approval-capable roles + admin. A user manages themselves; Elena can manage any pair. APIs demo-open.

**Limits**

- No parallel / AND steps, no calendar sync, no recurring OOO rules.
- `approval_limit` is not an authorization gate.
- Decide API still takes body `approver_id` (phased cut).

### 5.4 Purchase orders, multi-supplier split, change orders

**Shipped — convert** (`POST /api/purchase-orders/from-requisition`)

- Approved PR only. Lines grouped by resolved supplier, in order: convert-time `supplier_mappings` → `estimated_supplier_id` → catalog `preferred_supplier_id`.
- **Fail closed (400)** if any line has no resolvable supplier. Header `supplier_id` is not a silent default.
- One issued PO per resolved vendor, all sharing `requisition_id`, each with its own cents total and `PO-YYYY-NNN`. Single-supplier PRs still create exactly one PO. PR becomes `converted_to_po` only after every PO writes, in one transaction.
- Convert UI: per-line supplier picker (`ConvertRequisitionModal`). Remapping a line can change the split.
- Printable PO layout via **browser print** (`window.print`) — vendor address, terms, delivery, signature block. Not a generated PDF file.
- `PATCH /api/purchase-orders/:id/status` for fulfillment-style status updates (`issued` | `acknowledged` | `partially_received` | `received` | `closed` | `cancelled` | `draft`).

**Shipped — change orders** (`POST /api/purchase-orders/:id/change-orders`)

- Formal numbered revision `CO-YYYY-NNN` (MAX-suffix), apply-on-confirm (`status=applied`). Existing `po_item_id` only: qty and/or unit price (integer cents) and optional delivery notes.
- Fail-closed: PO not in `issued` / `acknowledged` / `partially_received` / `received`; missing reason/`actor_name`; empty change set; new qty below received (goods), accepted (services), or invoiced; non-integer qty/cents; unknown line; net increase **above € 1.000,00** without `confirm_increase: true`.
- Recalculates line and PO totals. Linked-PR POs move `budgets.committed_amount` by the delta (increase commits more; decrease releases, floor 0). **`actual_spent` is never touched.** `purchase_orders.revision` / `change_order_count` bump. Audit `CHANGE_ORDER_APPLIED`.
- Increase confirm is a **flag**, not a second approval chain. Change-order increases do **not** re-run the remaining-budget fail-closed check used on final PR approve.

**Limits**

- Cannot add brand-new catalog lines, swap supplier, or create blanket/contract POs.
- Closed / cancelled / draft POs cannot be amended.
- Convert APIs are demo-open.

### 5.5 GRN / SES / dual match

**Goods vs service**

A requisition or PO line is **goods** or **service** (`line_type`). Category suggests the default (consulting, software, marketing, travel → service; hardware, office, facilities, and anything else → goods). An explicit `line_type` on create wins, and that stored type is what GRN, service acceptance, and match use. Goods behavior is unchanged: the line is closed by a goods receipt, and invoice match is PO vs GRN vs invoice.

A service line may also set `service_basis`. Money stays integer cents (`quantity × unit_price`):

| Basis | Quantity | Unit price |
| --- | --- | --- |
| `lump_sum` | Whole number of fixed-fee occurrences (usually 1) | Fee for one occurrence |
| `hours` | Whole hours | Rate per hour |
| `days` | Whole days | Rate per day |
| omitted | Legacy unit quantity (software seats, licenses) | Price per unit |

Services do **not** go through goods receipt. A GRN that includes a service line is **400**. The line is closed by a service entry sheet acceptance: status `accepted` records who accepted (`decided_by`), when (`decided_at`), and that the service was delivered (`quantity_accepted`). Invoice match uses that accepted quantity and does not require a GRN.

Demo: **PR-2026-005** → **PO-2026-003** → **SES-2026-001** → **INV-AAD-5501** is the completed lump-sum consulting path (no GRN). **PR-2026-011** is a draft with 16 hours and 2 days so the time-based path is visible. Seat-based software (Figma, Slack) stays a service with no basis.

**Goods receipt (GRN)** — goods lines only

- Line-by-line qty received, condition (`good` / `damaged` / `partial` / `incorrect_item`), carrier / delivery slip. Numbered `GRN-YYYY-NNN`.
- Increments `po_items.quantity_received`. Partial receipts at or below remaining ordered qty are allowed.
- Over-receipt **400** unless `allow_over_receipt: true` (audited `OVER_RECEIPT_OVERRIDE`).
- Service lines on a GRN → **400** (use SES).
- Consignment draw-down lines on a GRN → **400** (stock was already supplier-owned; issue it from Consignment).

**Consignment stock** — supplier-owned inventory at the buyer site

Consignment is not company-owned stock and it is not a goods receipt. Receiving consignment (`CSN-YYYY-NNN`) increases `consignment_balances.quantity_on_hand` for a supplier, catalog goods item, and free-text `location_label`. ProcureFlow has no location master; the label is only a site note. No PO, GRN, or invoice is created, and `po_items.quantity_received` does not change.

Issuing stock into company use (`CSI-YYYY-NNN`) decreases that on-hand balance and creates a purchase order with `order_source = consignment`. The PO line is still `line_type = goods`, but `receipt_basis = consignment` and `quantity_consumed` equals the issued quantity. `quantity_received` stays 0. AP records the supplier invoice against that PO; match uses the drawn quantity. There is no requisition and no budget commit on the issue itself — budget still moves on the PR approval path and on invoice approve when a department is linked.

Owned stock in the Consignment screen is the sum of GRN `quantity_received` (company-owned receipts). It is listed separately from consignment on-hand. A normal goods PO is unchanged: match still requires a GRN.

Demo: **CSN-2026-001** received 12 FacilityCare sanitizer stands at **HQ facilities cage** (supplier-owned). **CSI-2026-001** issued 4 into use as **PO-2026-015** (no GRN). **INV-FCJ-4402** is a perfect match against the 4 drawn units. **CSN-2026-002** leaves 20 cases of WorkSpace copy paper on hand for a live issue. Owned GRN receipts for the same sanitizer SKU (lobby restock) stay on the goods-receipt side.

Discrete consignment does **not** cover metered utilities or vendor-managed bulk. Those use milli-unit quantities (`quantity_scale = 1000`) and their own tables.

**Metered utilities** — ongoing consumption billing

Water, electricity, and gas are not one-off goods purchase orders. An arrangement (`UTA-YYYY-NNN`) is the standing supply: supplier, utility type, meter, unit of measure, and price in cents per 1.000 of that unit. Recording a meter reading or a billed quantity (`UCN-YYYY-NNN`) opens a payable with `settlement_kind = utility`. `quantity` and `quantity_consumed` are milli-units (842.500 kWh is stored as 842500). `quantity_received` stays 0. No GRN is posted. AP invoices that PO; match uses the measured quantity the same way it uses drawn consignment quantity or accepted service quantity.

`order_source` stays `standard` and `receipt_basis` stays `grn` because those checks only allow the discrete values. The measured path is `settlement_kind`, not a reuse of consignment.

Demo: **UTA-2026-001** HQ electricity, meter **E-104**. **UCN-2026-001** records 842.500 kWh as **PO-2026-016**, matched by **INV-MGU-0901**. **UTA-2026-003** gas (**UCN-2026-002** / **PO-2026-017**) is waiting for an invoice. **UTA-2026-002** water has no reading yet.

**Vendor-managed bulk** — pipeline materials in a container or silo

Gases and fluids stay supplier-owned until drawn. A vessel (`BVL-YYYY-NNN`) is a real holding location: container or silo, capacity, unit of measure, and current measured level. It is not a free-text `location_label`. A fill (`BFL-YYYY-NNN`) increases the level only. A draw (`BDR-YYYY-NNN`) decreases the level and opens a payable with `settlement_kind = bulk`, milli-unit `quantity_consumed`, and `quantity_received` 0. No GRN. Match uses the drawn quantity.

Demo: **BVL-2026-001** LN2 silo (capacity 5000.000 kg) was filled with 3200.000 kg, then **BDR-2026-001** drew 450.250 kg as **PO-2026-018**, matched by **INV-NIG-1801**. Level left is 2749.750 kg. **BVL-2026-002** argon tube bank is filled and not yet drawn.

**Service entry sheet (SES)** — service lines only

- `draft` → `submitted` → `accepted` | `rejected`. Numbered `SES-YYYY-NNN`.
- Amount = qty × PO unit price (integer cents). Qty is **not** applied to the PO until **accept** (`quantity_accepted`).
- Over-acceptance **400** unless `allow_over_acceptance: true` (audited `OVER_ACCEPTANCE_OVERRIDE`).
- Rejecting a submitted SES does not change PO quantities. Goods lines on an SES → **400**.

**Dual invoice match** (`server/src/match.js`) — integer cents and whole qty. Runs **before** `quantity_invoiced` is incremented.

| Line type | Receipt basis |
| --- | --- |
| Goods (`receipt_basis` `grn`, the default) | GRN `quantity_received` (3-way: PO vs GRN vs invoice) |
| Consignment draw-down (`receipt_basis` `consignment`) | `quantity_consumed` (PO vs draw-down vs invoice). Physical GRN is not consulted. |
| Utility or bulk (`settlement_kind` `utility` or `bulk`) | `quantity_consumed` in milli-units (PO vs measured consumption vs invoice). Physical GRN is not consulted. |
| Service | SES `quantity_accepted` (physical GRN is not required and is not consulted) |

Quantity fail if prior invoiced + this claim > receipt basis **or** > ordered. Mixed POs combine both; one failing line flags the invoice.

Price: exact cents → perfect; non-zero difference within 1% of PO unit price (`Math.round(poUnitPriceCents / 100)`) → tolerated warning; larger → price variance fail.

Overall `match_status`: `perfect_match` | `tolerated_match` | `quantity_variance` | `price_variance` | `total_variance`.

**Invoice capture** is a **manual form** against a PO (`POST /api/invoices`), or a reviewed PDF proposal ([§5.15](#515-pdf-invoice-proposals)). Unique per `(supplier_id, invoice_number)` — same number from two vendors is allowed. OCR never posts by itself.

**Limits**

- Hours and days are still whole quantities times a cent rate. There is no free-form amount that ignores quantity.
- `tolerated_match` invoices are already `matched` and are **not** hard-queued on the Exception Workbench.

### 5.6 Exception workbench + Buyer Inbox

**Shipped**

Hard queue (`GET /api/invoice-exceptions?queue=open`): invoices with status `variance_flagged` (quantity / price / total variance). These **cannot** be approved or marked paid until resolved. `tolerated_match` is not queued.

Dispositions (`POST /api/invoice-exceptions/:id/resolve`) require `reason` + `actor_name`. Integer cents. Written to `invoice_exception_dispositions` and `audit_logs`.

| Disposition | Effect |
| --- | --- |
| `accept_variance` | Status → `matched`. `match_status` stays the engine result. `accepted_total_cents` = billed. Approve may proceed at billed total. |
| `short_pay` | Status → `matched`. Requires `payable_total_cents` ≥ 0 and **strictly less than** billed. Sets `invoices.payable_total_cents`; **does not** rewrite billed `total_amount`. Approve / budget actuals / mark-paid use **payable** cents. Equal billed → use accept; greater than billed never allowed. |
| `reject_invoice` | Status → `rejected` (terminal). Approve and pay refuse. |
| `return_to_buyer` | Stays `variance_flagged`. Parks in requester **Buyer Inbox**. Still blocked. Not listed under `resolved`. |

Free-text `override_reason` on approve is a **note only** and does **not** unlock a hard exception.

**Buyer Inbox** (`GET /api/invoice-exceptions/buyer-inbox`)

- Open queue: `variance_flagged` whose **latest** disposition is `return_to_buyer`.
- Buyer respond (`POST …/buyer-respond`) requires reason + actor. Writes `buyer_response`; invoice stays `variance_flagged` and leaves the requester inbox; AP can then accept / short-pay / reject.
- UI scoping: requester_id (PR requester **or** same department). Unscoped API returns the full park queue (demo-open). Invoices whose PO has no PR do not appear in a scoped list.
- **Not** an Approve-for-Payment override.

**Limits**

- Short-pay is header payable cents only — no line-level debit memo or supplier-portal credit.
- Sidebar **Buyer Inbox** is requester-only; the Exception Workbench is visible to all personas (API demo-open).

### 5.7 Duplicate suspects

**Shipped**

- Exact reuse of `(supplier_id, invoice_number)` remains a hard uniqueness fail (HTTP 400).
- **Likely duplicate (soft hold)** on create when another **non-rejected** invoice for the same supplier has:
  - the same billed `total_amount` (integer cents) **and** `invoice_date` within **±7 UTC calendar days** (inclusive), or
  - the same `po_id` **and** the same billed amount (different invoice number allowed; dates may be far apart).
- Both rules may fire (`match_rule = both`). Payable short-pay cents are **not** used — billed only. Create **still succeeds**; `duplicate_status = suspect`. Dual match still runs.
- Approve for Payment and mark-paid **refuse** until AP disposes.

| Disposition | Effect |
| --- | --- |
| `confirm_unique` | `confirmed_unique`. Block cleared. Approve may proceed if matched and any hard exception is resolved. |
| `confirm_duplicate` | Voids the **new** invoice (`rejected` + `confirmed_duplicate`). Candidate original unchanged. |

Required reason + persona name. Audit: `DUPLICATE_SUSPECTED` / `DUPLICATE_CLEARED` / `DUPLICATE_CONFIRMED`. Sidebar for finance + admin. Badge on Invoices & Matching.

**Limits**

- Not OCR, not fuzzy invoice-number typos (`INV-100` vs `INV-l00`).
- No automatic credit memo or supplier-portal dispute.
- APIs demo-open.

### 5.8 AP Aging + Payment Runs

**AP Aging** (`GET /api/ap-aging`, alias `/api/payment-queue`)

Pay queue: invoices already `approved_for_payment`, bucketed by `due_date` vs **today as a UTC calendar date** (`YYYY-MM-DD`; time-of-day ignored):

| Bucket | Rule |
| --- | --- |
| Overdue | `due_date` before today |
| Due soon | today through +N days (query `days`, default **7**, inclusive) |
| Later | after that window |

Optional chips: **Ready to approve** (`matched`, not yet approved; open suspects excluded) and **Recently paid**. Those are not the pay queue.

Each row: invoice #, supplier, PO, dates, billed / nullable payable cents, status, match status, days past/until due, linked PR requester when present.

**Mark paid** reuses `POST /api/invoices/:id/mark-paid` (must be `approved_for_payment`; payable cents when set). Same `PAID` audit. No second payment engine.

**Payment runs** (`PAY-YYYY-NNN`) — draft proposal + one-shot execute

- Create: `approved_for_payment` invoices not on another draft/executed run, not an open/confirmed duplicate. Empty selection → 400. Snapshots billed and payable cents. Audit `PAYMENT_RUN_CREATED`.
- Execute: requires UTC `payment_date` and `payment_reference`. One transaction: re-read lines (refuse if any left approved); call the **same** `applyInvoicePaid` write (shared ACH reference + `PAID` audit); write `PAYMENT_RUN_EXECUTED`; set run `executed`.
- Budget `actual_spent` already moved at **Approve for Payment**. Execute does **not** post actuals again.
- Cancel is **draft-only**. Re-execute is refused.
- UI: create from Payment Runs picker or AP Aging checkboxes. Single mark-paid remains.

**Limits**

- No NACHA/ACH file, remittance portal, early-pay calendar, or foreign exchange. The run’s currency is the deployment currency.
- APIs demo-open. Sidebar for finance + admin.

### 5.9 Budgets

**Shipped**

- Per department, fiscal year **2026** (hardcoded in `GET /api/budgets` and dashboard joins).
- Remaining = `total_budget − committed_amount − actual_spent` (cents).
- **Committed** increases on **final PR approve** (and by PO change-order delta when the PO is linked to a PR/department).
- **Actual** increases on **Approve for Payment** by payable cents (`payable_total_cents` when set, else billed). Committed is reduced (floored at 0) by the same payable amount.
- Dashboard KPIs and **Budgets & Cost Centers** are read-only views of those rows.

**Limits**

- **No create/edit budget UI or POST `/api/budgets`.** Operator path: `npm run bootstrap-org` (default € 100.000,00 = `10000000` cents per cost center). `--force-budget` rewrites `total_budget` only; never touches committed/actual.
- Empty schema has 0 budget rows — PR submit fails closed until the org skeleton exists.

### 5.10 Document trail

**Shipped**

`GET /api/document-trail` builds a chronological buying-journey view from existing FKs and `audit_logs`. It **does not invent events**.

Lookup (first match wins): `requisition_id`, `pr_number`, `po_id`, `po_number`, or `q` (exact PR / PO / invoice number). A split child PO still returns the parent PR and **all** sibling POs. Typeahead: `GET /api/document-trail/search?q=`.

Surfaces when present: PR header, sequential approval steps, linked PO branch(es), GRN/SES (or not_started / not_applicable), invoices + match_status, AP approve/paid from invoice audit, exception / duplicate / payment-run / change-order / contract-assignment audit actions **only if those rows exist**.

**Limits**

- Not a separate table. If an audit row was never written, the trail will not show that stage as a completed event.

### 5.11 Contracts and renewals

**Shipped**

- `contracts` / `contract_items`. ACV and line prices integer cents. Numbered `CNT-YYYY-NNN`. Create via UI or `POST /api/contracts`.
- Dynamic status from UTC calendar dates (computed at read; stored `cancelled` honored): **expired** if `end_date` before today; **expiring_soon** if days until `end_date` ≤ `notice_period_days`; else **active**.
- **1-click renewal PR** (`POST /api/contracts/:id/renew-pr`): only `active` / `expiring_soon`. Copies lines onto a `PR-YYYY-NNN`, sets `source_contract_id` **proposed**, calls `insertApprovalChain`. Refuses a second open renewal PR (`draft` / `pending_approval` / `approved`) for the same `CNT-`. Audit: `CONTRACT_PROPOSED`, `SUBMITTED`, `RENEWAL_PR_CREATED`.
- Match preview: `POST /api/contracts/match-preview`.

**Limits**

- Does **not** auto-extend `end_date` or write a successor `CNT-` row.
- No CLM, e-sign, vendor portal. APIs demo-open.
- Open-renewal uniqueness also keys on justification matching `/renewal/i` plus `CNT-` / `source_contract_id` — an ordinary auto-linked catalog seat does not block renew.

### 5.12 Admin: Users, Department Approvers, auth bootstrap

**Users** (session admin only to mutate)

- List / create / edit: name, unique email, role (existing CHECK), department, title, `approval_limit` cents, optional password, `status` active/inactive.
- Set / reset password (`POST /api/users/:id/password`). Soft-deactivate (`PATCH …/status`). Cannot deactivate last admin or self. Unique email → 409. `DELETE` → 405.
- Empty tenant: `GET /api/auth/config` → `bootstrapNeeded: true`. UI **Create the first admin** or `npm run bootstrap-admin`. CLI **refuses** (exit 2) if any users already exist.

**Department Approvers**

- Map or clear step-1 head on **existing** departments. Eligible picker: `role` in approver / admin / finance / procurement. Any existing user id is accepted on the API (including requesters).

**Org skeleton** (`npm run bootstrap-org`)

- Idempotent insert by **code**: MKT Marketing, ITE IT, FAC Facilities, HRP HR, ADM Finance.
- Ensures a FY **2026** budget row per department (`total_budget` default `10000000` cents). Skips existing codes; never wipes or renames. Does **not** create users, credentials, suppliers, catalog, or PRs. Refuses `--seed`.
- `approver_user_id` stays unset — map heads in the UI after users exist.

### 5.13 Audit and compliance reports

**Shipped**

- **Audit trail** (`GET /api/compliance/audit-trail`). One list, oldest first, from four append-only sources:
  - `audit_logs` — requisition and PO approvals and rejections, PO issue and change orders, goods receipts, service entry, consignment, utility and bulk payables, invoice match / approve / pay, exception and duplicate dispositions, payment runs, contracts, delegations, department-head changes
  - `sso_login_events` — SSO success and failure (not copied)
  - `sso_assertion_uses` — assertion id consumed (not copied)
  - `compliance_audit_events` — local login success, failure, inactive, and disabled; logout; first-admin bootstrap; user create / update / status / password; SSO settings changes; JIT user create; CSV export; API key create and revoke; integration upserts and exports; webhook replay
- Filters: `from` and `to` (`YYYY-MM-DD`, inclusive), `actor` (user id or name fragment), `entity_type`, `entity_id`, `action`. Default limit 500 (max 2000).
- **Approval and segregation** (`GET /api/compliance/approval-policy`). Findings, not a new write-block:
  - `self_approval` — a non-skipped approval step is assigned to the requester, or an `APPROVED` / `STEP_APPROVED` / `REJECTED` audit row was written in the requester’s name
  - `wrong_approver` — the step’s `approver_id` is not who `buildApprovalSteps` would assign today for that amount and department. A delegate does not rewrite `approver_id`, so acting as a delegate is not itself a finding
  - `sod_requester_receiver` / `sod_approver_receiver` — goods-receipt `received_by`, or the user who accepted a service entry, is the requester or an approver of that requisition
  - `sod_ap_overlap` — the name on `APPROVED_FOR_PAYMENT`, `APPROVED_PAYMENT`, or `PAID` matches a user who is also requester, approver, or receiver. `audit_logs` stores the session name, not a user id
- **Paid without support** (`GET /api/compliance/payment-support`), invoices with status `paid`:
  - `invoice_paid_without_approval` — no `APPROVED_FOR_PAYMENT` or `APPROVED_PAYMENT` audit row
  - `invoice_paid_without_receipt` — standard purchase PO missing a goods receipt on goods lines and/or an accepted service entry on service lines. Consignment, utility, and bulk payables are not GRN documents and are not flagged
  - `po_paid_without_requisition_approval` — the PO’s requisition has no approved step. POs with no requisition are not flagged
- **Verification** (`GET /api/compliance/verification`) re-derives totals and flags mismatches:
  - PO header vs sum of `po_items.total_price`
  - requisition header vs sum of `requisition_items.total_price`
  - invoice subtotal vs sum of `invoice_items.total_price`, and total vs subtotal plus tax
  - payment-run billed, payable, and invoice count vs `payment_run_items`
  - `compliance_audit_events` SHA-256 chain (`prev_hash` / `row_hash`). An empty chain is valid. `audit_logs` is append-only but not hashed
- **CSV:** `?format=csv` on any of those paths. The file is generated first; `COMPLIANCE_EXPORT` is appended after, so it shows up on the next query. Admin and finance only. Other roles 403. No cookie 401.
- **Append-only:** triggers on `audit_logs`, `sso_login_events`, `sso_assertion_uses`, and `compliance_audit_events` abort `UPDATE` and `DELETE`. The new ledger also aborts a broken hash link.
- **UI:** sidebar **Audit & Compliance** for finance and admin. Filter, view, export.

The training seed includes Sofia approving her own small PR (`PR-2026-009`). The segregation report is supposed to show that.

**Limits**

- These reports detect. They do not add segregation blocks on submit, receive, or pay.
- `audit_logs.actor_name` is the session name stamped when the row was written. It is not a user id, so two people with the same name collapse on the AP overlap check.
- `sso_requests` are still deleted when a login attempt finishes. They are not evidence.
- Existing customer databases pick up the table and triggers on `npm run db:migrate` or the next process start. No hand-written SQL.

### 5.14 Integrations

Machine clients are not users. An admin session (`pf_session`, role `admin`) creates keys. The ERP calls a separate set of routes with `Authorization: Bearer pfk_…`. Those routes ignore the cookie. A key does not open the rest of `/api`.

**API keys**

- `POST /api/integrations/keys` returns `key` once. `api_keys.key_hash` is SHA-256 hex. The list shows `key_prefix` (first 12 characters), scopes, `expires_at`, `last_used_at`, `rate_limit_per_minute`.
- Scopes: `vendors:write`, `catalog:write`, `export:read`, `invoices:write`.
- Missing, malformed, unknown, revoked, or expired key: **401**. Wrong scope: **403**. Over the per-key minute window: **429** (default 60, set per key, 1–6000).
- Non-admin: **403**. No cookie on the admin routes: **401**.
- Create and revoke append `API_KEY_CREATED` / `API_KEY_REVOKED` with the admin as actor. The plaintext is not in the details.

**Inbound**

- `POST /api/integrations/vendors` and `POST /api/integrations/catalog`, keyed by `external_id` in `integration_entity_links`.
- Repeat vendor and catalog calls update the same supplier or catalog row. `Idempotency-Key` replays the first 2xx body; a different body with the same key is **409**.
- Catalog `unit_price` is integer cents. `preferred_supplier_external_id` must already be linked. Supplier `code` does not change after create. Omitted optional vendor and catalog fields are stored as their defaults, so send the full record each time.
- `POST /api/integrations/invoices` (`invoices:write`) creates a supplier invoice through `createSupplierInvoice`, the same function the invoice screen uses (`createVendorInvoice` is the UI adapter). `postInboundInvoice` opens the transaction itself: the insert, the 3-way match (1% of PO unit price, integer cents, run once), the duplicate soft-hold, the `invoice.created` outbox row, the API-key audit, and the row in `integration_invoice_links`. A variance sets `variance_flagged`, which is the existing exception workbench queue. There is no second match path.
- The PO must already be issued and still open: `issued`, `acknowledged`, `partially_received`, or `received`. `draft`, `closed`, and `cancelled` are **400** `po_not_issued`. Unknown `po_id` or `po_number`, and a `po_id` that does not name the same order as `po_number`, are **404** `po_not_found`. The supplier (`supplier_id` or `supplier_external_id`) must be the PO’s supplier (**400** `vendor_mismatch`). An unknown `supplier_external_id` is **400** `vendor_not_linked`. Each line’s `po_item_id` must belong to that PO (**400** `po_line_mismatch`).
- Money is a safe integer number of cents (`Number.isSafeInteger`). `unit_price` must be greater than 0. `tax_amount` may be 0 and must not be negative. `1e20` and other unsafe magnitudes are **400** `invalid_amount`. `currency` is required (**400** `currency_required`) and must equal the deployment currency (`CURRENCY`, default `EUR`). Anything else is **400** `currency_mismatch`. The error names the deployment currency and does not repeat the caller’s value. This route does not convert.
- `external_id` is create-once. The same id with the same business payload (invoice number, PO, supplier, dates, tax, notes, lines) is **200** `created: false`, `unchanged: true`, and writes nothing. A different payload is **409** `invoice_immutable` with `invoice_id` and `status`. A posted invoice is not updated, including when it is already `matched`, `variance_flagged`, `approved_for_payment`, `paid`, or `rejected`. That is deliberate: vendor and catalog upserts update in place; invoices do not.
- Omitted `due_date` becomes `invoice_date` plus 30 UTC days. Omitted line `description` is copied from the PO line. `Idempotency-Key` behaves as on vendor and catalog (replay, or **409** `idempotency_conflict`).
- The compliance row is `INTEGRATION_INVOICE_CREATED`. `actor_name` is the key name, `actor_role` is `integration`, `actor_user_id` is null, and `details` includes `api_key_id`. The pipeline still writes `3_WAY_MATCHED` as `System 3-Way Matcher` and the duplicate audit as `System Duplicate Detector`, the same actors the UI path uses. A body `user_id`, `actor_name`, `created_by`, or the same kind of field is **400** `actor_rejected`.
- Create enqueues `invoice.created` in that same transaction, whether the invoice was posted from the screen or from this route. `invoice.approved` is still inserted only in the approve transaction. A likely duplicate is `duplicate_status: suspect` and is held by the existing Duplicate Suspects queue.
- `createSupplierInvoice({ header, lines, actor, source, dryRun: true })` runs the match and the duplicate check and returns `exception.queued` without writing. Sprint 7b (PDF upload, OCR proposals, finance inbox) should call that function. This route has no preview URL.

Example request:

```http
POST /api/integrations/invoices
Authorization: Bearer pfk_…
Idempotency-Key: erp-inv-1001
Content-Type: application/json

{
  "external_id": "TSG-INV-1001",
  "invoice_number": "INV-1001",
  "po_number": "PO-2026-014",
  "supplier_id": 3,
  "currency": "EUR",
  "invoice_date": "2026-09-04",
  "tax_amount": 0,
  "lines": [
    { "po_item_id": 44, "quantity_invoiced": 2, "unit_price": 74900 }
  ]
}
```

Example response (**201**, perfect match):

```json
{
  "external_id": "TSG-INV-1001",
  "created": true,
  "unchanged": false,
  "invoice": {
    "id": 18,
    "external_id": "TSG-INV-1001",
    "invoice_number": "INV-1001",
    "po_id": 12,
    "po_number": "PO-2026-014",
    "supplier_id": 3,
    "invoice_date": "2026-09-04",
    "due_date": "2026-10-04",
    "status": "matched",
    "match_status": "perfect_match",
    "duplicate_status": "clear",
    "duplicate_suspects": [],
    "exception_queued": false,
    "currency": "EUR",
    "subtotal_cents": 149800,
    "tax_cents": 0,
    "total_cents": 149800
  }
}
```

A variance response is still **201**. `invoice.status` is `variance_flagged`, `invoice.match_status` is `quantity_variance`, `price_variance`, or `total_variance`, and `exception_queued` is true.

| Code | HTTP | When |
| --- | --- | --- |
| `api_key_required`, `api_key_invalid`, `api_key_revoked`, `api_key_expired` | 401 | Key missing, unknown, revoked, or expired. |
| `api_key_scope` | 403 | Key does not include `invoices:write`. |
| `rate_limited` | 429 | Per-key fixed window exceeded. `Retry-After` is set. |
| `actor_rejected` | 400 | Body names a user. |
| `currency_required` | 400 | `currency` is missing. |
| `currency_mismatch` | 400 | `currency` is not the deployment currency. The message does not echo the supplied value. |
| `po_required` | 400 | Neither `po_id` nor `po_number` was sent. |
| `po_not_found` | 404 | Unknown `po_id` or `po_number`, or the two name different orders. |
| `po_not_issued` | 400 | PO is draft, closed, or cancelled. |
| `invalid_lines` | 400 | `lines` is missing or empty. |
| `link_broken` | 409 | The linked supplier, catalog item, or invoice row is gone. |
| `vendor_required`, `vendor_mismatch`, `vendor_not_linked` | 400 | Supplier missing, not the PO vendor, or external id not linked. |
| `po_line_mismatch` | 400 | Line is missing, repeated, or on another PO. |
| `invalid_amount` | 400 | Not a safe integer number of cents, `unit_price` is not greater than 0, or `tax_amount` is negative. |
| `invalid_quantity`, `invalid_date`, `invalid_invoice_number`, `invalid_external_id` | 400 | Field validation. |
| `duplicate_invoice_number` | 409 | `(supplier_id, invoice_number)` already exists. The transaction rolls back. |
| `invoice_immutable` | 409 | Same `external_id`, different payload. |
| `idempotency_conflict` | 409 | Same `Idempotency-Key`, different body. |

A body `user_id`, `actor_name`, `created_by`, or the same kind of field is **400**. The key name is `actor_name`, `actor_role` is `integration`, `actor_user_id` is null. The write goes to `audit_logs` and `compliance_audit_events`.

**Outbound**

- Events, in the same transaction as the business write: `po.issued`, `receipt.posted` (goods receipt only), `invoice.created`, `invoice.approved`, `invoice_proposal.posted`, `invoice_proposal.rejected` (a posted or rejected PDF proposal; see §5.15), `payment_run.created`, `payment_run.paid`.
- Money-bearing payloads (`po.issued`, `invoice.created`, `invoice.approved`, `payment_run.created`, `payment_run.paid`) include `currency` (the deployment code, default `EUR`) next to the existing cent fields. `invoice.created` also includes `external_id` (null for a screen post), `source` (`ui` or `integration`), `match_status`, and `total_cents`. `receipt.posted` has no amount, so it has no `currency` field. Cent field names and values are unchanged.

**Receiver payloads**

The HTTP body is `{ "id": "evt_<outbox id>", "type": "<event>", "created_at": "<timestamp>", "data": { ... } }`. Dedupe on `id`. These three are the new ones:

| `type` | When `data` is written | `data` fields |
| --- | --- | --- |
| `invoice.created` | A supplier invoice is inserted, from the screen, from `POST /api/integrations/invoices`, or from posting a PDF proposal. Same transaction as the invoice row. | `invoice_id`, `invoice_number`, `supplier_id`, `supplier_external_id`, `po_id`, `status`, `match_status`, `external_id` (null for a screen or proposal post), `source` (`ui` or `integration`), `total_cents`, `currency` |
| `invoice_proposal.posted` | A proposal’s status becomes `posted`. Same transaction as that proposal’s `invoice.created`, written after it. | `proposal_id`, `status` (`posted`), `invoice_id`, `invoice_number`, `supplier_id`, `po_id`, `extracted_currency`, `source`, `match_status`, `totals_override` (null unless the reviewer typed a totals reason), `currency` |
| `invoice_proposal.rejected` | A proposal’s status becomes `rejected`. No invoice row. | `proposal_id`, `status` (`rejected`), `reason`, `invoice_number`, `supplier_id`, `po_id`, `extracted_currency`, `source`, `currency` |
- `X-ProcureFlow-Signature: t=<unix seconds>,v1=<64 hex>`. `v1` is HMAC-SHA256 of the string `${t}.${rawBody}` with `WEBHOOK_SIGNING_SECRET`. Reject timestamps more than 300 seconds off. Dedupe on `id` (`evt_<outbox id>`). Retries get a new timestamp and the same id.
- `webhook_outbox` status is `pending`, `delivered`, or `dead`. Five attempts. Backoff after failure: 30s, 120s, 600s, 3600s. Unset URL or secret does not increment attempts.
- Admin list: `GET /api/integrations/outbox`. Replay: `POST /api/integrations/outbox/:id/replay` (resets attempts, audits `WEBHOOK_REPLAYED`). Deliver now: `POST /api/integrations/outbox/dispatch`.
- `npm start` (not Vercel) sweeps every 30 seconds. On Vercel the write tries once; the admin screen and the next business event sweep what is still pending.

**Pull export** (`export:read`)

- `GET /api/integrations/exports/invoices` — default status `approved_for_payment` (`paid` allowed). JSON or `?format=csv`.
- `GET /api/integrations/exports/payment-runs` — default status `executed` (`draft` or `all`). Nested invoices in JSON; one CSV row per invoice.
- Amounts are cents. JSON `currency` is the deployment code (default `EUR`, or `USD` when `CURRENCY=USD`). The invoice CSV already had a `currency` column; the payment-run CSV appends `currency` as the last column. Each response appends `INTEGRATION_EXPORT`.

**Config**

`WEBHOOK_TARGET_URL` and `WEBHOOK_SIGNING_SECRET` are environment variables for this deployment only. They are not in `tenant_settings` or any other table. `GET /api/integrations/config` returns two booleans and `webhook_target_host`. `vercel:customer` does not set them. Set both on Production and Preview, then redeploy.

`npm run db:migrate` or the next process start creates the tables, including `integration_invoice_links`, with `CREATE TABLE IF NOT EXISTS`, and `CREATE INDEX IF NOT EXISTS integration_invoice_links_invoice` on `invoice_id`. No separate migration file. An existing `integration_entity_links` table is not rebuilt and is not dropped. Supplier and catalog external ids stay on that table. Invoice external ids are only on `integration_invoice_links`.

**Follow-ups**

UBL or Peppol conversion. ERP-specific adapters. Service-entry webhooks. Overlapping webhook secrets during rotation. Foreign exchange and an in-app currency picker. The webhook dispatcher and its retry loop are unchanged. PDF intake is [§5.15](#515-pdf-invoice-proposals). Dutch UI shipped in Sprint 6; the integrations screen labels `invoices:write` in Dutch (`Inkomende facturen schrijven`) and still sends the English scope token.

---

### 5.15 PDF invoice proposals

**Shipped**

Finance and admin open **Financiële inbox**. They upload one or more supplier-invoice PDFs. Each file becomes a proposal (`invoice_proposals.status = proposed`). OCR does not post. The screen shows the PDF beside editable fields. A field with confidence below 0.8 is highlighted. A guessed vendor or PO (suggested, ambiguous, or a vendor taken from an exact PO when the name did not match) is highlighted the same way and is not stored as the chosen id until someone picks it. An exact name or PO number is stored. The proposal runs `createSupplierInvoice(..., { dryRun: true })` once for that proposal, so the reviewer sees the 3-way match (1% tolerance) and the duplicate check before anything is written to `invoices`. The queue itself is paged (default 50, max 100, `offset` and `has_more`) and does not run that preview again for every row. The screen has Vorige and Volgende when another page exists. Approve runs the match preview before it takes the write lock. The lock claims the row and then `createSupplierInvoice` matches once.

- **Goedkeuren en boeken** posts the current fields through `createSupplierInvoice` (`source: ui`). Match, duplicate soft-hold, and `variance_flagged` on the exception workbench are the existing ones. Statuses are the existing invoice statuses.
- **Bewerk en boek** stores the edited fields, keeps the OCR snapshot, and appends `INVOICE_PROPOSAL_EDITED` with `{ field, ocr, edited }` diffs, then posts the same way.
- **Afwijzen** requires a reason. Status becomes `rejected`. The PDF stays. No invoice row is created.

The uploader cannot post their own proposal while `INVOICE_PROPOSAL_SOD` is unset or `enforce`. The user who created the API key that uploaded the PDF cannot post it either. The key cannot call the approve route. `INVOICE_PROPOSAL_SOD=off` is for a single-person tenant, where the same person has to upload and post. Any other value still enforces. Post and reject succeed only while the row is still `proposed`. The update is `AND status = 'proposed'`. If another action already closed it, the response is **409** `proposal_not_open` and no second invoice is created.

Net plus VAT must equal the gross when a gross is present, and the line totals must equal the net. Those two blockers (`gross_mismatch`, `lines_net_mismatch`) can be posted only with `override_reason` (1–500 characters). That reason is stored on `INVOICE_PROPOSAL_POSTED`. Other blockers cannot be overridden.

A signed-in upload is limited per user, default 10 attempts per minute (`INVOICE_PROPOSAL_UPLOADS_PER_MINUTE`, integer 1–600). The attempt row is written before OCR, so an in-flight call and a failed call both count. The 429 code is `rate_limited`. API-key uploads keep the existing key rate limit, which increments before OCR.

`POST /api/integrations/invoice-proposals` is a machine route: `Authorization: Bearer pfk_…`, scope `invoices:write`, per-key rate limit, `Idempotency-Key`. Body is raw `application/pdf` (not JSON). The filename is `Content-Disposition` `filename*` (RFC 5987) when present, otherwise `X-Filename`. The fingerprint is the SHA-256, filename, and byte length. The key name is the compliance actor (`actor_role = integration`, `actor_user_id` null). The key’s `created_by_user_id` is the segregation check above.

Compliance actions on `invoice_proposal`: `INVOICE_PROPOSAL_UPLOADED`, `INVOICE_PROPOSAL_EXTRACTED`, `INVOICE_PROPOSAL_EDITED`, `INVOICE_PROPOSAL_POSTED`, `INVOICE_PROPOSAL_REJECTED`. Posting enqueues `invoice_proposal.posted` in the same transaction as the invoice write, which also enqueues `invoice.created`. It does not emit `invoice.approved`. That event is still only the payment-approval webhook. Rejecting enqueues `invoice_proposal.rejected` in the same transaction. Reject payload: `proposal_id`, `status`, `reason`, `invoice_number`, `supplier_id`, `po_id`, `extracted_currency`, `source`, and `currency` (the deployment code). Posted payload: `proposal_id`, `status`, `invoice_id`, `invoice_number`, `supplier_id`, `po_id`, `extracted_currency`, `source`, `match_status`, `totals_override`, and `currency`.

**Storage**

The PDF bytes are a BLOB on `invoice_proposal_files` (`proposal_id` primary key) in this customer’s database (SQLite locally, Turso on Vercel). `invoice_proposals` stores the filename, hash, and size only. List and detail queries do not select the file table. There is no public URL and no Vercel Blob store. Download is `GET /api/invoice-proposals/:id/pdf` with a finance or admin session (`Content-Disposition: inline` plus RFC 5987 `filename*`, `Content-Security-Policy: frame-ancestors 'self'`, `Cache-Control: private, no-store`). The inbox iframe is same-origin, so it can still show the file. Another site cannot frame it. A requester is 403. No session is 401. The cap is 4 MiB (4 × 1024 × 1024). Magic bytes must be `%PDF-`; the filename is not trusted. `INVOICE_PDF_MAX_BYTES` may set a lower cap. A larger value is ignored. A 4 MiB file on a Vercel preview plus Turso was not exercised here.

Why not Vercel Blob: this product provisions one Turso database per customer and does not provision a Blob store. A copied `BLOB_READ_WRITE_TOKEN` could point at another customer. The database credential cannot. Private Blob would still need this same session check. The upload already has to fit the function request, and 4 MiB stays under the common 4.5 MB serverless body limit. On Turso the bytes travel as base64 inside the HTTP pipeline (about 5.4 MiB of JSON for a 4 MiB file), which is the size this cap is written for. Local SQLite uses the same cap so a file that uploads in development uploads in production. Backups of the customer database include the PDFs.

**OCR**

`INVOICE_OCR_PROVIDER=gateway` and `INVOICE_OCR_MODEL` (an AI Gateway model id that accepts a PDF) enable extraction. The call is AI SDK `generateText` with `Output.object` and the PDF inline. Each attempt uses `AbortSignal.timeout`. `INVOICE_OCR_TIMEOUT_MS` defaults to 20000. An integer from 1000 up is accepted and clamped to 24500, so two attempts plus a 1 second backoff and about 10 seconds of other work fit in 60 seconds. A timeout or network failure waits that 1 second and is retried once. `vercel.json` sets `maxDuration` 60 only on `api/invoice-proposal-upload.js`. A rewrite sends `Content-Type: application/pdf` on the two upload URLs to that file. The rest of `/api` stays on `api/index.js` without that limit. Vercel cannot set `maxDuration` per route inside one function, and rewrites cannot select by HTTP method, so the PDF content type is the smallest split that keeps the existing URLs. Auth is `AI_GATEWAY_API_KEY`, or Vercel OIDC on Vercel. No provider SDK is imported. If either variable is missing, or the provider is not `gateway`, upload is disabled. The UI shows that. The API returns **503** `ocr_not_configured` and writes nothing. Tests inject a fake provider and do not call the network. Model amounts that are not a non-negative safe integer number of cents are stored as empty with confidence 0.

Amounts in the proposal are integer cents. The screen formats them with the Sprint 5 formatter and accepts Dutch comma amounts (`1.295,50`) on the editable money fields.

**Known limits**

No email inbox. No UBL/Peppol. No auto-post. The webhook drain is unchanged. A proposal with an unmapped vendor, PO, or line cannot be posted until a person fills those fields. A guessed match is treated as unmapped until that choice is explicit. API-key uploads have no session uploader; segregation uses the user who created the key.

---

## 6. Money model (integer cents)

SQLite columns (`unit_price`, `total_amount`, budget fields, invoice totals, match `price_variance`, user `approval_limit`, contract `annual_value_cents`, payment-run snapshots) store **integer cents** of the deployment currency. EUR and USD both have two decimal places, so switching `CURRENCY` does not migrate or rescale stored values. The API returns cents. Display and audit text use `formatMoney` (`shared/currency.js`, locale `nl-NL`) from `client/src/money.js` and `server/src/money.js`. `formatCents` stays a symbol-free dot-decimal string (`749.00`) for non-display use. Amount fields on the client accept nl-NL major units (`1.295,50`, comma decimal, dot thousands) via `parseMajorAmount` / `toCents`. A pasted `749.00` still parses. The API and the database still store integer cents. `shared/currency.js` is unchanged.

Do not mix a float major-unit amount with cents in the same field. Whole-unit line totals are `qty * unit_price_cents`. Discrete quantities (goods, services, consignment) are whole units. Utility and bulk quantities are integer milli-units (scale 1000); the line amount is `round(milli × unit_price_cents / 1000)`.

| Constant | Cents | Display (`nl-NL`, EUR) |
| --- | --- | --- |
| `APPROVAL_TIER2_CENTS` | 100000 | € 1.000,00 |
| `APPROVAL_TIER3_CENTS` | 1000000 | € 10.000,00 |
| `CHANGE_ORDER_INCREASE_CONFIRM_CENTS` | same as tier 2 | € 1.000,00 net increase confirm flag |

`bootstrap-org` default `total_budget` = `10000000` cents (€ 100.000,00).

---

## 7. Document number schemes

Allocated with **MAX of the numeric suffix** for the current calendar year (`server/src/docNumbers.js`), inside the create transaction. Not `COUNT(*)+1` (that collides after deletes or seed gaps). Columns are UNIQUE.

| Kind | Pattern | Table / column |
| --- | --- | --- |
| Requisition | `PR-YYYY-NNN` | `purchase_requisitions.pr_number` |
| Purchase order | `PO-YYYY-NNN` | `purchase_orders.po_number` |
| Goods receipt | `GRN-YYYY-NNN` | `goods_receipts.grn_number` |
| Service entry | `SES-YYYY-NNN` | `service_entry_sheets.ses_number` |
| Consignment receipt | `CSN-YYYY-NNN` | `consignment_receipts.receipt_number` |
| Consignment issue | `CSI-YYYY-NNN` | `consignment_issues.issue_number` |
| Change order | `CO-YYYY-NNN` | `po_change_orders.co_number` |
| Contract | `CNT-YYYY-NNN` | `contracts.contract_number` |
| Payment run | `PAY-YYYY-NNN` | `payment_runs.run_number` |
| Utility arrangement | `UTA-YYYY-NNN` | `utility_arrangements.arrangement_number` |
| Utility consumption | `UCN-YYYY-NNN` | `utility_consumptions.consumption_number` |
| Bulk vessel | `BVL-YYYY-NNN` | `bulk_containers.container_number` |
| Bulk fill | `BFL-YYYY-NNN` | `bulk_fills.fill_number` |
| Bulk draw | `BDR-YYYY-NNN` | `bulk_draws.draw_number` |

Invoice numbers are **vendor-assigned** strings, unique per supplier: `UNIQUE(supplier_id, invoice_number)`.

---

## 8. Runtime, entrypoints, env (short)

| File | Role |
| --- | --- |
| [`api/index.js`](../api/index.js) | Vercel Node Function — default-exports Express |
| [`server/src/app.js`](../server/src/app.js) | Express factory (API + lazy DB init). Does not `listen`. |
| [`server/src/index.js`](../server/src/index.js) | Local listen on `PORT` (default 5000) |
| [`vercel.json`](../vercel.json) | `buildCommand`, `includeFiles` for `schema.sql`, rewrite `/api/*` → `/api` |

On Vercel, Turso is **required**. Missing pair (or Turso 401) → HTML/JSON **503** (`TursoConfigError`), not a local SQLite file. Partial Turso credentials (URL xor token) are fail-closed on migrate/status/bootstrap-org.

Full env table: **[DEPLOYMENT.md](DEPLOYMENT.md)**. Keys (no values): [`.env.example`](../.env.example).

| Variable | Customer deploy |
| --- | --- |
| `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | Required on Vercel (classic libSQL URL + **database** token) |
| `SESSION_SECRET` | Required (signs `pf_session`) |
| `IDENTITY_PROVIDER` | `local` (default), `oidc`, or `saml`. See [§3 SSO](#sso-oidc-or-saml) |
| `APP_BASE_URL` | Required when SSO is on (this customer’s origin) |
| `DEMO_PERSONA_SWITCHER` | Leave unset |
| `PROCUREMENT_DB_PATH` | Local SQLite only — **do not** set on Vercel |
| `BCRYPT_ROUNDS` | Optional (default 10) |
| `BASE_URL` | Smoke only |
| `WEBHOOK_TARGET_URL` | Optional. HTTPS receiver for this customer. Not stored in the database. |
| `WEBHOOK_SIGNING_SECRET` | Optional. HMAC key. Never returned. Not written by `vercel:customer`. |
| `CURRENCY` | Optional. `EUR` (default) or `USD`. Anything else refuses to boot. Display locale `nl-NL`. Not written by the CLIs. |

There is **no platform cron**. `npm start` retries pending webhooks every 30 seconds. Vercel relies on the attempt at write time plus **Deliver pending** / replay. See [§5.14](#514-integrations).

---

## 9. New customer deploy

The operator procedure, including SSO env, the append-only audit trail, and offboard, is **[DEPLOY_MANUAL.md](DEPLOY_MANUAL.md)**. This section is the short form.

Preferred one-command (Turso + Vercel CLIs logged in; `vercel switch` first if you have more than one team):

```
npm run onboard:customer -- --slug <customer>
npm run onboard:customer -- --slug <customer> --apply --email … --password … --smoke
  → first login → Administration → Users → Department Approvers
```

`--apply` chains Turso → ensure Vercel project + link → env + redeploy, waits until that Production deployment is Ready, then provision (`--with-org` default **on**; `--no-org` to skip). `--smoke` on that same command is the preferred close. Secrets stay in-process. `vercel project add procureflow-<slug>` is idempotent (the CLI exits 0 if the project already exists). `vercel link --yes --project procureflow-<slug>` runs when this directory is not linked. Already linked to that name: both are skipped. Linked to a different project: stop (does not retarget).

`vercel project add` does not connect GitHub. Production is deployed from this laptop. Git-push deploys still need a one-time Vercel↔GitHub connection in the dashboard.

Stepped (same sequence, secrets copied by hand):

```
npm run turso:customer -- --apply
  → npm run vercel:customer -- --apply
  → npm run provision:customer -- --with-org
  → npm run smoke
  → first login → Administration → Users → Department Approvers
```

**Do not** `npm run seed` on a live tenant.

### 9.1 Sequence (operator)

1. **Turso DB + token + `SESSION_SECRET`:** prefer `npm run onboard:customer -- --slug <customer>` (dry-run) then `--apply`. Or the Turso-only CLI: `npm run turso:customer -- --slug <customer>` (dry-run) then `--apply`. Classic libSQL only (not `--tursodb`). Mints a **database token** (`turso db tokens create`, not an org JWT). Reuses an existing DB. Generates `SESSION_SECRET` unless already set in the shell (does not silently rotate). The orchestrator passes exports to the next step; the Turso-only CLI prints them for you to copy.
2. **New Vercel project** `procureflow-<slug>` (root = repo root; build from `vercel.json`). `vercel:customer --apply` runs `vercel project add` then `vercel link --yes --project` unless this directory is already linked to that name. It does not import GitHub. A directory linked to a different project fails closed.
3. Export the three secrets in the shell (the Vercel CLI **refuses to invent secrets**), then:

   ```bash
   npm run vercel:customer -- --slug <customer>            # dry-run
   npm run vercel:customer -- --slug <customer> --apply    # Production + Preview + redeploy, then wait until Ready
   ```

   Never sets `DEMO_PERSONA_SWITCHER`. Preview URLs stay broken if vars are Production-only. Env changes do not retrofit an already-built Preview.
4. **Same `TURSO_*` on the laptop:**

   ```bash
   npm run db:migrate -- --turso
   npm run db:status
   npm run bootstrap-org
   npm run bootstrap-admin -- --email admin@customer.com --password 'choose-a-long-password'
   ```

   One-shot wrapper (still **never seeds**):

   ```bash
   npm run provision:customer -- --with-org \
     --email admin@customer.com --password 'choose-a-long-password'
   ```

5. Smoke: `BASE_URL=https://<customer-project>.vercel.app npm run smoke` (optional `--email` / `--password` for a login check).
6. Sign in → **Administration → Users** (requesters, approvers, procurement, finance, extra admins) → **Department Approvers** (step-1 heads) → **Suppliers & Catalog** as needed.

**Customer B** = a **second** Turso DB + **second** Vercel project + new `SESSION_SECRET`. Never paste customer A’s URL.

Click-by-click (Acme worked example, troubleshooting, deprovision): **[CUSTOMER_ONBOARDING.md](CUSTOMER_ONBOARDING.md)**. Deprovision CLI: `npm run offboard:customer -- --slug <customer>` then `--apply --confirm-slug <customer>`. Env tables, Auth API, rollback: **[DEPLOYMENT.md](DEPLOYMENT.md)**. Checklist: [`scripts/provision-customer.md`](../scripts/provision-customer.md).

### 9.2 Three data tiers (do not confuse)

| Tier | Command | Result |
| --- | --- | --- |
| Empty schema | `npm run db:migrate` | Tables exist. `departments` / `budgets` empty. PR submit fails closed. 0 users. |
| Org skeleton | `npm run bootstrap-org` | Five cost centers + FY 2026 budgets. **Idempotent.** No users, catalog, or PRs. |
| First admin | `npm run bootstrap-admin` | One admin + password. Catalog / PRs / invoices still blank. |
| Demo wipe | `npm run seed` | **Destructive:** drops application tables, loads Alice/Bob/… and the demo password |

`provision:customer -- --with-org` = migrate + org skeleton + optional first admin. It **never** seeds.

---

## 10. After first login (empty tenant)

Until you do these, the product looks “empty” because it **is** empty:

1. Create people in **Users** (unique email, role, department, password).
2. Map a step-1 head per cost center in **Department Approvers**. Unmapped depts with no `role=approver` fallback cannot accept PR submit.
3. Create suppliers and catalog items in the UI, or issue an API key under **Administration → Integrations** and let the ERP upsert them (`external_id`). There is no file import and no inbound invoice feed.
4. Hand each person their **own** password. Do not share the seed demo password on a live tenant.

Skip org mapping only if you are proving login + admin CRUD and do not need PR submit yet.

---

## 11. Out of scope

Hand this list with the URL so nobody assumes Coupa-parity.

| Topic | Honest status |
| --- | --- |
| SCIM | Not implemented. OIDC and SAML login are optional per customer and mint `pf_session`. Roles are not taken from the IdP. |
| `org_id` multi-tenancy | Isolation is the **connection**, not a tenant column. |
| Finer role matrix on every screen | Session is required everywhere. Admin and AP roles are enforced. Catalog edits are not limited to procurement. |
| Create-department / create-budget UI | Operator CLI `bootstrap-org` only. |
| Email invoice ingest / unattended OCR posting | PDF proposals are reviewed in the finance inbox (§5.15). There is no mailbox. The manual invoice form remains. |
| NACHA / bank file / remittance portal | Payment run stores a shared ACH **reference string** and marks paid. No file. |
| Foreign exchange / tax engine / 1099 | One currency per deployment (`CURRENCY`, default EUR). Amounts stay integer cents. No FX and no in-app picker. |
| Parallel / AND approvals | Sequential pending/waiting only. |
| Transitive OOO / calendar sync | Direct delegation window only. |
| Change-order approval chain / new PO lines / supplier swap | Apply-on-confirm; existing lines; € 1.000,00 confirm flag. |
| Line-level short-pay / debit memo / supplier portal | Header `payable_total_cents` only. |
| Fuzzy duplicate / OCR typos | Exact billed cents + ±7 UTC days or same PO + amount. |
| Contract CLM / e-sign / auto-extend / PO `source_contract_id` | Renewal creates a standard PR; convert does not copy the FK. |
| Cron / scheduled renewals / aging jobs | No platform cron. Webhook retry is the 30-second loop on `npm start`, plus admin Deliver pending. Renewals and aging stay request-driven. |
| Inbound supplier invoices / ERP adapters | Not built. Sprint 4 upserts vendors and catalog items and exports approved invoices and payment runs. |
| Fiscal years other than 2026 | Hardcoded in budget queries. |
| `approval_limit` as a routing gate | Stored and displayed; policy uses PR total + roles. |
| Header persona switcher on customers | Off unless `DEMO_PERSONA_SWITCHER=1`. |
| Warehouse WMS | Discrete consignment is still a free-text `location_label`. Bulk vessels store capacity, unit, and level only. No bins, picks, or cycle counts. |

More control-model detail: [ARCHITECTURE.md — Known demo limits](ARCHITECTURE.md#known-demo-limits-out-of-scope).

---

## 12. Troubleshooting pointers

Full tables: [CUSTOMER_ONBOARDING.md § Troubleshooting](CUSTOMER_ONBOARDING.md#troubleshooting).

### Login fails: users exist, nobody has a password

Typical of a **legacy seed from before auth** (`users` rows, empty `user_credentials`). Login 401. `bootstrapNeeded: false` (UI will **not** show Create the first admin). `bootstrap-admin` exits **2**.

| Situation | Fix |
| --- | --- |
| Disposable demo DB | `npm run seed` — **destructive** wipe + personas + demo password |
| At least one admin can log in | Administration → Users → **Set password** |
| Nobody can log in and you must keep going | Recreate DB → `db:migrate` → `bootstrap-org` → `bootstrap-admin`. Bootstrap will not run while any users exist. |

### HTTP 503 / `TursoConfigError`

`TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are not both visible to **that** deployment. Re-run `npm run vercel:customer -- --slug <customer> --apply` (Production **and** Preview) and Redeploy. Partial credentials are fail-closed (no silent local file).

### HTTP 401 from Turso / token rejected

Wrong token kind: org/platform JWT (`turso auth token`) or a token for a **different** database. Mint with `turso db tokens create <db>` and `--apply` again.

### Preview URL broken; Production works

Preview missing env. `--apply` sets Preview as well as Production. Rebuild **that** Preview. Env edits do not retrofit an old Preview deployment.

### `SESSION_SECRET` missing / sessions die after Redeploy

Customer / Vercel **must** set it. Changing it invalidates every `pf_session` cookie (expected on rotate). Do not share one secret across customers.

### Smoke fails against Vercel; laptop migrate worked

`BASE_URL` has no trailing path. Redeploy after env changes. `npm run db:status` with the same `TURSO_*` should show `turso-http` and the expected user count.

### First deploy built before env existed

Redeploy. Do not debug the 503 as an application bug until a deployment **built with the vars** is Ready.

### PR submit fails closed on a fresh customer

No cost centers / FY 2026 budgets (`bootstrap-org`) or no department head mapped (and no `role=approver` in that department). Catalog/suppliers may also be empty.

---

## 13. Demo seed vs empty tenant

| | Empty / customer | Seed / training |
| --- | --- | --- |
| Command | `db:migrate` → `bootstrap-org` → `bootstrap-admin` | `npm run seed` or `db:migrate -- --seed` |
| Users | First admin only | Eight fictional personas |
| Password | The one you chose at bootstrap | **`ProcureFlow!demo`** (documented seed password **only** — never a production secret) |
| Catalog / PRs / invoices | Empty until created in-app | Walkthrough documents (happy path, short-pay, buyer inbox, duplicates, aging, payment run, contracts, …) |
| Persona switcher | Off | Optional `DEMO_PERSONA_SWITCHER=1` |
| Destructive? | Org skeleton is **idempotent** and does not wipe | **Yes — drops application tables** on whatever DB this shell’s `TURSO_*` / `PROCUREMENT_DB_PATH` points at |

```bash
# DEMO ONLY — wipes the database this env points at
# npm run seed
```

Laptop demo (not a customer): unset `TURSO_*`, `npm run seed`, `npm run dev` (API `:5000` + Vite `:3000`) or `npm start` (`:5000`). Walkthroughs live in the [README](../README.md).

---

## 14. Local development (not onboarding)

Prerequisites: Node 18+, npm 9+. From repo root: `npm install` plus `npm install --prefix server` and `npm install --prefix client`.

```bash
npm run dev          # API :5000 + Vite :3000 (proxy /api)
npm start            # Express serves client/dist when present — :5000
npm test             # node --test, SQLite in-memory
npm run smoke        # health / auth/config / users / session gate
npm run db:status
```

Tests cover the control model listed in [ARCHITECTURE.md](ARCHITECTURE.md). This manual does not duplicate that list.

---

## 15. Related files

| Path | Why |
| --- | --- |
| [DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) | Operator procedure: deploy, SSO, audit, update, offboard |
| [CUSTOMER_ONBOARDING.md](CUSTOMER_ONBOARDING.md) | Click-by-click customer install |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Isolation, env, Auth API, Vercel, rollback |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Match math, contract scoring, sequential approvals |
| [`scripts/provision-customer.md`](../scripts/provision-customer.md) | Copy-paste checklist |
| [`.env.example`](../.env.example) | Env key names |
| [`server/src/schema.sql`](../server/src/schema.sql) | Tables and CHECKs |
| [`server/src/approvalPolicy.js`](../server/src/approvalPolicy.js) | Approval chains |
| [`server/src/bootstrapOrg.js`](../server/src/bootstrapOrg.js) | Cost-center skeleton |
