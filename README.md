# ProcureFlow - Non-Production Procurement & P2P System

A full-lifecycle **Indirect Procurement (Procure-to-Pay / P2P)** application built with **React**, **Node.js / Express**, and **SQLite (`better-sqlite3`)**. Specifically designed for non-production goods and services (IT hardware/software, office furniture, facilities/MRO, consulting, SaaS subscriptions, and operational expenses).

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
   - The decide API requires `approver_id` matching the current pending step (persona switcher is client-only; no JWT).
   - 1-Click approval/rejection modal with audit trail. Department budget is committed only when the **final** step is approved.

3. **Purchase Orders (PO) Management**
   - Convert approved requisitions into official binding Purchase Orders with sequential numbering (`PO-YYYY-XXX`).
   - Printable & exportable corporate Purchase Order layout complete with vendor address, payment terms, delivery instructions, and signature block.
   - Real-time fulfillment tracking with partial delivery indicators.

4. **Goods & Service Receipts (GRN)**
   - Receiving inspection wizard against active Purchase Orders.
   - Line-by-line inspection (quantity received, condition: good/damaged/partial, carrier tracking, supplier delivery slip).
   - Automatically updates PO fulfillment status and calculates unreceived balances.

5. **Automated 3-Way Matching Engine (PO vs. GRN vs. Invoice)**
   - Matrix comparison analyzing:
     1. **Purchase Order**: Authorized line item quantities and contracted unit prices
     2. **Goods Receipt (GRN)**: Physically received and inspected quantities
     3. **Supplier Invoice**: Invoiced quantities and billed unit prices
   - Automated discrepancy detection:
     - Exact Match (100% agreement)
     - Price Variance (Flags if billed unit price exceeds PO contract price)
     - Quantity Variance (Flags if billed quantity exceeds physically received units on GRN)
   - Finance / Accounts Payable review, exception override, and ACH payment release.

6. **Department Budgets & Cost Centers**
   - Real-time departmental tracking (Allocated vs. Committed via POs vs. Actual Spent via Invoices vs. Remaining).

7. **Multi-Persona Testing Switcher**
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

## 🗄️ Database Architecture (SQLite)

Money columns (`unit_price`, `total_amount`, budget fields, invoice totals, match price variance, etc.) are stored as **integer cents**. The API returns cents; the client formats dollars for display. Quantities are whole units.
- `departments`: Cost centers & organizational units
- `users`: Employees with roles and authorization limits
- `budgets`: Fiscal year budgets, commitments, and actual expenditures
- `suppliers`: Approved vendor repository with payment terms & ratings
- `catalog_items`: Non-production items and pre-negotiated pricing
- `purchase_requisitions` & `requisition_items`: Requisitions & line items
- `approval_requests`: Multi-tier approval routing steps
- `purchase_orders` & `po_items`: Official Purchase Orders
- `goods_receipts` & `goods_receipt_items`: Inward receiving records
- `invoices` & `invoice_items`: Supplier billing entries
- `match_results`: 3-way line item match logs & variance records
- `audit_logs`: Complete immutable event history
