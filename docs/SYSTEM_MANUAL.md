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
- **Money:** integer **cents** everywhere in SQLite and the API. The client formats dollars at display/input edges.

**Isolation:** **one database per customer** (one Turso DB or one SQLite file) **and** one Vercel project per customer. Schema and application code are shared; **data is not**. There is **no** shared-row `org_id` (or equivalent) multi-tenancy. Pointing two deploys at the same Turso URL **merges** those customers.

**Path:** this is a **demo-to-customer** product. The same git repo is deployed per tenant. Empty-tenant provision is the customer path; `npm run seed` is the laptop/training wipe.

**Lifecycle (what the software actually does)**

```
Draft PR → Submit → Sequential approvals → budget commit on final approve
        → Convert to PO(s) (one issued PO per resolved supplier)
        → Optional PO change order / revision
        → Goods: GRN          ──┐
        → Services: SES accept ─┴→ Vendor invoice (manual) → dual match
        → Exception workbench (hard failures; optional return_to_buyer → Buyer Inbox)
        → Duplicate suspects (soft hold) → AP approve → AP Aging → Payment run / Mark paid
        (parallel) Contracts hub → 1-click renewal PR → sequential approvals
        New PR create/submit may auto-propose a matching contract; approver allows or refuses
```

---

## 2. What ProcureFlow is not

Do not promise these. They are **not** in the code:

- Enterprise Coupa / SAP Ariba / Oracle Fusion replacement
- SSO / SAML / OIDC / SCIM
- Shared-row multi-tenancy (`org_id` on every table)
- OCR / PDF / email invoice capture
- Bank NACHA / ACH file export, remittance portal, early-pay discount calendar, multi-currency
- CLM, e-sign, vendor portal, successor `CNT-` rows, auto-extend of `end_date`
- Create-department or create-budget UI
- Full segregation of duties on every API route
- Cron / scheduled jobs (the app is **request-driven**)
- Native mobile apps
- Production goods / MRP / inventory / warehouse WMS

Honest limits are listed again in [§11 Out of scope](#11-out-of-scope).

---

## 3. Personas and authentication

### Roles (`users.role` CHECK)

| Role | Typical job | UI notes |
| --- | --- | --- |
| `requester` | Creates PRs, responds in **Buyer Inbox** | Buyer Inbox sidebar only for this role |
| `approver` | Department head / step-1 | **Delegations** sidebar |
| `procurement` | Strategic sourcing (Carol in the demo) | Convert PR → PO, change orders, Vendors & Catalog, contracts; **Delegations** |
| `finance` | AP / controller (David in the demo) | **Duplicate Suspects**, **AP Aging**, **Payment Runs**; **Delegations** |
| `admin` | Org admin / CFO (Elena in the demo) | **Administration → Users** and **Department Approvers**; same AP queues as finance |

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
| `GET /api/auth/config` | Public: `{ auth, demoPersonaSwitcher, bootstrapNeeded }` |
| `POST /api/auth/login` | `{ email, password }` → cookie |
| `POST /api/auth/logout` | Clears cookie |
| `GET /api/auth/me` | Session user or 401 |
| `POST /api/auth/bootstrap` | First admin on an **empty** `users` table only |

**Enforced on session (`req.user`):** mutating `/api/users` (create / edit / status / password) requires a logged-in `role=admin`. The header switcher cannot spoof `req.user` for those paths. `DELETE /api/users/:id` is **405**.

**Phased cut — not a security boundary:** most P2P mutating routes still trust body fields (`approver_id`, `requester_id`, `received_by`, `actor_name`, …). Anyone who can reach those APIs can still send another person’s id. Department-head `PUT`, catalog/supplier PATCH, exceptions, aging, payment runs, contracts, etc. stay **demo-open** (no JWT). Sidebar hiding is **UI only**.

### Optional demo persona switcher

Set `DEMO_PERSONA_SWITCHER=1` (or `true` / `yes`) to show the header dropdown that swaps `currentUser` without logging in. Default is **off**. `npm run vercel:customer` **never** sets this flag. Live customers use the login page.

`GET /api/users` stays demo-open so that optional switcher can load people.

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
| Goods Receipt (GRN) | Everyone | Goods lines only |
| Service Entry (SES) | Everyone | Service lines: draft → submitted → accepted/rejected |
| Invoices & Matching | Everyone | Manual invoice against a PO; match matrix; approve / mark paid |
| Exception Workbench | Everyone | Hard dual-match failures |
| Duplicate Suspects | `finance` + `admin` | Likely-duplicate soft holds |
| Buyer Inbox | `requester` only | Invoices AP parked with `return_to_buyer` |
| AP Aging | `finance` + `admin` | Approved payables by due date |
| Payment Runs | `finance` + `admin` | Draft `PAY-YYYY-NNN` → execute |
| Document trail | Everyone | PR → PO(s) → GRN/SES → invoice chain from FKs + audit |
| Budgets & Cost Centers | Everyone | Read-only FY 2026 allocated / committed / actual / remaining |
| Contracts & Renewals | Everyone | Agreements + 1-click renewal PR |
| Suppliers & Catalog | Everyone | Create / edit / soft-deactivate |
| **Administration → Department Approvers** | `admin` only | Map step-1 head; does **not** create departments |
| **Administration → Users** | `admin` only | Create / edit / password / soft-deactivate |

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
- Line money: `qty × unit_price` in integer cents. Quantities are whole units.
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

Thresholds (`APPROVAL_TIER2_CENTS` = $1,000 / `APPROVAL_TIER3_CENTS` = $10,000):

| PR total | Chain |
| --- | --- |
| ≤ $1,000 | Department head |
| > $1,000 and ≤ $10,000 | Dept head, then `role=procurement` |
| > $10,000 | Dept head, then procurement, then `role=finance` (or `role=admin` if no finance user) |

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
- Fail-closed: PO not in `issued` / `acknowledged` / `partially_received` / `received`; missing reason/`actor_name`; empty change set; new qty below received (goods), accepted (services), or invoiced; non-integer qty/cents; unknown line; net increase **above $1,000** without `confirm_increase: true`.
- Recalculates line and PO totals. Linked-PR POs move `budgets.committed_amount` by the delta (increase commits more; decrease releases, floor 0). **`actual_spent` is never touched.** `purchase_orders.revision` / `change_order_count` bump. Audit `CHANGE_ORDER_APPLIED`.
- Increase confirm is a **flag**, not a second approval chain. Change-order increases do **not** re-run the remaining-budget fail-closed check used on final PR approve.

**Limits**

- Cannot add brand-new catalog lines, swap supplier, or create blanket/contract POs.
- Closed / cancelled / draft POs cannot be amended.
- Convert APIs are demo-open.

### 5.5 GRN / SES / dual match

**Goods receipt (GRN)** — goods lines only

- Line-by-line qty received, condition (`good` / `damaged` / `partial` / `incorrect_item`), carrier / delivery slip. Numbered `GRN-YYYY-NNN`.
- Increments `po_items.quantity_received`. Partial receipts at or below remaining ordered qty are allowed.
- Over-receipt **400** unless `allow_over_receipt: true` (audited `OVER_RECEIPT_OVERRIDE`).
- Service lines on a GRN → **400** (use SES).

**Service entry sheet (SES)** — service lines only

- `draft` → `submitted` → `accepted` | `rejected`. Numbered `SES-YYYY-NNN`.
- Amount = qty × PO unit price (integer cents). Qty is **not** applied to the PO until **accept** (`quantity_accepted`).
- Over-acceptance **400** unless `allow_over_acceptance: true` (audited `OVER_ACCEPTANCE_OVERRIDE`).
- Rejecting a submitted SES does not change PO quantities. Goods lines on an SES → **400**.

**Dual invoice match** (`server/src/match.js`) — integer cents and whole qty. Runs **before** `quantity_invoiced` is incremented.

| Line type | Receipt basis |
| --- | --- |
| Goods | GRN `quantity_received` (3-way: PO vs GRN vs invoice) |
| Service | SES `quantity_accepted` (physical GRN is not required and is not consulted) |

Quantity fail if prior invoiced + this claim > receipt basis **or** > ordered. Mixed POs combine both; one failing line flags the invoice.

Price: exact cents → perfect; non-zero difference within 1% of PO unit price (`Math.round(poUnitPriceCents / 100)`) → tolerated warning; larger → price variance fail.

Overall `match_status`: `perfect_match` | `tolerated_match` | `quantity_variance` | `price_variance` | `total_variance`.

**Invoice capture** is a **manual form** against a PO (`POST /api/invoices`). Unique per `(supplier_id, invoice_number)` — same number from two vendors is allowed. No OCR.

**Limits**

- SES is quantity-based; not free-form T&M amount match.
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

- No NACHA/ACH file, remittance portal, early-pay calendar, or multi-currency.
- APIs demo-open. Sidebar for finance + admin.

### 5.9 Budgets

**Shipped**

- Per department, fiscal year **2026** (hardcoded in `GET /api/budgets` and dashboard joins).
- Remaining = `total_budget − committed_amount − actual_spent` (cents).
- **Committed** increases on **final PR approve** (and by PO change-order delta when the PO is linked to a PR/department).
- **Actual** increases on **Approve for Payment** by payable cents (`payable_total_cents` when set, else billed). Committed is reduced (floored at 0) by the same payable amount.
- Dashboard KPIs and **Budgets & Cost Centers** are read-only views of those rows.

**Limits**

- **No create/edit budget UI or POST `/api/budgets`.** Operator path: `npm run bootstrap-org` (default $100,000.00 = `10000000` cents per cost center). `--force-budget` rewrites `total_budget` only; never touches committed/actual.
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

---

## 6. Money model (integer cents)

SQLite columns (`unit_price`, `total_amount`, budget fields, invoice totals, match `price_variance`, user `approval_limit`, contract `annual_value_cents`, payment-run snapshots) store **integer USD cents**. The API returns cents. The client converts at edges (`client/src/money.js`, `server/src/money.js`).

Do not mix float dollars with cents in the same field. Line totals are `qty * unit_price_cents` with integer arithmetic. Quantities are whole units.

| Constant | Cents | Dollars |
| --- | --- | --- |
| `APPROVAL_TIER2_CENTS` | 100000 | $1,000.00 |
| `APPROVAL_TIER3_CENTS` | 1000000 | $10,000.00 |
| `CHANGE_ORDER_INCREASE_CONFIRM_CENTS` | same as tier 2 | $1,000.00 net increase confirm flag |

`bootstrap-org` default `total_budget` = `10000000` cents ($100,000.00).

---

## 7. Document number schemes

Allocated with **MAX of the numeric suffix** for the current calendar year (`server/src/docNumbers.js`), inside the create transaction. Not `COUNT(*)+1` (that collides after deletes or seed gaps). Columns are UNIQUE.

| Kind | Pattern | Table / column |
| --- | --- | --- |
| Requisition | `PR-YYYY-NNN` | `purchase_requisitions.pr_number` |
| Purchase order | `PO-YYYY-NNN` | `purchase_orders.po_number` |
| Goods receipt | `GRN-YYYY-NNN` | `goods_receipts.grn_number` |
| Service entry | `SES-YYYY-NNN` | `service_entry_sheets.ses_number` |
| Change order | `CO-YYYY-NNN` | `po_change_orders.co_number` |
| Contract | `CNT-YYYY-NNN` | `contracts.contract_number` |
| Payment run | `PAY-YYYY-NNN` | `payment_runs.run_number` |

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
| `DEMO_PERSONA_SWITCHER` | Leave unset |
| `PROCUREMENT_DB_PATH` | Local SQLite only — **do not** set on Vercel |
| `BCRYPT_ROUNDS` | Optional (default 10) |
| `BASE_URL` | Smoke only |

There is **no cron**.

---

## 9. New customer deploy

Proven sequence (after PR #34):

```
npm run turso:customer -- --apply
  → (human) new Vercel project + vercel link
  → npm run vercel:customer -- --apply
  → npm run provision:customer -- --with-org
  → npm run smoke
  → first login → Administration → Users → Department Approvers
```

**Do not** `npm run seed` on a live tenant.

### 9.1 Sequence (operator)

1. **Turso DB + token + `SESSION_SECRET`:** `npm run turso:customer -- --slug <customer>` (dry-run) then `--apply`. Classic libSQL only (not `--tursodb`). Mints a **database token** (`turso db tokens create`, not an org JWT). Reuses an existing DB. Generates `SESSION_SECRET` unless already set in the shell (does not silently rotate). Copy the printed exports.
2. **New Vercel project** from this repo (root = repo root; build from `vercel.json`). Suggested name `procureflow-<slug>`. `vercel link --yes --project procureflow-<slug>`. The env script **does not** create Vercel projects.
3. Export the three secrets in the shell (the Vercel CLI **refuses to invent secrets**), then:

   ```bash
   npm run vercel:customer -- --slug <customer>            # dry-run
   npm run vercel:customer -- --slug <customer> --apply    # Production + Preview + redeploy
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

Click-by-click (Acme worked example, troubleshooting, deprovision): **[CUSTOMER_ONBOARDING.md](CUSTOMER_ONBOARDING.md)**. Env tables, Auth API, rollback: **[DEPLOYMENT.md](DEPLOYMENT.md)**. Checklist: [`scripts/provision-customer.md`](../scripts/provision-customer.md).

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
3. Create suppliers and catalog items (and optionally contracts). There is no master-data import.
4. Hand each person their **own** password. Do not share the seed demo password on a live tenant.

Skip org mapping only if you are proving login + admin CRUD and do not need PR submit yet.

---

## 11. Out of scope

Hand this list with the URL so nobody assumes Coupa-parity.

| Topic | Honest status |
| --- | --- |
| SSO / SAML / OIDC / SCIM | Not implemented. Email + bcrypt local to this DB. |
| `org_id` multi-tenancy | Isolation is the **connection**, not a tenant column. |
| Full SoD on every route | Only auth + admin user CRUD use `req.user`. Most P2P routes accept body persona ids. |
| Create-department / create-budget UI | Operator CLI `bootstrap-org` only. |
| OCR / PDF / email invoice ingest | Manual invoice form. |
| NACHA / bank file / remittance portal | Payment run stores a shared ACH **reference string** and marks paid. No file. |
| Multi-currency / tax engine / 1099 | USD integer cents only. |
| Parallel / AND approvals | Sequential pending/waiting only. |
| Transitive OOO / calendar sync | Direct delegation window only. |
| Change-order approval chain / new PO lines / supplier swap | Apply-on-confirm; existing lines; $1,000 confirm flag. |
| Line-level short-pay / debit memo / supplier portal | Header `payable_total_cents` only. |
| Fuzzy duplicate / OCR typos | Exact billed cents + ±7 UTC days or same PO + amount. |
| Contract CLM / e-sign / auto-extend / PO `source_contract_id` | Renewal creates a standard PR; convert does not copy the FK. |
| Cron / scheduled renewals / aging jobs | Request-driven only. |
| Fiscal years other than 2026 | Hardcoded in budget queries. |
| `approval_limit` as a routing gate | Stored and displayed; policy uses PR total + roles. |
| Header persona switcher on customers | Off unless `DEMO_PERSONA_SWITCHER=1`. |

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
| [CUSTOMER_ONBOARDING.md](CUSTOMER_ONBOARDING.md) | Click-by-click customer install |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Isolation, env, Auth API, Vercel, rollback |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Match math, contract scoring, sequential approvals |
| [`scripts/provision-customer.md`](../scripts/provision-customer.md) | Copy-paste checklist |
| [`.env.example`](../.env.example) | Env key names |
| [`server/src/schema.sql`](../server/src/schema.sql) | Tables and CHECKs |
| [`server/src/approvalPolicy.js`](../server/src/approvalPolicy.js) | Approval chains |
| [`server/src/bootstrapOrg.js`](../server/src/bootstrapOrg.js) | Cost-center skeleton |
