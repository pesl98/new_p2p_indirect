# ProcureFlow architecture

Non-production **Procure-to-Pay (P2P)** demo: React client, Express API, SQLite locally (`better-sqlite3`) or Turso (libSQL **SQL-over-HTTP** `/v2/pipeline`) on Vercel. Money is integer **cents**. Quantities are whole units.

This document describes the control model implemented in code. The header persona switcher is **client-only demo auth** — it is not JWT, sessions, or server-enforced identity. API bodies still carry `approver_id` / `received_by` / `requester_id`; anyone who can reach the API can send any persona id.

## Lifecycle

```
Draft PR → Submit → Sequential approvals → (budget commit on final approve)
        → Convert to PO(s) (one issued PO per resolved supplier)
        → Goods: GRN          ──┐
        → Services: SES accept ─┴→ Vendor invoice → dual match
        → Exception workbench (hard failures only) → AP approve → Mark paid
```

| Stage | What happens |
| --- | --- |
| Requisition | Lines stored as qty × unit price in cents. Numbered `PR-YYYY-NNN`. |
| Approval | Role-based chain; only the current `pending` step can decide. Later steps stay `waiting`. |
| Budget commit | On **final PR approve** only: `budgets.committed_amount += PR total`. Not on PO issue. |
| Purchase order | Copy of approved PR lines, including `line_type`. Numbered `PO-YYYY-NNN`. Multi-supplier PRs issue **one PO per resolved supplier**. |
| Goods receipt | Goods lines only. Increments `po_items.quantity_received`. Over-receipt is blocked unless `allow_over_receipt: true`. Numbered `GRN-YYYY-NNN`. Service lines are rejected (use SES). |
| Service entry sheet | Service lines only. Draft → submitted → accepted/rejected. Accept increments `po_items.quantity_accepted`. Over-acceptance is blocked unless `allow_over_acceptance: true`. Numbered `SES-YYYY-NNN`. |
| Invoice | Unique per `(supplier_id, invoice_number)`. Dual match: goods 3-way vs GRN; services SES-backed vs accepted SES. |
| Exception workbench | Hard match failures (`variance_flagged`) require a structured AP disposition before approve/pay. |
| AP approve | Relieves committed, increases `actual_spent` by invoice total (cents). Refuses unresolved hard exceptions and rejected invoices. |

## Money (integer cents)

SQLite columns (`unit_price`, `total_amount`, budget fields, invoice totals, match `price_variance`, user `approval_limit`) store **integer USD cents**. The API returns cents. The client formats dollars at display/input edges (`client/src/money.js`, `server/src/money.js`).

Do not mix float dollars with cents in the same field. Line totals are `qty * unit_price_cents` with integer arithmetic.

Approval thresholds (`server/src/money.js`):

- `APPROVAL_TIER2_CENTS` = 100000 ($1,000)
- `APPROVAL_TIER3_CENTS` = 1000000 ($10,000)

## Sequential approvals

Policy lives in `server/src/approvalPolicy.js` and is resolved by **role + department**, not hardcoded user ids:

| PR total | Chain |
| --- | --- |
| ≤ $1,000 | Department Head (`role=approver` in the PR’s department) |
| > $1,000 and ≤ $10,000 | Dept Head, then Strategic Sourcing (`role=procurement`) |
| > $10,000 | Dept Head, then Procurement, then Finance (`role=finance`) or CFO (`role=admin`) if no finance user exists |

Steps are sequential, not parallel:

- Step 1 is inserted `pending`; later steps are `waiting`.
- `POST /api/approvals/:id/decide` requires `approver_id` matching the current pending row (403 otherwise). Waiting steps cannot be decided (400).
- Approving a non-final step promotes the next `waiting` row to `pending`.
- Rejecting a step sets remaining `waiting`/`pending` rows to `skipped` and the PR to `rejected`. No budget movement.

Waiting steps do not appear in the approver inbox (list defaults to `status=pending`).

## Multi-supplier PO split

`purchase_orders.supplier_id` is one vendor per PO. An approved requisition whose lines resolve to different suppliers is converted into **N issued POs**, not a single blended order.

`POST /api/purchase-orders/from-requisition` (`server/src/purchaseOrdersService.js`):

1. Load PR lines with catalog `preferred_supplier_id`.
2. Resolve each line’s supplier, in order:
   - explicit convert-time `supplier_mappings` (`[{ requisition_item_id, supplier_id }]` or `{ [itemId]: supplierId }`)
   - `requisition_items.estimated_supplier_id`
   - catalog `preferred_supplier_id` when the line is catalog-linked
3. **Fail closed (HTTP 400)** if any line has no resolvable supplier. Header-level `supplier_id` is **not** a silent default (the previous path used `first line || 1` and invented a vendor).
4. Group lines by resolved supplier. Single-supplier PRs still create exactly one PO.
5. In one transaction: allocate each `PO-YYYY-NNN` via existing MAX-suffix numbering, write per-PO totals in integer cents, copy lines with `requisition_item_id` preserved, share `requisition_id`, then mark the PR `converted_to_po`.
6. Audit: each PO is `ISSUED`; the PR gets `CONVERTED_TO_PO` (one supplier) or `SPLIT_CONVERTED_TO_PO` (N suppliers, listing PO numbers and vendor names). Convert-time remaps that differ from the default vendor are appended to that PR audit row.
7. Response is `{ purchase_orders: [...], split, message }` — a list, not a single `poId`.

PR detail returns `purchase_orders` (array). `purchase_order` remains the first linked PO for older clients.

Demo seed: **PR-2026-001** is the complete goods document-trail happy path (`PR → approvals → PO-2026-001 → GRN-2026-001 → INV-WED-9042 → AP paid`). **PR-2026-002** is a single-supplier approved convert; **PR-2026-006** is an approved TechSupply + WorkSpace split for Carol to convert — after convert the trail shows two PO branches. Existing SES/GRN demo POs (`PO-2026-003`, `PO-2026-004`, etc.) are unchanged. **PR-2026-005** is the service path (`PO-2026-003 → SES-2026-001 → INV-AAD-5501`).

The convert UI (`client/src/components/ConvertRequisitionModal.jsx`) is the Coupa/Ariba-style vendor assignment step. From an approved PR (Requisitions **Convert to PO**, or Purchase Orders **Convert Approved PR**), each line shows its resolved default supplier and a picker to override it. Confirm posts the existing `POST /api/purchase-orders/from-requisition` body including `supplier_mappings` — there is no second convert path. The response list of issued POs is shown in the same modal. Clearing a line’s supplier fails closed in the UI with the same missing-supplier rule as the API. Single-supplier PRs keep the default vendor and convert in one confirm. Ad-hoc PR lines still default to a supplier on create (`estimated_supplier_id || 1`); convert itself does not invent one.

PR detail items include `resolved_supplier_id` / `resolved_supplier_name` (same resolution order, before convert-time mappings) so the UI and API share one default. When a picker remaps a line, the PR `CONVERTED_TO_PO` / `SPLIT_CONVERTED_TO_PO` audit row records the remap.

## Budget commitment control

Remaining budget (cents):

```
remaining = total_budget − committed_amount − actual_spent
```

Enforced **only on the final approval step**, immediately before commit:

- If `remaining < PR.total_amount`, the decide API returns **400** and does not approve or commit.
- Optional `override_budget: true` force-commits and writes a `BUDGET_OVERRIDE` audit row (demo / finance exception path).
- Intermediate steps may still be approved when remaining is insufficient; the fail-closed check runs at commit time.

When AP approves an invoice for payment, committed is reduced (floored at 0) and `actual_spent` increases by the invoice total.

Demo fiscal year is hardcoded to **2026**.

## Line type (goods vs service)

Catalog, requisition, and PO lines store `line_type` (`goods` | `service`). Default is derived from category:

| `service` | `goods` |
| --- | --- |
| Consulting & Professional Services | IT Hardware |
| Software & Cloud | Office Supplies |
| Marketing & Events | Facilities & MRO |
| Travel & Subscriptions | anything else |

An explicit `line_type` on create wins over category. The stored type is what GRN, SES, and match use — they do not re-derive at control time.

## Receiving (GRN) over-receipt

Default: a receipt is **400** if any line’s `quantity_received` would make cumulative received **greater than ordered**.

Exception: body includes `allow_over_receipt: true`. The GRN is stored, PO qty received is incremented (including the overage), and an `OVER_RECEIPT_OVERRIDE` audit log is written.

Partial receipts at or below remaining ordered qty are allowed. Over-receipt is an exception path, not silent.

GRN is goods-only. Posting a service line on a GRN returns **400**.

## Service entry sheets (SES)

SES is the receipt for service PO lines (consulting, SaaS, marketing). Statuses: `draft` → `submitted` → `accepted` | `rejected`.

- Create records claimed qty/amount (amount = qty × PO unit price, integer cents). Qty is **not** applied to the PO until accept.
- Accept increments `po_items.quantity_accepted` and refreshes PO fulfillment (service lines use accepted qty; goods lines still use GRN received qty).
- Default: accept is **400** if any line’s cumulative accepted qty would exceed ordered.
- Exception: body includes `allow_over_acceptance: true`. The SES is accepted, PO qty accepted is incremented (including the overage), and an `OVER_ACCEPTANCE_OVERRIDE` audit log is written.
- Rejecting a submitted SES does not change PO quantities.

SES is service-only. Posting a goods line on an SES returns **400**.

## Dual invoice match (goods 3-way / services SES-backed)

`server/src/match.js` compares integer cents and integer qty. Match runs **before** `po_items.quantity_invoiced` is incremented so prior cumulative invoiced qty is intact. The claimed invoiced qty is still persisted afterward for audit, even on fail.

Receipt basis is per line:

- **Goods:** physically received (`quantity_received` from GRNs)
- **Services:** SES-accepted (`quantity_accepted`). Physical GRN is not required and is not consulted.

Quantity fail if:

- prior invoiced + this claim **>** that line’s receipt basis, or
- prior invoiced + this claim **>** ordered qty

A mixed PO can have both kinds of lines. Overall invoice `match_status` aggregates line results (a single failing service line flags the invoice even if goods lines pass).

Price:

- Exact cent equality → perfect (for that line)
- Non-zero difference within 1% of PO unit price (`Math.round(poUnitPriceCents / 100)`) → tolerated warning
- Larger difference → price variance fail

Overall invoice `match_status`: `perfect_match` | `tolerated_match` | `quantity_variance` | `price_variance` | `total_variance`.

## Invoice exception workbench

World-class P2P treats match exceptions as an AP control point, not a free-text note on Approve for Payment. ProcureFlow’s workbench is that queue.

**Hard queue (default `GET /api/invoice-exceptions?queue=open`):** invoices with status `variance_flagged` — i.e. overall `quantity_variance`, `price_variance`, or `total_variance`. These cannot be approved or marked paid until resolved.

**`tolerated_match` is not in the queue.** Those invoices already have status `matched` (soft 1% price warning). They proceed to AP approve without a disposition. Warnings remain on the match matrix. This matches Coupa/Ariba “soft hold vs hard exception”: only failing matches block STP.

Queue filters: `open` (default), `resolved` (terminal dispositions only), `all` (open plus any invoice that has a disposition row).

Structured dispositions (`POST /api/invoice-exceptions/:id/resolve`) require `reason` and `actor_name` (persona name; still client-only demo auth). Integer cents throughout. Written to `invoice_exception_dispositions` and `audit_logs`:

| Disposition | Invoice status | Approve / pay |
| --- | --- | --- |
| `accept_variance` | `matched` (block cleared). `match_status` stays the engine result. Records `accepted_total_cents` = billed invoice total and `accepted_match_status`. | Approve may proceed. No second override path. |
| `reject_invoice` | `rejected` (terminal). | Approve and mark-paid refuse. |
| `return_to_buyer` | Stays `variance_flagged`. Audit/park only. | Still blocked. May later accept or reject. Not listed under `resolved`. |

`approveInvoicePayment` / `markInvoicePaid` fail closed:

- `variance_flagged` → 400 (unresolved exception)
- `rejected` → 400 (permanent)
- mark-paid also requires status `approved_for_payment` (cannot skip approve)

The previous free-text `override_reason` on approve is a note only and does **not** unlock a hard exception.

Detail (`GET /api/invoice-exceptions/:id` and `GET /api/invoices/:id`) includes `match_results`, GRN/SES receipt basis already used by match, and prior dispositions. Document trail timeline includes exception audit actions (`EXCEPTION_ACCEPT_VARIANCE`, `EXCEPTION_REJECT_INVOICE`, `EXCEPTION_RETURN_TO_BUYER`) when present — it does not invent them.

Demo: **INV-TSG-11029** (`PO-2026-002`, total variance) is open for David/Elena. **INV-FCJ-7701** is an already-accepted price variance (`accepted_total_cents` = 29800). **INV-WED-9042** / PR-2026-001 remains the paid happy path.

## Document numbers

`PR-` / `PO-` / `GRN-` / `SES-` numbers use **MAX of the numeric suffix** for the current year (`server/src/docNumbers.js`), allocated inside the create transaction. This avoids `COUNT(*)+1` collisions after deletes or seed gaps. Columns `pr_number`, `po_number`, `grn_number`, and `ses_number` are UNIQUE.

Invoice numbers are unique per supplier: `UNIQUE(supplier_id, invoice_number)`. The same number from two vendors is allowed.

## Document trail

`GET /api/document-trail` builds a chronological buying-journey view from existing FKs and `audit_logs`. It does **not** invent events.

Lookup (first match wins): `requisition_id`, `pr_number`, `po_id`, `po_number`, or `q` (exact PR / PO / invoice number). Looking up a split child PO still returns the parent PR and **all** sibling POs. `GET /api/document-trail/search?q=` is the typeahead list.

Response includes:

- PR header + status (cents, ISO timestamps)
- Sequential approval steps (who / when / decision)
- Linked PO(s) — one branch per supplier
- GRNs and SES rows (or `not_started` / `not_applicable` on the branch)
- Invoices with `match_status`
- AP approve / paid rows taken only from invoice `audit_logs` (`APPROVED_PAYMENT`, `APPROVED_FOR_PAYMENT`, `PAID`)
- Exception dispositions, when present, from the same invoice `audit_logs` (`EXCEPTION_ACCEPT_VARIANCE`, `EXCEPTION_REJECT_INVOICE`, `EXCEPTION_RETURN_TO_BUYER`)

The Document trail sidebar screen opens this payload as a stage strip + vertical timeline, with click-through to the existing PR / PO / GRN / SES / invoice tabs.

Demo: open **PR-2026-001** for the completed goods chain. Convert **PR-2026-006** to see two PO branches.

## How to run, seed, and test

Prerequisites: Node 18+, npm 9+.

```bash
# Install (from repo root and both packages)
npm install
cd server && npm install && cd ../client && npm install && cd ..

# Seed sample data (SQLite locally; Turso when TURSO_* are set)
npm run seed
# or: node server/src/seed.js

# Unit tests (node --test) — SQLite in-memory plus Turso HTTP mocks
npm test

# Dev: API :5000 + Vite :3000
npm run dev

# Production-style: Express serves client/dist if present
npm start
```

Tests cover money/match, sequential approvals, budget fail/override, GRN over-receipt reject/override, SES numbering and over-acceptance reject/override, service SES-backed match pass/fail (including mixed POs), goods 3-way still working, document-number uniqueness, invoice-number uniqueness, multi-supplier PO split (single-supplier still one PO; N POs with correct lines/totals; missing supplier fail-closed; convert-time `supplier_mappings` remap/collapse; PR status only converts after success), the document trail (complete goods chain shape, multi-PO branches, lookups by PR/PO/invoice, empty later stages, no invented events), and the invoice exception workbench (open queue excludes tolerated/perfect matches; accept unlocks approve; reject blocks approve/pay; return-to-buyer stays open; audit rows; integer cents).

## Known demo limits (out of scope)

- **Persona auth is client-only.** No JWT, sessions, or server identity. Do not treat this as an authorization boundary.
- SES acceptance is quantity-based (whole units); amount stored is qty × PO unit price in cents, not a free-form T&M amount match.
- Fiscal year 2026 is fixed in queries.
- Exception workbench does not short-pay (no payable-amount rewrite). Accept records the billed cents; reject blocks; return-to-buyer parks. There is no buyer inbox — return is an AP audit disposition only.
- `tolerated_match` invoices are not hard-queued; AP can still approve them from Invoices & Matching without a workbench disposition.

## Local vs Vercel / Turso

```
Laptop (no TURSO_*):  better-sqlite3 → server/data/procurement.db
Laptop (TURSO_* set): fetch POST /v2/pipeline → Turso (same path as Vercel)
Vercel:               Turso required; missing env → HTML/JSON 503 config page
```

The access layer (`server/src/db.js`, `tursoHttp.js`, `sqliteAdapter.js`) exposes `prepare` / `run` / `get` / `all` / `exec` / `transaction` for both backends. Route and service code is async so Turso HTTP is not left half-migrated. Transactions on Turso keep a Hrana **baton** so `BEGIN`/`COMMIT` share one connection.

Vercel entry: [`api/index.js`](../api/index.js) default-exports the Express app. CLI 59.x requires `vercel.json` `functions` patterns under `api/` (a root `app.js` key fails with unmatched-function-pattern). [`vercel.json`](../vercel.json) runs `npm run build` (Vite → `public/`), includes `server/src/schema.sql` on `api/index.js`, and rewrites `/api/*` to that function. `express.static` is ignored on Vercel — static UI must live in `public/`. No scrape/cron job.

Create the Turso DB with `turso db create …`, `turso db show … --url`, and `turso db tokens create …` (database token, not an org JWT). Set `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` on Preview **and** Production, then `npm run seed` from a laptop with those vars. See the README deploy section.
