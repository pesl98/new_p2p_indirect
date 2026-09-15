# ProcureFlow customer deployment

ProcureFlow is installed **one database per customer**. Customer A and customer B never share a SQLite file or Turso database. There is **no** shared-row `org_id` multi-tenancy.

This is the human install path. Operator copy-paste lives in [`scripts/provision-customer.md`](../scripts/provision-customer.md). Dual-mode (local `better-sqlite3` vs Turso HTTP on Vercel) is unchanged.

**Auth caveat (honest):** the header persona switcher is **client-only demo auth**. It is not SSO, JWT, or sessions. Anyone who can reach the API can send any `requester_id` / `approver_id`. Do not treat a customer deploy as an authorization boundary until SSO ships (out of scope).

Feature work (new match / OCR / exception / payment / contract capabilities) is paused in favor of this install path.

---

## Isolation model

```
Customer A  →  Turso DB A  (or SQLite file A)  →  Vercel project A  →  TURSO_* for A
Customer B  →  Turso DB B  (or SQLite file B)  →  Vercel project B  →  TURSO_* for B
```

The application code and schema are identical. Isolation is the **connection string** (or `PROCUREMENT_DB_PATH`), not a tenant column. Pointing two projects at the same Turso URL **merges** those customers — do not do that.

| Mode | When | Connection |
| --- | --- | --- |
| Local SQLite | `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` both **omitted** | `better-sqlite3` file (`PROCUREMENT_DB_PATH` or `server/data/procurement.db`) |
| Turso HTTP | **both** URL and token set | `POST /v2/pipeline` (no native libsql `.so`) |
| Vercel | `VERCEL` / `VERCEL_ENV` | Turso **required**. Missing pair → HTML/JSON 503, not a local file |

Partial Turso credentials (URL xor token) are **fail-closed** on `npm run db:migrate` / `db:status`. The CLI will not silently create a local SQLite file.

---

## 1. Create an empty database for customer X

### Turso (typical customer / Vercel)

Classic libSQL database (not `--tursodb`). Token must be a **database token**, not an org/platform JWT:

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login

# Customer A
turso db create procureflow-acme
turso db show procureflow-acme --url
turso db tokens create procureflow-acme

# Customer B (separate database — do not reuse Acme’s URL or token)
turso db create procureflow-beta
turso db show procureflow-beta --url
turso db tokens create procureflow-beta
```

### Local SQLite (laptop, air-gapped, or a file-per-customer VM)

```bash
# Customer A
export PROCUREMENT_DB_PATH="$PWD/server/data/acme.db"
unset TURSO_DATABASE_URL TURSO_AUTH_TOKEN

# Customer B
export PROCUREMENT_DB_PATH="$PWD/server/data/beta.db"
```

Do not commit `*.db` files (`server/data/` is gitignored).

---

## 2. Set connection env

**Turso**

```bash
export TURSO_DATABASE_URL='libsql://…'   # from `turso db show … --url`
export TURSO_AUTH_TOKEN='…'              # from `turso db tokens create …`
```

**SQLite** — omit both Turso variables; optionally set `PROCUREMENT_DB_PATH`.

On Vercel, set **both** Turso variables for **Production and Preview** (or All Environments). Preview URLs stay broken if the vars are Production-only. Env changes do not apply to an already-built Preview — Redeploy.

---

## 3. Apply schema (`applySchema`) — no demo data

From the repo root (Node 18+, `npm install`):

```bash
npm run db:migrate
npm run db:status
```

`db:migrate` connects with the env above, runs `schema.sql` plus the existing migrations in `server/src/db.js` (`CREATE TABLE IF NOT EXISTS` + `ALTER` / rebuilds). It does **not** load Alice/Bob/Carol sample PRs unless you pass `--seed`.

`db:status` prints mode (`sqlite` / `turso-http`), table count vs expected, and user count. It does **not** apply schema, so you can tell an empty file from a migrated one. It never prints `TURSO_AUTH_TOKEN`.

Machine-readable:

```bash
npm run db:migrate -- --json
npm run db:status -- --json
npm run db:migrate -- --turso          # fail if TURSO_* are unset
```

First process start (`npm start` / Vercel cold start) also calls `applySchema` on an empty DB. Prefer `db:migrate` so you see health before traffic.

---

## 4. Load the customer’s people (bootstrap) vs demo seed

`GET /api/users` and `GET /api/departments` are **read-only**. There is no POST to create the first department or user (SSO/onboarding APIs are out of scope). After migrate, a real tenant is initialized with a **JSON org file**, not with the API and not with `npm run seed`.

| Goal | Command | Result |
| --- | --- | --- |
| Real customer | `db:migrate` then `db:bootstrap -- --file <org.json>` | Schema plus *their* departments, users, FY2026 budgets, optional step-1 approvers. **Non-destructive** (skips existing codes/emails). |
| Schema only | stop after `db:migrate` | Empty tables (0 users). `GET /api/users` → `[]`. The persona picker is empty; PR/PO FKs cannot start until bootstrap (or seed). |
| Demo / training | `npm run seed` or `npm run db:migrate -- --seed` | **Destructive:** drops all app tables, reapplies schema, loads Alice/Bob/Carol walkthrough data |

Copy [`scripts/customer-org.example.json`](../scripts/customer-org.example.json), edit emails/names/codes/budget cents, then:

```bash
npm run db:bootstrap -- --file ./acme-org.json
npm run db:status
curl -s http://localhost:5000/api/users
curl -s http://localhost:5000/api/departments
```

Re-running bootstrap against the same file skips rows that already exist (department `code`, user `email`, budget year). It will not overwrite an existing department-head mapping. Integer cents only (`total_budget_cents`, `approval_limit_cents`). Roles must be `requester` / `approver` / `procurement` / `finance` / `admin`. `approver_email` on a department must match a user in that file.

**Do not** seed a production customer unless you intend to replace their data with the fictional walkthrough:

```bash
# Demo only — wipes the database this env points at
npm run seed
```

**Auth caveat:** bootstrap users appear in the header persona switcher the same way seeded personas do. That switcher is still **client-only demo auth**, not SSO. Anyone who can reach the API can send any user id.

---

## 5. Vercel: one project (or clone) per customer

Same git repo, **separate Vercel projects**, each with its own Turso pair.

1. Vercel → Add New Project → import `pesl98/new_p2p_indirect` (or your fork).
2. Root directory = repo root. Build command is already `npm run build` in [`vercel.json`](../vercel.json).
3. Settings → Environment Variables (Production **and** Preview):

   | Variable | Value |
   | --- | --- |
   | `TURSO_DATABASE_URL` | This customer’s `turso db show … --url` |
   | `TURSO_AUTH_TOKEN` | This customer’s database token |

4. Deploy. Vercel runs `npm run build` (Vite → `public/`), deploys [`api/index.js`](../api/index.js) as one Node Function (`includeFiles` keeps `schema.sql`), rewrites `/api/*` to that function, and serves `public/` on the CDN. There is **no cron**.
5. Repeat for customer B as a **second project** (or duplicate). Do not share env vars across customers.

Entrypoints (unchanged):

| File | Role |
| --- | --- |
| [`api/index.js`](../api/index.js) | Vercel Node Function — default-exports Express |
| [`server/src/app.js`](../server/src/app.js) | Express factory (API + lazy DB init). Does not `listen`. |
| [`server/src/index.js`](../server/src/index.js) | Local listen on `PORT` (default 5000) |

To clone an existing Vercel project: duplicate it, **replace** both Turso variables, Redeploy. Leaving the old URL in place would serve customer A’s data as customer B.

---

## 6. Smoke URLs

After migrate (laptop against the customer DB, or the Vercel hostname):

```bash
# Laptop
npm start
curl -s http://localhost:5000/api/health
# expect: { "status":"ok", "db":"sqlite" }  or  "db":"turso-http"

curl -s http://localhost:5000/api/users
# after migrate only: []
# after db:bootstrap: the org file’s users
# after npm run seed: Alice / Bob / Carol / …

curl -s http://localhost:5000/api/catalog
curl -s http://localhost:5000/api/departments
```

On Vercel, same paths on `https://<customer-project>.vercel.app/api/health` (and `/api/users`, `/api/catalog`). Missing Turso on Vercel is **503** with a setup page (HTML) or JSON `{ "error": "TursoConfigError" }` for `/api/*`.

A 401 from Turso usually means an **org JWT** was pasted instead of `turso db tokens create`.

---

## 7. Secrets checklist

Store these in Vercel env / a password manager. **Never commit** `.env`, tokens, or `*.db`.

| Secret | Required | Notes |
| --- | --- | --- |
| `TURSO_AUTH_TOKEN` | Turso / Vercel | Database token only. Rotate with `turso db tokens create` and Redeploy. |
| `TURSO_DATABASE_URL` | Turso / Vercel | Identifies the customer DB. Not a password, still treat as sensitive. |
| `PROCUREMENT_DB_PATH` | SQLite only | Filesystem path; protect the file (contains all P2P data). |
| SSO / JWT / IdP | **Not used** | Persona demo auth only. No client secret to set. |

Also confirm:

- [ ] Customer A and B have **different** Turso URLs (or different SQLite paths)
- [ ] Preview **and** Production env vars are set
- [ ] `.env` / `.env.local` are gitignored (already)
- [ ] Tokens are not in `vercel.json`, README, or screenshots
- [ ] Seed was skipped for a real customer (or accepted as a wipe)
- [ ] Real customer used `db:bootstrap -- --file` (not POST /api/users — that route does not exist)

---

## 8. Rollback / wipe / re-seed

**Local SQLite**

```bash
# Wipe this customer file, then migrate to an empty schema again
rm -f "$PROCUREMENT_DB_PATH" "$PROCUREMENT_DB_PATH"-wal "$PROCUREMENT_DB_PATH"-shm
npm run db:migrate
```

**Turso**

```bash
# Destroy is irreversible. Recreate a new empty DB, then migrate.
turso db destroy procureflow-acme --yes
turso db create procureflow-acme
# new URL + token → update env / Vercel → Redeploy
npm run db:migrate
```

**Re-seed (destructive demo)**

```bash
npm run seed
# or: npm run db:migrate -- --seed
```

This drops every application table on the **currently configured** database and reloads sample data. There is no in-app “undo”. Point env at the intended customer first.

**Vercel rollback**

- Instant Rollback to a previous deployment in the Vercel dashboard (code only; the Turso DB is not reverted).
- To roll back **data**, restore a Turso dump / recreate + migrate / re-seed. Pointing the project at a previous database URL is a data rollback if that DB still exists.
- To deprovision: remove the Vercel project (or unset env) **and** `turso db destroy` so the isolated DB is gone.

---

## Laptop demo (unchanged)

The existing main demo still works:

```bash
unset TURSO_DATABASE_URL TURSO_AUTH_TOKEN
npm install
npm run seed          # local server/data/procurement.db
npm run dev           # API :5000 + Vite :3000
# or: npm start       # http://localhost:5000
npm test
```

See [README.md](../README.md) walkthroughs and [ARCHITECTURE.md](ARCHITECTURE.md) for the P2P control model.
