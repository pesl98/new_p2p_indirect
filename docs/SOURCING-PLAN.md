# Sourcing module (RFQ): architecture and sprint plan

Status: **proposal**, not started. Written against `main` at `cdefb448106f0c5a52d583e9abe69f02facc8802` (Sprint 7b merge, #54). Intended to be committed as `docs/SOURCING-PLAN.md`. Sprint rows go into [SPRINT-LOG.md](SPRINT-LOG.md) when each sprint opens.

Owner: Peter (`pesl98`). The program is routed by Software Architect and built by P2P Developer in the usual flow: one daily sprint, one draft PR.

## 0. Why, and what this is not

ProcureFlow is buy-side indirect procure-to-pay. Peter decided **not** to merge TenderSync (sell-side TED tender alerts) into ProcureFlow. Sourcing is the buy-side counterpart: a buyer asks several suppliers for prices before a PO exists, compares the answers, and awards.

This plan covers an **RFQ (request for quotation) for indirect spend**. A formal tender is a later variant: public procurement, the Aanbestedingswet, TED/TenderNed publication, two-envelope opening, and a standstill period. The schema leaves room for it (`kind`), but v1 does not build it.

The sprint log's design principles still hold:
- Fail-closed controls live in the server and the database.
- Decisions and evidence are append-only.
- The session is the actor.
- Integrations use scoped keys.
- Each customer has its own database.

---

## 1. What exists today (repo inspection)

Checked in the tree at `cdefb448`.

| Area | What is there | Where | Consequence for sourcing |
| --- | --- | --- | --- |
| Vendors | `suppliers`: name, unique `code`, one `email`, one `contact_person`, `rating REAL` (default 5.0), `status` (active/inactive/under_review). There is no contacts table. Upserts use `vendors:write` and `integration_entity_links`. | `schema.sql`, `routes/suppliers.js`, `integrationConnectors.js` | Invitees are existing supplier rows. The contact email is copied onto the invitation, where it can be overridden. A PO needs an `active` supplier, and convert already enforces that. |
| Requisition → PO | `convertRequisitionToPurchaseOrders` needs an `approved` PR. It groups lines by resolved supplier (convert mapping, then `estimated_supplier_id`, then catalog preferred) and creates **one PO per supplier**, issued immediately (no draft). It writes `ISSUED`/`CONVERTED_TO_PO` audit rows and enqueues `po.issued`, all in one transaction. | `purchaseOrdersService.js`, `routes/purchaseOrders.js` | A split award maps onto lines that carry different suppliers. There is **no draft-PO step** and no PO-level approval. |
| Approval engine | It handles **requisitions only**. `approval_requests.requisition_id` is `NOT NULL` with an FK. Chains depend on the PR total (`approvalPolicy.js`): up to €1.000 the department head; above €1.000 the first `procurement` user is added; above €10.000 finance is added, or admin if there is no finance user. Budget is committed at **final PR approval** (`approvalsService.js`). Delegations are resolved at decide time. | `approvalPolicy.js`, `approvalsService.js` | To reuse approvals and the budget commit, an award must go through a **requisition** (§5.4). |
| PR creation | The logic sits **inside the route handler** (`routes/requisitions.js` POST `/`), not in a service. `estimated_supplier_id` silently defaults to **1**. | `routes/requisitions.js` | Extract a `createRequisition` service for award PRs. An RFQ created from a PR must ignore the default supplier 1. |
| Audit | `audit_logs` is append-only through triggers and stores names only. `compliance_audit_events` is a SHA-256 hash chain written by `appendComplianceEvent`, which retries once on `prev_hash mismatch`. The compliance reports recompute the expected chain with `buildApprovalSteps`. | `complianceAudit.js`, `complianceReports.js` | Sourcing writes both: `audit_logs` for the document trail, and the compliance ledger for decisions. The approval-policy report has to learn award-PR SoD, or it will raise false `wrong_approver` findings. |
| Outbox | `webhook_outbox` is written in the business transaction. Event names are a frozen list, `WEBHOOK_EVENTS`. Deliveries are signed with HMAC. On Vercel, delivery is the inline kick plus the admin **Deliver pending** button; there is no cron. | `webhookOutbox.js` | Add the `sourcing_*` events. The bid webhook carries **no prices**. |
| Files (7b) | `invoice_proposals` holds metadata and `invoice_proposal_files(proposal_id, pdf_bytes BLOB)` holds the bytes. Only the download route reads the blob. The cap is 4 MiB, with a `%PDF-` magic check and `express.raw` (`invoicePdf.js`). `maxDuration: 60` applies only to the OCR upload function, through a `vercel.json` rewrite on `content-type: application/pdf`. | `invoicePdf.js`, `invoiceProposalsService.js`, `vercel.json` | Copy the pattern: `sourcing_files` for metadata, `sourcing_file_blobs` for bytes. No OCR, so the default duration is fine. |
| API keys | `pfk_` plus 32 bytes, stored as SHA-256. Scopes come from the frozen `API_KEY_SCOPES`. Each key has a per-minute rate window (`api_key_rate_windows`) and `Idempotency-Key` replay. Machine routes are listed one by one in `isIntegrationMachineRoute`. | `apiKeys.js`, `requestActor.js` | Add `sourcing:read` and `sourcing:write`. The key handling (random → SHA-256 → constant-time compare) is the template for magic links. |
| Session | `pf_session` is an HMAC-signed cookie, `HttpOnly; SameSite=Lax`, plus `Secure` on Vercel. `requireApiSession` fails closed except for `/api/health`, `/api/auth/*`, and the machine routes. `requireRole(...)` exists. | `auth.js`, `requestActor.js` | The portal needs a **third explicit exception** (`/api/portal/*`), authenticated by an invitation token. |
| CORS / headers | The global `cors({ origin: true, credentials: true })` **reflects any Origin and allows credentials**. There are no security headers (no helmet, no CSP). | `app.js` | The portal gets its own strict policy (§3.6). Global CORS gets tightened in 8d. |
| Mail | **No mail sender exists.** Sprint 5 says so explicitly, and no mail dependencies are installed. | — | Build a provider abstraction with a copy-link fallback (§3.5). |
| Cron | `vercel.json` has no `crons`, and there is no `CRON_SECRET`. | `vercel.json`, PROGRAM-REPORT §7 | Deadlines must close **without** a cron: lazy close plus SQL predicates (§6.2). |
| Doc numbers | `nextDocumentNumber(db, kind)` takes MAX+1 inside the write transaction. | `docNumbers.js` | Add kind `rfq`, giving `RFQ-YYYY-NNN`. |
| Money | Integer cents throughout: `lineTotalCents`, `asCents`, `requireIntegerCents`, and `formatMoney`/`shared/currency.js` (nl-NL, EUR). The client parses `1.295,50`. | `money.js`, `client/src/money.js` | Bids are integer cents in the deployment currency. No FX. |
| i18n | The Dutch catalog is split into parts (`client/src/i18n/parts/*.js`), used through `t()`/`useI18n()`. A test fails when a `t()` key is missing. | `client/src/i18n*` | Add `parts/sourcing.js` (buyer) and `parts/portal.js` (supplier). |
| Client routing | There is **no URL router**. `App.jsx` switches on `activeTab` state, and `Sidebar.jsx` builds `navItems` with role filters. `vercel.json` rewrites only `/api/*`, so there is no SPA fallback. | `App.jsx`, `Sidebar.jsx`, `vercel.json` | The portal must be a **separate static entry** (`portal.html`, Vite multi-page), not a tab in the buyer app. |
| DB access | `tursoHttp.js` keeps **one cached client per process** (`getDb()`), with a single `_baton` and a single `_inTransaction` counter shared by concurrent requests. Each statement is one HTTP round-trip. | `db.js`, `tursoHttp.js` | This is the known **shared-connection transaction isolation** follow-up. It is a hard prerequisite for the portal (§6.4). |
| Schema init | `applySchema` runs `schema.sql` (`CREATE … IF NOT EXISTS`) plus hand-written migrations on cold start. Some **older** migrations rebuild tables (`DROP TABLE … RENAME`). Sprint 7a banned that pattern for new work, because a Turso batch keeps running after a failed statement. | `db.js` | All sourcing DDL is new tables, indexes, and triggers with `IF NOT EXISTS`. Existing tables are not touched. |
| Tests | `node --test` over `server/src/*.test.js` plus 3 client tests. `createTestDatabase()` gives an in-memory better-sqlite3 database behind the same adapter API. `withCookie(userId)` signs a session. `createApp({ db })` is used for HTTP tests. CI runs `npm ci && npm test` on Node 22. | `testDb.js`, `testSession.js`, `.github/workflows/test.yml` | Use the same harness. Portal tests send `Authorization: Bearer pfi_…`. |
| Sprint log | Each sprint has a register row plus "Done when" and "Decisions" sections. `done` means the PR is open and waiting for Architect and Peter review. | `docs/SPRINT-LOG.md` | **The 7b row still says "in progress" with no merge SHA, although `main` HEAD `cdefb44` is the 7b squash-merge.** Fix this in 8a. |
| Tiers | **No plan or tier mechanism exists** (no Gratis/Premium/Executive anywhere). | — | Use a per-deployment flag, `SOURCING_ENABLED` (§9). |

### 1.1 Repo issues that block or complicate this work

1. **Shared-connection transaction isolation blocks the portal.** `getDb()` returns one `TursoHttpClient` per warm instance, and its `_baton`/`_inTransaction` state is shared. When one instance serves concurrent requests (Vercel Fluid compute), request B's statements can run inside A's open transaction, or A's `COMMIT`/`ROLLBACK` can end B's work. Supplier bids cluster just before a deadline, so this must be fixed **before 8b**.
   - Fix: route statements issued inside `transaction()` to that transaction's own baton using `AsyncLocalStorage`, and keep all other statements stateless. Call sites do not change.
   - Test: two interleaved transactions on one client, using a fake fetch.
2. **Preview must not open the production Turso database.** On `new-p2p-indirect`, `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are set for Production only. A Preview deploy of main with no Turso variables does not open production and does not create a local SQLite file: `createApp` sees `VERCEL` / `VERCEL_ENV` and a missing pair, and returns **503** `TursoConfigError` before `getDb()`. The Vercel entry is `api/index.js`, which only calls `createApp()`. The 7b previews `f94a732` and `2496b85` took that path, so they most likely never touched production. `SESSION_SECRET` may still be the same in both environments. `vercel:customer` does copy the production URL and token onto Preview for a new customer project; that copy must not become the preview connection. Set `SOURCING_ENABLED=1` and `PORTAL_TOKEN_SECRET` on **Production only** (§3.1) until a customer runs a live RFQ.
3. **The approval engine is requisition-only.** There is no PO approval and no draft PO; convert creates `issued` POs directly. An award therefore travels as an **award requisition** (§5.4). Whether POs should start as drafts is an open decision (§10).
4. **The PO routes have weak gates.** `POST /api/purchase-orders/from-requisition` has no `requireRole`. `PATCH /api/purchase-orders/:id/status` accepts any status with no checks. Convert defaults `created_by` to 3 and the ship-to to a hardcoded Austin, TX address. Award POs go through this path, so 8c adds a role gate for award PRs and lists the rest as follow-ups.
5. **`FISCAL_YEAR = 2026` is hardcoded** in approvals and change orders. An award PR approved in 2027 would fail the budget lookup. This is an existing limit, recorded here.
6. **The compliance approval-policy report recomputes chains with `buildApprovalSteps`.** The SoD exclusion for award PRs has to be applied there too, or the report will raise false `wrong_approver` findings.
7. **Global CORS reflects any origin with credentials, and there are no security headers.** `SameSite=Lax` limits the risk in the buyer app today. The portal gets its own headers, and 8d tightens global CORS to `APP_BASE_URL`.
8. **There is no mail and no cron.** The plan works around both (copy link, lazy close), so they do not block v1.
9. **The 7b row in SPRINT-LOG is stale** (see the table above).

---

## 2. Scope: v1 vs later

### 2.1 v1 (Sprints 8a–8d)

**Creating an event (RFQ)**
- **From scratch:** title, description or specification (free text), one of the 7 categories, a department or cost centre (used for budget and approvals), and lines.
- **From an approved requisition:** the PR lines are copied (description, category, quantity, line type, service basis, catalog item) and keep their `requisition_item_id`.
  - PR unit prices become the internal **target price**, which suppliers never see.
  - The source PR is **locked** against conversion while the event is open (§5.4).
- **Spec-only RFQ:** one generated lump-sum line ("Totaalprijs volgens specificatie", `service_basis = lump_sum`, quantity 1), so the award still maps onto a PO line.
- **Other event fields:**
  - buyer attachments (PDF, 7b limits);
  - a deadline, entered in Europe/Amsterdam time in the UI and stored as UTC ISO;
  - invited suppliers (existing `suppliers` rows, with a contact email per invitation);
  - optional Q&A with its own question deadline.
- **Scoring weights** for price, lead time, and quality are integers that sum to 100. They are **frozen at publish**.
- **Limits:** at most 50 lines, 20 invitations, and 10 buyer files per event. These caps come from Turso transaction sizing (§6.1).

**Supplier response (portal, magic link)**
- **Per line:** unit price in cents (excl. VAT), lead time in days, and an optional comment. A line can be marked "niet aangeboden" (not offered).
- **Per bid:** a validity date ("geldig tot"), a default lead time, a note, and PDF attachments (up to 10, 4 MiB each).
- **Revisions:** the supplier can edit and resubmit until the deadline. Each submit is an append-only **revision** with a content-hash receipt.
- **Withdrawing and declining:** a bid can be withdrawn before the deadline. A supplier can also decline to take part.
- **After the deadline**, nothing is accepted.

**Comparison**
- A side-by-side matrix of lines × suppliers showing unit price, line total, and lead time. The per-line lowest price and the lowest complete total are highlighted.
- A simple weighted score: price, lead time, and quality (evaluators score 0–10). Incomplete bids are flagged and excluded from "lowest total".
- Prices become visible only after the deadline. Sealing is enforced server-side.

**Award**
- **Full award:** all lines go to one supplier.
- **Split award:** whole lines go to different suppliers. Splitting the quantity of one line is not in v1.
- **A reason is mandatory** when the award is not the lowest:
  - for a full award, when the winner's total is above the lowest complete total;
  - for a split award, when any line does not go to its lowest bid;
  - and whenever an accepted bid's validity has expired.
- The award creates an **award requisition**. That requisition runs through the **existing approval chain** with SoD, then the **existing convert** turns it into one or more POs.

### 2.2 Later (not v1)

- A formal **tender** (`kind = 'tender'`): two-envelope opening, minimum-quote rules, a standstill period, published award notices, TED/TenderNed (see the open decisions).
- Supplier accounts and a self-registration portal across events. Onboarding of invitees who are not yet in master data.
- Awards that split one line's quantity across suppliers. Alternative offers and variants. Volume price breaks.
- Reverse auctions. Multi-round RFQs (in v1, "Opnieuw uitvragen" clones the event into a new draft).
- Sealed bids encrypted at rest, with the key released at the deadline. In v1, sealing is enforced by the application.
- Bids in a foreign currency (ProcureFlow has no FX).
- Creating a contract (CNT-) from an award instead of a PO. Framework or catalog awards that update `catalog_items` prices.
- English portal copy (the catalog is ready, but it does not ship in v1).
- Scheduled reminders ("sluit over 24 uur") once a cron exists.

## 3. Supplier portal security (no supplier accounts in v1)

### 3.1 Magic link per invitation

**Token format:** `pfi_<rand>.<tag>`
- `rand` is 32 random bytes in base64url.
- `tag` is the first 16 bytes of `HMAC-SHA256(PORTAL_TOKEN_SECRET, "pfi:v1:" + rand)`, in base64url.
- The database stores **only** `token_hash = SHA-256(full token)` (hex, `UNIQUE`) and `token_prefix` (the first 12 characters, for display). This is the same approach as `api_keys`.

**Verification order:**
1. Check the syntax.
2. Check the HMAC in constant time. Forged or guessed tokens are rejected here, **without a database write**.
3. Look up the SHA-256 hash.
4. Check `revoked_at IS NULL`, `expires_at > now`, and that the event is not `draft`.
5. Apply the rate window.

Unknown, revoked, and expired tokens all get the same response: `401 portal_link_invalid`, with the message "Deze link is ongeldig of verlopen. Neem contact op met de inkoper." Only the audit row records the actual reason.

**Rules:**

- **Signed.**
  - The HMAC binds each token to this deployment's `PORTAL_TOKEN_SECRET`. This is a new env var, separate from `SESSION_SECRET`.
  - It is required when `SOURCING_ENABLED=1`. Until the databases are split, it is set on Production only.
  - If it is missing, the portal returns `503 portal_not_configured`.
  - Rotating the secret invalidates all open links. The runbook says to regenerate them afterwards.
- **Scoped to one event.** The token resolves to one invitation, which means one `(event_id, supplier_id)` pair. The server never reads an event or supplier id from the URL or the body.
- **Expiring.** `expires_at` defaults to the deadline plus 30 days, so the supplier can still see their read-only receipt and the outcome. When the deadline is extended, the expiry moves with it.
- **Revocable.**
  - "Link intrekken" sets `revoked_at`.
  - "Nieuwe link" replaces `token_hash` in place (`token_version + 1`), so the old link stops working immediately.
  - Both actions are audited.
- **Shown once.**
  - The plaintext link is returned once, when the invitation is created or rotated, the same way `pfk_` keys are.
  - "Link kopiëren" exists only in that response. After that, the only option is "Nieuwe link genereren".
- **Delivered in the URL fragment.**
  - The link is `https://<APP_BASE_URL>/portal.html#t=<token>`. A fragment never reaches the server, never shows up in Vercel access logs, and never leaks through `Referer`.
  - The portal SPA reads the token, removes it from the address bar (`history.replaceState`), and keeps it in `sessionStorage` for that tab.
  - It then sends `Authorization: Bearer pfi_…` on every `/api/portal/*` call.
- **Rate-limited.** Counts live in database windows (`sourcing_portal_rate_windows`, same shape as `api_key_rate_windows`), so they hold across serverless instances. Going over a limit returns `429` with `Retry-After`.
  - Per invitation: 60 requests/min, 10 submits/min, and 10 uploads/min.
  - Per client IP (SHA-256 of the first `x-forwarded-for` hop plus the secret): 20 failed lookups per 10 minutes, counted only after the HMAC has passed.
- **Audited.** These actions append to `compliance_audit_events`: invitation created, link rotated, link revoked, first opened, declined, bid submitted, bid withdrawn, late attempt rejected, and file uploaded.
  - The actor fields are `actor_role = 'supplier'`, `actor_user_id = null`, and `actor_name = "<supplier code> (<contact email>)"`. `details` holds the `invitation_id`.
  - Read-only views only update `last_seen_at`, so a supplier refreshing the page does not flood the hash chain.

### 3.2 Sealed bids (enforced server-side)

- **One visibility rule.** A single function, `bidPricesVisible(event, now)`, decides. It returns true only when `now >= deadline_at` and the event was not cancelled before its deadline. If an event is cancelled before the deadline, its bids stay sealed forever.
- **One read model.**
  - `server/src/sourcingBidReadModel.js` is the only module allowed to `SELECT` from `sourcing_bid_lines`, the price columns of `sourcing_bid_revisions`, or bid-owned `sourcing_files`/`sourcing_file_blobs`.
  - The portal module is the exception, and it reads only the caller's own bid. The schema and seed files are also exempt.
  - A unit test scans `server/src/**/*.js` and fails when any other file mentions these tables. It works like the existing i18n catalog test.
- **Before the deadline, the buyer sees status only:**
  - each invitation's status: uitgenodigd, geopend, ingediend, afgezien, or ingetrokken;
  - `submitted_at`;
  - the number of revisions;
  - the number of attachments.

  The buyer sees **no** prices, totals, lead times, or file downloads. Integration keys with `sourcing:read` follow the same rule.
- **Bid opening is recorded.** The first time a buyer views prices after the deadline, the server appends `SOURCING_BIDS_OPENED`, once per user per event.
- **No side channels.** Exports, the document trail, analytics, and the compliance reports must not join bid prices while an event is sealed. The scan test enforces this.
- **Webhooks carry no prices.** The `sourcing_bid.submitted` payload contains only the event number, the supplier code or external id, the revision, `submitted_at`, and the content hash.
- **Known limit** (stated in the docs as well): sealing is enforced by the application. Anyone with the Turso token can read the rows directly. A preview build can read production only when that environment actually has the production URL and token. This project's Preview did not. Encryption at rest is in the "later" list.

### 3.3 Editing until the deadline, nothing after

- **The deadline check runs inside the write.** A submit is one transaction with a guarded insert:

  ```sql
  INSERT INTO sourcing_bid_revisions (...)
  SELECT ... FROM sourcing_events e
  WHERE e.id = ? AND e.status = 'published' AND e.deadline_at > ?   -- ? = server now (UTC ISO)
  ```

  If no row is inserted, the server returns `409 deadline_passed` and writes nothing else. The supplier sees "De inschrijftermijn is gesloten om {tijd}". The late attempt is audited as `SOURCING_BID_REJECTED_LATE`.
- **The server clock decides.** There is no grace period. The portal shows `server_now` and a countdown, and asks suppliers to submit well before the deadline.
- **Revisions are append-only.** Triggers block UPDATE and DELETE. `sourcing_bids.current_revision` points to the latest revision.
- **Withdrawing.** A **withdraw** sets the bid to `withdrawn`. The comparison ignores it, but its revisions stay as evidence.
- **Safe retries.** The portal sends a client `submission_id` (a UUID), and `UNIQUE(bid_id, submission_id)` makes a retry return the first receipt instead of creating a new revision. This is the same idea as `Idempotency-Key`.
- **Deadline changes.** The buyer can **extend** the deadline (later only, never earlier) while the event is `published`. Extensions are audited and the invitees are notified. Shortening is rejected.

### 3.4 Data isolation per supplier

- **Everything is keyed by the invitation.** Every portal query uses the `invitation_id` resolved from the token. Any file, question, or bid id in a URL must belong to that invitation, or to a file the buyer published on the event.
- **Foreign ids return 404**, not 403, so a supplier cannot probe for ids.
- **Suppliers never see each other.** They cannot see other invitees, how many there are, or their bids. When a Q&A answer is published "to all", the question is shown without the asker.
- **Internal fields are never sent.** Target prices (`target_unit_price_cents`) and internal notes never reach the portal. The portal uses an explicit allow-list serializer, and tests check it.
- **The award result is minimal.** The portal (8d) shows only "gegund aan u" or "niet gegund", with no competitors or prices.

### 3.5 Email delivery

§10's decisions override this section: delivery is copy-link plus optional SMTP.

**Today:** no mail exists. There is no code, no dependency, and no env var in the onboarding CLIs.

**Proposal:** a provider abstraction, built in 8d. In 8b, links are delivered by copy-link only.

```
server/src/mail/index.js            sendMail({ to, subject, text, html, tag }) → { status: 'sent'|'skipped'|'failed', providerId?, error? }
server/src/mail/providers/none.js   default: 'skipped' → UI shows the copy-link panel
server/src/mail/providers/smtp.js   MAIL_SMTP_URL (customer relay, e.g. Microsoft 365 / own domain)
server/src/mail/providers/http.js   one HTTP API provider via fetch (no SDK). Choice is open (Postmark / Brevo / Mailgun EU / Resend)
```

**Configuration**
- Env vars: `MAIL_PROVIDER` (`none` | `smtp` | `<http>`), `MAIL_FROM`, `MAIL_REPLY_TO`, and the provider credentials.
- An invalid configuration yields `skipped` plus an admin warning. It does not stop the app from booting, because mail is not a control.

**Plaintext links are never stored**
- Invite and rotate send the mail **after commit**, using the token held in memory.
- The result is recorded in `sourcing_invitations.delivery_status` (`sent`, `failed`, `skipped`, or `copied`).
- On `failed` or `skipped`, the same response shows the buyer the copy-link panel.
- Invitation mail does **not** use an outbox, because an outbox would have to store the plaintext link.

**v1 mails**
- invitation
- deadline extended
- event cancelled
- Q&A answer published
- bid receipt (with the content hash)
- award notice (won or not won, no prices)

The copy is Dutch, plain text with simple HTML, and has no tracking pixels.

**Per-customer setup**
- DNS (SPF and DKIM for `MAIL_FROM`) becomes a per-customer onboarding step.
- With `none`, the product works without any mail setup, which keeps per-customer deploys easy.

### 3.6 CSRF, CORS, and headers for an unauthenticated portal route

- **CSRF.**
  - The portal authenticates with a **bearer header, not a cookie**. A cross-site form cannot set that header, so classic CSRF does not apply.
  - The portal router **ignores `pf_session`**: it never reads `req.user`. A buyer who is signed in on the same browser is therefore never treated as a supplier. This mirrors the existing machine-route rule in `requestActor.js`.
- **CORS.**
  - `/api/portal/*` is mounted **before** the global `cors({ origin: true, credentials: true })` and has its own policy.
  - It sends no CORS headers, so only same-origin requests work.
  - `OPTIONS` returns 204 with no allow-origin header.
- **Headers on `/api/portal/*`:**
  - `Cache-Control: no-store`
  - `Referrer-Policy: no-referrer`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `X-Robots-Tag: noindex`
- **Headers on `portal.html`** (set through `vercel.json` `headers`):
  - a strict CSP: `default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
  - `Referrer-Policy: no-referrer` and `noindex`;
  - no third-party scripts or fonts.

  These limit XSS, which is the main threat to a token kept in `sessionStorage`.
- **Downloads.** Supplier files are served with `Content-Disposition: attachment`, `Content-Type: application/pdf` only, and `nosniff`.
- **Body limits.**
  - JSON keeps Express's default 100 kB limit, which fits 50 lines.
  - PDFs use `express.raw({ type: 'application/pdf', limit: 4 MiB })` from `invoicePdf.js`.
- **`requireApiSession`.**
  - Add `isPortalRoute(req)` (the `/api/portal/` prefix) as an explicit, tested exception.
  - The portal router's own `requirePortalInvitation` middleware fails closed on every route.
  - A test hits every `/api/portal/*` route without a token and expects 401.
- **Global CORS** (8d, separate commit). Restrict it to `APP_BASE_URL`, plus `localhost:3000` in dev. This is a repo-wide improvement; the portal just makes the need more visible.

---

## 4. Data model

**Ground rules**
- **Only new tables.** They are appended at the **end** of `server/src/schema.sql` using `CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS`.
- **Existing tables are never changed.** No `ALTER`, `DROP`, or rebuild, and no DML in the schema file.
- **Money** is `INTEGER` cents in the deployment currency.
- **Timestamps** are UTC ISO-8601 `TEXT` in one fixed format (milliseconds plus `Z`), so string comparison is safe.
- **Quantities** are whole units, as on `requisition_items`. Measured utility and bulk lines are out of scope.

```sql
-- Sourcing (RFQ). One database per customer, so no org_id.
-- Bid prices are sealed until deadline_at; only sourcingBidReadModel.js and
-- the portal (own bid) may read sourcing_bid_lines / sourcing_bid_revisions.
CREATE TABLE IF NOT EXISTS sourcing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_number TEXT UNIQUE NOT NULL,                       -- RFQ-YYYY-NNN (docNumbers kind 'rfq')
  kind TEXT NOT NULL DEFAULT 'rfq' CHECK (kind IN ('rfq', 'tender')),   -- 'tender' reserved; service rejects it in v1
  title TEXT NOT NULL,
  description TEXT,                                        -- free-text specification
  category TEXT CHECK (category IS NULL OR category IN ('IT Hardware', 'Software & Cloud', 'Office Supplies', 'Facilities & MRO', 'Consulting & Professional Services', 'Marketing & Events', 'Travel & Subscriptions')),
  department_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  source_requisition_id INTEGER,                           -- approved PR this RFQ was raised from
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed', 'evaluated', 'awarded', 'cancelled')),
  currency TEXT NOT NULL,                                  -- deployment CURRENCY at creation (EUR)
  deadline_at TEXT,                                        -- required to publish
  qa_enabled INTEGER NOT NULL DEFAULT 0 CHECK (qa_enabled IN (0, 1)),
  qa_deadline_at TEXT,
  weight_price INTEGER NOT NULL DEFAULT 70 CHECK (weight_price BETWEEN 0 AND 100),
  weight_lead_time INTEGER NOT NULL DEFAULT 15 CHECK (weight_lead_time BETWEEN 0 AND 100),
  weight_quality INTEGER NOT NULL DEFAULT 15 CHECK (weight_quality BETWEEN 0 AND 100),
  target_total_cents INTEGER,                              -- internal estimate, never shown to suppliers
  published_at TEXT, closed_at TEXT, evaluated_at TEXT, awarded_at TEXT,
  cancelled_at TEXT, cancel_reason TEXT,
  cancelled_before_deadline INTEGER CHECK (cancelled_before_deadline IS NULL OR cancelled_before_deadline IN (0, 1)),
  row_version INTEGER NOT NULL DEFAULT 0,                  -- optimistic concurrency on draft edits
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (weight_price + weight_lead_time + weight_quality = 100),
  CHECK (status = 'draft' OR status = 'cancelled' OR deadline_at IS NOT NULL),
  CHECK (status != 'cancelled' OR (cancel_reason IS NOT NULL AND length(trim(cancel_reason)) > 0)),
  FOREIGN KEY (department_id) REFERENCES departments(id),
  FOREIGN KEY (owner_user_id) REFERENCES users(id),
  FOREIGN KEY (source_requisition_id) REFERENCES purchase_requisitions(id)
);
CREATE INDEX IF NOT EXISTS sourcing_events_status_deadline ON sourcing_events (status, deadline_at);
CREATE INDEX IF NOT EXISTS sourcing_events_owner ON sourcing_events (owner_user_id, status);
-- At most one live RFQ per source PR.
CREATE UNIQUE INDEX IF NOT EXISTS sourcing_events_open_source_pr
  ON sourcing_events (source_requisition_id)
  WHERE source_requisition_id IS NOT NULL AND status != 'cancelled';

CREATE TABLE IF NOT EXISTS sourcing_event_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  line_no INTEGER NOT NULL,
  requisition_item_id INTEGER,
  catalog_item_id INTEGER,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_of_measure TEXT NOT NULL DEFAULT 'each',
  line_type TEXT NOT NULL DEFAULT 'goods' CHECK (line_type IN ('goods', 'service')),
  service_basis TEXT CHECK (service_basis IS NULL OR service_basis IN ('lump_sum', 'hours', 'days')),
  target_unit_price_cents INTEGER CHECK (target_unit_price_cents IS NULL OR target_unit_price_cents >= 0),  -- buyer-only
  notes TEXT,
  UNIQUE (event_id, line_no),
  FOREIGN KEY (event_id) REFERENCES sourcing_events(id),
  FOREIGN KEY (requisition_item_id) REFERENCES requisition_items(id),
  FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id)
);

CREATE TABLE IF NOT EXISTS sourcing_invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  contact_name TEXT,
  contact_email TEXT NOT NULL,
  token_hash TEXT UNIQUE,                                  -- SHA-256 hex; NULL while the event is draft
  token_prefix TEXT,
  token_version INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  revoked_at TEXT, revoked_by_user_id INTEGER, revoke_reason TEXT,
  first_opened_at TEXT, last_seen_at TEXT,
  declined_at TEXT, decline_reason TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'failed', 'skipped', 'copied')),
  invited_by_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (event_id, supplier_id),
  FOREIGN KEY (event_id) REFERENCES sourcing_events(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (invited_by_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS sourcing_invitations_event ON sourcing_invitations (event_id);

CREATE TABLE IF NOT EXISTS sourcing_portal_rate_windows (
  scope_key TEXT NOT NULL,                                 -- 'inv:<id>', 'inv:<id>:submit', 'ip:<hash>'
  window_start INTEGER NOT NULL,                           -- epoch minute
  request_count INTEGER NOT NULL,
  PRIMARY KEY (scope_key, window_start)
);

-- One bid per invitation. Prices live in append-only revisions.
CREATE TABLE IF NOT EXISTS sourcing_bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  invitation_id INTEGER NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'withdrawn')),
  current_revision INTEGER NOT NULL DEFAULT 1,
  first_submitted_at TEXT NOT NULL,
  last_submitted_at TEXT NOT NULL,
  withdrawn_at TEXT,
  FOREIGN KEY (event_id) REFERENCES sourcing_events(id),
  FOREIGN KEY (invitation_id) REFERENCES sourcing_invitations(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);
CREATE INDEX IF NOT EXISTS sourcing_bids_event ON sourcing_bids (event_id, status);

CREATE TABLE IF NOT EXISTS sourcing_bid_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bid_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  submission_id TEXT NOT NULL,                             -- client UUID, replay-safe
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),   -- sum of quoted lines
  quoted_line_count INTEGER NOT NULL,
  validity_until TEXT,                                     -- YYYY-MM-DD
  default_lead_time_days INTEGER CHECK (default_lead_time_days IS NULL OR default_lead_time_days BETWEEN 0 AND 730),
  supplier_note TEXT,
  content_sha256 TEXT NOT NULL,                            -- receipt hash shown to the supplier
  submitted_at TEXT NOT NULL,
  UNIQUE (bid_id, revision),
  UNIQUE (bid_id, submission_id),
  FOREIGN KEY (bid_id) REFERENCES sourcing_bids(id)
);

CREATE TABLE IF NOT EXISTS sourcing_bid_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bid_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  event_line_id INTEGER NOT NULL,
  quoted INTEGER NOT NULL DEFAULT 1 CHECK (quoted IN (0, 1)),   -- 0 = "niet aangeboden"
  unit_price_cents INTEGER CHECK (unit_price_cents IS NULL OR unit_price_cents > 0),
  line_total_cents INTEGER CHECK (line_total_cents IS NULL OR line_total_cents >= 0),
  lead_time_days INTEGER CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 730),
  comment TEXT,
  CHECK (quoted = 0 OR (unit_price_cents IS NOT NULL AND line_total_cents IS NOT NULL)),
  UNIQUE (bid_id, revision, event_line_id),
  FOREIGN KEY (bid_id) REFERENCES sourcing_bids(id),
  FOREIGN KEY (event_line_id) REFERENCES sourcing_event_lines(id)
);

CREATE TABLE IF NOT EXISTS sourcing_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  invitation_id INTEGER,                                   -- NULL = buyer-initiated clarification
  question TEXT NOT NULL,
  asked_at TEXT NOT NULL,
  answer TEXT,
  answered_by_user_id INTEGER,
  answered_at TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'all')),
  FOREIGN KEY (event_id) REFERENCES sourcing_events(id),
  FOREIGN KEY (invitation_id) REFERENCES sourcing_invitations(id),
  FOREIGN KEY (answered_by_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS sourcing_questions_event ON sourcing_questions (event_id, visibility);

CREATE TABLE IF NOT EXISTS sourcing_evaluators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  coi_status TEXT NOT NULL DEFAULT 'pending' CHECK (coi_status IN ('pending', 'none_declared', 'conflict_declared')),
  coi_declared_at TEXT,
  coi_note TEXT,
  added_by_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (event_id, user_id),
  FOREIGN KEY (event_id) REFERENCES sourcing_events(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sourcing_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  bid_id INTEGER NOT NULL,
  evaluator_user_id INTEGER NOT NULL,
  quality_score INTEGER NOT NULL CHECK (quality_score BETWEEN 0 AND 10),
  comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (event_id, bid_id, evaluator_user_id),
  FOREIGN KEY (bid_id) REFERENCES sourcing_bids(id),
  FOREIGN KEY (evaluator_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sourcing_awards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  award_type TEXT NOT NULL CHECK (award_type IN ('full', 'split')),
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'approved', 'rejected')),
  award_requisition_id INTEGER,                            -- PR that carries the award through approvals
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  lowest_total_cents INTEGER,                              -- snapshot: lowest comparable alternative
  is_lowest INTEGER NOT NULL CHECK (is_lowest IN (0, 1)),
  has_expired_validity INTEGER NOT NULL DEFAULT 0 CHECK (has_expired_validity IN (0, 1)),
  reason TEXT,
  comparison_snapshot_json TEXT NOT NULL,                  -- frozen matrix + scores at award time
  proposed_by_user_id INTEGER NOT NULL,
  proposed_at TEXT NOT NULL,
  decided_at TEXT,
  CHECK ((is_lowest = 1 AND has_expired_validity = 0) OR (reason IS NOT NULL AND length(trim(reason)) >= 10)),
  FOREIGN KEY (event_id) REFERENCES sourcing_events(id),
  FOREIGN KEY (award_requisition_id) REFERENCES purchase_requisitions(id),
  FOREIGN KEY (proposed_by_user_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sourcing_awards_one_open
  ON sourcing_awards (event_id) WHERE status IN ('pending_approval', 'approved');
CREATE INDEX IF NOT EXISTS sourcing_awards_requisition ON sourcing_awards (award_requisition_id);

CREATE TABLE IF NOT EXISTS sourcing_award_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  award_id INTEGER NOT NULL,
  event_line_id INTEGER NOT NULL,
  bid_id INTEGER NOT NULL,
  bid_revision INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
  line_total_cents INTEGER NOT NULL,
  is_line_lowest INTEGER NOT NULL CHECK (is_line_lowest IN (0, 1)),
  UNIQUE (award_id, event_line_id),
  FOREIGN KEY (award_id) REFERENCES sourcing_awards(id),
  FOREIGN KEY (event_line_id) REFERENCES sourcing_event_lines(id),
  FOREIGN KEY (bid_id) REFERENCES sourcing_bids(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

-- Files: metadata here, bytes in sourcing_file_blobs (Sprint 7b pattern).
CREATE TABLE IF NOT EXISTS sourcing_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('event', 'bid')),
  invitation_id INTEGER,                                   -- set for owner_kind = 'bid'
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type = 'application/pdf'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL,
  uploaded_by_user_id INTEGER,
  removed_at TEXT,                                         -- soft remove before deadline; bytes kept as evidence
  created_at TEXT NOT NULL,
  CHECK ((owner_kind = 'event' AND invitation_id IS NULL AND uploaded_by_user_id IS NOT NULL)
      OR (owner_kind = 'bid' AND invitation_id IS NOT NULL)),
  FOREIGN KEY (event_id) REFERENCES sourcing_events(id),
  FOREIGN KEY (invitation_id) REFERENCES sourcing_invitations(id)
);
CREATE INDEX IF NOT EXISTS sourcing_files_event ON sourcing_files (event_id, owner_kind);
CREATE INDEX IF NOT EXISTS sourcing_files_invitation ON sourcing_files (invitation_id);

CREATE TABLE IF NOT EXISTS sourcing_file_blobs (
  file_id INTEGER PRIMARY KEY,
  bytes BLOB NOT NULL,
  FOREIGN KEY (file_id) REFERENCES sourcing_files(id)
);

-- Append-only evidence (same pattern as audit_logs).
CREATE TRIGGER IF NOT EXISTS sourcing_bid_revisions_no_update BEFORE UPDATE ON sourcing_bid_revisions
BEGIN SELECT RAISE(ABORT, 'sourcing_bid_revisions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS sourcing_bid_revisions_no_delete BEFORE DELETE ON sourcing_bid_revisions
BEGIN SELECT RAISE(ABORT, 'sourcing_bid_revisions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS sourcing_bid_lines_no_update BEFORE UPDATE ON sourcing_bid_lines
BEGIN SELECT RAISE(ABORT, 'sourcing_bid_lines is append-only'); END;
CREATE TRIGGER IF NOT EXISTS sourcing_bid_lines_no_delete BEFORE DELETE ON sourcing_bid_lines
BEGIN SELECT RAISE(ABORT, 'sourcing_bid_lines is append-only'); END;
CREATE TRIGGER IF NOT EXISTS sourcing_award_lines_no_update BEFORE UPDATE ON sourcing_award_lines
BEGIN SELECT RAISE(ABORT, 'sourcing_award_lines is append-only'); END;
CREATE TRIGGER IF NOT EXISTS sourcing_award_lines_no_delete BEFORE DELETE ON sourcing_award_lines
BEGIN SELECT RAISE(ABORT, 'sourcing_award_lines is append-only'); END;
CREATE TRIGGER IF NOT EXISTS sourcing_file_blobs_no_update BEFORE UPDATE ON sourcing_file_blobs
BEGIN SELECT RAISE(ABORT, 'sourcing_file_blobs is append-only'); END;
-- Belt and braces for sealing: no bid revision at or after the deadline, even if a code path forgets.
CREATE TRIGGER IF NOT EXISTS sourcing_bid_revisions_deadline BEFORE INSERT ON sourcing_bid_revisions
WHEN (SELECT e.status != 'published' OR e.deadline_at <= NEW.submitted_at
      FROM sourcing_bids b JOIN sourcing_events e ON e.id = b.event_id WHERE b.id = NEW.bid_id)
BEGIN SELECT RAISE(ABORT, 'sourcing bid after deadline'); END;
```

Notes:
- **Checked on 2026-10-08.** The block was run twice on SQLite over the current `schema.sql` (it is idempotent). These cases are rejected: a revision submitted at the deadline, an UPDATE on a revision, weights that do not add up to 100, a non-lowest award with no reason, and a second open award per event.
- **FK order.** The sourcing block is appended at the end of `schema.sql`, so every FK target (`purchase_requisitions`, `requisition_items`, `suppliers`, `users`, `departments`) already exists. No FK has to be skipped.
- **Triggers.** Each trigger body is a single statement. `tursoHttp.splitSqlScript` already handles trigger bodies, which contain semicolons.
- **Submit order and the deadline trigger.** The deadline trigger compares the server-stamped `NEW.submitted_at` with `deadline_at`. That means the `sourcing_bids` row must exist before the first revision is inserted, so a submit writes in this order inside one transaction:
  1. Upsert `sourcing_bids`, guarded by the same deadline predicate.
  2. Insert the revision.
  3. Insert the lines.
- **Doc kind.** Add `rfq: { table: 'sourcing_events', column: 'event_number', prefix: 'RFQ' }` to `docNumbers.js`. `event_number` is UNIQUE. Two interactive transactions can both read MAX and then collide on insert. The create retries that whole transaction up to 3 times, recomputing the number each time. After that the API returns **409** `event_number_conflict`.
- **Line totals.** `lineTotalCents(quantity, unit_price_cents)` (the existing helper). A revision's `total_cents` is the sum over its quoted lines. Bids are excl. VAT, the same basis as the PO `unit_price`.
- **Nothing is hard-deleted.** Drafts are cancelled, never deleted. `DELETE` returns 405, the same as for suppliers and the catalog.

### 4.1 Status machine

```
            publish (≥1 line, ≥1 invitation, deadline ≥ now+1h, weights = 100)
  draft ───────────────────────────────▶ published ──(deadline passes: lazy close / tick)──▶ closed
    │                                     │  ▲ extend deadline (later only)                  │
    │ cancel(reason)                      │  └─────────┘                                     │ "Beoordeling afronden"
    ▼                                     │ cancel(reason) → cancelled_before_deadline = 1   ▼
 cancelled ◀──────────────────────────────┘                                              evaluated
    ▲                                                                                       │ propose award →
    │ cancel(reason) from closed / evaluated (no pending/approved award)                    │ award PR in approval
    └───────────────────────────────────────────────────────────────────────────────────────┤ (award.status = pending_approval;
                                                                                            │  reject → award rejected, stays evaluated)
                                                                                            ▼ award PR fully approved (hook)
                                                                                         awarded ──▶ "Bestelling(en) aanmaken" (existing convert) → PO(s)
```

- **Transitions.**
  - All transitions live in a pure, unit-tested module: `sourcingStatus.js`, `assertTransition(from, to)`.
  - Each transition is a **conditional UPDATE** (`… WHERE id = ? AND status = ?`). If no row changes, the server returns `409 event_state_changed`. This is the 7b claim pattern.
- **`closed` → `evaluated`.** Requires at least one bid that was not withdrawn. If `weight_quality > 0`:
  - every evaluator who has not declared a conflict must score every bid;
  - otherwise the owner must override with a reason, which is audited.
- **`awarded` is final for the event.** Creating POs afterwards uses the existing convert and does not change the sourcing state. The detail page lists the POs where `purchase_orders.requisition_id = award_requisition_id`.
- **Events with no bids at close** can only be cancelled or re-run with "Opnieuw uitvragen", which clones them into a new draft. A closed event cannot be reopened, because that would break the seal.

---

## 5. Governance

### 5.1 Roles

| Action | Who (enforced on the server) |
| --- | --- |
| See the Sourcing nav and the event list | `procurement`, `admin`, `finance` (read-only), plus any user named as evaluator on an event (that event only) |
| Create or edit a draft, invite, publish, extend, cancel, answer Q&A, rotate or revoke links | `procurement` and `admin`. Edits are limited to the event **owner** or an admin. |
| Create an RFQ from an approved PR | `procurement` and `admin`. The PR requester sees "In offerteaanvraag RFQ-…" on the PR, read-only. |
| See bid prices (only after the deadline) | The owner, evaluators with `coi_status = none_declared`, admin, and finance (read-only). Evaluators whose status is still `pending` see the matrix **without** prices until they declare. |
| Score quality | Evaluators with `none_declared` |
| Propose an award | The owner or an admin |
| Approve an award | The existing approval chain on the award PR, plus the SoD rules in §5.2 |
| Create POs from an approved award | `procurement` and `admin`. A role gate is added to the convert route **for award PRs**. |
| Integrations | Keys with `sourcing:read` or `sourcing:write` (§5.5) |

Users with the `requester` or `approver` role get no sourcing screens. Approvers see award PRs in the normal **Goedkeuringen** inbox, with an "RFQ-…" badge and a link to the frozen comparison snapshot.

### 5.2 Segregation of duties

**1. The owner cannot approve their own award above a threshold.**

The threshold is `SOURCING_AWARD_SOD_THRESHOLD_CENTS`. It defaults to `APPROVAL_TIER2_CENTS` (€ 1.000,00) and can be changed in the environment. The rule is enforced in three places.

- **Preventive, when the chain is built.**
  - `buildApprovalSteps` gets a new `{ excludeUserIds }` option.
  - For an award PR above the threshold, a step that resolves to the owner, or to an evaluator who declared a conflict, is re-resolved to the **next user with the same role**.
  - If no such user exists, the step escalates to the next tier's resolver (procurement → finance → admin).
  - If nobody is left, the server returns `422 sod_no_alternate_approver` and fails closed.
  - Demo note: the seed has only one procurement user (Carol Zhang). On her RFQs, the procurement step escalates to finance (David Miller).
- **Preventive, when a step is decided.**
  - `decideApprovalStep` returns `403 sod_award_self_approval` when all of these hold:
    - the deciding user is the event owner, or is acting as a delegate for the owner;
    - the award is above the threshold;
    - the step was not already excluded when the chain was built.
  - This covers a delegation granted to the owner after the chain was built.
- **Detective, in the compliance report.**
  - The approval-policy report computes the expected chain with the same `excludeUserIds`, so it raises no false `wrong_approver` findings.
  - New findings:
    - `sourcing_award_self_approval`
    - `sourcing_award_not_lowest`: informational, shows the reason.
    - `sourcing_bid_after_deadline`: a verification that every revision has `submitted_at < deadline_at`. It should never fire.

Below the threshold, the owner may approve their own award if the chain resolves to them. The existing detective `self_approval` finding still reports it.

**2. Evaluator conflict of interest.**
- Every evaluator declares "geen belangenconflict" or "mogelijk belangenconflict" (with a note) before seeing prices.
- `conflict_declared` has three effects for that evaluator:
  - they are removed from scoring;
  - prices are hidden from them;
  - they are excluded from the award approval chain, through the same exclusion list.
- The owner must declare too. An owner who declares a conflict cannot propose the award, and an admin must reassign the owner. The reassignment is audited.
- Each declaration is a compliance event.

**3. Weights are frozen at publish.** The scoring cannot be tuned after prices are visible.

**4. The award snapshot is frozen.** `comparison_snapshot_json` records the matrix, scores, and lowest markers as they were when the award was proposed. Approvers see this snapshot, not a recomputation.

### 5.3 Audit events

Unless noted, `compliance_audit_events` actions use `entity_type = 'sourcing_event'`. `audit_logs` gets readable history lines for the event Historie tab and the document trail.

| Action | Actor | Details (JSON) |
| --- | --- | --- |
| `SOURCING_EVENT_CREATED` / `SOURCING_EVENT_UPDATED` | session | source, source PR id, `line_count`, `lines_sha256`, `invitation_count`, `invites_sha256` |
| `SOURCING_EVENT_PUBLISHED` | session | deadline, invitation count, weights |
| `SOURCING_DEADLINE_EXTENDED` | session | old and new deadline |
| `SOURCING_EVENT_CLOSED` | `System Sourcing Scheduler` | trigger (`lazy_read` / `tick`) |
| `SOURCING_EVENT_CANCELLED` | session | reason, before_deadline |
| `SOURCING_INVITATION_CREATED` / `_LINK_ROTATED` / `_REVOKED` (entity `sourcing_invitation`) | session | supplier code, token prefix, delivery |
| `SOURCING_INVITATION_OPENED` / `_DECLINED` | supplier | first open only |
| `SOURCING_BID_SUBMITTED` / `_WITHDRAWN` (entity `sourcing_bid`) | supplier | revision, content hash, number of quoted lines. **No amounts.** |
| `SOURCING_BID_REJECTED_LATE` | supplier | attempted_at, deadline |
| `SOURCING_BIDS_OPENED` | session | first price view per user |
| `SOURCING_COI_DECLARED` | session | status, note |
| `SOURCING_SCORES_RECORDED` | session | bid ids, count |
| `SOURCING_EVENT_EVALUATED` | session | override reason, if any |
| `SOURCING_AWARD_PROPOSED` (entity `sourcing_award`) | session | type, total, is_lowest, reason, award PR number |
| `SOURCING_AWARD_APPROVED` / `_REJECTED` | final approver (hook) | award PR number |
| `SOURCING_SOURCE_REQUISITION_SUPERSEDED` (entity `requisition`) | final approver (hook) | released cents |
| `SOURCING_FILE_UPLOADED` / `SOURCING_FILE_REMOVED` / `_DOWNLOADED` (bid files after opening) | session or supplier | file id, sha256 |

In 8a a draft save does not write one `SOURCING_INVITATION_CREATED` per supplier. The invitations are summarized on `SOURCING_EVENT_CREATED` / `SOURCING_EVENT_UPDATED` (count and sha256) so the interactive transaction stays within §6.1. The per-invitation rows start in 8b, when a link is minted.

### 5.4 Award to PO through the existing PO path and approvals

**Why an award requisition.** Approvals and budget commitment exist only on requisitions (`approval_requests.requisition_id NOT NULL`; commitment happens at final PR approval). Approving at PO level would need a parallel engine or a table rebuild. Reusing the PR keeps these paths unchanged:
- delegations
- budget
- the approval inbox
- the compliance report
- the document trail

**Steps**

1. **Propose the award.**
   - Endpoint: `POST /api/sourcing/events/:id/awards`, by the owner or an admin, in an `immediateTransaction`.
   - Preconditions: the event is `evaluated` and has no open award.
   - Checks:
     - validate each line against the current bid revisions;
     - every awarded supplier must be `active`. This fails early, because convert would enforce it later anyway.
   - Compute `is_lowest` and `has_expired_validity`, require a reason where needed, and freeze the snapshot.
   - Create the **award PR** with a new `createRequisition` service. The service is extracted from `routes/requisitions.js` without changing behaviour for existing callers. The award PR has:
     - requester = the owner;
     - department = the event's department;
     - status `pending_approval`;
     - justification `Gunning RFQ-2026-004 (volledig|gesplitst): <reden of "laagste bieding">`;
     - lines = the awarded lines at the awarded unit price, each with `estimated_supplier_id` set to the winner;
     - an approval chain from `insertApprovalChain`, with the SoD exclusions.
   - Write `sourcing_awards` and its lines, the audit row, and the compliance event. No webhook is sent yet.
2. **Approval.**
   - The award PR goes through the existing inbox with SoD (§5.2).
   - A small hook module, `sourcingApprovalHooks.js`, is called from `decideApprovalStep` **inside its transaction**.
   - **On final approval of an award PR:**
     - the award becomes `approved` and the event becomes `awarded`;
     - if the event has a `source_requisition_id`, **that PR's commitment is released**. The change is `committed_amount = MAX(0, committed_amount − source.total_amount)`, applied to its department with the same `FISCAL_YEAR` constant, and audited as `SOURCING_SOURCE_REQUISITION_SUPERSEDED`;
     - the award PR's own commitment is the existing logic, so the net effect moves the budget from the estimate to the awarded amount;
     - enqueue `sourcing_event.awarded`.
   - **On rejection:** the award becomes `rejected` and the event stays `evaluated`. The source PR stays locked.
3. **Create the POs.**
   - "Bestelling(en) aanmaken" on the awarded event calls the **existing** `convertRequisitionToPurchaseOrders(awardPR)`.
   - The lines carry different `estimated_supplier_id` values, so a split award produces **one PO per supplier** automatically, each with the usual `po.issued`.
   - PO notes reference the `RFQ-…` number.
   - Auto-convert on final approval and draft POs are open decisions (§10).
4. **Guard the source PR.**
   - `convertRequisitionToPurchaseOrders` refuses with `409 requisition_in_sourcing` when the PR is the `source_requisition_id` of an event that is not cancelled. That covers both an open RFQ and a superseded PR.
   - A superseded PR keeps status `approved`, because its CHECK constraint cannot be extended without a rebuild. The UI shows "Vervangen door PR-… (RFQ-…)".
   - Cancelling an event before the award unlocks the source PR. Its budget was never released, so nothing needs to be undone.

**Changes to existing code** (each is small and covered by tests):
- `docNumbers.js`: the `rfq` kind.
- `approvalPolicy.js`: `excludeUserIds`.
- `approvalsService.js`: the hook call and the SoD guard.
- `purchaseOrdersService.js`: the source-PR guard.
- `routes/purchaseOrders.js`: a role gate when the PR is an award PR.
- `routes/requisitions.js` → `requisitionsService.js`: the extraction.
- `complianceReports.js`: the exclusions and the new findings.
- `requestActor.js`: the portal routes and the sourcing machine routes.
- `apiKeys.js`: the new scopes.
- `webhookOutbox.js`: the new events.
- `app.js`: router mounts.
- `vercel.json`: the `portal.html` headers.
- `client/vite.config.js`: multi-page build with `portal.html`.

### 5.5 Webhooks and API scopes

**Webhooks** are added to `WEBHOOK_EVENTS` and always enqueued in the business transaction:

| Event | When | Money |
| --- | --- | --- |
| `sourcing_event.published` | Publish | No (the target price is internal) |
| `sourcing_bid.submitted` | Each supplier submit or resubmit | **No.** Revision and content hash only. |
| `sourcing_event.closed` | Lazy close or tick | No |
| `sourcing_event.cancelled` | Cancel | No |
| `sourcing_event.awarded` | Award PR fully approved | Award total and per-supplier totals in cents, `currency`, award PR number |

PO numbers follow through the existing `po.issued`.

**API scopes** are added to `API_KEY_SCOPES`, with Dutch labels on the Integraties screen.

`sourcing:read` gives:
- `GET /api/integrations/sourcing/events?status=&updated_since=`: header and lines, no target prices.
- `GET /api/integrations/sourcing/events/:number`: bids and prices **only after the deadline**, through the same read model.
- `GET …/:number/award`.

`sourcing:write` gives:
- `POST /api/integrations/sourcing/events`: creates a **draft** only, so an ERP can push a sourcing need. Idempotent on `external_id`, with `Idempotency-Key` replay.
- `POST …/:number/invitations`: adds invitees to a draft, by supplier external id.

Keys can **never** publish, see links, award, or approve. Publishing sends links to third parties, so a human does it.

Machine routes follow the Sprint 4 conventions:
- each one is listed explicitly in `isIntegrationMachineRoute`;
- `pfk_` is required and the cookie is ignored;
- the key is the actor.

---

## 6. Turso and serverless fit

### 6.1 Transaction sizing (5 s interactive cap)

In a `tursoHttp` transaction, every statement is one HTTP round-trip on the baton. Plan for **25 statements or fewer per transaction**, which is about 2.5 s at a pessimistic 100 ms each.

- **Read and validate before the transaction.** Inside it, re-check state only through conditional UPDATE/INSERT predicates.
- **Insert lines with one multi-row statement** (`INSERT … VALUES (…), (…), …`, built from validated arrays). Fifty lines then cost one statement.
- **Never put a blob in the same transaction as business rows.** An upload is its own transaction (metadata plus blob, 2 statements). Business actions refer to the file id later. The 7b cap of 4 MiB keeps a blob insert at about 5.4 MiB of base64 pipeline body.

| Operation | Statements in tx (approx.) |
| --- | --- |
| Create draft at the caps (header, 50 lines, 20 invitations, one audit, compliance ×2) | 7, measured |
| Publish (conditional update, up to 20 token updates as one `UPDATE … CASE`, compliance ×2, audit, outbox) | ~7 |
| Submit bid (rate window, guarded bid upsert, guarded revision insert, multi-row lines, compliance ×2, outbox) | ~8 |
| Propose award (conditional event check, award + lines, PR number, PR + lines, approval chain up to 3, audit ×3, compliance ×2) | ~16 |
| Final-approval hook (existing ~8, plus award/event updates ×2, budget release, compliance ×2, audit, outbox) | ~15 |
| Lazy close, per event (conditional update, compliance ×2, audit, outbox) | ~5 |

The caps of 50 lines, 20 invitations, and 10 files per bid and per event keep these numbers valid.

**Measured in 8a.** A draft save at those caps stays inside one interactive transaction and at or under 25 prepared statements. Lines and invitations use multi-row `INSERT … VALUES`, chunked at 900 bound variables so the statement stays under SQLite's historical 999-variable limit. One compliance row covers the save (`SOURCING_EVENT_CREATED` or `SOURCING_EVENT_UPDATED`) and carries `line_count`, `lines_sha256`, `invitation_count`, and `invites_sha256`. A per-invitation `SOURCING_INVITATION_CREATED` waits until 8b, when a link is minted. Create is 7 statements (number, header, lines, invitations, audit, chain head, compliance insert). Replacing the same caps on update is 9 (delete and insert lines, read and replace invitations, header update, audit, compliance ×2). A test counts the prepared statements inside the transaction for both and asserts ≤ 25. Splitting the write into a non-interactive `batch()` was not used: a partial save is not acceptable, and a `batch()` pipeline can commit a chunk before a later statement fails.

`appendComplianceEvent` costs 2 statements: it reads the chain head, then inserts, and it retries once on a mismatch. Bids that cluster near the deadline will queue behind the single writer. That is acceptable at RFQ volumes (tens of suppliers, not thousands).

### 6.2 Closing deadlines: lazy close plus an optional tick

**Correctness does not depend on closing.** Bid writes are gated twice: by `deadline_at > now` inside the INSERT and by the trigger. Price visibility is gated by `now >= deadline_at`.

**Lazy close.** `closeDueEvents(db, now, { limit: 20 })` runs at the start of every sourcing list or detail call, whether from the buyer app, the portal, or an integration.
1. One bounded `SELECT id … WHERE status='published' AND deadline_at <= ? LIMIT 20`.
2. For each event, a small transaction runs a conditional `UPDATE … SET status='closed' WHERE id=? AND status='published'`.
3. Audit and `sourcing_event.closed` are written only if a row changed, so concurrent readers are idempotent.

**Optional tick (8d).**
- `POST /api/sourcing/tick` takes `Authorization: Bearer $CRON_SECRET`. It runs the same function plus the webhook drain, which also closes an open PROGRAM-REPORT follow-up.
- It is called by a `vercel.json` cron. Vercel plan limits on cron frequency apply: Hobby allows roughly daily, Pro allows minute-level.
- Without the cron, lazy close is sufficient. The only visible effect is that `closed_at` and the `closed` webhook land on the next access rather than at the exact second.
- The UI always derives "Gesloten" from `deadline_at`.

### 6.3 Files

**Reuse `invoicePdf.js`:**
- `pdfUploadMiddleware`: `application/pdf` only, `%PDF-` magic check, 4 MiB cap. A new `SOURCING_PDF_MAX_BYTES` follows the `INVOICE_PDF_MAX_BYTES` semantics and is clamped to 4 MiB.
- `sha256Pdf` and `safePdfFilename`.
- `contentDispositionInline` for buyer files; supplier files use `attachment`.

**Limits:**
- at most 10 files per bid and 10 buyer files per event;
- at most 40 MiB stored per event, checked with `SUM(size_bytes)` before insert;
- uploads limited to 10 per minute per invitation and 10 per minute per buyer user.

**PDF only in v1.** Office files are an open question: they carry macro and parser risk, and the platform has no antivirus scanning.

**No 60 s function needed.** Uploads do no OCR, so they run on the default function.
- If a 4 MiB upload turns out to be slow on Turso, add a `content-type: application/pdf` rewrite for `/api/portal/files` and `/api/sourcing/events/:id/files` to `api/invoice-proposal-upload.js`. This is the 7b trick.
- Upload speed has not been measured from this environment.

**Size is checked before the blob enters a transaction.** List and detail queries never select `sourcing_file_blobs`.

### 6.4 Prerequisites and environment

- **Transaction isolation fix** (repo issue 1). It must land before 8b, either as its own small PR ("8.0") or as the first commit of 8a.
- **Preview/Prod DB split** before any customer runs a live RFQ. Until then, `SOURCING_ENABLED` and `PORTAL_TOKEN_SECRET` are set on Production only. Preview treats sourcing as disabled (`503 sourcing_disabled`, nav item hidden).
- **New env vars:**

  | Variable | Notes |
  | --- | --- |
  | `SOURCING_ENABLED` | Default off |
  | `PORTAL_TOKEN_SECRET` | 32-byte hex. Required when sourcing is enabled, and its minimum length is enforced (unlike the webhook-secret nit). |
  | `APP_BASE_URL` | Already used by SSO. Required for links. |
  | `SOURCING_AWARD_SOD_THRESHOLD_CENTS` | Optional |
  | `SOURCING_PDF_MAX_BYTES` | Optional |
  | `MAIL_PROVIDER`, `MAIL_FROM`, `MAIL_REPLY_TO`, provider credentials | 8d |
  | `CRON_SECRET` | 8d, optional |

- `vercel:customer` keeps writing only its three variables. The new ones are documented as manual settings, like the webhook and SSO variables.

---

## 7. UI (Dutch)

### 7.1 Navigation

- **New sidebar item: "Offerteaanvragen".** It uses a lucide icon (`Gavel` or `FileQuestion`) and sits between **Goedkeuringen** and **Inkooporders**, following the flow PR → approval → sourcing → PO.
  - It is visible to `procurement`, `admin`, and `finance`, and to any user with an evaluator assignment (`GET /api/sourcing/me` returns `{ canSee }`).
  - It is hidden when `SOURCING_ENABLED` is off.
  - Its badge counts events that are closed and waiting for evaluation, plus approved awards still waiting for POs.
- **Changes on the Inkoopaanvragen detail:**
  - An approved PR gets **"Offerteaanvraag starten"** (procurement/admin).
  - A PR that is in sourcing shows the banner "In offerteaanvraag RFQ-2026-004". Its **Omzetten naar inkooporder** button is disabled and shows that reason.

### 7.2 Buyer screens and key labels

| Screen | Labels |
| --- | --- |
| List | Title **Offerteaanvragen (RFQ)**. Subtitle "Vraag offertes op bij meerdere leveranciers, vergelijk en gun." Columns **Nummer, Titel, Status, Sluitingstijd, Uitgenodigd, Ingediend, Eigenaar**. Filters **Alle, Concept, Gepubliceerd, Gesloten, Beoordeeld, Gegund, Geannuleerd**. Button **Nieuwe offerteaanvraag**. |
| Empty state | "Nog geen offerteaanvragen." "Start een offerteaanvraag vanaf nul of vanuit een goedgekeurde inkoopaanvraag." Buttons **Nieuwe offerteaanvraag** and **Naar inkoopaanvragen**. |
| Section **Basis** | Titel, Omschrijving / specificatie, Categorie, Kostenplaats / afdeling, Bron: **Leeg beginnen** / **Vanuit inkoopaanvraag** |
| Section **Regels** | Omschrijving, Aantal, Eenheid, Type (Goed / Dienst), Basis (Vast bedrag / Uren / Dagen), **Richtprijs (intern, niet zichtbaar voor leveranciers)**, + Regel toevoegen, "Alleen specificatie (één totaalprijs)" |
| Section **Bijlagen** | "Sleep PDF's hierheen (max. 4 MB per bestand)" |
| Section **Leveranciers** | Leverancier zoeken, Contactpersoon, E-mailadres, + Uitnodigen. Hint "Minimaal 3 leveranciers aanbevolen". |
| Section **Planning en beoordeling** | **Sluitingstijd** (date and time, "Nederlandse tijd"), **Vragen toestaan**, **Vragen mogelijk tot**, **Weging: Prijs / Levertijd / Kwaliteit (%)** with "Totaal moet 100% zijn", **Beoordelaars** |
| **Controleren en publiceren** | Summary. Button **Publiceren en uitnodigingen versturen**. Confirmation: "Na publicatie kunnen regels en weging niet meer worden gewijzigd." |
| Detail tabs | **Overzicht, Regels, Leveranciers, Vragen en antwoorden, Bijlagen, Vergelijking, Gunning, Historie** |
| Leveranciers tab | Statuses **Uitgenodigd, Geopend, Ingediend (versie n), Afgezien, Ingetrokken, Link verlopen**. Actions **Link kopiëren** (only right after creation or rotation), **Nieuwe link genereren**, **Link intrekken**. Delivery chips **Verzonden / Verzenden mislukt / Niet verzonden: kopieer de link**. |
| Vergelijking before the deadline | Lock panel: "**Verzegeld tot {datum tijd}.** Prijzen worden pas zichtbaar na de sluitingstijd." |
| Vergelijking after the deadline | Matrix with rows = regels and columns = leveranciers. Each cell shows **Eenheidsprijs / Regeltotaal / Levertijd**. Badges **Laagste** (green), **Niet aangeboden**, **Onvolledige offerte**, **Geldigheid verlopen**. Footer **Totaal, Score prijs, Score levertijd, Score kwaliteit, Totaalscore, Rang**. COI modal **Verklaring belangenconflict**: "Ik verklaar dat ik geen belangenconflict heb met de uitgenodigde leveranciers" / "Ik heb mogelijk een belangenconflict" + Toelichting. |
| Gunning | **Volledig gunnen aan…** / **Per regel gunnen (gesplitst)**. **Motivatie** (required when not the lowest; hint "Verplicht omdat dit niet de laagste bieding is"). Summary per supplier. Button **Gunning ter goedkeuring indienen**. The state then shows "Gunning ter goedkeuring: PR-2026-0xx", then **Gegund**, then the button **Bestelling(en) aanmaken**. |
| Other actions | **Sluitingstijd verlengen**, **Annuleren** (Reden), **Opnieuw uitvragen**, **Beoordeling afronden** |

**Status labels.** API codes stay English, per the Sprint 6 rule:

| Code | Label |
| --- | --- |
| `draft` | Concept |
| `published` | Gepubliceerd |
| `closed` | Gesloten |
| `evaluated` | Beoordeeld |
| `awarded` | Gegund |
| `cancelled` | Geannuleerd |

Award statuses: `pending_approval` Ter goedkeuring, `approved` Goedgekeurd, `rejected` Afgewezen.

**Formatting.**
- Amounts display through `formatMoney` (`€ 1.295,00`).
- Amount inputs use `parseMajorAmount`/`toCents` (comma decimals).
- Times display as `15 okt 2026, 12:00` in Europe/Amsterdam, using `Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam' })`.

**Layout.** The client has no router, so authoring is **one screen with collapsible sections**, not a multi-step routed wizard.

### 7.3 Supplier portal (`portal.html`, separate bundle, Dutch)

§10's decisions override this section: the portal is Dutch and English.

| Page | Content |
| --- | --- |
| Header | Customer name, "Offerteaanvraag RFQ-2026-004" |
| **Uitnodiging** | Titel, Omschrijving, Bijlagen (download), **Sluitingstijd** with a countdown "Nog 2 dagen 4 uur", "Tijd volgens onze server" |
| **Uw offerte** | Per line: Omschrijving, Aantal, Eenheid, **Eenheidsprijs (excl. btw)**, **Levertijd (dagen)**, **Opmerking**, checkbox **Niet aangeboden**. Bid level: **Geldig tot**, **Standaard levertijd**, **Toelichting**, **Bijlagen toevoegen**. Button **Offerte indienen**, or **Gewijzigde offerte indienen** after the first submit. |
| **Ontvangstbevestiging** | "Uw offerte (versie 2) is ontvangen op 14 okt 2026 10:42." "Controlecode: 3f9a…c1" |
| **Vragen** | **Vraag stellen**, the supplier's own questions, and published answers ("Antwoord voor alle deelnemers") |
| Other actions | **Afzien van deelname** (Reden), **Offerte intrekken** |
| After the deadline | "De inschrijftermijn is gesloten op {tijd}. U kunt uw ingediende offerte nog bekijken." Later, "Uitslag: gegund / niet gegund". |
| Error | "Deze link is ongeldig of verlopen. Neem contact op met de inkoper." |

### 7.4 Demo seed and empty state

**`npm run seed`** (destructive, demo only) adds three RFQs:
- **RFQ-2026-001** "Ergonomische bureaustoelen Q4": `published`, deadline 7 days out. Three invitations (WorkSpace Ergonomics Depot, TechSupply Global, FacilityCare & Janitorial Pro), two bids submitted and still sealed. It shows the lock panel.
- **RFQ-2026-002** "Laptopvervanging marketing": `closed` with 3 complete bids. It shows the matrix and scores. Owner Carol Zhang; evaluator David Miller, COI declared.
- **RFQ-2026-003** "Schoonmaakdienst kantoor": `awarded` (split). Its award PR was approved by the chain and converted to POs.

**Demo portal links.** The seed prints them to the console and never stores plaintext. It uses a fixed demo `PORTAL_TOKEN_SECRET` only when `NODE_ENV !== 'production'`.

**Customer tenants** are never seeded:
- They see the empty state from §7.2.
- The onboarding docs gain a 5-minute walkthrough, "eerste offerteaanvraag".

---

## 8. Sprint plan

P2P Developer, daily sprints, one draft PR each, base `main`.

Each sprint appends its row to `docs/SPRINT-LOG.md`, with "Done when" and "Decisions" sections. `done` means the draft PR is open and waiting for Architect and Peter review. Nothing merges before that review.

### Sprint 8.0 (prerequisite, small): Turso transaction isolation

- **Goal:** concurrent requests on one warm instance never share a transaction.
- **Scope:**
  - In `tursoHttp.js`, use an `AsyncLocalStorage` transaction context. Each `transaction()` call gets its own baton and nesting counter. Statements outside a transaction are stateless.
  - Give `sqliteAdapter.js` the same semantics. It already serializes.
  - No call sites change.
- **Done when:**
  - Two concurrent transactions on one client never share a baton.
  - A statement outside any transaction is not part of an open one.
  - `npm test` is green.
- **Tests:** a fake-fetch client runs interleaved `transaction()` calls and asserts the baton for each request, plus rollback isolation.
- **Risk:** this touches every write path. It is mitigated by keeping the API unchanged and by the full existing suite.

### Sprint 8a: Data model and buyer RFQ authoring

- **Goal:** procurement can create, edit, and cancel RFQ drafts. A draft starts from scratch or from an approved PR, and holds lines, buyer PDFs, invitees (no links yet), weights, and evaluators. Nothing is visible to suppliers yet.
- **Scope:**
  - **Backend:**
    - the schema block from §4 and the `rfq` doc kind;
    - `sourcingStatus.js` and `sourcingService.js` (draft CRUD, copy from PR, invitee list, evaluators);
    - a `/api/sourcing` router with `requireRole('procurement','admin','finance')` and owner checks, gated by `SOURCING_ENABLED`;
    - a source-PR lock guard in `convertRequisitionToPurchaseOrders`;
    - buyer file upload and download, using the 7b pattern.
  - **Client:**
    - the nav item, list, and empty state;
    - the authoring screen, with the publish button disabled and the note "beschikbaar in 8b";
    - detail tabs Overzicht, Regels, Leveranciers, Bijlagen, and Historie;
    - `client/src/i18n/parts/sourcing.js`.
  - **Docs:** fix the stale 7b row in `SPRINT-LOG.md`.
- **Done when:**
  - **Drafts:** a draft can be created from scratch and from an approved PR, and the PR's default supplier 1 is not copied.
  - **PR lock:** the source PR cannot be converted while the RFQ is not cancelled (`409 requisition_in_sourcing`). Cancelling the RFQ unlocks it.
  - **Access:**
    - requester and approver get 403 on `/api/sourcing/*`;
    - a request with no cookie gets 401;
    - a procurement user who is not the owner gets 403 on edit.
  - **Validation:** weights must add up to 100. More than 50 lines or 20 invitations returns 400.
  - **Money:** amounts are integer cents, and comma input works.
  - **Feature flag:** when `SOURCING_ENABLED` is unset, the API returns `503 sourcing_disabled` and the nav item is hidden.
  - **Schema:**
    - applying it twice to an existing database changes nothing and drops nothing (a `db.test.js`-style test);
    - applying it to a pre-sourcing database fixture keeps all existing rows.
  - **i18n:** the catalog test passes.
- **Tests:** `sourcing.test.js` covers:
  - the auth and role matrix;
  - copying from a PR;
  - PR lock and unlock;
  - the transition table (pure);
  - validation limits;
  - file type, size, and magic checks, and that list queries never read blobs;
  - schema idempotency;
  - `RFQ-2026-001…` number allocation.
- **Risks:**
  - DDL is effectively permanent, because rebuilds are not allowed. Review CHECK constraints carefully.
  - The PR-lock guard touches the PO path.
  - The UI is large.

### Sprint 8b: Supplier portal and sealed bids

- **Goal:** publishing creates one magic link per invitation, delivered by copy link. Suppliers submit and revise bids until the deadline in a separate portal, and the server keeps prices sealed.
- **Scope:**
  - **Links:** `PORTAL_TOKEN_SECRET`; mint, verify, rotate, and revoke tokens (`sourcingPortalTokens.js`).
  - **Event transitions:** publish, extend, and cancel.
  - **Portal API:** a `/api/portal` router with its own CORS and headers. It authenticates with the bearer token and ignores the cookie. It serves:
    - the invitation view;
    - bid submit, with revisions and `submission_id`;
    - withdraw and decline;
    - Q&A;
    - bid PDF upload, remove, and download.
  - **Rate limits:** rate windows, plus lazy close.
  - **Sealing:** `sourcingBidReadModel.js` and the scan test.
  - **Buyer UI:** the Leveranciers tab with link actions and statuses, the Q&A tab, and the sealed Vergelijking panel.
  - **Events:** compliance and audit events. Webhooks `sourcing_event.published|closed|cancelled` and `sourcing_bid.submitted`.
  - **Portal client:** a `portal.html` Vite entry, `vercel.json` headers, and `parts/portal.js`.
- **Done when:**
  - **Deadline:** a submit 1 ms before the deadline is accepted. A submit at or after the deadline gets 409, writes no rows, and a direct insert is also blocked by the trigger.
  - **Sealing:** before the deadline, no buyer or integration endpoint returns a price, total, lead time, or bid file. This is asserted per endpoint. After the deadline, the owner sees prices and `SOURCING_BIDS_OPENED` is logged once.
  - **Isolation:** supplier A gets 404 on B's bid, files, and questions. The portal ignores `pf_session`.
  - **Links:** revoked, rotated, expired, forged, and HMAC-invalid tokens all return the same 401 body. Rate limits return 429. The plaintext token never appears in the database, the logs, or the API after the create/rotate response.
  - **Headers:** portal responses carry `no-store`, `no-referrer`, `nosniff`, and `DENY`. A foreign Origin gets no `Access-Control-Allow-Origin` on `/api/portal/*`.
  - **Webhook:** the `sourcing_bid.submitted` payload has no amount fields.
  - **Revisions:** a resubmit creates revision n+1. Repeating a `submission_id` returns the original receipt.
- **Tests:** `sourcingPortal.test.js` covers:
  - the token lifecycle;
  - deadline edges, using an injected clock;
  - A/B isolation;
  - sealing on each endpoint;
  - the scan test;
  - rate limits;
  - headers and CORS;
  - replay;
  - the late-attempt audit;
  - the webhook payload shape;
  - append-only triggers.
- **Risks:**
  - Sealing could leak through a forgotten query. The read model and scan test mitigate this.
  - Clock edge cases.
  - A token in `sessionStorage` is exposed to XSS. The CSP and the absence of third-party scripts mitigate this.
  - The sprint needs 8.0 merged first.
  - Real suppliers need the DB split.

### Sprint 8c: Comparison, scoring, award, and POs

- **Goal:** after the deadline, buyers compare bids side by side, score them, and propose a full or split award. The award goes through the existing approval chain with SoD and becomes POs through the existing convert.
- **Scope:**
  - **Comparison:**
    - a comparison read model: matrix, lowest per line, lowest complete total, weighted score (§8.1);
    - COI declarations and quality scores;
    - "Beoordeling afronden".
  - **Award:**
    - the award proposal: `immediateTransaction`, reason rules, validity check, snapshot;
    - extraction of `requisitionsService.createRequisition`.
  - **Approvals and SoD:**
    - `buildApprovalSteps({ excludeUserIds })` with escalation;
    - `sourcingApprovalHooks` in `decideApprovalStep` (approve, reject, source-PR release);
    - the SoD guard at decide time;
    - a convert role gate for award PRs.
  - **Reporting:** compliance report changes and new findings; `sourcing_event.awarded`.
  - **UI:**
    - a badge and snapshot view in the Goedkeuringen inbox;
    - the document trail RFQ → award PR → PO(s);
    - the Vergelijking and Gunning tabs.
- **Done when:**
  - **Comparison:** the matrix marks the lowest price per line and the lowest complete total. Incomplete and withdrawn bids are handled. Scores are deterministic and match §8.1.
  - **Award:**
    - a non-lowest award without a reason gets 400, and the database CHECK rejects it too;
    - a split award produces one award PR, and converting it yields one PO per supplier at the awarded prices.
  - **SoD:**
    - above the threshold, the owner is never an approver: the chain re-resolves or escalates;
    - an owner trying to decide through a delegation gets 403.
  - **Budget:** final approval commits the award total and releases the source PR's commitment in the same transaction. Budget totals reconcile in a test. A rejection leaves the event `evaluated` with no POs.
  - **Compliance:** the report shows no `wrong_approver` for award PRs. It does show `sourcing_award_self_approval` when that is forced in a test.
  - **Regression:** existing approval, PO, and compliance tests stay green.
- **Tests:**
  - `sourcingAward.test.js` covers:
    - a table of scoring-formula cases;
    - lowest and tie rules;
    - reason enforcement;
    - split → multiple POs;
    - SoD chain resolution, including escalation when there is only one procurement user;
    - an attempt to bypass SoD through a delegation;
    - budget reconciliation for from-PR and from-scratch events;
    - the reject path;
    - concurrency: of two award proposals, one gets 409.
  - Additions to `approvalPolicy.test.js`, `compliance.test.js`, and `purchaseOrders.test.js`.
- **Risks:**
  - The sprint touches the approval and budget core: double-commit or a missed release.
  - `FISCAL_YEAR=2026` is hardcoded.
  - The compliance report can drift.
  - The final-approval hook has to stay within 25 statements. Measure it on a Turso preview after the DB split.

### Sprint 8d: Hardening, email, integrations, demo seed, and docs

- **Goal:** sourcing is ready for production at one customer. Invites go out by email, with copy-link as the fallback. The sprint adds an integration API, an optional scheduler tick, a demo seed, and complete docs.
- **Scope:**
  - **Mail:**
    - a `server/src/mail` abstraction with providers `none` (default), `smtp`, and one HTTP provider (Peter's choice);
    - invitation, extension, cancellation, Q&A-answer, receipt, and award-notice mails, sent after commit, with `delivery_status`;
    - mail status shown to admins in Integraties.
  - **Integrations:** machine routes for `sourcing:read` and `sourcing:write`.
  - **Tick:** `POST /api/sourcing/tick` (needs `CRON_SECRET`) plus the webhook drain. An optional `vercel.json` cron, documented and off by default.
  - **Security:** global CORS restricted to `APP_BASE_URL`.
  - **Portal and seed:** the demo seed (§7.4) and the portal's award-outcome page.
  - **Docs:**
    - SYSTEM_MANUAL (a Sourcing section);
    - DEPLOY_MANUAL (the env table, the Preview/Prod split prerequisite, DNS for mail);
    - the CUSTOMER_ONBOARDING walkthrough;
    - PROGRAM-REPORT;
    - this plan as `docs/SOURCING-PLAN.md`;
    - the SPRINT-LOG rows.
  - **Manual checks:** on a Vercel preview, test 4 MiB uploads and deadline-rush concurrency. This needs the DB split first.
- **Done when:**
  - **Mail:**
    - with `MAIL_PROVIDER` unset, every flow works through copy link;
    - with a fake provider, mail is sent after commit, a failure is recorded as `failed`, and the business write is not rolled back;
    - the plaintext link is in no table and no log.
  - **Integrations:** a key without the scope gets 403. A key cannot publish or award. Sealing applies to keys.
  - **Tick:** a call without the secret gets 401. With the secret, due events close idempotently.
  - **CORS:** a foreign Origin no longer gets credentialed CORS on the buyer API.
  - **Seed:** creates the three demo RFQs and prints the demo links.
  - **Docs:** they name every env var and the migration (`db:migrate` or the next cold start; additive only).
- **Tests:**
  - `mail.test.js`: provider selection, failure handling, and that the token is never persisted.
  - `sourcingIntegrations.test.js`.
  - Tick auth.
  - A CORS regression test.
  - A seed smoke test (`seed` → row counts).
  - The i18n catalog test.
- **Risks:**
  - Mail deliverability and per-customer DNS go against the easy-deploy goal. Copy link keeps mail optional.
  - Tighter CORS can break a custom domain if `APP_BASE_URL` is wrong. Always allow same-origin, and log the rest.
  - Vercel cron limits depend on the plan.
  - Scope creep toward tenders.

### 8.1 Scoring formula (fixed in 8c, shown in the UI as "Hoe wordt gescoord?")

Only complete bids (every line quoted, not withdrawn) get a total score. Incomplete bids are shown and can win individual lines in a split award, but they get no total rank.

| Part | Formula |
| --- | --- |
| Price score | `100 × lowest_complete_total / bid_total` |
| Lead-time score | `100 × (min_lead + 1) / (bid_lead + 1)`, where a bid's lead time is its maximum line lead time and `+1` avoids division by zero |
| Quality score | `10 × average evaluator score` (0–10, evaluators without a conflict) |
| Total | `(w_p × price + w_l × lead + w_q × quality) / 100` |

- Each part is rounded to one decimal for display, and ranks use full precision.
- On a tie, the lower total price ranks first, then the earlier first submit.
- Lowest per line is the lowest `unit_price_cents` among non-withdrawn bids that quoted that line.
- Equal prices all count as lowest.

---

## 9. Packaging

There is no tier mechanism in the repo, and each customer has its own deployment. A tier is therefore a **deployment flag**, set per customer in the Vercel env like the other manual settings:

| Flag | Effect |
| --- | --- |
| `SOURCING_ENABLED=1` | Turns the RFQ module on |
| *(later)* `SOURCING_TENDER_ENABLED=1` | Turns on the formal tender variant |
| *(later)* `SOURCING_MAX_OPEN_EVENTS=n` | An optional cap for a lower tier |

How these flags map to Gratis, Premium, and Executive is Peter's decision (§10).

---

## 10. Open decisions for Peter

1. **Supplier accounts later?**
   - v1 uses magic links only. Accounts (multi-event portal, self-service, contacts, onboarding questionnaires) bring identity management, password reset, and more GDPR scope.
   - **Recommendation:** not before there is demand. Revisit when one customer runs more than about 10 RFQs a month with the same suppliers.
2. **Email provider.**
   - **Recommendation:** ship `none` (copy link) as the default, plus `smtp`, so a customer can use their own relay (for example Microsoft 365) and send from their own domain.
   - Pick **one** HTTP provider for customers without a relay: Postmark, Brevo, Mailgun EU, or Resend. Prefer EU data residency for NL customers.
   - Who sets up SPF and DKIM for each customer?
3. **Public tenders and TED/TenderNed: ever in scope?**
   - This is the TenderSync line, but on the buy side.
   - **Recommendation:** keep it out of the core. If it is ever needed, build it as `kind = 'tender'` after legal review (Aanbestedingswet, standstill period), and publish through an integration rather than an in-app publisher.
4. **Pricing tier.** A suggestion:
   - Gratis: no sourcing, or a view-only demo.
   - Premium: RFQ v1.
   - Executive: scoring templates, integration scopes, and the tender variant later.

   Alternatively, put sourcing in Premium with a cap on open events.
5. **Award to PO.**
   - Is creating POs a manual "Bestelling(en) aanmaken" step after the award is approved (the plan's default), or automatic on final approval?
   - Should POs from awards start as `draft` instead of today's immediate `issued`? That would need a guarded issue action, because `PATCH /status` is unguarded today.
6. **SoD threshold.**
   - Is € 1.000 (Tier 2) the right default?
   - Is it acceptable for the owner to approve their own award below the threshold? The existing `self_approval` finding would still report it.
7. **Minimum quotes.** Should there be a rule, for example at least 3 invitations above € 10.000? If so, should publish enforce it or only warn?
8. **Notices to suppliers who lose.** Should a "niet gegund" notice (no prices, no competitor names) go out by default, or should the buyer decide?
9. **Sealing strength.** Is sealing enforced by the application acceptable for v1, or is encryption at rest needed, with the key released at the deadline?
10. **Portal language.** Dutch only in v1, or Dutch and English from day one? Many indirect suppliers are international.
11. **Attachment types.** PDF only (recommended, reuses the 7b checks), or also xlsx/docx? The latter would need content scanning.
12. **Retention.** How long should losing bids and supplier files be kept, given GDPR and Turso storage?
13. **Preview/Prod DB split timing.** The split gates customer use. Can it be scheduled before 8b's review?
14. **Limits.** Are 50 lines, 20 invitations, and 10 files of 4 MiB per bid acceptable for v1?

### Decided 2026-10-08 (Peter)

- No supplier accounts in v1; magic links only.
- Email: `none` (copy link) by default, plus optional `smtp`. No HTTP provider yet.
- Public tenders/TED stay out of scope.
- Award to PO: a manual "Bestelling(en) aanmaken" step after award approval. POs stay issued as today; no draft PO state in v1.
- SoD threshold €1.000: the owner can't approve their own award above it.
- Minimum 3 quotes above €10.000 is a warning only, not blocking.
- Sealing is app-enforced in v1.
- The portal is NL + EN from day one.
- Attachments are PDF only.
- Limits: 50 lines, 20 invitations, 10 files × 4 MiB.
- The Preview/Prod DB split happens in 8.0. On this project the 7b previews had no Turso variables, so they returned 503 instead of opening production. The split is still required where `vercel:customer` has copied the production URL and token onto Preview.
- Still open: retention, pricing tier, losing-bidder notices (default: the buyer decides on the notice).
