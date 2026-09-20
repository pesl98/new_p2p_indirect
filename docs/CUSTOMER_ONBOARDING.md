# Onboard a new ProcureFlow customer

This is the operator runbook. Follow it top to bottom for **one new customer**. You do not need to read the rest of the README.

Worked example: **Acme**. Replace `acme` / `Acme` / `admin@acme.test` with the real customer slug, display name, and first-admin email.

**Happy path (preferred):** one operator command. Dry-run first (no network); `--apply` chains Turso → Vercel env → provision. `--with-org` is **on by default** here. Secrets minted by Turso stay in-process — you do not copy `export` lines between commands.

```bash
npm run onboard:customer -- --slug acme
npm run onboard:customer -- --slug acme --apply \
  --email admin@acme.test --password 'choose-a-long-password' \
  --name "Ada Admin"
# optional once Production is Ready: add --smoke
```

Still create the Vercel project in the dashboard and `vercel link --yes --project procureflow-acme` once per clone. If the project is not linked, `--apply` stops after Turso with those next steps (it does **not** create Vercel projects).

**Stepped path (explicit/advanced):** `npm run turso:customer -- --apply` → create/link Vercel project → `npm run vercel:customer -- --apply` → `provision:customer -- --with-org` → smoke → first login. Same sequence as the orchestrator; use it when you need to re-run one step.

| Next | Where |
| --- | --- |
| **System manual** (what the app can do + deploy overview) | **[SYSTEM_MANUAL.md](SYSTEM_MANUAL.md)** |
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
- [ ] **Turso CLI** — used by `npm run turso:customer -- --apply` (`turso auth login`)
- [ ] **Vercel CLI** (`npm i -g vercel`, then `vercel login`) — used by `npm run vercel:customer -- --apply`
- [ ] A **password manager** for URL, database token, `SESSION_SECRET`, and the first-admin password. Never commit `.env`, tokens, or `*.db`.

```bash
# Turso CLI (macOS / Linux) — needed for npm run turso:customer -- --apply
curl -sSfL https://get.tur.so/install.sh | bash
turso --version

# Vercel CLI (needed for npm run vercel:customer -- --apply)
npm i -g vercel
vercel login
vercel --version

# Repo
git clone https://github.com/pesl98/new_p2p_indirect.git
cd new_p2p_indirect
npm install
npm install --prefix server
npm install --prefix client
```

Confirm Node is 18 or newer. The Vercel project should also run Node 18+ (Project → Settings → General → Node.js Version).

---

## 0. Preferred: one-command orchestrator

After Turso + Vercel CLIs are logged in (below), the usual operator entry is:

```bash
npm run onboard:customer -- --slug acme
# then, after the Vercel project exists and this clone is linked (step 5):
npm run onboard:customer -- --slug acme --apply \
  --email admin@acme.test --password 'choose-a-long-password' \
  --name "Ada Admin"
```

| Flag | Meaning |
| --- | --- |
| (default) | Dry-run. Prints the full Turso → Vercel → provision plan. Exit 0. No network. Does not invent secrets. |
| `--apply` | Create/reuse the Turso DB, push env to the linked Vercel project, migrate + org skeleton, optional first admin. |
| `--with-org` | Default **on** for this command (unlike `provision:customer`, which requires the flag). |
| `--no-org` | Skip cost centers / FY budgets. |
| `--smoke` | After provision, hit `https://procureflow-acme.vercel.app` (or `--base-url`). Skip until the deploy is Ready. |
| `--db` / `--project` | Override Turso DB name or Vercel project name. |
| `--json` | Machine summary. Tokens redacted to last 4 characters. |

`--apply` never seeds, never invents Turso URL/token, never sets `DEMO_PERSONA_SWITCHER`, and never destroys a database.

The rest of this document is the **same sequence, command by command**.

---

## 1. Turso account / login

```bash
turso auth login
turso auth whoami
```

Use a Turso org the operator is allowed to create databases in. You do **not** need a Turso org JWT in the app — that token is the wrong kind (see step 3).

---

## 2–4. Turso database + token + `SESSION_SECRET`

Create **one** classic libSQL database for this customer, mint a **database token**, and generate `SESSION_SECRET`. Prefer the operator CLI (dry-run first — it does not invent secrets or call Turso):

```bash
# See planned DB name + exact turso commands (no mutation)
npm run turso:customer -- --slug acme

# Create/reuse procureflow-acme, mint a database token, print exports
npm run turso:customer -- --slug acme --apply
```

`--apply` requires the Turso CLI and `turso auth login`. It runs (and you can still run by hand):

```bash
turso db create procureflow-acme
turso db show procureflow-acme --url
turso db tokens create procureflow-acme
```

Name pattern: `procureflow-<customer-slug>` (override with `--db <name>`). Lowercase, no spaces. Do **not** pass `--tursodb` (that is a different engine; ProcureFlow talks HTTP `/v2/pipeline` to classic libSQL). If the DB already exists, `--apply` **reuses** it — it never destroys.

Copy the printed `export TURSO_DATABASE_URL=…`, `export TURSO_AUTH_TOKEN=…`, and `export SESSION_SECRET=…` into this shell and a password manager. `--json` redacts the token to its last 4 characters; full export lines are still printed on human stdout after `--apply`.

`SESSION_SECRET` HMAC-signs the httpOnly `pf_session` cookie. `--apply` mints a new 32-byte hex secret **unless** `SESSION_SECRET` is already set in this environment — then it **reuses** it (does not silently rotate). Generate a new one **per customer**. Do not reuse Acme’s secret on Beta.

| Right | Wrong |
| --- | --- |
| `turso db tokens create procureflow-acme` | `turso auth token` / org / platform JWT |
| Token minted for **this** database | A token copied from another customer |

`TURSO_AUTH_TOKEN` must be the **database token**. An org JWT looks like it might work and then returns **401** from Turso (the app surfaces that as a 503 configuration error). If you are unsure which token you have, re-run `npm run turso:customer -- --slug acme --apply` (or `turso db tokens create`) and replace the env var.

Help: `npm run turso:customer -- --help`.

---

## 5. Create a **new Vercel project** (human, once)

Same git repo, **new project** — do not add this customer as a second domain on an existing ProcureFlow project. This step stays in the dashboard (the env script will **not** create a project).

1. Vercel dashboard → **Add New… → Project**.
2. **Import** `pesl98/new_p2p_indirect` (or your fork). Grant GitHub access if Vercel asks.
3. **Root Directory** = repository root (leave the default; do not set `client/` or `server/`).
4. Framework: leave as detected / Other. **Do not** invent a build command — [`vercel.json`](../vercel.json) already sets `buildCommand` to `npm run build`.
5. Suggested project name: `procureflow-acme`.
6. Create the project. The first deploy may 503 until env vars exist — that is expected.

On the laptop (once per operator / clone), link that project so later commands know the target:

```bash
# Once per laptop
npm i -g vercel
vercel login
vercel link --yes --project procureflow-acme
```

`vercel link` binds this checkout to the **existing** dashboard project. If the project is missing, create it in the dashboard first — do not invent a second customer on an existing ProcureFlow project.

What Vercel does on each deploy:

- Runs `npm run build` (Vite → `public/`)
- Deploys [`api/index.js`](../api/index.js) as one Node Function (`includeFiles` keeps `schema.sql`)
- Rewrites `/api/*` to that function
- Serves `public/` on the CDN

There is **no cron**.

---

## 6. Set environment variables (Production **and** Preview)

Keep the **same** `TURSO_*` / `SESSION_SECRET` already exported in this shell (from `turso:customer --apply`). The script **refuses to invent secrets**.

```bash
# See the Production+Preview checklist + exact commands (no Vercel network, no mutation)
npm run vercel:customer -- --slug acme

# Set/update the three vars on Production and Preview, then redeploy
npm run vercel:customer -- --slug acme --apply
```

`--slug acme` targets project `procureflow-acme` (override with `--project <name>`). `--apply` requires the Vercel CLI, `vercel login`, and `vercel link`. Help: `npm run vercel:customer -- --help`.

| Variable | Value | Production | Preview |
| --- | --- | --- | --- |
| `TURSO_DATABASE_URL` | From `turso:customer --apply` (`turso db show procureflow-acme --url`) | ✓ | ✓ |
| `TURSO_AUTH_TOKEN` | From `turso:customer --apply` (`turso db tokens create procureflow-acme`) | ✓ | ✓ |
| `SESSION_SECRET` | From `turso:customer --apply` (reused if already in the shell) | ✓ | ✓ |

Leave **unset** (the script will not add this):

| Variable | Why |
| --- | --- |
| `DEMO_PERSONA_SWITCHER` | Default is off. Set to `1` only for a training demo that should show the header persona switcher. Live customers use login. |

Do **not** set `PROCUREMENT_DB_PATH` on Vercel. Local SQLite is not available in serverless.

**Env changes do not apply to an already-built deployment** — `--apply` redeploys so they take effect.

Dashboard fallback (if you cannot use the CLI): Settings → Environment Variables → set all three for **Production and Preview** (or **All Environments**), then Redeploy. Preview URLs stay broken if the vars are Production-only.

---

## 7. Deploy / Redeploy after env change

`npm run vercel:customer -- --slug acme --apply` already rebuilds the latest Production deployment (`vercel redeploy`). If there is no Production deployment yet, it falls back to `vercel deploy --prod --yes`.

1. Wait until Ready.
2. Copy the Production URL (`https://procureflow-acme.vercel.app` or the project’s alias).

Opening the URL before Redeploy often still shows the 503 Turso setup page. If you set env in the dashboard instead of the script, Redeploy there, then continue.

---

## 8. From the laptop: migrate, then bootstrap (do **not** seed)

Use the **same** `TURSO_*` you pasted into Vercel. Schema does **not** apply itself usefully for operators — first process start can call `applySchema`, but you want `db:migrate` so you see health before handing over the URL.

```bash
cd /path/to/new_p2p_indirect

export TURSO_DATABASE_URL='libsql://…'    # Acme URL from turso:customer --apply
export TURSO_AUTH_TOKEN='…'               # Acme *database* token from turso:customer --apply
export SESSION_SECRET='…'                 # same value as Vercel

# Optional: fail closed if TURSO_* are missing
npm run db:migrate -- --turso
npm run db:status

# Cost centers + FY 2026 budgets (idempotent; never wipes). Skip only if you
# are proving login and do not need PR submit yet. See §11.
npm run bootstrap-org
```

`db:status` prints mode (`turso-http`), table count, and user count. It never prints `TURSO_AUTH_TOKEN`. On a fresh customer you should see **0 users**. `bootstrap-org` does not create users.

### First admin (pick one)

**A — CLI (preferred for operators)**

```bash
npm run bootstrap-admin -- \
  --name "Ada Admin" \
  --email admin@acme.test \
  --password 'choose-a-long-password'
```

**B — one-shot wrapper** (migrate + optional org skeleton + bootstrap; still **never seeds**)

```bash
npm run provision:customer -- --with-org \
  --name "Ada Admin" \
  --email admin@acme.test \
  --password 'choose-a-long-password'
```

Omit `--with-org` if you only want schema + first admin (departments stay empty until `npm run bootstrap-org`).

**C — UI** if the database still has 0 users: open the Production URL, use **Create the first admin** (name, email, password ≥ 8 characters).

The CLI **refuses** (exit 2) if any users already exist. Additional people are created in the UI, not by running bootstrap again.

### Do not seed a real customer

Three tiers — pick one; do not confuse the org skeleton with seed:

| Goal | Command | Result |
| --- | --- | --- |
| Empty schema | `npm run db:migrate` | Tables exist. `departments` / `budgets` are empty. PR submit fails closed. |
| Org skeleton | `npm run bootstrap-org` (or `provision:customer -- --with-org`) | Five cost centers + FY 2026 budgets. **Idempotent.** No users, no demo personas. |
| Demo / training wipe | `npm run seed` | **Destructive:** drops all app tables, loads Alice/Bob/… and password `ProcureFlow!demo` |

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

## 11. Cost centers and department approvers (`bootstrap-org`)

`db:migrate` leaves `departments` and `budgets` empty. Until cost centers and a FY budget exist, PR submit fails closed (no department head / no budget). Fiscal year in budget joins is hardcoded **2026**.

There is **no in-app “create department” or “create budget” form**. The operator path is `npm run bootstrap-org` (or `provision:customer -- --with-org` in step 8). **Administration → Department Approvers** only assigns a step-1 head (`departments.approver_user_id`) on **existing** rows. Do **not** set heads in SQL — map them in the UI after users exist.

Default skeleton (idempotent; skip codes that already exist; never wipe or rename):

| Code | Name | FY 2026 `total_budget` |
| --- | --- | --- |
| MKT | Marketing | `10000000` cents ($100,000.00) |
| ITE | IT | same |
| FAC | Facilities | same |
| HRP | HR | same |
| ADM | Finance | same |

`committed_amount` / `actual_spent` start at 0. `approver_user_id` stays unset.

```bash
# Same TURSO_* (or PROCUREMENT_DB_PATH) as migrate / bootstrap-admin
npm run bootstrap-org
npm run bootstrap-org -- --json
# optional: --fiscal-year 2026 --budget-cents 10000000
# optional: --force-budget   # rewrite total_budget only; never touches committed/actual
```

Safe to re-run. Existing department names and live budget totals are left alone unless you pass `--force-budget` (totals only). This command **never** creates users, suppliers, catalog, or PRs. Never pass `--seed`.

If you already ran `provision:customer -- --with-org …` in step 8, you do not need to run `bootstrap-org` again.

Then:

1. Administration → Users — set each person’s department if you skipped it at create.
2. Administration → Department Approvers — pick a step-1 head per cost center.
3. Catalog and suppliers are also empty until someone with access adds them under **Vendors & Catalog** (create APIs exist; this is not a Coupa master-data migration).

Skip the UI mapping if you are only proving login + admin user CRUD. Skip `bootstrap-org` only if you do not need PR submit yet.

---

## 12. Second customer = second Turso DB + second Vercel project

Never share a URL.

```bash
npm run turso:customer -- --slug beta --apply
# copy the printed exports into this shell (new SESSION_SECRET — do not reuse Acme’s)

# Then: new Vercel project procureflow-beta + vercel link --yes --project procureflow-beta
npm run vercel:customer -- --slug beta --apply
npm run provision:customer -- --with-org \
  --email admin@beta.test \
  --password 'choose-a-long-password'
```

Smoke `BASE_URL=https://procureflow-beta.vercel.app`. `vercel:customer --apply` replaces Turso URL/token + `SESSION_SECRET` on Production + Preview and redeploys.

Leaving Acme’s URL in place would serve Acme’s data as Beta.

Local SQLite pair (laptop / air-gapped only — not Vercel):

```bash
unset TURSO_DATABASE_URL TURSO_AUTH_TOKEN
export PROCUREMENT_DB_PATH="$PWD/server/data/acme.db"
npm run provision:customer -- --with-org --email admin@acme.test --password 'choose-a-long-password'
```

Do not commit `*.db` (`server/data/` is gitignored).

---

## Operator checklist (Acme)

Copy this into the ticket and tick as you go.

- [ ] Node 18+, Turso CLI logged in, GitHub + Vercel access
- [ ] Preferred: `npm run onboard:customer -- --slug acme` (dry-run) then `--apply --email … --password …` (after `vercel link`)
- [ ] Or stepped: `npm run turso:customer -- --slug acme` (dry-run) then `--apply` — **classic libSQL**, no `--tursodb`; prints `TURSO_*` + `SESSION_SECRET` exports
- [ ] Database token stored (**not** an org JWT). Same as `turso db tokens create procureflow-acme`
- [ ] **New** Vercel project; root = repo root; build from `vercel.json`
- [ ] `vercel link --yes --project procureflow-acme`
- [ ] `npm run vercel:customer -- --slug acme` (dry-run) then `--apply` (Production + Preview env + redeploy)
- [ ] `DEMO_PERSONA_SWITCHER` left unset
- [ ] Laptop `export` of the same `TURSO_*` (+ `SESSION_SECRET`)
- [ ] `npm run db:migrate` then `npm run bootstrap-org` then `npm run bootstrap-admin` (or `npm run provision:customer -- --with-org --email … --password …`)
- [ ] **Did not** `npm run seed`
- [ ] First admin can sign in at the Production URL
- [ ] Extra users created in Administration → Users
- [ ] `BASE_URL=https://<acme>.vercel.app npm run smoke` exit 0
- [ ] Department heads assigned in Administration → Department Approvers after those users exist
- [ ] Secrets only in Vercel + password manager — not in git, screenshots, or chat logs

---

## Honest limits (read once)

Hand this to the customer with the URL so nobody assumes Coupa-parity.

- **No SSO / SAML / OIDC.** Login is email + bcrypt password in this customer’s database. `SESSION_SECRET` only signs the cookie; it is not an IdP client secret.
- **Not a full authorization rewrite.** Admin user CRUD uses the session (`req.user`). Many P2P routes still accept body persona ids (`requester_id`, `approver_id`, `actor_name`, …). Anyone who can reach those APIs can still send another person’s id. That is a known phased cut, not a security boundary.
- **No `org_id` multi-tenancy.** Two customers on one Turso URL is one pile of data.
- **Persona switcher is demo-only** (`DEMO_PERSONA_SWITCHER=1`). Default customer UI is login.
- **Empty tenant is empty.** No catalog, suppliers, departments, budgets, or sample PRs until you add them. Three tiers: `db:migrate` (schema only) → `bootstrap-org` (five cost centers + FY budgets; non-destructive) → `npm run seed` (**wipe**, not an overlay).
- **No department/budget create UI.** Operator path is `npm run bootstrap-org`. Map heads in Administration → Department Approvers after users exist.
- **Fiscal year 2026** is hardcoded in budget queries.
- **No cron**, no bank NACHA export, no OCR invoice capture.

Product detail: [ARCHITECTURE.md](ARCHITECTURE.md) “Known demo limits”. Full capability catalog: [SYSTEM_MANUAL.md](SYSTEM_MANUAL.md).

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

- Re-run `npm run vercel:customer -- --slug <customer> --apply` (or set both on **Production and Preview** in the dashboard, then **Redeploy**).
- Smoke prints a Production+Preview / Redeploy hint in this case.
- Partial credentials (URL xor token) are fail-closed — the CLI will not silently open a local SQLite file.

### HTTP 401 from Turso / “token rejected” (org JWT)

The token is the wrong kind (org/platform JWT, or a token for a **different** database).

```bash
turso db tokens create procureflow-acme
```

Export it and re-run `npm run vercel:customer -- --slug acme --apply` (or paste into `TURSO_AUTH_TOKEN` on Production + Preview and Redeploy). Do not use `turso auth token`.

### Preview URL broken; Production works

Preview is missing env. Re-run `npm run vercel:customer -- --slug <customer> --apply` (it sets Preview as well as Production) and Redeploy **that** Preview. Env edits do not retrofit an old Preview deployment.

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
npm run turso:customer -- --slug acme --apply   # recreate + new database token + exports
# then: npm run vercel:customer -- --slug acme --apply
npm run db:migrate
npm run bootstrap-org
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
