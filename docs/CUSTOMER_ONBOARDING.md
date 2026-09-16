# Onboard a new ProcureFlow customer

This is the operator runbook. Follow it top to bottom for **one new customer**. You do not need to read the rest of the README.

Worked example: **Acme**. Replace `acme` / `Acme` / `admin@acme.test` with the real customer slug, display name, and first-admin email.

**Happy path:** Turso database → Vercel project → env → migrate → bootstrap → smoke → first login.

| Next | Where |
| --- | --- |
| Technical reference (isolation, APIs, env table, rollback details) | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Copy-paste operator checklist | [`scripts/provision-customer.md`](../scripts/provision-customer.md) |
| Env key names (no secrets) | [`.env.example`](../.env.example) |
| Control model / known product limits | [ARCHITECTURE.md](ARCHITECTURE.md) |

---

## What you are installing

ProcureFlow is **one database per customer**. Acme and Beta never share a Turso database, SQLite file, or Vercel project URL.

```
Acme  →  Turso DB procureflow-acme  →  Vercel project procureflow-acme  →  that project’s TURSO_* + SESSION_SECRET
Beta  →  Turso DB procureflow-beta  →  Vercel project procureflow-beta  →  a *different* URL and token
```

The application code is the same. Isolation is the **connection string**. Pasting Acme’s `TURSO_DATABASE_URL` into Beta’s Vercel project **merges** those customers. Do not do that.

Auth is **email + password local to that database** (httpOnly `pf_session` cookie). There is **no SSO / SAML / OIDC** in this phase. The header persona switcher is demo-only — leave it off for a live tenant.

---

## Prerequisites

Do this once on the operator laptop before the first customer.

- [ ] **Node.js 18+** and **npm 9+** (`node -v`, `npm -v`)
- [ ] **GitHub access** to [`pesl98/new_p2p_indirect`](https://github.com/pesl98/new_p2p_indirect) (clone + the Vercel GitHub integration can import it)
- [ ] **Vercel account** that can create a new project from that repo
- [ ] **Turso account** (create at [turso.tech](https://turso.tech) if needed)
- [ ] **Turso CLI**
- [ ] A **password manager** for URL, database token, `SESSION_SECRET`, and the first-admin password. Never commit `.env`, tokens, or `*.db`.

```bash
# Turso CLI (macOS / Linux)
curl -sSfL https://get.tur.so/install.sh | bash
turso --version

# Repo
git clone https://github.com/pesl98/new_p2p_indirect.git
cd new_p2p_indirect
npm install
npm install --prefix server
npm install --prefix client
```

Confirm Node is 18 or newer. The Vercel project should also run Node 18+ (Project → Settings → General → Node.js Version).

---

## 1. Turso account / login

```bash
turso auth login
turso auth whoami
```

Use a Turso org the operator is allowed to create databases in. You do **not** need a Turso org JWT in the app — that token is the wrong kind (see step 3).

---

## 2. Create a classic libSQL database

Create **one** classic libSQL database for this customer. Do **not** pass `--tursodb` (that is a different engine; ProcureFlow talks HTTP `/v2/pipeline` to classic libSQL).

```bash
# Acme
turso db create procureflow-acme
```

Name pattern: `procureflow-<customer-slug>`. Lowercase, no spaces.

Confirm it exists:

```bash
turso db list
turso db show procureflow-acme
```

---

## 3. Database URL + **database token** (not an org JWT)

```bash
# Connection URL (often libsql://…)
turso db show procureflow-acme --url

# Database token for THIS database only
turso db tokens create procureflow-acme
```

Store both in the password manager.

| Right | Wrong |
| --- | --- |
| `turso db tokens create procureflow-acme` | `turso auth token` / org / platform JWT |
| Token minted for **this** database | A token copied from another customer |

`TURSO_AUTH_TOKEN` must be the **database token**. An org JWT looks like it might work and then returns **401** from Turso (the app surfaces that as a 503 configuration error). If you are unsure which token you have, mint a new one with `turso db tokens create` and replace the env var.

---

## 4. Generate `SESSION_SECRET`

This HMAC-signs the httpOnly `pf_session` cookie. Generate a new one **per customer**. Do not reuse Acme’s secret on Beta.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Store the 64-character hex string. You will paste it into Vercel and export it on the laptop for migrate/bootstrap.

---

## 5. Create a **new Vercel project**

Same git repo, **new project** — do not add this customer as a second domain on an existing ProcureFlow project.

1. Vercel dashboard → **Add New… → Project**.
2. **Import** `pesl98/new_p2p_indirect` (or your fork). Grant GitHub access if Vercel asks.
3. **Root Directory** = repository root (leave the default; do not set `client/` or `server/`).
4. Framework: leave as detected / Other. **Do not** invent a build command — [`vercel.json`](../vercel.json) already sets `buildCommand` to `npm run build`.
5. Suggested project name: `procureflow-acme`.
6. Create the project. The first deploy may 503 until env vars exist — that is expected.

What Vercel does on each deploy:

- Runs `npm run build` (Vite → `public/`)
- Deploys [`api/index.js`](../api/index.js) as one Node Function (`includeFiles` keeps `schema.sql`)
- Rewrites `/api/*` to that function
- Serves `public/` on the CDN

There is **no cron**.

---

## 6. Set environment variables (Production **and** Preview)

Vercel project → **Settings → Environment Variables**. Set all three for **Production and Preview** (or **All Environments**). Preview URLs stay broken if the vars are Production-only.

| Variable | Value | Production | Preview |
| --- | --- | --- | --- |
| `TURSO_DATABASE_URL` | Output of `turso db show procureflow-acme --url` | ✓ | ✓ |
| `TURSO_AUTH_TOKEN` | Output of `turso db tokens create procureflow-acme` | ✓ | ✓ |
| `SESSION_SECRET` | The hex string from step 4 | ✓ | ✓ |

Leave **unset** (do not add):

| Variable | Why |
| --- | --- |
| `DEMO_PERSONA_SWITCHER` | Default is off. Set to `1` only for a training demo that should show the header persona switcher. Live customers use login. |

Do **not** set `PROCUREMENT_DB_PATH` on Vercel. Local SQLite is not available in serverless.

Save. **Env changes do not apply to an already-built deployment.**

---

## 7. Deploy / Redeploy after env change

1. Deployments → ⋮ on the latest deployment → **Redeploy** (or push a no-op if you prefer a fresh git deploy).
2. Wait until Ready.
3. Copy the Production URL (`https://procureflow-acme.vercel.app` or the project’s alias).

Opening the URL before Redeploy often still shows the 503 Turso setup page. Redeploy, then continue.

---

## 8. From the laptop: migrate, then bootstrap (do **not** seed)

Use the **same** `TURSO_*` you pasted into Vercel. Schema does **not** apply itself usefully for operators — first process start can call `applySchema`, but you want `db:migrate` so you see health before handing over the URL.

```bash
cd /path/to/new_p2p_indirect

export TURSO_DATABASE_URL='libsql://…'    # Acme URL from step 3
export TURSO_AUTH_TOKEN='…'               # Acme *database* token from step 3
export SESSION_SECRET='…'                 # same value as Vercel

# Optional: fail closed if TURSO_* are missing
npm run db:migrate -- --turso
npm run db:status
```

`db:status` prints mode (`turso-http`), table count, and user count. It never prints `TURSO_AUTH_TOKEN`. On a fresh customer you should see **0 users**.

### First admin (pick one)

**A — CLI (preferred for operators)**

```bash
npm run bootstrap-admin -- \
  --name "Ada Admin" \
  --email admin@acme.test \
  --password 'choose-a-long-password'
```

**B — one-shot wrapper** (migrate + bootstrap; still **never seeds**)

```bash
npm run provision:customer -- \
  --name "Ada Admin" \
  --email admin@acme.test \
  --password 'choose-a-long-password'
```

**C — UI** if the database still has 0 users: open the Production URL, use **Create the first admin** (name, email, password ≥ 8 characters).

The CLI **refuses** (exit 2) if any users already exist. Additional people are created in the UI, not by running bootstrap again.

### Do not seed a real customer

| Goal | Command |
| --- | --- |
| Real customer | `db:migrate` → `bootstrap-admin` (or `provision:customer`) → `smoke` |
| Demo / training wipe | `npm run seed` (**destructive**: drops all app tables, loads Alice/Bob/… and password `ProcureFlow!demo`) |

```bash
# DEMO ONLY — wipes whatever TURSO_* / SQLite this shell points at
# npm run seed
```

---

## 9. First admin login; create additional users

1. Open `https://<acme-project>.vercel.app`.
2. Sign in with the bootstrap email and password.
3. You should land in the app, not the demo persona switcher.
4. **Administration → Users** (admin role only):
   - Create requesters, approvers, procurement, finance, and extra admins.
   - Unique email, role, optional department, title, approval limit (dollars in the form; stored as integer cents).
   - Set a password on create, or **Set password** later.
   - Soft-deactivate instead of delete (`DELETE` is 405).

Hand each person their own password. Do **not** share `ProcureFlow!demo` on a live tenant.

---

## 10. Smoke the hostname

From the same laptop (app does not need to be running locally — smoke is HTTP against `BASE_URL`):

```bash
export BASE_URL=https://<acme-project>.vercel.app
npm run smoke

# Optional login check (after bootstrap):
npm run smoke -- --email admin@acme.test --password 'choose-a-long-password'
```

Expect exit 0. The script hits `/api/health`, `/api/auth/config`, `/api/users`, unauthenticated `/api/auth/me` (must be **401**), plus departments/catalog.

- Empty tenant (migrate only): `bootstrapNeeded: true`, `/api/users` → `[]`.
- After bootstrap: `bootstrapNeeded: false`.

Machine-readable: `npm run smoke -- --json`.

---

## 11. Optional: departments and department approvers

Do this **after** users exist. Step-1 approval is the mapped department head (`departments.approver_user_id`).

**Administration → Department Approvers** (admin UI) assigns a head on **existing** departments. It does **not** create cost centers.

Honest limit: there is **no in-app “create department” or “create budget” form**. `db:migrate` leaves `departments` and `budgets` empty. Until you insert rows, PRs cannot be submitted (approval policy fails closed with no department head). Fiscal year in queries is **2026**.

Insert from the laptop (same `TURSO_*`), then map heads in the UI:

```bash
# Example cost centers — edit codes/names/cents for the customer
# total_budget is integer cents ($100,000.00 = 10000000)
turso db shell procureflow-acme <<'SQL'
INSERT INTO departments (code, name) VALUES
  ('MKT', 'Marketing'),
  ('ITE', 'IT'),
  ('FAC', 'Facilities'),
  ('HRP', 'HR'),
  ('ADM', 'Finance');

INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
SELECT id, 2026, 10000000, 0, 0 FROM departments;
SQL
```

Then:

1. Administration → Users — set each person’s department if you skipped it at create.
2. Administration → Department Approvers — pick a step-1 head per cost center.
3. Catalog and suppliers are also empty until someone with access adds them under **Vendors & Catalog** (create APIs exist; this is not a Coupa master-data migration).

Skip this section if you are only proving login + admin user CRUD.

---

## 12. Second customer = second Turso DB + second Vercel project

Never share a URL.

```bash
turso db create procureflow-beta
export TURSO_DATABASE_URL="$(turso db show procureflow-beta --url)"
export TURSO_AUTH_TOKEN="$(turso db tokens create procureflow-beta)"
export SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"

npm run provision:customer -- \
  --email admin@beta.test \
  --password 'choose-a-long-password'
```

Then: **new** Vercel project (or duplicate Acme’s project), **replace** both Turso variables and `SESSION_SECRET`, Production + Preview, Redeploy, smoke `BASE_URL=https://<beta>.vercel.app`.

Leaving Acme’s URL in place would serve Acme’s data as Beta.

Local SQLite pair (laptop / air-gapped only — not Vercel):

```bash
unset TURSO_DATABASE_URL TURSO_AUTH_TOKEN
export PROCUREMENT_DB_PATH="$PWD/server/data/acme.db"
npm run provision:customer -- --email admin@acme.test --password 'choose-a-long-password'
```

Do not commit `*.db` (`server/data/` is gitignored).

---

## Operator checklist (Acme)

Copy this into the ticket and tick as you go.

- [ ] Node 18+, Turso CLI logged in, GitHub + Vercel access
- [ ] `turso db create procureflow-acme` (**classic libSQL**, no `--tursodb`)
- [ ] `turso db show procureflow-acme --url` stored
- [ ] `turso db tokens create procureflow-acme` stored (**database token**, not org JWT)
- [ ] New `SESSION_SECRET` generated and stored
- [ ] **New** Vercel project; root = repo root; build from `vercel.json`
- [ ] Env on **Production and Preview**: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SESSION_SECRET`
- [ ] `DEMO_PERSONA_SWITCHER` left unset
- [ ] **Redeploy** after saving env
- [ ] Laptop `export` of the same `TURSO_*` (+ `SESSION_SECRET`)
- [ ] `npm run db:migrate` then `npm run bootstrap-admin` (or `npm run provision:customer -- --email … --password …`)
- [ ] **Did not** `npm run seed`
- [ ] First admin can sign in at the Production URL
- [ ] Extra users created in Administration → Users
- [ ] `BASE_URL=https://<acme>.vercel.app npm run smoke` exit 0
- [ ] (Optional) departments inserted; heads assigned after those users exist
- [ ] Secrets only in Vercel + password manager — not in git, screenshots, or chat logs

---

## Honest limits (read once)

Hand this to the customer with the URL so nobody assumes Coupa-parity.

- **No SSO / SAML / OIDC.** Login is email + bcrypt password in this customer’s database. `SESSION_SECRET` only signs the cookie; it is not an IdP client secret.
- **Not a full authorization rewrite.** Admin user CRUD uses the session (`req.user`). Many P2P routes still accept body persona ids (`requester_id`, `approver_id`, `actor_name`, …). Anyone who can reach those APIs can still send another person’s id. That is a known phased cut, not a security boundary.
- **No `org_id` multi-tenancy.** Two customers on one Turso URL is one pile of data.
- **Persona switcher is demo-only** (`DEMO_PERSONA_SWITCHER=1`). Default customer UI is login.
- **Empty tenant is empty.** No catalog, suppliers, departments, budgets, or sample PRs until you add them. `npm run seed` is a **wipe**, not an overlay.
- **No department/budget create UI.** Map heads in Administration → Department Approvers after rows exist (SQL above, or a future feature).
- **Fiscal year 2026** is hardcoded in budget queries.
- **No cron**, no bank NACHA export, no OCR invoice capture.

Product detail: [ARCHITECTURE.md](ARCHITECTURE.md) “Known demo limits”.

---

## Troubleshooting

### Login fails: users exist, but nobody has a password

Typical of a **legacy seed from before auth** (`users` rows, empty `user_credentials`). Login returns 401. `GET /api/auth/config` has `bootstrapNeeded: false` (users exist, so the UI will **not** show Create the first admin). `npm run bootstrap-admin` exits **2** (`already has users`).

| Situation | Fix |
| --- | --- |
| Disposable demo DB | `npm run seed` — **destructive** wipe + personas + `ProcureFlow!demo` |
| At least one admin can already log in | Administration → Users → **Set password** for the others |
| Nobody can log in and you must keep going | Wipe / recreate (see rollback), then `db:migrate` → `bootstrap-admin`. Bootstrap will not run while any users exist. |

Do not paste the demo password onto a live tenant you intend to keep.

### HTTP 503 / `TursoConfigError` (missing Turso on Vercel)

The HTML setup page or JSON `{ "error": "TursoConfigError" }` means `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are not both visible to that deployment.

- Set both on **Production and Preview**, then **Redeploy**.
- Smoke prints a Production+Preview / Redeploy hint in this case.
- Partial credentials (URL xor token) are fail-closed — the CLI will not silently open a local SQLite file.

### HTTP 401 from Turso / “token rejected” (org JWT)

The token is the wrong kind (org/platform JWT, or a token for a **different** database).

```bash
turso db tokens create procureflow-acme
```

Paste that into `TURSO_AUTH_TOKEN` (Production + Preview) and Redeploy. Do not use `turso auth token`.

### Preview URL broken; Production works

Preview is missing env. Add the three variables to Preview (or All Environments) and Redeploy **that** Preview. Env edits do not retrofit an old Preview deployment.

### `SESSION_SECRET` missing / sessions die after Redeploy

- If unset, local/dev uses an insecure default and logs a warning. Customer / Vercel deploys **must** set it.
- Changing `SESSION_SECRET` invalidates every existing `pf_session` cookie — users sign in again. That is expected on rotate.
- Production and Preview must use a secret (they may share one per customer project; do **not** share across customers).

### Smoke fails against Vercel; laptop migrate worked

- Confirm `BASE_URL` has no trailing path (`https://….vercel.app`, not `/login`).
- Confirm you Redeployed after env changes.
- `npm run db:status` on the laptop with the same `TURSO_*` should show `turso-http` and the user count you expect.

### First deploy built before env existed

Redeploy. Do not debug the 503 as an application bug until a deployment that was **built** with the vars is Ready.

---

## Rollback / wipe / deprovision

**Local SQLite**

```bash
rm -f "$PROCUREMENT_DB_PATH" "$PROCUREMENT_DB_PATH"-wal "$PROCUREMENT_DB_PATH"-shm
npm run db:migrate
```

**Turso (irreversible)**

```bash
turso db destroy procureflow-acme --yes
turso db create procureflow-acme
# new URL + new database token → update Vercel env → Redeploy
export TURSO_DATABASE_URL="$(turso db show procureflow-acme --url)"
export TURSO_AUTH_TOKEN="$(turso db tokens create procureflow-acme)"
npm run db:migrate
npm run bootstrap-admin -- --email admin@acme.test --password 'choose-a-long-password'
```

**Vercel**

- **Instant Rollback** reverts **code** only. The Turso database is not rolled back.
- Data rollback = restore a Turso dump, or recreate + migrate (+ optional destructive seed). Pointing the project at a previous database URL is a data rollback only if that DB still exists.

**Deprovision Acme**

1. Remove or empty the Vercel project (or unset env so it cannot serve data).
2. `turso db destroy procureflow-acme --yes`.
3. Rotate/delete stored secrets in the password manager.

Leaving the Turso DB alive after deleting the Vercel project still holds all P2P data.

---

## Laptop demo (not a customer)

The README walkthrough still uses local SQLite + seed. That is **training**, not onboarding.

```bash
unset TURSO_DATABASE_URL TURSO_AUTH_TOKEN
npm install
npm run seed          # local server/data/procurement.db — destructive
# optional: export DEMO_PERSONA_SWITCHER=1
npm run dev           # API :5000 + Vite :3000
```

Demo login: `alice.chen@company.com` / `ProcureFlow!demo`.
