# ProcureFlow customer deployment

ProcureFlow is installed **one database per customer**. Customer A and customer B never share a SQLite file or Turso database. There is **no** shared-row `org_id` multi-tenancy. Authentication is therefore **local to that database** — a login on tenant A cannot see users in tenant B.

This is the human install path. Operator copy-paste lives in [`scripts/provision-customer.md`](../scripts/provision-customer.md). Dual-mode (local `better-sqlite3` vs Turso HTTP on Vercel) is unchanged. Env keys (no secrets) are listed in [`.env.example`](../.env.example).

**Real customer sequence:** `npm run db:migrate` → `npm run bootstrap-admin` → `npm run smoke`. Wrapper: `npm run provision:customer` (optional `--email` / `--password`; **never seeds**). Demo wipe stays opt-in: `npm run seed`.

**Auth (this phase):** email + bcrypt password in `user_credentials`, httpOnly `pf_session` cookie, admin user CRUD on `req.user`. SSO / SAML / OIDC is **out of scope** (next). The header persona switcher is **demo-only** (`DEMO_PERSONA_SWITCHER=1`; default **off**). Legacy P2P routes still accept body `requester_id` / `approver_id` — that is not a full authorization boundary.

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

**Session cookie** (customer / Vercel):

```bash
export SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
```

On Vercel, set **both** Turso variables **and** `SESSION_SECRET` for **Production and Preview** (or All Environments). Preview URLs stay broken if the vars are Production-only. Env changes do not apply to an already-built Preview — Redeploy.

| Variable | Required | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | **Yes in customer / Vercel deploys** | HMAC key for the `pf_session` httpOnly cookie. If unset, local/dev uses an insecure default and production/Vercel logs a warning. |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Vercel; optional locally | Tenant database. Auth rows live here. |
| `PROCUREMENT_DB_PATH` | No | Override local SQLite path. |
| `DEMO_PERSONA_SWITCHER` | No | Set to `1` to show the header persona switcher (demo only). Default **off** — customer deploys use login. |
| `BCRYPT_ROUNDS` | No | bcrypt cost (default 10). |
| `BASE_URL` | Smoke only | Origin for `npm run smoke` (`http://127.0.0.1:5000` or the customer Vercel URL). |
| `SMOKE_EMAIL` / `SMOKE_PASSWORD` | Smoke only | Optional login check after bootstrap. |

---

## 3. Apply schema (`applySchema`) — no demo data

From the repo root (Node 18+, `npm install`):

```bash
npm run db:migrate
npm run db:status
```

`db:migrate` connects with the env above, runs `schema.sql` plus the existing migrations in `server/src/db.js` (`CREATE TABLE IF NOT EXISTS` + `ALTER` / rebuilds, including `users.status` and `user_credentials`). It does **not** load Alice/Bob/Carol sample PRs unless you pass `--seed`.

`db:status` prints mode (`sqlite` / `turso-http`), table count vs expected, and user count. It does **not** apply schema, so you can tell an empty file from a migrated one. It never prints `TURSO_AUTH_TOKEN`.

Machine-readable:

```bash
npm run db:migrate -- --json
npm run db:status -- --json
npm run db:migrate -- --turso          # fail if TURSO_* are unset
```

First process start (`npm start` / Vercel cold start) also calls `applySchema` on an empty DB. Prefer `db:migrate` so you see health before traffic.

---

## 4. First admin bootstrap (empty tenant)

After `db:migrate`, the customer DB has **0 users**. Until a user exists, `GET /api/auth/config` returns `{ bootstrapNeeded: true }` and the UI shows **Create the first admin**. `npm run provision:customer` is migrate plus this step when `--email` and `--password` are passed; it still **does not seed**.

### Option A — UI

Open the app with no users in the DB. Submit name, email, and password (≥ 8 characters). That calls `POST /api/auth/bootstrap`, hashes the password with bcrypt, writes `users` + `user_credentials`, and sets an httpOnly session cookie.

### Option B — CLI (same database the server uses)

```bash
# Local SQLite (default server/data/procurement.db, or PROCUREMENT_DB_PATH)
npm run bootstrap-admin -- \
  --name "Ada Admin" \
  --email ada@customer.com \
  --password 'choose-a-long-password'

# Turso tenant: same TURSO_* the app uses
export TURSO_DATABASE_URL=libsql://…
export TURSO_AUTH_TOKEN=…
npm run bootstrap-admin -- --email ada@customer.com --password '…'
# equivalent: node server/src/bootstrapAdmin.js --email ada@customer.com --password '…'
```

The CLI **refuses** if any users already exist (exit 2). After that, sign in as that admin and use **Administration → Users** to create more people.

One-shot empty tenant (still no demo data):

```bash
npm run provision:customer -- \
  --email ada@customer.com \
  --password 'choose-a-long-password'
```

---

## 5. Optional demo seed vs empty customer

| Goal | Command | Result |
| --- | --- | --- |
| Real customer | `db:migrate` then `bootstrap-admin` (or `provision:customer`) then `smoke` | Empty tables until first admin. Catalog, PRs, invoices stay blank. |
| Demo / training | `npm run seed` or `npm run db:migrate -- --seed` | **Destructive:** drops all app tables, reapplies schema, loads persona demo data + demo password |

```bash
# Demo only — wipes the database this env points at
npm run seed
```

Seed is the existing `server/src/seed.js` path. Do **not** run `npm run seed` against a production customer unless you intend to replace their data with the fictional walkthrough (Alice/Bob/… and the README demo password `ProcureFlow!demo`).

**Empty-customer UI:** the login page is the default. With 0 users it shows first-admin bootstrap, not a broken persona switcher. `GET /api/users` → `[]` is valid. Leave `DEMO_PERSONA_SWITCHER` unset on a live tenant.

---

## 6. Vercel: one project (or clone) per customer

Same git repo, **separate Vercel projects**, each with its own Turso pair. Never paste customer A’s `TURSO_DATABASE_URL` into customer B.

### Per-customer checklist

- [ ] **New Vercel project** for this customer (Add New Project → import `pesl98/new_p2p_indirect` or your fork). Root directory = repo root. Build command is already `npm run build` in [`vercel.json`](../vercel.json).
- [ ] **Dedicated Turso DB** (`turso db create procureflow-<customer>`). Do **not** reuse another customer’s URL or token.
- [ ] Settings → Environment Variables — set **Production and Preview** (or All Environments). Preview URLs stay broken if vars are Production-only:

  | Variable | Value |
  | --- | --- |
  | `TURSO_DATABASE_URL` | This customer’s `turso db show … --url` |
  | `TURSO_AUTH_TOKEN` | This customer’s database token |
  | `SESSION_SECRET` | Long random string (signs the httpOnly session cookie) |

- [ ] Leave `DEMO_PERSONA_SWITCHER` unset (login, not the demo header switcher).
- [ ] **Redeploy** after saving env. Env changes do not apply to an already-built Preview.
- [ ] From a laptop with the same `TURSO_*`: `npm run db:migrate` then `npm run bootstrap-admin` (or `npm run provision:customer -- --email … --password …`). Do **not** `npm run seed`.
- [ ] Smoke the hostname: `BASE_URL=https://<customer-project>.vercel.app npm run smoke`

Deploy itself: Vercel runs `npm run build` (Vite → `public/`), deploys [`api/index.js`](../api/index.js) as one Node Function (`includeFiles` keeps `schema.sql`), rewrites `/api/*` to that function, and serves `public/` on the CDN. There is **no cron**.

Repeat as a **second project** (or duplicate) for customer B. To clone: duplicate the project, **replace** both Turso variables and `SESSION_SECRET`, Redeploy. Leaving the old URL in place would serve customer A’s data as customer B.

Entrypoints (unchanged):

| File | Role |
| --- | --- |
| [`api/index.js`](../api/index.js) | Vercel Node Function — default-exports Express |
| [`server/src/app.js`](../server/src/app.js) | Express factory (API + lazy DB init). Does not `listen`. |
| [`server/src/index.js`](../server/src/index.js) | Local listen on `PORT` (default 5000) |

---

## 7. Smoke (`npm run smoke`)

After migrate (and usually bootstrap), verify the running app — laptop or Vercel. The script checks `/api/health`, `/api/auth/config`, `/api/users`, unauthenticated `/api/auth/me` (401), plus departments/catalog. Exit 1 on failure.

```bash
# Laptop (app must be listening)
npm start
npm run smoke
# or: BASE_URL=http://127.0.0.1:5000 npm run smoke

# After bootstrap, optional login check:
npm run smoke -- --email ada@customer.com --password 'choose-a-long-password'

# Vercel customer hostname
BASE_URL=https://<customer-project>.vercel.app npm run smoke
```

Empty customer: `bootstrapNeeded: true` and `/api/users` → `[]`. After bootstrap or seed: `bootstrapNeeded: false`. Machine-readable: `npm run smoke -- --json`.

Missing Turso on Vercel is **503** with a setup page (HTML) or JSON `{ "error": "TursoConfigError" }` for `/api/*`. Smoke prints a Production+Preview / Redeploy hint in that case.

A 401 from Turso usually means an **org JWT** was pasted instead of `turso db tokens create`.

---

## 8. Auth API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/auth/config` | `{ auth, demoPersonaSwitcher, bootstrapNeeded }` — public |
| `POST` | `/api/auth/login` | `{ email, password }` → httpOnly `pf_session` cookie |
| `POST` | `/api/auth/logout` | Clears the cookie |
| `GET` | `/api/auth/me` | Session user or 401 |
| `POST` | `/api/auth/bootstrap` | First admin only (empty `users` table) |

Cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `VERCEL` or `NODE_ENV=production`. TTL 7 days.

Passwords are bcrypt hashes in `user_credentials`. They are never returned on `GET /api/users` or `/api/auth/me`.

### Admin user management

Signed-in **admin** (`req.user.role === 'admin'`):

| Method | Path |
| --- | --- |
| `GET` | `/api/users` (optional `?status=active\|inactive\|all`) — list stays demo-open so the optional persona switcher can load people |
| `POST` | `/api/users` — create (name, unique email, role, department_id, title, approval_limit cents, optional password) |
| `PATCH` | `/api/users/:id` — edit core fields |
| `PATCH` | `/api/users/:id/status` — `active` / `inactive` (soft-deactivate) |
| `POST` | `/api/users/:id/password` — set / reset password |
| `DELETE` | `/api/users/:id` — **405** (deactivate instead) |

Mutating routes require the session cookie and an admin role. The header persona switcher cannot spoof `req.user` for these paths.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the phased cut: leftover P2P routes still accept body persona ids (`approver_id`, `requester_id`, …) until a follow-up.

---

## 9. Secrets checklist

Store these in Vercel env / a password manager. **Never commit** `.env`, tokens, or `*.db`.

| Secret | Required | Notes |
| --- | --- | --- |
| `TURSO_AUTH_TOKEN` | Turso / Vercel | Database token only. Rotate with `turso db tokens create` and Redeploy. |
| `TURSO_DATABASE_URL` | Turso / Vercel | Identifies the customer DB. Not a password, still treat as sensitive. |
| `SESSION_SECRET` | Customer / Vercel | Signs the httpOnly session cookie. Generate a long random string. Rotate by changing the env and Redeploy (existing sessions invalidate). |
| `PROCUREMENT_DB_PATH` | SQLite only | Filesystem path; protect the file (contains all P2P data). |
| SSO / SAML / OIDC | **Not used** | Email+password local to this DB. No IdP client secret to set. |

Also confirm:

- [ ] Customer A and B have **different** Turso URLs (or different SQLite paths)
- [ ] Preview **and** Production env vars are set (`TURSO_*` and `SESSION_SECRET`)
- [ ] `.env` / `.env.local` are gitignored (already)
- [ ] Tokens are not in `vercel.json`, README, or screenshots
- [ ] Seed was skipped for a real customer (or accepted as a wipe)
- [ ] First admin was created via bootstrap (UI or `npm run bootstrap-admin`), not by sharing the demo password
- [ ] `BASE_URL=https://<this-customer>.vercel.app npm run smoke` passed after Redeploy

---

## 10. Rollback / wipe / re-seed

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

## Laptop demo

The existing main demo still works. Seed creates Alice/Bob/… with the README demo password `ProcureFlow!demo`.

```bash
unset TURSO_DATABASE_URL TURSO_AUTH_TOKEN
npm install
npm run seed          # local server/data/procurement.db
# optional: export DEMO_PERSONA_SWITCHER=1   # keep the header switcher
npm run dev           # API :5000 + Vite :3000
# or: npm start       # http://localhost:5000
npm test
```

Customer path: empty DB → `npm run db:migrate` → `npm run bootstrap-admin` → `npm start` → `npm run smoke`. Leave `DEMO_PERSONA_SWITCHER` unset. Env template: [`.env.example`](../.env.example).

See [README.md](../README.md) walkthroughs and [ARCHITECTURE.md](ARCHITECTURE.md) for the P2P control model.
