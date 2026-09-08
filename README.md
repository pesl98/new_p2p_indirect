# ProcureFlow - Non-Production Procurement & P2P System

A full-lifecycle **Indirect Procurement (Procure-to-Pay / P2P)** application built with **React**, **Node.js / Express**, and **SQLite** locally (`better-sqlite3`) or **Turso** (libSQL over HTTP) on Vercel. Specifically designed for non-production goods and services (IT hardware/software, office furniture, facilities/MRO, consulting, SaaS subscriptions, and operational expenses).

Control model (integer cents, sequential approvals, dual invoice match, invoice exception workbench, GRN/SES receiving, multi-supplier PO split, budget fail-closed rules): see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## 🌟 Key Features Across the Complete Purchasing Lifecycle

1. **Catalog & Ad-Hoc Requisitions (PR)**
   - Pre-negotiated non-production catalog across 6 categories (IT Hardware, Software & Cloud, Office Supplies, Facilities & MRO, Consulting & Professional Services, Marketing & Events).
   - Dynamic Cart with direct catalog addition plus ad-hoc/custom order entry.
   - Cost center assignment, delivery requirements, and business justifications.

2. **Multi-Tier Approval Routing**
   - Role-based policy (`server/src/approvalPolicy.js`) resolves approvers by role and department — not hardcoded user IDs. Thresholds are integer cents (`APPROVAL_TIER2_CENTS` = \$1,000 / `APPROVAL_TIER3_CENTS` = \$10,000):
     - **≤ \$1,000**: Department Head (`role=approver` in the requisition’s department)
     - **> \$1,000 and ≤ \$10,000**: Department Head, then Strategic Sourcing (`role=procurement`)
     - **> \$10,000**: Department Head, then Procurement, then Finance Controller (`role=finance`) or CFO (`role=admin`) if no finance user exists
   - Steps are **sequential**, not parallel: only the current step is `pending`; later steps stay `waiting` until the previous step is approved. Waiting steps do not appear in the approver inbox. Rejecting a step skips remaining `waiting`/`pending` rows.
   - The decide API requires `approver_id` matching the current pending step. **Persona auth is client-only demo** (header switcher; no JWT/sessions).
   - 1-Click approval/rejection modal with audit trail. Department budget is committed only when the **final** step is approved — not when a PO is issued. Final approve **fails closed** if remaining budget (`total − committed − actual`, cents) is less than the PR total.

3. **Purchase Orders (PO) Management**
   - Convert approved requisitions into official binding Purchase Orders with sequential numbering (`PO-YYYY-XXX`).
   - **Multi-supplier split:** lines are grouped by resolved supplier (`estimated_supplier_id`, else catalog `preferred_supplier_id`, else an explicit convert-time mapping). One approved PR becomes **one issued PO per vendor**. A line with no resolvable supplier fails closed (HTTP 400) — the API does not invent a vendor. Single-supplier PRs still create exactly one PO. All split POs share `requisition_id`; each has its own cents total and `PO-YYYY-NNN`. The PR is marked `converted_to_po` only after every PO writes, in one transaction.
   - Printable & exportable corporate Purchase Order layout complete with vendor address, payment terms, delivery instructions, and signature block.
   - Real-time fulfillment tracking with partial delivery indicators.

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
     - **reject_invoice** — permanently block approve/pay (`status` → `rejected`).
     - **return_to_buyer** — park with audit; stays in the open queue until accepted or rejected.
   - Seed: **INV-TSG-11029** is open for David/Elena; **INV-FCJ-7701** is already accepted. **INV-WED-9042** (PR-2026-001) stays the paid happy path.

8. **Department Budgets & Cost Centers**
   - Real-time departmental tracking in cents: Allocated vs. **Committed (on final PR approve)** vs. Actual Spent (AP-approved invoices) vs. Remaining (`total − committed − actual`).

9. **Document trail (P2P lifecycle overview)**
   - One screen for a buying journey: PR header, sequential approvals, linked PO(s) (multi-supplier split as branches), GRN and/or SES, invoice `match_status`, and AP approve/paid events.
   - Derived from existing FKs + `audit_logs` only — no invented events. Lookup by `requisition_id`, `pr_number`, `po_id`, `po_number`, or document number search.
   - Seed demo: **PR-2026-001** is the completed goods path (PR → PO-2026-001 → GRN-2026-001 → INV-WED-9042 → paid). Convert **PR-2026-006** to see two PO branches.

10. **Multi-Persona Testing Switcher (demo only — not real auth)**
   - Instant live switcher in the header to alternate between:
     - **Alice Chen** (Requester - Marketing)
     - **Bob Martinez** (Approver / Dept Head - Marketing Director)
     - **Carol Zhang** (Procurement Officer - Strategic Sourcing)
     - **David Miller** (Finance & Accounts Payable Controller)
     - **Elena Rostova** (Executive / CFO)

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

Document numbers (`PR-` / `PO-` / `GRN-` / `SES-YYYY-NNN`) use the **max numeric suffix** for the year, not `COUNT(*)+1`. Invoice numbers are unique per supplier (`UNIQUE(supplier_id, invoice_number)`).

Catalog / PR / PO lines are typed `goods` or `service` from category (Consulting, Software & Cloud, Marketing & Events, Travel → service; IT Hardware, Office, Facilities → goods) unless an explicit `line_type` is stored.

---

## 🗄️ Database Architecture

Local default is SQLite (`better-sqlite3`). Production on Vercel is Turso via SQL-over-HTTP. Schema bootstrap (`CREATE TABLE IF NOT EXISTS` + existing migrations) runs on cold start for both.

Money columns (`unit_price`, `total_amount`, budget fields, invoice totals, match price variance, etc.) are stored as **integer cents**. The API returns cents; the client formats dollars for display. Quantities are whole units. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for lifecycle, match rules, sequential approvals, and receiving/budget controls.
- `departments`: Cost centers & organizational units
- `users`: Employees with roles and authorization limits
- `budgets`: Fiscal year budgets, commitments, and actual expenditures
- `suppliers`: Approved vendor repository with payment terms & ratings
- `catalog_items`: Non-production items and pre-negotiated pricing (`line_type` goods|service)
- `purchase_requisitions` & `requisition_items`: Requisitions & line items
- `approval_requests`: Multi-tier approval routing steps
- `purchase_orders` & `po_items`: Official Purchase Orders (`quantity_received`, `quantity_accepted`, `line_type`)
- `goods_receipts` & `goods_receipt_items`: Inward receiving records (goods)
- `service_entry_sheets` & `service_entry_sheet_items`: Service acceptance records (SES)
- `invoices` & `invoice_items`: Supplier billing entries
- `match_results`: Line item match logs & variance records (GRN or SES receipt basis)
- `invoice_exception_dispositions`: Structured AP exception resolutions (accept / reject / return-to-buyer)
- `audit_logs`: Complete immutable event history
- Document trail is **not** a new table: `GET /api/document-trail` derives the chain from the FKs above plus AP rows in `audit_logs`
