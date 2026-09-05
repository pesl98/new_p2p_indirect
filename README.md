# ProcureFlow - Non-Production Procurement & P2P System

A full-lifecycle **Indirect Procurement (Procure-to-Pay / P2P)** application built with **React**, **Node.js / Express**, and **SQLite (`better-sqlite3`)**. Specifically designed for non-production goods and services (IT hardware/software, office furniture, facilities/MRO, consulting, SaaS subscriptions, and operational expenses).

Control model (integer cents, sequential approvals, dual invoice match, GRN/SES receiving, budget fail-closed rules): see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

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
   - Finance / Accounts Payable review, exception override, and ACH payment release.

7. **Department Budgets & Cost Centers**
   - Real-time departmental tracking in cents: Allocated vs. **Committed (on final PR approve)** vs. Actual Spent (AP-approved invoices) vs. Remaining (`total − committed − actual`).

8. **Multi-Persona Testing Switcher (demo only — not real auth)**
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

1. **Start the Production Application (Single Port)**:
   ```bash
   node server/src/index.js
   ```
   Open [http://localhost:5000](http://localhost:5000) in your browser.

2. **Or Run in Development Mode (with Live Reload)**:
   ```bash
   # Terminal 1: Backend
   cd server && npm run dev

   # Terminal 2: Frontend
   cd client && npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

3. **Re-seed the Database with Sample Data**:
   ```bash
   node server/src/seed.js
   ```

4. **Run unit tests** (`node --test`):
   ```bash
   npm test
   ```

---

Document numbers (`PR-` / `PO-` / `GRN-` / `SES-YYYY-NNN`) use the **max numeric suffix** for the year, not `COUNT(*)+1`. Invoice numbers are unique per supplier (`UNIQUE(supplier_id, invoice_number)`).

Catalog / PR / PO lines are typed `goods` or `service` from category (Consulting, Software & Cloud, Marketing & Events, Travel → service; IT Hardware, Office, Facilities → goods) unless an explicit `line_type` is stored.

---

## 🗄️ Database Architecture (SQLite)

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
- `audit_logs`: Complete immutable event history
