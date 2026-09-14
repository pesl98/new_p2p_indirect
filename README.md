# ProcureFlow - Non-Production Procurement & P2P System

A full-lifecycle **Indirect Procurement (Procure-to-Pay / P2P)** application built with **React**, **Node.js / Express**, and **SQLite** locally (`better-sqlite3`) or **Turso** (libSQL over HTTP) on Vercel. Specifically designed for non-production goods and services (IT hardware/software, office furniture, facilities/MRO, consulting, SaaS subscriptions, and operational expenses).

Control model (integer cents, sequential approvals, approval delegation / OOO substitute, dual invoice match, invoice exception workbench, buyer inbox for `return_to_buyer`, **duplicate invoice detection**, **AP payment aging / payables queue**, **SaaS & vendor contract renewals**, **PR → contract auto-assignment**, GRN/SES receiving, multi-supplier PO split, **PO change orders / revisions**, budget fail-closed rules): see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## 🌟 Key Features Across the Complete Purchasing Lifecycle

1. **Catalog & Ad-Hoc Requisitions (PR)**
   - Pre-negotiated non-production catalog across 6 categories (IT Hardware, Software & Cloud, Office Supplies, Facilities & MRO, Consulting & Professional Services, Marketing & Events).
   - **Master-data maintenance (Carol / procurement persona):** edit supplier and catalog fields; **soft-deactivate** (`active` / `inactive` / `under_review` for suppliers; `active` / `inactive` for catalog). No hard delete — `DELETE` returns 405. Supplier `code` is immutable. Requisition browse and buyer pickers show **active** rows only; the Vendors & Catalog admin screen lists all with status badges.
   - Dynamic Cart with direct catalog addition plus ad-hoc/custom order entry.
   - **Contract auto-assign:** when a new PR is created or submitted and a suitable `active` / `expiring_soon` contract matches (supplier and/or category / catalog overlap), ProcureFlow stores a durable `source_contract_id` as **proposed**. The requester can override or clear before submit. Matching never blocks create.
   - Cost center assignment, delivery requirements, and business justifications.

2. **Multi-Tier Approval Routing**
   - Role-based policy (`server/src/approvalPolicy.js`) resolves **step 1** from `departments.approver_user_id` (org-admin mapping), then falls back to `role=approver` in the requisition’s department. Later steps are still by role — not hardcoded user IDs. Thresholds are integer cents (`APPROVAL_TIER2_CENTS` = \$1,000 / `APPROVAL_TIER3_CENTS` = \$10,000):
     - **≤ \$1,000**: Department Head (mapped user, else `role=approver` in the requisition’s department)
     - **> \$1,000 and ≤ \$10,000**: Department Head, then Strategic Sourcing (`role=procurement`)
     - **> \$10,000**: Department Head, then Procurement, then Finance Controller (`role=finance`) or CFO (`role=admin`) if no finance user exists
   - **Org Admin (Elena):** assign or clear the step-1 head per department (`GET/PUT /api/departments…`). The sidebar entry is visible only for the admin persona. APIs are demo-open like supplier/catalog master-data (no JWT). Seed maps a head on every cost center so submit no longer fails for IT / Facilities / HR / Finance.
   - Steps are **sequential**, not parallel: only the current step is `pending`; later steps stay `waiting` until the previous step is approved. Waiting steps do not appear in the approver inbox. Rejecting a step skips remaining `waiting`/`pending` rows.
   - The decide API requires `approver_id` matching the current pending step **or an active delegate** covering now for that mapped approver. Stored `approver_id` on `approval_requests` is not rewritten when a delegation is created. **Persona auth is client-only demo** (header switcher; no JWT/sessions).
   - **Approval delegation (OOO):** an approver (or Elena as org admin) assigns a temporary substitute (`approval_delegations`: window, reason, soft-revoke). The delegate sees the current pending step in their inbox (badge “Delegated from …”) and may decide it. Waiting steps stay waiting. Cannot delegate to self; expired/inactive windows are ignored. Audit: `DELEGATION_CREATED` / `DELEGATION_REVOKED`, plus delegated_from on decide.
   - 1-Click approval/rejection modal with audit trail. Department budget is committed only when the **final** step is approved — not when a PO is issued. Final approve **fails closed** if remaining budget (`total − committed − actual`, cents) is less than the PR total.
   - **Contract use gate:** if a contract is proposed, the current approver (Bob / Priya as delegate) must **Allow contract use** or **Refuse contract use** as part of approve. Refuse does **not** reject the PR — it continues as ad-hoc. Omitting the choice is HTTP 400 (no silent force).

3. **Purchase Orders (PO) Management**
   - Convert approved requisitions into official binding Purchase Orders with sequential numbering (`PO-YYYY-XXX`).
   - **Multi-supplier split:** lines are grouped by resolved supplier (`estimated_supplier_id`, else catalog `preferred_supplier_id`, else an explicit convert-time mapping). One approved PR becomes **one issued PO per vendor**. A line with no resolvable supplier fails closed (HTTP 400) — the API does not invent a vendor. Single-supplier PRs still create exactly one PO. All split POs share `requisition_id`; each has its own cents total and `PO-YYYY-NNN`. The PR is marked `converted_to_po` only after every PO writes, in one transaction.
   - **Convert UI (per-line supplier remap):** from an approved PR, Carol (or any demo persona) opens **Convert to PO** on Requisitions or **Convert Approved PR** on Purchase Orders. The modal lists each line with its resolved default vendor and a supplier picker. Confirm posts `POST /api/purchase-orders/from-requisition` with `supplier_mappings` and shows the issued PO list (N POs when split). Remapping a line can change the split; leaving a line unassigned fails closed with a clear error. Seed demo: convert **PR-2026-006** (TechSupply + WorkSpace) and optionally remap a line before issue.
   - Printable & exportable corporate Purchase Order layout complete with vendor address, payment terms, delivery instructions, and signature block.
   - Real-time fulfillment tracking with partial delivery indicators.
   - **Change orders / revisions:** Carol (or any demo persona) amends an issued or partially received/received PO from the PO detail **Change order** action. Numbered `CO-YYYY-NNN` (MAX-suffix), revision per PO. Apply-on-confirm updates existing line qty / unit price (integer cents) and optional delivery notes. Fail-closed if the new qty would drop below already received (goods), accepted (services), or invoiced. Recalculates line and PO totals in cents. When the PO is linked to a PR/department, `budgets.committed_amount` moves by the delta (increase commits more; decrease releases, floored at 0) — `actual_spent` is never touched. Net increases above **$1,000** (`CHANGE_ORDER_INCREASE_CONFIRM_CENTS` = `APPROVAL_TIER2_CENTS`) require an explicit `confirm_increase` flag, not a second approval chain. Adding brand-new catalog lines is out of scope. Seed: **PO-2026-007** / **CO-2026-001** already applied; **PO-2026-004** is open for the live walkthrough.

4. **Goods Receipts (GRN)**
   - Receiving inspection wizard against **goods** PO lines (IT hardware, office, facilities).
   - Line-by-line inspection (quantity received, condition: good/damaged/partial, carrier tracking, supplier delivery slip).
   - Automatically updates PO fulfillment status and calculates unreceived balances.
   - **Over-receipt is blocked (HTTP 400)** unless the request includes explicit `allow_over_receipt: true` (audited exception).
   - Service lines are rejected on a GRN — use a Service Entry Sheet instead.

5. **Service Entry Sheets (SES)**
   - Acceptance flow for **service** PO lines (consulting, SaaS, marketing): draft → submitted → accepted/rejected.
   - Line-by-line accepted quantity; amount is qty × PO unit price in integer cents. Numbered `SES-YYYY-NNN`.
   - Accepting an SES increments `po_items.quantity_accepted` (parallel to GRN `quantity_received`).
   - **Over-acceptance is blocked (HTTP 400)** unless `allow_over_acceptance: true` (audited exception).

6. **Dual Invoice Matching (goods 3-way / services SES-backed)**
   - **Goods lines:** PO vs GRN received vs invoice (unchanged 3-way).
   - **Service lines:** PO vs SES-accepted vs invoice. Physical GRN is not required.
   - Mixed POs combine both; overall invoice status reflects any failing line.
   - Price rules unchanged (exact cents, 1% tolerated warning, else fail).
   - Finance / Accounts Payable review and ACH payment release. Hard match failures cannot be approved or paid until the Exception Workbench records a structured disposition.

7. **Invoice Exception Workbench**
   - Coupa/Ariba-style AP queue for dual-match failures (`variance_flagged`: quantity / price / total variance).
   - **`tolerated_match` is not queued** — those invoices are already `matched` and may proceed to approve. Soft warnings stay on the match matrix.
   - Structured dispositions with required reason + persona name, written to `invoice_exception_dispositions` and `audit_logs` (integer cents):
     - **accept_variance** — clear the block (`status` → `matched`); billed total recorded as `accepted_total_cents`. Approve may then proceed; no free-text override bypass.
     - **short_pay** — clear the block (`status` → `matched`) and rewrite **payable** below billed. `invoices.total_amount` (vendor claim) is unchanged; `invoices.payable_total_cents` is the amount AP approve/pay and budget actuals use. `accepted_total_cents` on the disposition is the payable amount; `billed_total_cents` stores the billed claim.
     - **reject_invoice** — permanently block approve/pay (`status` → `rejected`).
     - **return_to_buyer** — park with audit; invoice appears in the requester **Buyer Inbox** until they respond; stays in the AP open queue until accepted, short-paid, or rejected.
   - **Buyer Inbox (Alice / requester personas):** queue of invoices whose latest disposition is `return_to_buyer`. Respond with a required reason (ready-for-AP note). Invoice stays `variance_flagged`; AP then accept / short-pay / reject. Not an Approve for Payment override.
   - Seed: **INV-TSG-11029** is open for David/Elena (short-pay practice: billed $3,196.00 → e.g. pay $1,498.00 = 2 received × $749 PO price). **INV-TSG-22041** (`PR-2026-007`) is parked `return_to_buyer` for Alice’s Buyer Inbox. **INV-FCJ-7701** is already accepted. **INV-WED-9042** (PR-2026-001) stays the paid happy path.

8. **Duplicate Invoice Detection**
   - Exact reuse of `(supplier_id, invoice_number)` remains a hard DB uniqueness fail.
   - **Likely duplicate (soft hold)** on create when another non-rejected invoice for the same supplier has:
     - the same billed `total_amount` (integer cents) **and** `invoice_date` within **±7 UTC calendar days**, or
     - the same `po_id` **and** the same billed amount (different invoice number allowed).
   - The invoice is still created and dual-matched as today. `duplicate_status` becomes `suspect`; Approve for Payment and mark-paid refuse until AP disposes.
   - **Confirm unique** clears the hold (`confirmed_unique`) so approve may proceed if the invoice is matched. **Confirm duplicate** voids the new invoice (`rejected` + `confirmed_duplicate`) — Coupa-style; the candidate original is unchanged.
   - Required reason + persona name. Written to `invoice_duplicate_flags` and `audit_logs` (`DUPLICATE_SUSPECTED` / `DUPLICATE_CLEARED` / `DUPLICATE_CONFIRMED`).
   - Sidebar **Duplicate Suspects** for finance + admin (David / Elena). Badge on Invoices & Matching. APIs stay demo-open (no JWT).
   - Seed: **INV-TSG-6610** (paid $99.00 / PO-2026-011) is the candidate. **INV-TSG-6611** (matched $99.00 / PO-2026-012, near date) is the open suspect. Do not use INV-WED-9042 / INV-TSG-11029 / INV-TSG-22041 / INV-FCJ-8810 / INV-WED-3308 / INV-TSG-5508 for this walkthrough.
   - Still out of scope: OCR/PDF capture, fuzzy invoice-number OCR typos, payment-run / batch ACH.

9. **AP Payment Aging / Payables Queue**
   - Coupa/Ariba-style inbox for invoices already **`approved_for_payment`**, bucketed by `due_date` vs **today (UTC calendar date)**:
     - **Overdue** — `due_date` is before today
     - **Due soon** — due today through +N days (default **7**)
     - **Later** — due after that window
   - Optional chips: **Ready to approve** (`matched`, not yet approved) and **Recently paid** (due-date context). Those are not the pay queue.
   - Each row: invoice #, supplier, PO, invoice/due dates, billed `total_amount`, nullable `payable_total_cents` (short-pay), status, match status, days past due / until due, linked PR requester when present.
   - **Mark paid** reuses `POST /api/invoices/:id/mark-paid` (fail-closed: must be `approved_for_payment`; payable cents when set). Same `PAID` audit as Invoices & Matching — no second payment engine.
   - Sidebar **AP Aging** is visible for finance + admin (David / Elena). APIs stay demo-open (no JWT).
   - Seed: **INV-FCJ-8810** overdue (billed $220.00 → pay $210.00 short-pay, then approved — mark-paid practice). **INV-WED-3308** due soon (`PR-2026-009` / Sofia). **INV-TSG-5508** later. Do not use INV-WED-9042 / INV-TSG-11029 / INV-TSG-22041 for this walkthrough.

10. **Department Budgets & Cost Centers**
   - Real-time departmental tracking in cents: Allocated vs. **Committed (on final PR approve)** vs. Actual Spent (AP-approved invoices) vs. Remaining (`total − committed − actual`).

11. **Document trail (P2P lifecycle overview)**
   - One screen for a buying journey: PR header, sequential approvals, linked PO(s) (multi-supplier split as branches), GRN and/or SES, invoice `match_status`, and AP approve/paid events.
   - Derived from existing FKs + `audit_logs` only — no invented events. Lookup by `requisition_id`, `pr_number`, `po_id`, `po_number`, or document number search.
   - Seed demo: **PR-2026-001** is the completed goods path (PR → PO-2026-001 → GRN-2026-001 → INV-WED-9042 → paid). Convert **PR-2026-006** (optionally remapping a line in the convert UI) to see two PO branches — or one, if both lines are issued to the same vendor. **PR-2026-008** / **PO-2026-007** includes applied change order **CO-2026-001**.

12. **SaaS & Vendor Contract Renewal Hub**
   - Track non-production software licenses, maintenance, and professional-service retainers (`contracts` / `contract_items`). ACV and line prices are **integer cents**.
   - Dynamic status from UTC calendar dates: **active**, **expiring_soon** (within `notice_period_days` of `end_date`), **expired**, **cancelled**.
   - **1-click renewal PR:** only `active` / `expiring_soon` (expired and cancelled fail closed). Copies lines onto a `PR-YYYY-NNN` (MAX-suffix), sets `source_contract_id` as proposed, and inserts the existing sequential approval chain (`insertApprovalChain`). Refuses a second open renewal PR for the same `CNT-YYYY-NNN`.
   - Numbered `CNT-YYYY-NNN`. Sidebar **Contracts & Renewals** is visible to all demo personas (no JWT). APIs stay demo-open like catalog PATCH.
   - Seed: **CNT-2026-001** Figma (Marketing / CloudCore, 10 seats × $540.00 = $5,400.00 ACV) is the expiring-soon walkthrough. **PR-2026-010** is a new Figma seat already proposed against that contract so Bob/Priya can allow or refuse. **CNT-2026-002** Slack (IT, active). **CNT-2026-003** FacilityCare janitorial (Facilities, expiring soon). **CNT-2026-004** Apex retainer (Marketing, active, no auto-renew).

13. **Multi-Persona Testing Switcher (demo only — not real auth)**
   - Instant live switcher in the header to alternate between:
     - **Alice Chen** (Requester - Marketing)
     - **Bob Martinez** (Approver / Dept Head - Marketing)
     - **Carol Zhang** (Procurement Officer - Strategic Sourcing)
     - **David Miller** (Finance & Accounts Payable Controller)
     - **Elena Rostova** (Executive / CFO — Org Admin for department heads)
     - **Priya Nair** (IT department head)
     - **James Okonkwo** (Facilities department head)
     - **Sofia Berg** (HR department head)

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v18+)
- npm (v9+)

### Running the Application

From the repo root (`npm install` plus `npm install --prefix server` and `npm install --prefix client` on a fresh clone):

1. **Start the Production Application (Single Port)**:
   ```bash
   npm start
   # or: node server/src/index.js
   ```
   Open [http://localhost:5000](http://localhost:5000) in your browser. Express serves `client/dist` when present.

2. **Or Run in Development Mode (with Live Reload)**:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) (Vite proxies `/api` to `:5000`).

3. **Re-seed the Database with Sample Data** (local SQLite unless Turso env is set):
   ```bash
   npm run seed
   # or: node server/src/seed.js
   ```

4. **Run unit tests** (`node --test`, SQLite in-memory):
   ```bash
   npm test
   ```

**Short-pay walkthrough (David / Elena):** Exception Workbench → open **INV-TSG-11029** (billed $3,196.00; 4 monitors @ $799 vs 2 received @ PO $749). Choose **Short pay**, enter payable **1498.00** (2 × $749), required reason, confirm. Status becomes `matched`; billed stays $3,196.00; payable is $1,498.00. Invoices & Matching then **Approve for Payment** posts the payable cents (not billed). `match_status` stays `total_variance` — short-pay is a disposition, not a rematch.

**Buyer inbox walkthrough:** Switch to **Alice Chen** → sidebar **Buyer Inbox** → open **INV-TSG-22041** (PO-2026-006 / PR-2026-007; 3 mice billed vs 2 received). AP’s return reason is on the row. **Respond** with a required note (e.g. third unit arrived off-system / ready for AP) and **Send to AP**. Invoice stays `variance_flagged` and leaves Alice’s inbox. Switch to **David Miller** → Exception Workbench → INV-TSG-22041 still open with Alice’s buyer response in history → Accept variance, Short pay, or Reject. To practice the AP return itself: David can **Return to buyer** on a different open hard exception — leave **INV-TSG-11029** for short-pay practice.

**Approval delegation walkthrough:** Seed maps **Bob Martinez → Priya Nair** with an active OOO window. Switch to **Priya Nair** → Approvals Inbox → **PR-2026-003** shows “Delegated from Bob Martinez”. Approve as delegate; the step’s stored approver stays Bob; Carol’s waiting procurement step is unchanged (promoted to pending after step 1). Audit on the PR notes `Delegated from Bob Martinez`. To create/revoke: switch to **Bob** → sidebar **Delegations** → pick Priya, optional window, reason. **Elena** can manage any pair from the same screen. Revoke is a soft inactivate — history remains.

**PO change order walkthrough:** Switch to **Carol Zhang** → Purchase Orders → open **PO-2026-004** (issued Figma seats; 2 × $540.00; no SES yet). **Change order** → e.g. qty 2 → 3 or unit price $540.00 → $500.00, required reason, confirm. Totals recompute in integer cents; history lists the new `CO-YYYY-NNN`. To see an already-applied revision: open **PO-2026-007** (Rev 1, **CO-2026-001**, $2,670.00 → $2,550.00 volume discount) or Document trail **PR-2026-008**. Do not amend **PO-2026-001** (paid happy path), **PO-2026-002** (INV-TSG-11029 short-pay), or **PO-2026-006** (buyer inbox). A net increase over $1,000 requires the confirm-increase checkbox. Reducing a line below received / accepted / invoiced is rejected (400).

**AP Aging walkthrough (David / Elena):** Switch to **David Miller** → sidebar **AP Aging**. Overdue shows **INV-FCJ-8810** (FacilityCare first-aid; billed $220.00 → pay $210.00). Due soon shows **INV-WED-3308** (WorkSpace paper / **PR-2026-009** / Sofia). Later shows **INV-TSG-5508** (CalDigit dock). **Mark paid** on INV-FCJ-8810 (payment reference required in the modal) — status becomes `paid` via the existing mark-paid API. Ready to approve still lists matched invoices such as **INV-AAD-5501** and **INV-FCJ-7701**. Leave **INV-WED-9042** paid, **INV-TSG-11029** open for short-pay, and **INV-TSG-22041** in Alice’s Buyer Inbox. Elena sees the same sidebar entry.

**Duplicate suspects walkthrough (David / Elena):** Switch to **David Miller** → sidebar **Duplicate Suspects**. Open **INV-TSG-6611** (TechSupply, billed $99.00, PO-2026-012). The candidate is **INV-TSG-6610** (same $99.00, paid on PO-2026-011, invoice dates within ±7 UTC days). Dual match already passed — Approve for Payment is blocked by the duplicate hold. **Confirm unique** (required reason) clears the hold so Invoices & Matching can approve; **Confirm duplicate** rejects/voids INV-TSG-6611 (the paid original is unchanged). Leave INV-WED-9042 / INV-TSG-11029 / INV-TSG-22041 / the AP aging trio alone. Elena sees the same sidebar entry.

**Contract renewal walkthrough (Carol / Alice):** Switch to **Carol Zhang** (or Alice) → sidebar **Contracts & Renewals**. **CNT-2026-001** Figma is expiring soon (10 seats × $540.00 = $5,400.00 ACV, CloudCore / Marketing). **Renew PR** creates the next `PR-YYYY-NNN` with copied seats, durable `source_contract_id`, sequential dept-head + procurement approvals (Bob pending, Carol waiting), and `CONTRACT_PROPOSED` / `SUBMITTED` / `RENEWAL_PR_CREATED` audit rows. Expired and cancelled contracts cannot renew. A second click while that PR is still draft/pending/approved is refused. Leave INV-TSG-11029 / 22041 / 6610 / 6611 and the AP aging trio alone. Then Approvals Inbox → Bob (or Priya via the seeded OOO delegation if you use a Marketing step-1 PR — this Figma PR is also Marketing). Bob must **Allow** or **Refuse** contract use; refuse still lets him approve the PR as ad-hoc.

**Contract auto-assign walkthrough (Alice → Bob / Priya):** Switch to **Alice Chen** → Requisitions → **Create Requisition** → add **Figma Organization Annual User License**. The create form previews **CNT-2026-001**. Submit for approval. The PR stores `source_contract_id` as **proposed** (not just CNT- in justification). Switch to **Bob Martinez** (or **Priya Nair**, who also sees it via the seeded OOO delegation) → Approvals Inbox → **Allow contract use** or **Refuse contract use**, then confirm approval. Seeded **PR-2026-010** is the same loop without creating a PR. Do not use **PR-2026-003** for this walkthrough (that one stays unlinked so the delegation demo does not require a contract decision).

---

## ☁️ Deploy: Vercel + Turso

Local laptop default is **SQLite** at `server/data/procurement.db` (override with `PROCUREMENT_DB_PATH`). When `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are set, the same code uses Turso over **HTTP** (`POST /v2/pipeline`). No native libsql/`.so` is loaded — that crashes Vercel serverless.

On Vercel (`VERCEL` / `VERCEL_ENV`), Turso is **required**. Missing vars (or a 401 from an org JWT instead of a database token) show a readable configuration page / JSON 503 instead of `FUNCTION_INVOCATION_FAILED`. There is **no cron** — this app is request-driven.

### Entrypoint files

| File | Role |
| --- | --- |
| [`api/index.js`](api/index.js) | Vercel Node Function — **default-exports** the Express app. CLI 59.x requires `functions` keys under `api/` (root `app.js` is rejected). |
| [`server/src/app.js`](server/src/app.js) | Express factory (API + lazy DB init). Does not `listen`. |
| [`server/src/index.js`](server/src/index.js) | Local listen on `PORT` (default 5000) |
| [`vercel.json`](vercel.json) | `buildCommand`, `functions.api/index.js.includeFiles` for `server/src/schema.sql`, rewrite `/api/*` → `/api` |
| [`public/`](public/) | Vite build output (`npm run build` copies `client/dist` here). Vercel CDN serves it; `express.static` is ignored on Vercel. |

### Create a Turso database

Use a **classic libSQL** database (not `--tursodb`) and a **database token** (not an org/platform JWT):

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
turso db create procureflow
turso db show procureflow --url
turso db tokens create procureflow
```

### Vercel environment variables

In the Vercel project → Settings → Environment Variables, set **both** for **Production and Preview** (or All Environments). Preview URLs stay broken if the vars are Production-only:

| Variable | Value |
| --- | --- |
| `TURSO_DATABASE_URL` | URL from `turso db show … --url` (often `libsql://…`) |
| `TURSO_AUTH_TOKEN` | Token from `turso db tokens create …` |

Redeploy after saving. Env changes do not apply to an already-built Preview.

### Seed against Turso (from your laptop)

```bash
export TURSO_DATABASE_URL=libsql://…
export TURSO_AUTH_TOKEN=…
npm run seed
```

Then verify a read/write path (still on your laptop against Turso, or on the Preview URL after deploy):

```bash
# with the same TURSO_* env:
npm start
curl -s http://localhost:5000/api/health
# expect: { "status":"ok", "db":"turso-http", ... }

curl -s http://localhost:5000/api/users | head
curl -s -X POST http://localhost:5000/api/catalog \
  -H 'Content-Type: application/json' \
  -d '{"sku":"SKU-SMOKE-1","name":"Smoke item","category":"Office Supplies","unit_price":199}'
```

Omit the Turso vars to keep using local `server/data/procurement.db`.

### Build / deploy

```bash
npm run build    # client → client/dist and public/
# Connect the Git repo in Vercel, or: vercel
```

Vercel runs `npm run build`, deploys `api/index.js` as one Node Function (`includeFiles` keeps `schema.sql` in the bundle), rewrites `/api/*` to that function, and serves `public/` statically. No Hobby-breaking cron is configured.

---

Document numbers (`PR-` / `PO-` / `GRN-` / `SES-` / `CO-` / `CNT-YYYY-NNN`) use the **max numeric suffix** for the year, not `COUNT(*)+1`. Invoice numbers are unique per supplier (`UNIQUE(supplier_id, invoice_number)`).

Catalog / PR / PO lines are typed `goods` or `service` from category (Consulting, Software & Cloud, Marketing & Events, Travel → service; IT Hardware, Office, Facilities → goods) unless an explicit `line_type` is stored.

---

## 🗄️ Database Architecture

Local default is SQLite (`better-sqlite3`). Production on Vercel is Turso via SQL-over-HTTP. Schema bootstrap (`CREATE TABLE IF NOT EXISTS` + existing migrations) runs on cold start for both.

Money columns (`unit_price`, `total_amount`, budget fields, invoice totals, match price variance, etc.) are stored as **integer cents**. The API returns cents; the client formats dollars for display. Quantities are whole units. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for lifecycle, match rules, sequential approvals, and receiving/budget controls.
- `departments`: Cost centers & organizational units, plus nullable `approver_user_id` (step-1 department head). Maintain via Org Admin / `PUT /api/departments/:id/approver`.
- `users`: Employees with roles and authorization limits
- `budgets`: Fiscal year budgets, commitments, and actual expenditures
- `suppliers`: Approved vendor repository with payment terms, ratings, and `status` (`active` | `inactive` | `under_review`). Edit via `PATCH /api/suppliers/:id`; deactivate via status — never hard-delete.
- `catalog_items`: Non-production items and pre-negotiated pricing (`line_type` goods|service, `status` active|inactive). Edit via `PATCH /api/catalog/:id`. Requisition browse defaults to active items.
- `purchase_requisitions` & `requisition_items`: Requisitions & line items (`source_contract_id` nullable pointer at `contracts.id`; `contract_use_status` `none` | `proposed` | `allowed` | `refused`)
- `approval_requests`: Multi-tier approval routing steps (stored `approver_id` is the mapped step owner)
- `approval_delegations`: Out-of-office substitute approvers (`delegator_user_id` → `delegate_user_id`, optional `starts_at` / `ends_at`, `active` soft-revoke)
- `purchase_orders` & `po_items`: Official Purchase Orders (`quantity_received`, `quantity_accepted`, `line_type`, `revision`, `change_order_count`)
- `po_change_orders` & `po_change_order_items`: Formal PO revisions (`CO-YYYY-NNN`, before/after totals in cents)
- `goods_receipts` & `goods_receipt_items`: Inward receiving records (goods)
- `service_entry_sheets` & `service_entry_sheet_items`: Service acceptance records (SES)
- `invoices` & `invoice_items`: Supplier billing entries (`total_amount` = billed claim; nullable `payable_total_cents` set by short-pay; `duplicate_status` `clear` | `suspect` | `confirmed_unique` | `confirmed_duplicate`)
- `match_results`: Line item match logs & variance records (GRN or SES receipt basis)
- `invoice_exception_dispositions`: Structured AP exception resolutions (accept / short-pay / reject / return-to-buyer)
- `invoice_duplicate_flags`: Likely-duplicate candidate links + AP dispositions (confirm unique / confirm duplicate)
- `contracts` & `contract_items`: SaaS / vendor agreements (ACV and line prices in integer cents, `CNT-YYYY-NNN`)
- `audit_logs`: Complete immutable event history
- Document trail is **not** a new table: `GET /api/document-trail` derives the chain from the FKs above plus AP rows in `audit_logs`
