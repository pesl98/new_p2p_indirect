# ProcureFlow architecture

Non-production **Procure-to-Pay (P2P)** demo: React client, Express API, SQLite (`better-sqlite3`). Money is integer **cents**. Quantities are whole units.

This document describes the control model implemented in code. The header persona switcher is **client-only demo auth** — it is not JWT, sessions, or server-enforced identity. API bodies still carry `approver_id` / `received_by` / `requester_id`; anyone who can reach the API can send any persona id.

## Lifecycle

```
Draft PR → Submit → Sequential approvals → (budget commit on final approve)
        → Convert to PO → Goods receipt (GRN) → Vendor invoice → 3-way match
        → AP approve (relieve commit / book actual) → Mark paid
```

| Stage | What happens |
| --- | --- |
| Requisition | Lines stored as qty × unit price in cents. Numbered `PR-YYYY-NNN`. |
| Approval | Role-based chain; only the current `pending` step can decide. Later steps stay `waiting`. |
| Budget commit | On **final PR approve** only: `budgets.committed_amount += PR total`. Not on PO issue. |
| Purchase order | Copy of approved PR lines. Numbered `PO-YYYY-NNN`. |
| Goods receipt | Increments `po_items.quantity_received`. Over-receipt is blocked unless `allow_over_receipt: true`. Numbered `GRN-YYYY-NNN`. |
| Invoice | Unique per `(supplier_id, invoice_number)`. 3-way match vs PO + cumulative GRN + prior invoiced qty. |
| AP approve | Relieves committed, increases `actual_spent` by invoice total (cents). |

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

## Receiving (GRN) over-receipt

Default: a receipt is **400** if any line’s `quantity_received` would make cumulative received **greater than ordered**.

Exception: body includes `allow_over_receipt: true`. The GRN is stored, PO qty received is incremented (including the overage), and an `OVER_RECEIPT_OVERRIDE` audit log is written.

Partial receipts at or below remaining ordered qty are allowed. Over-receipt is an exception path, not silent.

## 3-way match (PO vs GRN vs invoice)

`server/src/match.js` compares integer cents and integer qty. Match runs **before** `po_items.quantity_invoiced` is incremented so prior cumulative invoiced qty is intact. The claimed invoiced qty is still persisted afterward for audit, even on fail.

Quantity fail if:

- prior invoiced + this claim **>** physically received (`quantity_received` from GRNs), or
- prior invoiced + this claim **>** ordered qty

Price:

- Exact cent equality → perfect (for that line)
- Non-zero difference within 1% of PO unit price (`Math.round(poUnitPriceCents / 100)`) → tolerated warning
- Larger difference → price variance fail

Overall invoice `match_status`: `perfect_match` | `tolerated_match` | `quantity_variance` | `price_variance` | `total_variance`.

## Document numbers

`PR-` / `PO-` / `GRN-` numbers use **MAX of the numeric suffix** for the current year (`server/src/docNumbers.js`), allocated inside the create transaction. This avoids `COUNT(*)+1` collisions after deletes or seed gaps. Columns `pr_number`, `po_number`, and `grn_number` are UNIQUE.

Invoice numbers are unique per supplier: `UNIQUE(supplier_id, invoice_number)`. The same number from two vendors is allowed.

## How to run, seed, and test

Prerequisites: Node 18+, npm 9+.

```bash
# Install (from repo root and both packages)
npm install
cd server && npm install && cd ../client && npm install && cd ..

# Seed SQLite sample data (money in cents)
npm run seed
# or: node server/src/seed.js

# Unit tests (node --test)
npm test

# Dev: API :5000 + Vite :3000
npm run dev

# Production-style: Express serves client/dist if present
node server/src/index.js
```

Tests cover money/match, sequential approvals, budget fail/override, GRN over-receipt reject/override, document-number uniqueness, and invoice-number uniqueness.

## Known demo limits (out of scope)

- **Persona auth is client-only.** No JWT, sessions, or server identity. Do not treat this as an authorization boundary.
- No multi-supplier PO split (one PO, one supplier).
- No service entry sheets / 2-way match for services (receiving is quantity GRN; services use the same path).
- No hosted production deployment.
- Fiscal year 2026 is fixed in queries.
