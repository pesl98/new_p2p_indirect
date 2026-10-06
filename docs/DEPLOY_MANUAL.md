# ProcureFlow deploy and operations manual

This is the operator manual for one customer install. Follow it to deploy, run, update, and remove ProcureFlow without reading the application code.

Worked example: customer slug **acme**, first admin **Ada Admin** `<admin@acme.test>`. Replace those with the real slug and email. Run every `npm run` command from the **repository root** (the directory that contains the top-level `package.json`).

What the product can do is **[SYSTEM_MANUAL.md](SYSTEM_MANUAL.md)**. The long environment tables are there and in **[DEPLOYMENT.md](DEPLOYMENT.md)** (SSO in [§2.1](DEPLOYMENT.md#21-sso-oidc-or-saml-per-customer), capabilities and report definitions in [SYSTEM_MANUAL.md §3](SYSTEM_MANUAL.md#sso-oidc-or-saml) and [§5.13](SYSTEM_MANUAL.md#513-audit-and-compliance-reports)). This file is the operator procedure: deploy, run, update, and remove one customer. [CUSTOMER_ONBOARDING.md](CUSTOMER_ONBOARDING.md) and [`scripts/provision-customer.md`](../scripts/provision-customer.md) are the same install, in shorter form, and they point here.

---

## 1. Architecture of a deployment

Each customer is a separate install. There is no shared-row multi-tenancy and no `org_id` column that isolates customers inside one database. Pasting customer A’s database URL into customer B’s project merges those customers.

```
Acme  →  Turso DB procureflow-acme  →  Vercel project procureflow-acme
Beta  →  Turso DB procureflow-beta  →  Vercel project procureflow-beta
```

The git repository is the same for every customer. Isolation is the connection: a Turso URL plus database token, or (on a laptop only) a SQLite file path.

| Piece | Where it lives |
| --- | --- |
| React UI | Built by `npm run build` (Vite). Output is copied from `client/dist` to `public/`. On Vercel, the CDN serves `public/`. |
| HTTP API | One Express app. On Vercel it is the Node function [`api/index.js`](../api/index.js) (default export). Locally, [`server/src/index.js`](../server/src/index.js) listens on `PORT` (default **5000**). |
| Business logic | [`server/src/app.js`](../server/src/app.js) builds the Express app. It does not listen. |
| Schema | [`server/src/schema.sql`](../server/src/schema.sql), plus additive migrations in [`server/src/db.js`](../server/src/db.js) (`applySchema`). `vercel.json` bundles `schema.sql` with the function (`includeFiles`). |
| Customer data | One classic libSQL database on Turso, reached over HTTPS `POST /v2/pipeline`. The app does not load a native libsql addon (that crashes Vercel serverless). |
| Laptop data | SQLite via `better-sqlite3` when both Turso variables are omitted. Default file: `server/data/procurement.db`. |
| Session | httpOnly cookie `pf_session`, HMAC-SHA256 signed with `SESSION_SECRET` (not a JWT library). Lifetime 7 days. `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` when `VERCEL` is set or `NODE_ENV=production`. Password login and a successful OIDC or SAML callback both set this cookie. |
| Scheduled jobs | None. The app is request-driven. There is no cron. |

Three ways the process picks a database:

| Mode | When | What you get |
| --- | --- | --- |
| Local SQLite | `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are both unset | `better-sqlite3` file (`PROCUREMENT_DB_PATH` or `server/data/procurement.db`) |
| Turso HTTP | Both Turso variables are set | `POST /v2/pipeline`. `libsql://` URLs are called as `https://…/v2/pipeline` |
| Vercel | `VERCEL` or `VERCEL_ENV` is set | Turso is required. If either variable is missing, the function returns HTTP 503 (HTML setup page, or JSON `{ "error": "TursoConfigError" }` on `/api/*`). It does not open a local file |

`npm run db:migrate`, `db:status`, `bootstrap-org`, and `bootstrap-admin` refuse a half-set pair (URL without token, or token without URL). They will not silently create a SQLite file in that case.

Sign-in is the `pf_session` cookie for this database. Password login stores a bcrypt hash in `user_credentials`. Optional OIDC or SAML (section 8.6) resolves the IdP user to a local `users.id` and sets the same cookie. Every business API requires that session. A body or query id that names someone else (`requester_id`, `approver_id`, `received_by`, `actor_name`, and the same kind of field) is rejected. Admin user create/edit requires `role=admin`.

`SESSION_SECRET` is the HMAC key. Customer and Vercel deploys must set it. If it is unset, local development uses the built-in insecure default `procureflow-dev-insecure-session-secret`. On Vercel, or when `NODE_ENV=production`, the process logs a warning and still starts with that default — do not ship a customer that way.

The header persona switcher is off unless `DEMO_PERSONA_SWITCHER` is `1`, `true`, or `yes`. When it is on, choosing a person signs in again with the demo password `ProcureFlow!demo`. It does not skip the session. `npm run seed` is a destructive demo wipe of whatever database this shell points at. It is not how you create the first admin (section 6.3).

---

## 2. Prerequisites

Do this once on the operator laptop before the first customer.

Accounts and access:

- A GitHub clone of this repository (`https://github.com/pesl98/new_p2p_indirect`).
- A Vercel account that can create a project. If you belong to more than one team, you will pick one with `vercel switch` (see below).
- A Turso account that can create a database. Sign up at [turso.tech](https://turso.tech) if you do not have one.
- A password manager entry per customer for the database URL, the database token, `SESSION_SECRET`, and the first-admin password. Do not commit `.env`, tokens, or `*.db` files.

Tools:

- **Node.js 18 or newer.** `package.json` sets `"engines": { "node": ">=18" }`. Check with `node -v`.
- **npm 9 or newer** is what this runbook uses (`npm -v`). The repo does not pin an npm version beyond that.
- **Vercel CLI** and **Turso CLI**, logged in. The customer commands shell out to `vercel` and `turso` on `PATH`. You can override the binaries with `VERCEL_CLI` and `TURSO_CLI` if they are not named that.

Install and log in:

```bash
node -v
npm -v

# Turso CLI (macOS / Linux)
curl -sSfL https://get.tur.so/install.sh | bash
turso --version
turso auth login
turso auth whoami

# Vercel CLI
npm i -g vercel
vercel --version
vercel login
vercel whoami
```

`turso auth whoami` and `vercel whoami` must succeed before any `--apply`. A non-zero whoami stops the command before it creates a database, writes env vars, or destroys anything.

Team and organization:

- The scripts do **not** pass `--scope` or `--team`. They use whatever team the Vercel CLI is on right now.
- If `vercel whoami` is fine but the project lands on the wrong team, run `vercel switch`, then run the command again.
- Turso uses the organization you logged into. `turso:customer` does not switch orgs for you.

Versions these scripts were written and checked against (comments in the CLI source, not a live install on every laptop):

| Tool | Checked behavior |
| --- | --- |
| Vercel CLI **59.24.0** | `vercel project add` exits 0 when the project already exists (HTTP 409). |
| Vercel CLI **59.25.4** | `vercel inspect <deployment> --json` returns `readyState`. The scripts poll that. They do not use `inspect --wait`. |
| Vercel CLI **59.26.0** | `vercel env rm <name> <production\|preview> --yes` works. `vercel project rm` has **no** `--yes`, so offboard does not delete the project. |
| Turso CLI **v1.0.32** | `turso db destroy <name> --yes` deletes the database. That command does not take `--location` or `--instance` (those flags, when present, target one replica). |

If a newer CLI rejects a flag, run `vercel <command> --help` or `turso <command> --help` and compare it with the commands in this manual before you improvise.

Clone and install:

```bash
git clone https://github.com/pesl98/new_p2p_indirect.git
cd new_p2p_indirect
npm install
```

`npm run build` installs the client on its own. You do not have to install `server/` and `client/` separately for a Vercel deploy. Local `npm test` needs the root install (and `better-sqlite3`, which is an optional dependency and is required for SQLite mode).

On the Vercel project, Node must also be 18 or newer. `vercel project add` uses the account default and does not set the runtime. If the first build fails on an old Node, set Project → Settings → General → Node.js Version to 18 or newer and redeploy.

---

## 3. Environment variables

The application and the operator CLIs read the variables below. Vercel also injects `VERCEL` and `VERCEL_ENV`; you do not set those yourself.

The customer CLIs write only three variables, and only to **Production** and **Preview**: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `SESSION_SECRET`. They never set `DEMO_PERSONA_SWITCHER`. They never set Vercel’s **Development** environment (`vercel env pull` / `vercel dev`). Local development uses your shell or a gitignored `.env`.

| Variable | Purpose | Required? | Vercel environments | Secret? | How it is produced |
| --- | --- | --- | --- | --- | --- |
| `TURSO_DATABASE_URL` | libSQL URL of this customer’s database (usually `libsql://…`). | Required on Vercel. Required locally if you want Turso. Must be set together with the token. | Production and Preview (or All Environments). Not set on Development by the scripts. | Treat as sensitive. It names the database. | `turso db show procureflow-<slug> --url`, printed by `npm run turso:customer -- --apply`. |
| `TURSO_AUTH_TOKEN` | Database token for that URL. | Same as the URL. An org or platform JWT is the wrong kind and returns Turso HTTP 401 (the app surfaces that as 503). | Production and Preview. | Yes. | `turso db tokens create procureflow-<slug>`. Not `turso auth token`. |
| `SESSION_SECRET` | HMAC key for the `pf_session` cookie. | Required for a customer / Vercel deploy. If it is unset, local dev uses a built-in insecure default. On Vercel, or when `NODE_ENV=production`, the process logs a warning. | Production and Preview. One value per customer project. Do not reuse it across customers. | Yes. | 32-byte hex. `turso:customer --apply` mints one with `crypto.randomBytes(32)` unless `SESSION_SECRET` is already exported, in which case it **reuses** it and does not rotate. Or: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `DEMO_PERSONA_SWITCHER` | Shows the header persona switcher when the value is `1`, `true`, or `yes`. Any other value, including unset, `0`, `false`, and `no`, leaves it off. | Optional. Leave unset on a live customer. | Do not set it for a real customer. The CLIs will not copy it to Vercel even if it is set in your shell. | No. | Set the shell variable yourself only for a training demo. |
| `PROCUREMENT_DB_PATH` | SQLite file path. Used only when both Turso variables are unset. | Optional locally. Do **not** set it on Vercel. Serverless has no durable disk. | Leave unset on Vercel. | The file holds all P2P data. Do not commit it. | A path you choose, for example `server/data/acme.db`. Default is `server/data/procurement.db`. |
| `BCRYPT_ROUNDS` | bcrypt cost for new password hashes. Default **10**. A non-integer or a value below 4 falls back to 10. | Optional. | Not written by the CLIs. Set on Production and Preview only if you need a different cost. | No. | An integer you choose. |
| `PORT` | Local listen port. Default **5000**. | Optional locally. | Vercel assigns the function port. Do not set this for a customer project. | No. | |
| `NODE_ENV` | When `production`, the session cookie is `Secure` and a missing `SESSION_SECRET` is warned. | Optional locally. | Vercel sets this for Production. | No. | |
| `BASE_URL` | Origin for `npm run smoke` and the “next step” line from provision. Default `http://127.0.0.1:5000`. | Smoke / provision messages only. The running app does not read it. | Do not put this on the Vercel project as an app secret. | No. | `https://procureflow-<slug>.vercel.app` or your custom domain, with no path. |
| `SMOKE_EMAIL` | Optional login check for smoke. Overridden by `--email`. | Smoke only. | No. | No. | The first-admin email. |
| `SMOKE_PASSWORD` | Password for that login check. Overridden by `--password`. | Smoke only, and only together with an email. | No. | Yes. | The first-admin password. |
| `SMOKE_TIMEOUT_MS` | Per-request timeout for smoke. Default **15000**. Non-positive values fall back to the default. `--timeout` / `--timeout-ms` overrides it. | Smoke only. | No. | No. | Milliseconds. |
| `VERCEL_READY_TIMEOUT_MS` | How long `vercel:customer --apply` and `onboard:customer --apply` wait for Production `readyState` READY. Default **240000** (4 minutes). Non-numeric or non-positive values fall back to the default. | Operator CLI only. The app does not read it. | No. | No. | Milliseconds. The poll interval is 5 seconds and is not configurable. |
| `VERCEL` | Set by Vercel. The app treats this as serverless and requires Turso. Also forces a `Secure` cookie. | Automatic. | Injected. | No. | Vercel. |
| `VERCEL_ENV` | Set by Vercel (`production`, `preview`, or `development`). Also counts as “on Vercel”. | Automatic. | Injected. | No. | Vercel. |
| `TURSO_CLI` | Path or name of the Turso binary. Default `turso`. | Optional. | No. | No. | |
| `VERCEL_CLI` | Path or name of the Vercel binary. Default `vercel`. | Optional. | No. | No. | |
| `PROCUREFLOW_LIBSQL_HTTP` | Read into an internal `preferHttp` flag. The database open path still uses HTTP whenever Turso is selected. It does not load a native addon. | Leave unset. | Do not set it on Vercel. | No. | |
| `WEBHOOK_TARGET_URL` | HTTPS URL that receives signed webhooks for this customer. | Optional. Required only when you want delivery. `http` is allowed for localhost only. | Production and Preview. Not written by the CLIs. | Treat as sensitive if the URL contains a token. | You set it. The API returns the host only, never the URL. |
| `WEBHOOK_SIGNING_SECRET` | HMAC-SHA256 key for `X-ProcureFlow-Signature`. | Optional. Required together with the URL. | Production and Preview. One value per customer. Not written by the CLIs. | Yes. Never stored in the database and never returned by the API. | 32-byte hex, same generator as `SESSION_SECRET`. |
| `CURRENCY` | Deployment currency for display, audit text, exports, and money-bearing webhooks. Allowlist: `EUR` (default) or `USD`. | Optional. Leave unset for EUR. Any other value refuses to boot (503). It does not convert stored cents. | Production and Preview. Not written by the CLIs. | No. | `EUR` or `USD`. |

### 3.1 SSO and login flags the CLIs do not write

`onboard:customer` and `vercel:customer` write only `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `SESSION_SECRET`. They never set `DEMO_PERSONA_SWITCHER`, any `IDENTITY_PROVIDER` / `OIDC_*` / `SAML_*` / `SSO_*` / `APP_BASE_URL` / `LOCAL_LOGIN` key, or `WEBHOOK_TARGET_URL` / `WEBHOOK_SIGNING_SECRET`, or `CURRENCY` (unset means EUR). Set those yourself on **that** customer’s project (Production and Preview), then redeploy. Column-by-column notes are already in [DEPLOYMENT.md §2.1](DEPLOYMENT.md#21-sso-oidc-or-saml-per-customer) and [SYSTEM_MANUAL.md §3](SYSTEM_MANUAL.md#sso-oidc-or-saml). Webhooks are [§8.8](#88-integrations). This checklist is the operator decision, not a second copy of those tables.

| Decision | What to set |
| --- | --- |
| Live customer, password login only | Leave `IDENTITY_PROVIDER` unset or set `local`. Leave `DEMO_PERSONA_SWITCHER`, `OIDC_ALLOW_INSECURE`, and `SAML_ALLOW_INSECURE` unset. |
| Password form | `LOCAL_LOGIN` unset, `1`, `true`, or `yes` (default **on**). `0`, `false`, or `no` disables `POST /api/auth/login` with **403** `local_login_disabled`. It does not open an unsigned path. Any other value is unrecognized and also disables password login. |
| Turn SSO on | `IDENTITY_PROVIDER=oidc` or `saml`, plus `APP_BASE_URL` (this customer’s origin, no path, for example `https://procureflow-acme.vercel.app`). Any other provider value fails closed. |
| OIDC required | `OIDC_ISSUER` (HTTPS), `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`. |
| OIDC optional | `OIDC_REDIRECT_URI` (default `{APP_BASE_URL}/api/auth/oidc/callback`). `OIDC_SCOPES` (default `openid email profile`; must include `openid`). Register the redirect URL on the IdP. |
| SAML required | `SAML_ENTRY_POINT` (HTTPS), `SAML_IDP_CERT`, `SAML_IDP_ISSUER`, `SAML_SP_ENTITY_ID`. |
| SAML optional | `SAML_ACS_URL` (default `{APP_BASE_URL}/api/auth/saml/acs`). `SAML_AUDIENCE` (default the SP entity id). `SAML_WANT_ASSERTIONS_SIGNED` (default true). `SAML_WANT_RESPONSE_SIGNED` (default false). Setting **both** false is rejected. Give the IdP `GET /api/auth/saml/metadata`. The IdP **posts** the assertion to the ACS URL. |
| Unknown IdP users | Off by default. `SSO_PROVISIONING` unset or `0`. Optional `SSO_DEFAULT_ROLE` is one of `requester`, `approver`, `procurement`, `finance`, `admin`. The role never comes from an IdP claim. The first admin is still bootstrap (section 6.3), because a just-in-time user is not an admin unless you set that role yourself. |

IdP client secrets and certificates live only in that customer’s environment. The database row `tenant_settings` stores the provisioning switch and the default role, not those secrets. Missing or invalid SSO settings leave `ssoReady` false. OIDC and SAML start/callback set no cookie. A client that sends `Accept: application/json` gets **503** `sso_not_configured`. A browser request, when `APP_BASE_URL` is set, is redirected to `/?sso_error=sso_not_configured`. How to turn provisioning on after go-live is section 8.6.

Template with the same names and no secret values: [`.env.example`](../.env.example).

Changing any of the three customer variables on Vercel does nothing to a deployment that is already built. You must redeploy. `vercel:customer --apply` does that and waits until the new Production deployment is Ready.

---

## 4. Turso

One classic libSQL database per customer. Name: `procureflow-<slug>` (lowercase). Override with `--db` if you must. Do not pass `--tursodb`. That flag selects a different Turso engine. ProcureFlow talks HTTP `/v2/pipeline` to classic libSQL only. `turso:customer` and `onboard:customer` exit with an error if you pass `--tursodb`.

Slug rules (the CLIs normalize to lowercase): letters, numbers, and hyphens; cannot start or end with a hyphen; at most 48 characters. Example: `acme`. The database name is at most 64 characters.

### 4.1 Create the database, URL, and token

Prefer the wrapper. Dry-run first. It prints the plan and does not call Turso.

```bash
npm run turso:customer -- --slug acme
npm run turso:customer -- --slug acme --apply
```

`--apply` requires the Turso CLI and a successful `turso auth whoami`. It then runs, in order:

```bash
turso auth whoami
turso db show procureflow-acme          # existence check
turso db create procureflow-acme        # only if missing; never --tursodb
turso db show procureflow-acme --url
turso db tokens create procureflow-acme # database token, not an org JWT
```

If the database already exists, it is reused. This command never destroys a database, never migrates, never seeds, and never calls Vercel.

It prints shell exports. Copy them into this shell and into the password manager:

```bash
export TURSO_DATABASE_URL='libsql://…'
export TURSO_AUTH_TOKEN='…'
export SESSION_SECRET='…'
```

`--json` redacts the token and `SESSION_SECRET` to the last 4 characters. The full `export` lines are still printed on human stdout after `--apply`.

`SESSION_SECRET` is a new 32-byte hex string unless that variable is already set in the environment. If it is set, the command reuses it and says so. It does not silently rotate.

### 4.2 Region and group

`turso db create procureflow-<slug>` is run with no `--group` and no `--location`. The database is created in the Turso CLI’s current organization, in that organization’s default group and primary location. The scripts cannot move it later.

To choose a group or location, create the database yourself first, using the flags your installed CLI documents:

```bash
turso db create --help
# example shape — confirm the flags on your CLI, then:
# turso db create procureflow-acme --group <group> --location <location>
npm run turso:customer -- --slug acme --apply
```

`--apply` sees that the database exists, skips create, and only mints the URL, a database token, and `SESSION_SECRET`.

### 4.3 Schema on an empty database

Creating the Turso database does not create tables. Apply the schema from the laptop with the same `TURSO_*` exports:

```bash
npm run db:migrate -- --turso
npm run db:status
```

`db:migrate` runs `schema.sql` and the additive migrations (`CREATE TABLE IF NOT EXISTS`, `ALTER`, and a few table rebuilds, including `users.status` and `user_credentials`). The same run creates `compliance_audit_events` and the append-only triggers on `audit_logs`, `sso_login_events`, `sso_assertion_uses`, and that ledger (`CREATE TRIGGER IF NOT EXISTS`). An existing customer database gets them on the next `npm run db:migrate` or the next process start. There is no separate SQL file to apply by hand. Those four tables reject `UPDATE` and `DELETE` (section 9). It does not load cost centers or demo people unless you pass `--seed`.

`db:status` prints the mode (`turso-http` or `sqlite`), how many expected tables exist, and the user count. It does not apply schema and it never prints `TURSO_AUTH_TOKEN`. A new customer should show **0 users**.

The first request on Vercel also calls `applySchema`. Prefer `db:migrate` so you see success or failure before you hand anyone the URL.

A migrate with no org skeleton leaves `departments` and `budgets` empty. Purchase-request submit then fails closed. The org skeleton is `npm run bootstrap-org` (section 6.3), not migrate.

### 4.4 Token rotation

Mint a new database token. This does not revoke the old one.

```bash
turso db tokens create procureflow-acme
export TURSO_AUTH_TOKEN='…'          # the new token
# keep the existing TURSO_DATABASE_URL and SESSION_SECRET
npm run vercel:customer -- --slug acme --apply
```

`--apply` writes the three variables to Production and Preview and redeploys. `npm run turso:customer -- --slug acme --apply` also mints a new token (and reuses `SESSION_SECRET` if it is already exported). You still have to push the new token with `vercel:customer`.

After the new deployment is Ready, revoke the old token in Turso if `turso db tokens --help` offers an invalidate or revoke command. These scripts do not run one. Removing the variable from Vercel does not revoke it either.

### 4.5 Backups, restore, and point-in-time

These scripts do not take backups and do not restore them.

What you can do with the tools this repo actually calls:

- **Code rollback** is Vercel Instant Rollback (section 5.6). It does not put database rows back.
- **Data rollback** means a dump you took yourself and restore outside this app, or pointing the Vercel project at a different Turso database that still exists, or destroying the database and creating an empty one (the data is gone).
- **`turso db destroy procureflow-acme --yes`** deletes that database. On Turso CLI v1.0.32 it does not take `--location` or `--instance`. Offboard uses this form and deletes the whole database name.

Point-in-time restore, extra replicas, and scheduled backups are Turso product features. They are not in `package.json`. If your Turso plan includes them, enable them in the Turso dashboard for **each** customer database and confirm the commands with `turso --help`. A database created by `turso:customer` does not turn those features on for you.

Take a dump or snapshot before `offboard:customer --apply` or a manual `turso db destroy` if you might need the data. After destroy, ProcureFlow cannot reconstruct it.

### 4.6 Destroy

```bash
turso db destroy procureflow-acme --yes
```

Prefer `npm run offboard:customer` (section 9) when the customer is leaving. That removes the Vercel env vars first, then destroys the database. A bare `turso db destroy` leaves the Vercel project and its env pointing at a database that no longer exists.

### 4.7 Costs and limits

This repository does not record Turso or Vercel prices, storage quotas, or row limits. Budget for **one Turso database and one Vercel project per customer**. There is no shared database you can use to reduce that count. The app configures no Vercel Cron.

---

## 5. Vercel

One Vercel project per customer. Default name: `procureflow-<slug>`. Override with `--project`. Do not add a second customer as another domain on an existing ProcureFlow project.

### 5.1 Create and link the project

`onboard:customer --apply` and `vercel:customer --apply` do this before they write env. Checked against Vercel CLI 59.x:

```bash
vercel project add procureflow-acme
vercel link --yes --project procureflow-acme
```

| This checkout | What `--apply` does |
| --- | --- |
| No `.vercel/project.json` | `vercel project add` (create, or reuse if the CLI says it already exists), then `vercel link --yes --project procureflow-acme` |
| Already linked to `procureflow-acme` | Skips both |
| Linked to a different project | Stops. Does not retarget. Does not change that other project’s env |

`vercel project add` only creates the project. It does not import GitHub and it does not turn on git-push deploys. Production is deployed from this laptop (`vercel deploy --prod` or `vercel redeploy`). If you want `git push` to deploy, connect the GitHub repo once in the Vercel dashboard for that project. These commands cannot do that connection reliably, so do not expect it to happen by itself.

Root directory is the repository root. The build command is already in [`vercel.json`](../vercel.json): `npm run build`. Framework is unset (`null`). There is no cron.

What a deploy does:

1. `npm run build` installs the client, runs Vite, deletes `public/`, and copies `client/dist` into `public/`.
2. Deploys `api/index.js` as one Node function. `includeFiles` keeps `server/src/schema.sql` in the bundle.
3. Rewrites `/api/(.*)` to that function.
4. Serves `public/` from the CDN. `express.static` is ignored on Vercel, so the UI must be in `public/`.

`api/index.js` has to live under `api/`. A `vercel.json` `functions` key of `app.js` at the repo root fails on CLI 59 with `unmatched-function-pattern`.

Dashboard fallback, if `project add` cannot run: Add New → Project, name `procureflow-acme`, root = repository root, then re-run the CLI. Do not attach Acme to another customer’s project.

### 5.2 Environment variables from the CLI

Export the three secrets first (section 4.1). The Vercel command refuses to invent them.

```bash
npm run vercel:customer -- --slug acme          # dry-run, no network
npm run vercel:customer -- --slug acme --apply
```

`--apply` checks `vercel whoami`, ensures the project and link, then for each of the three keys and for both `production` and `preview` runs:

```bash
printf '%s' "$TURSO_DATABASE_URL" | vercel env add TURSO_DATABASE_URL production --yes --force
printf '%s' "$TURSO_DATABASE_URL" | vercel env add TURSO_DATABASE_URL preview --yes --force
printf '%s' "$TURSO_AUTH_TOKEN"   | vercel env add TURSO_AUTH_TOKEN production --yes --force
printf '%s' "$TURSO_AUTH_TOKEN"   | vercel env add TURSO_AUTH_TOKEN preview --yes --force
printf '%s' "$SESSION_SECRET"     | vercel env add SESSION_SECRET production --yes --force
printf '%s' "$SESSION_SECRET"     | vercel env add SESSION_SECRET preview --yes --force
```

The secret goes on stdin. It is not placed in the argument list. `--force` updates a key that is already there. The command does not set `DEMO_PERSONA_SWITCHER`, `IDENTITY_PROVIDER`, `APP_BASE_URL`, `LOCAL_LOGIN`, or any `OIDC_*`, `SAML_*`, or `SSO_*` key, and it does not delete keys it does not write. SSO for this customer is section 3.1 and section 8.6.

### 5.3 Environment variables from the dashboard

Project → Settings → Environment Variables. Set `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `SESSION_SECRET` for **Production and Preview** (or All Environments). Leave `DEMO_PERSONA_SWITCHER` unset. If this customer uses SSO, add the keys from section 3.1 on the same two environments. Then Redeploy. Preview URLs stay broken if the variables exist only on Production. Saving env does not change a deployment that is already built.

### 5.4 Deploy and redeploy

`vercel:customer --apply` lists Production deployments (`vercel ls --environment production`). If one exists, it runs `vercel redeploy <deployment-url-or-id> --yes`. If none exists, it runs `vercel deploy --prod --yes`.

It then polls `vercel inspect <that-deployment> --json` until `readyState` is `READY`. It keeps waiting only while the state is `BUILDING`, `QUEUED`, or `INITIALIZING`. The default wait is 4 minutes (`VERCEL_READY_TIMEOUT_MS`). `ERROR`, `CANCELED` (also spelled `CANCELLED` in some CLI output), and `BLOCKED` exit non-zero immediately. A timeout exits non-zero and names the last state. The command does not return, and `onboard:customer --smoke` does not start, until that deployment is Ready.

Suggested Production URL: `https://procureflow-acme.vercel.app`.

To ship code when env is already correct and this directory is already linked to that project:

```bash
vercel deploy --prod --yes
```

That uses the linked project. It does not refresh env. Wait until the dashboard shows Ready, or inspect it yourself:

```bash
vercel inspect <deployment-url-or-id> --json
```

### 5.5 Domains, Preview, and Production

| Target | What it is |
| --- | --- |
| Production | The deployment `vercel deploy --prod` / `vercel redeploy` updates. Default hostname `https://procureflow-<slug>.vercel.app`. Custom domains you attach to Production also hit this deployment. |
| Preview | Other deployment URLs. They need the same three variables on the Preview environment. An old Preview keeps the env it was built with until you rebuild it. |
| Development | `vercel dev` / env pulled for local CLI development. The customer scripts do not write this target. Use a shell or `.env` locally instead. |

Custom domains are not set by these scripts. In the dashboard: Project → Settings → Domains → add the hostname, then create the DNS records Vercel shows you. After the domain serves Production, point smoke at it:

```bash
BASE_URL=https://procure.acme.example npm run smoke
```

The `*.vercel.app` hostname keeps working. Isolation does not change because you added a domain. Do not point two customers’ domains at one project.

### 5.6 Rollback

Instant Rollback in the Vercel dashboard (open a previous Production deployment and roll back) restores **code** only. The Turso database is not reverted. Env vars are not reverted. Sessions stay valid as long as `SESSION_SECRET` is unchanged.

To undo data, restore a Turso dump you took earlier, or point this project at another database URL that still exists (`vercel:customer --apply` with that URL’s token). Destroy-and-recreate is an empty database, not a restore.

### 5.7 Logs

Build and runtime logs are on the deployment page in the Vercel dashboard. The CLIs print command output and, on failure, the CLI’s stderr. `vercel:customer` redacts the three secret values out of text it prints (it substitutes `$TURSO_DATABASE_URL` and the other names). `db:status` never prints the token.

There is no separate monitoring product in this repo. The health check is `GET /api/health` (`status`, `db` of `turso-http` or `sqlite`). `npm run smoke` is the operator check (section 6.4).

---

## 6. New customer

### 6.1 One command (preferred)

Log in to both CLIs and `vercel switch` to the right team first. Dry-run, then apply.

```bash
npm run onboard:customer -- --slug acme

npm run onboard:customer -- --slug acme --apply \
  --email admin@acme.test \
  --password 'choose-a-long-password' \
  --name "Ada Admin" \
  --smoke
```

Dry-run is the default. It prints the plan and does not call Turso, Vercel, or the database. It does not invent secrets. `--apply` and `--dry-run` together are an error.

`--apply` runs inside one process, in this order:

1. Turso: create or reuse `procureflow-acme`, mint a database token, mint or reuse `SESSION_SECRET`.
2. Vercel: create or reuse project `procureflow-acme`, link this checkout, write the three env vars to Production and Preview, redeploy, wait until that Production deployment is Ready.
3. Provision: `db:migrate`, then the org skeleton (on by default), then the first admin if you passed both `--email` and `--password`.
4. If you passed `--smoke`, HTTP checks against `https://procureflow-acme.vercel.app` (or `--base-url`). Smoke runs only after Ready, so it is not racing a build.

| Flag | Meaning |
| --- | --- |
| `--slug <customer>` | Required. Default database and project `procureflow-<slug>`. |
| `--db <name>` | Override the Turso database name. |
| `--project <name>` | Override the Vercel project name. |
| `--apply` | Do the work. Without it, dry-run. |
| `--email` and `--password` | First admin. Both or neither. Password must be at least 8 characters. |
| `--name <display>` | First-admin display name. Optional. Default from bootstrap is `Administrator` if you omit it on the standalone CLI. |
| `--with-org` | Org skeleton. **Already the default** on this command. |
| `--no-org` | Schema and optional admin only. Departments stay empty. |
| `--smoke` | Run smoke after provision. |
| `--base-url <url>` | Smoke and the printed next-step URL. |
| `--json` | Machine-readable summary. Tokens redacted to the last 4 characters. Full Turso export lines may still appear on stdout. |
| `--help` | Help text. |

`--apply` never seeds, never sets `DEMO_PERSONA_SWITCHER`, and never destroys a database. `--seed` is refused.

If Vercel fails after Turso succeeded, the database is left in place and is not seeded. Fix the Vercel error and re-run the same `--apply`. The database is reused. A re-run mints a **new** `SESSION_SECRET` and a **new** database token unless `SESSION_SECRET` is already in your shell. Save the `export` lines from the run that finishes, not from an earlier attempt.

`vercel project add` still does not connect GitHub.

### 6.2 The same steps, one command at a time

Use this when you need to repeat a single step. Copy the Turso `export` lines into the shell before the Vercel step.

```bash
npm run turso:customer -- --slug acme
npm run turso:customer -- --slug acme --apply
# paste the three export lines into this shell and the password manager

vercel login
vercel whoami
vercel switch          # only if you have more than one team

npm run vercel:customer -- --slug acme
npm run vercel:customer -- --slug acme --apply

npm run provision:customer -- --with-org \
  --name "Ada Admin" \
  --email admin@acme.test \
  --password 'choose-a-long-password'

BASE_URL=https://procureflow-acme.vercel.app npm run smoke
```

Equivalent to the provision line, if you want to see each tier:

```bash
npm run db:migrate -- --turso
npm run db:status
npm run bootstrap-org
npm run bootstrap-admin -- \
  --name "Ada Admin" \
  --email admin@acme.test \
  --password 'choose-a-long-password'
```

`provision:customer` does **not** turn on the org skeleton unless you pass `--with-org` (unlike `onboard:customer`, where the skeleton is the default). It accepts `--email`, `--password`, `--name`, `--title`, `--base-url`, `--turso` / `--require-turso`, and `--json`. It refuses `--seed`.

Hand equivalents, if you are not using the wrappers:

```bash
turso auth login && turso auth whoami
turso db create procureflow-acme
turso db show procureflow-acme --url
turso db tokens create procureflow-acme

vercel login && vercel whoami
vercel project add procureflow-acme
vercel link --yes --project procureflow-acme
# then the six `vercel env add` pipes in section 5.2, then:
vercel deploy --prod --yes
```

### 6.3 Empty tenant, demo seed, and the first admin

Three tiers. Do not confuse them.

| Goal | Command | Result |
| --- | --- | --- |
| Empty schema | `npm run db:migrate` | Tables exist. No departments, budgets, users, catalog, or PRs. PR submit fails closed. |
| Org skeleton | `npm run bootstrap-org` or `provision:customer -- --with-org` or `onboard:customer` (default) | Five cost centers and FY **2026** budgets. Idempotent. Does not wipe or rename. No users. |
| First admin | `npm run bootstrap-admin` or provision/onboard with `--email` and `--password` | One admin. Catalog, PRs, and invoices stay empty. |
| Demo wipe | `npm run seed` or `npm run db:migrate -- --seed` | **Destructive.** Drops application tables on whatever database this shell points at, reloads the fictional Alice/Bob walkthrough, password `ProcureFlow!demo`. |

Do not seed a live tenant. Seed is opt-in and there is no undo inside the app.

Org skeleton (safe to re-run):

| Code | Name | FY 2026 `total_budget` |
| --- | --- | --- |
| MKT | Marketing | `10000000` cents (€ 100.000,00) |
| ITE | IT | same |
| FAC | Facilities | same |
| HRP | HR | same |
| ADM | Finance | same |

`committed_amount` and `actual_spent` start at 0. `approver_user_id` stays unset. There is no screen to create a department or a budget. Map heads later in **Administration → Department Approvers** after the people exist.

```bash
npm run bootstrap-org
npm run bootstrap-org -- --json
npm run bootstrap-org -- --fiscal-year 2026 --budget-cents 10000000
npm run bootstrap-org -- --force-budget
```

`--force-budget` rewrites `total_budget` on existing FY rows to `--budget-cents`. It does not change committed or actual amounts. Budget queries in the app are hardcoded to fiscal year 2026, so leave the year at 2026 unless you know the code has changed.

First admin, if you did not pass `--email` to onboard:

- **CLI.** `npm run bootstrap-admin -- --email … --password '…' [--name "…"] [--title "…"]`. Exit **2** if any user already exists. It will not add a second admin.
- **UI.** If the database has zero users, open the Production URL. The login page shows **Create the first admin** (name, email, password of at least 8 characters). That calls `POST /api/auth/bootstrap`.

Then sign in and create everyone else under **Administration → Users** (unique email, role, department, title, approval limit, password). Deactivate with status. `DELETE` returns 405. Hand each person their own password. Do not share `ProcureFlow!demo`.

SSO does not replace this step. Just-in-time provisioning is off by default, and when it is on the new user’s role is `SSO_DEFAULT_ROLE` or the stored default (`requester`), never a role from the IdP. An empty database still needs this first admin before anyone can turn provisioning on in the UI (`PUT /api/auth/sso-settings` is admin-only). Bootstrap is `POST /api/auth/bootstrap` or `npm run bootstrap-admin`.

`npm run seed` drops application tables (including the append-only audit tables, via `DROP TABLE`, which the delete triggers do not block) and reloads the fictional walkthrough. It is demo-only. Do not run it against a customer database.

### 6.4 Smoke checklist

```bash
BASE_URL=https://procureflow-acme.vercel.app npm run smoke

# optional login after the first admin exists
npm run smoke -- --base-url https://procureflow-acme.vercel.app \
  --email admin@acme.test \
  --password 'choose-a-long-password'

npm run smoke -- --json
```

`BASE_URL` may also be `--base-url` or `--url`. No trailing path (`https://….vercel.app`, not `/login`). Exit 1 if any check fails.

| Check | Expect |
| --- | --- |
| `GET /api/health` | `status` ok, `db` is `turso-http` (or `sqlite` on a laptop) |
| `GET /api/auth/config` | HTTP 200, `auth` is `session`, `bootstrapNeeded` and `demoPersonaSwitcher` are booleans, `identityProvider` is `local`, `oidc`, or `saml`, and `ssoReady` and `localLogin` are booleans |
| `GET /api/users`, `GET /api/departments`, `GET /api/catalog` | **401** when no session cookie is sent |
| `GET /api/auth/me` | **401** when no session cookie is sent |
| `POST /api/auth/login` | Only when email and password were provided. HTTP 200 and a user |
| With that cookie: `GET /api/auth/me` | Session user matches that email |
| With that cookie: `GET /api/users` | A JSON array, no `password_hash`. Empty only when `bootstrapNeeded` is true. If `bootstrapNeeded` is false the array must not be empty |
| With that cookie: `GET /api/departments`, `GET /api/catalog` | JSON arrays (departments empty before `bootstrap-org`, five rows after; catalog empty until someone adds items) |

After a successful onboard with `--email` and `--smoke`, you should be able to open the Production URL and sign in as that admin. Confirm `DEMO_PERSONA_SWITCHER` is unset (no header persona switcher). If SSO is configured, `identityProvider` matches it and `ssoReady` is true. A false `ssoReady` with `IDENTITY_PROVIDER=oidc` or `saml` means a required IdP setting is missing or invalid (section 10).

### 6.5 Second customer

A second customer is a second database, a second Vercel project, and a new `SESSION_SECRET`. This checkout can be linked to only one Vercel project. If it is still linked to `procureflow-acme`, `vercel:customer --slug beta --apply` **stops** and does not retarget. Use another clone, or a checkout that is not linked to Acme.

```bash
npm run onboard:customer -- --slug beta --apply \
  --email admin@beta.test \
  --password 'choose-a-long-password' \
  --smoke
```

Never paste Acme’s URL or token into Beta’s project.

### 6.6 Laptop SQLite (not a Vercel customer)

```bash
unset TURSO_DATABASE_URL TURSO_AUTH_TOKEN
export PROCUREMENT_DB_PATH="$PWD/server/data/acme.db"
npm run provision:customer -- --with-org \
  --email admin@acme.test \
  --password 'choose-a-long-password'
npm start
BASE_URL=http://127.0.0.1:5000 npm run smoke
```

Do not commit `*.db`. `server/data/` is gitignored. For the fictional walkthrough only: unset Turso, `npm run seed`, and optionally `export DEMO_PERSONA_SWITCHER=1`, then `npm run dev` (API on port 5000, Vite on port 3000). Demo login after seed: `alice.chen@company.com` / `ProcureFlow!demo`.

---

## 7. Updating existing customers

There is no command that deploys every customer in one shot. One checkout’s `.vercel/project.json` names one project. The customer CLIs will not retarget a checkout that is linked to someone else.

For each customer, from a clone that is unlinked or already linked to **that** project:

1. `git pull` the release. `npm install` at the repo root if dependencies changed.
2. Export **this** customer’s `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `SESSION_SECRET` from the password manager.
3. Apply migrations **before** you replace Production, using the new code:

   ```bash
   npm run db:migrate -- --turso
   npm run db:status
   ```

   Migrations are additive. They do not seed. This is also how an existing database picks up `compliance_audit_events` and the append-only triggers. A failed migrate stops here, while the previous deployment is still serving.
4. Deploy that same checkout.
   - Env unchanged and the directory is already linked to this customer: `vercel deploy --prod --yes`.
   - You also need to refresh the three secrets: `npm run vercel:customer -- --slug <slug> --apply` (writes Production and Preview, redeploys, waits until Ready).
5. `BASE_URL=https://procureflow-<slug>.vercel.app npm run smoke`.
6. Do not `npm run seed`.

The first request of a new deployment also runs `applySchema`. Laptop migrate-first is still the right order, so a bad migration does not take down the live function.

Repeat from step 2 for the next slug. Do not leave the previous customer’s `TURSO_*` exported.

GitHub auto-deploy, if you connected it in the dashboard, builds from the branch you attached. You still run `db:migrate` yourself for each database. A git push does not migrate Turso.

---

## 8. Operations

### 8.1 Rotate `SESSION_SECRET`

Rotating the secret signs everyone out. They sign in again with the same password. The database is unchanged.

```bash
export TURSO_DATABASE_URL='libsql://…'     # unchanged
export TURSO_AUTH_TOKEN='…'                # unchanged, unless you are rotating it too
export SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
npm run vercel:customer -- --slug acme --apply
```

Store the new secret in the password manager. Do not run `turso:customer --apply` for a secret-only rotation: that command also mints a new database token. If `SESSION_SECRET` is already exported, `turso:customer` will keep it.

Production and Preview for one customer may share one secret. Two customers must not.

### 8.2 Rotate the Turso token

Section 4.4. Then smoke the Production URL. A 401 from Turso means the deployment is still using an org JWT or a token for a different database.

### 8.3 Add users

Only the first admin is created by the CLI. After that, sign in as an admin and use **Administration → Users**. `npm run bootstrap-admin` exits 2 once any user exists.

Set a password on create, or **Set password** later. Soft-deactivate instead of deleting. Map **Administration → Department Approvers** or PR submit fails closed for a department with no head and no `approver` in that department. Add suppliers and catalog items under **Vendors & Catalog**. Nothing in the empty tenant imports a spreadsheet for you.

### 8.4 Backups

Section 4.5. Put a Turso dump or the platform’s snapshot on your calendar per customer. This app will not do it. Test a restore on a **new** database name before you need it. Do not restore over a live customer URL until you have a second copy.

### 8.5 Monitoring and logs

- Vercel deployment page: build log and function log (section 5.7).
- `npm run smoke` against the Production URL after every deploy and every secret rotation.
- `npm run db:status` with that customer’s `TURSO_*` when the user count or table count looks wrong.
- `GET /api/health` returns `db: "turso-http"` when the function is on Turso.

There is no uptime hook, no cron, and no error tracker in the repo. A 503 HTML page titled ProcureFlow configuration means Turso env is missing or Turso rejected the token (section 10). After the first admin exists, the compliance verification report (section 8.7) is the data health check.

### 8.6 Configure SSO for this customer

Skip this section when the customer will use email and password only. Leave `IDENTITY_PROVIDER` unset.

The names and defaults are section 3.1. Full notes: [DEPLOYMENT.md §2.1](DEPLOYMENT.md#21-sso-oidc-or-saml-per-customer). Set the values on **this** project’s Production and Preview, not in the database and not on another customer’s project. Then redeploy. If the three database secrets are already exported:

```bash
npm run vercel:customer -- --slug acme --apply
```

That rewrites `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `SESSION_SECRET` and redeploys. It does not erase SSO keys you added in the dashboard. If you only changed SSO keys and this checkout is already linked to `procureflow-acme`:

```bash
vercel deploy --prod --yes
```

Wait until that deployment is Ready, then:

```bash
BASE_URL=https://procureflow-acme.vercel.app npm run smoke
```

`GET /api/auth/config` should show `identityProvider` of `oidc` or `saml` and `ssoReady: true`. If a required value is missing or invalid, OIDC start (`GET /api/auth/oidc/start`), the OIDC callback, SAML start (`GET /api/auth/saml/start`), and the SAML ACS (`POST /api/auth/saml/acs`) set no `pf_session`. With `Accept: application/json` the status is **503** `sso_not_configured`. A browser, when `APP_BASE_URL` is set, is sent to `/?sso_error=sso_not_configured`. An unknown `IDENTITY_PROVIDER` does the same. Password login still works unless `LOCAL_LOGIN=0`.

Register these URLs on the IdP (replace the origin with `APP_BASE_URL`):

| Protocol | Give the IdP |
| --- | --- |
| OIDC | Redirect `{APP_BASE_URL}/api/auth/oidc/callback`, unless `OIDC_REDIRECT_URI` overrides it |
| SAML | ACS `{APP_BASE_URL}/api/auth/saml/acs` (POST), unless `SAML_ACS_URL` overrides it. Metadata is `GET {APP_BASE_URL}/api/auth/saml/metadata` |

Who can sign in: an existing user matched by a stored IdP subject (`user_identities`) or by verified email. OIDC requires `email_verified`. Unknown users are rejected (`403 sso_user_unknown`) until provisioning is turned on.

Provisioning stays **off** unless you choose one of these:

- Set `SSO_PROVISIONING=1` (and optionally `SSO_DEFAULT_ROLE`) on Production and Preview, then redeploy.
- As a signed-in admin, `PUT /api/auth/sso-settings` with `{ "provisioning": true, "defaultRole": "requester" }`. `sso_provisioning` and `sso_default_role` are aliases for those two fields. A bad role, a bad flag, or aliases that disagree is rejected and does not change the row. A `role` field on the body is ignored.

`SSO_DEFAULT_ROLE` overrides the stored role when it is one of the five roles. The role never comes from an IdP claim. The first admin still comes from bootstrap. A just-in-time user has no password. `GET /api/auth/sso-settings` is admin-only.

`OIDC_CLIENT_SECRET` and `SAML_IDP_CERT` stay in this customer’s env. Do not insert them into `tenant_settings` or any other table.

### 8.7 Audit and compliance

`npm run db:migrate`, or the next process start, applies the ledger and the triggers. You do not run extra SQL.

These tables are append-only. `UPDATE` and `DELETE` abort in the database:

| Table | What it holds |
| --- | --- |
| `audit_logs` | Procurement decisions (approvals, receipts, invoices, payment runs, contracts, delegations, and the rest of the buying journey). Not hash-chained. |
| `sso_login_events` | SSO success and failure. Reports read this table in place. |
| `sso_assertion_uses` | Assertion ids already consumed. |
| `compliance_audit_events` | Local login, logout, bootstrap, user changes, SSO settings, just-in-time user create, and CSV export. Each row stores `prev_hash` (`GENESIS` on the first row, otherwise the previous `row_hash`) and a SHA-256 `row_hash`. A broken link is rejected on insert. |

`sso_requests` are single-use login state and **are** deleted when the attempt finishes. They are not evidence.

Admin and finance can open **Audit & Compliance** and call:

| Report | Path |
| --- | --- |
| Audit trail | `GET /api/compliance/audit-trail` |
| Approval and segregation | `GET /api/compliance/approval-policy` |
| Paid documents missing support | `GET /api/compliance/payment-support` |
| Verification | `GET /api/compliance/verification` |

Requester, approver, and procurement receive **403**. No cookie is **401**. What each report flags is [SYSTEM_MANUAL.md §5.13](SYSTEM_MANUAL.md#513-audit-and-compliance-reports).

**Ops health check.** Sign in as the customer admin (or a finance user) and open Verification, or `GET /api/compliance/verification` with the session cookie. A healthy result has `findings` empty. An empty `compliance_audit_events` chain is valid. `hash_chain_prev_mismatch` or `hash_chain_digest_mismatch` means that ledger was altered outside the app. Money findings mean a stored total does not match the line rows. CSV is `?format=csv` on any of those paths. The file is built first, then a `COMPLIANCE_EXPORT` row is appended, so the export shows up on the next query. There is no npm script that runs these reports.

Because the rows cannot be edited or deleted, a manual `DELETE FROM audit_logs` (or the other three tables) fails. Section 9 says what actually removes them.

### 8.8 Integrations

`npm run db:migrate`, or the next process start, creates `api_keys`, `api_key_rate_windows`, `integration_entity_links`, `integration_idempotency`, and `webhook_outbox`. You do not run extra SQL. API keys are rows in this customer’s database. The webhook URL and signing secret are environment variables on this deployment. They are not in the database, and the CLIs do not set them.

**Issue a key**

1. Sign in as the customer admin (`pf_session`, role `admin`). Finance and everyone else get **403** on these routes.
2. Open **Administration → Integrations**, or `POST /api/integrations/keys` with `{ "name": "SAP vendor sync", "scopes": ["vendors:write"], "rate_limit_per_minute": 60 }`. Optional `expires_at` is an ISO timestamp in the future.
3. The response includes `key` (`pfk_…`) once. Copy it into the password manager. `GET /api/integrations/keys` returns the prefix, scopes, expiry, last used, and rate limit. It does not return the key or the hash.
4. Revoke with **Revoke** or `POST /api/integrations/keys/:id/revoke`. Create and revoke append `API_KEY_CREATED` and `API_KEY_REVOKED` to `compliance_audit_events` under the admin’s name. The hash stays in `api_keys`. The row is not deleted.

Scopes are `vendors:write`, `catalog:write`, and `export:read`. The default limit is 60 requests in a minute. Over the limit is **429**.

**What the ERP calls**

| Call | Scope |
| --- | --- |
| `POST /api/integrations/vendors` | `vendors:write` |
| `POST /api/integrations/catalog` | `catalog:write` |
| `GET /api/integrations/exports/invoices` | `export:read` |
| `GET /api/integrations/exports/payment-runs` | `export:read` |

Header: `Authorization: Bearer pfk_…`. A `pf_session` cookie does not authorize these four routes. The key does not authorize the rest of `/api` (those still require the cookie, and a missing cookie is **401**). The key’s name is the audit actor. Do not send `user_id` or `actor_name`. That body is **400**.

Vendor and catalog bodies are keyed by `external_id`. Sending the same id again updates that row. `Idempotency-Key` replays the first success. Catalog `unit_price` is integer cents. Preferred vendor is `preferred_supplier_external_id` (upsert the vendor first).

**Configure webhooks**

On that customer’s Vercel project, Production and Preview:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put the hex in `WEBHOOK_SIGNING_SECRET`. Put the receiver’s `https` URL in `WEBHOOK_TARGET_URL`. Redeploy. Do not commit either value. `GET /api/integrations/config` with the admin cookie returns `webhook_target_configured`, `webhook_signing_secret_configured`, and `webhook_target_host`. It does not return the secret or the URL.

Events written with the business transaction: `po.issued`, `receipt.posted` (goods receipt), `invoice.approved`, `payment_run.created`, `payment_run.paid`. Payloads that already carry cent amounts (`po.issued`, `invoice.approved`, `payment_run.created`, `payment_run.paid`) also include `currency` (this deployment’s code, default `EUR`). `receipt.posted` has no amount and no `currency` field. Cent field names and values are unchanged. Invoice and payment-run export JSON uses the same `currency` value (it was hardcoded `USD` before Sprint 5). The payment-run CSV adds `currency` as the last column. The invoice CSV already had that column; the value follows `CURRENCY`.

The receiver gets `X-ProcureFlow-Signature: t=<unix seconds>,v1=<hex>` where `v1` is HMAC-SHA256 of `${t}.${rawBody}` using the signing secret. Reject a timestamp more than five minutes from now. Dedupe on the JSON `id` (`evt_<n>`). A retry signs again with a new timestamp and the same id. The dispatcher, retry schedule, and drain are unchanged.

Five attempts, then status `dead`. Backoff is 30 seconds, 2 minutes, 10 minutes, then 1 hour. If the URL or secret is unset, rows stay `pending` and attempts are not burned. A long-running `npm start` sweeps every 30 seconds. On Vercel, delivery is attempted when the event is written; further tries are **Deliver pending**, **Replay**, or the next business event. Replay is `POST /api/integrations/outbox/:id/replay` (admin cookie). It resets the attempt count.

There is still no inbound supplier-invoice connector and no SAP/NetSuite-specific adapter.

---

## 9. Offboarding

Dry-run is the default and does not use the network. `--apply` does not remove env or destroy the database unless `--confirm-slug` equals the normalized slug. `acme` matches. `Acme` does not.

```bash
npm run offboard:customer -- --slug acme
npm run offboard:customer -- --slug acme --apply --confirm-slug acme
```

What `--apply` does, in order:

1. If this checkout is linked to a **different** Vercel project, it stops. It does not run `vercel link`, does not change env, and does not destroy the database.
2. `vercel whoami`, then `turso auth whoami`. A login failure stops before any delete. If the Vercel project is not in the current team, the command stops **before** Turso destroy. `vercel switch`, then retry. If you already deleted the project by hand, destroy the database yourself with `turso db destroy procureflow-acme --yes`.
3. Removes only `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `SESSION_SECRET` from Production and Preview:

   ```bash
   vercel env rm TURSO_DATABASE_URL production --yes --project procureflow-acme
   vercel env rm TURSO_DATABASE_URL preview --yes --project procureflow-acme
   vercel env rm TURSO_AUTH_TOKEN production --yes --project procureflow-acme
   vercel env rm TURSO_AUTH_TOKEN preview --yes --project procureflow-acme
   vercel env rm SESSION_SECRET production --yes --project procureflow-acme
   vercel env rm SESSION_SECRET preview --yes --project procureflow-acme
   ```

   Other keys are left alone, including `IDENTITY_PROVIDER`, `APP_BASE_URL`, `LOCAL_LOGIN`, `OIDC_*`, `SAML_*`, `SSO_*`, and `DEMO_PERSONA_SWITCHER`. A key that is already absent counts as success. Remove IdP secrets from the project yourself before you delete the project, or they remain in Vercel until the project is gone. The script does not copy them into the database.
4. `turso db destroy procureflow-acme --yes`. If the database is already gone, that counts as success.

It never seeds and never prints full tokens.

What it does **not** remove:

- The Vercel project, its domains, and its GitHub connection. `vercel project rm` on CLI 59.26.0 has no `--yes`, so the script will not delete the project.
- Deployments and Instant Rollback history (rollback still will not bring the database back).
- The token inside Turso. Deleting the env var does not revoke it.
- Password-manager copies. Delete or rotate those yourself.
- A SQLite file on a laptop. Offboard only talks to Vercel and Turso.
- Individual audit rows. `UPDATE` and `DELETE` on `audit_logs`, `sso_login_events`, `sso_assertion_uses`, and `compliance_audit_events` abort. Do not plan a SQL cleanup of those tables before destroy. `turso db destroy` removes the whole database, which is how that customer’s evidence goes away. Deleting a local SQLite file does the same for a laptop database. `npm run seed` also removes them, by `DROP TABLE`, and then loads demo data — that is a wipe, not an offboard, and it is not for a customer you are keeping.

Delete the empty Vercel project in the dashboard: Settings → General → Delete Project. Do that after offboard, or accept that an empty project remains. If you delete the project first, the next offboard cannot strip env (the project is missing) and will not reach Turso destroy. In that case run `turso db destroy` yourself. IdP secrets that offboard left on the project are deleted with the project.

`--db` and `--project` override the names. Help: `npm run offboard:customer -- --help`.

### Wipe data but keep the install

This is not offboarding. The Vercel project and its env remain until you push the new URL and token.

```bash
turso db destroy procureflow-acme --yes
npm run turso:customer -- --slug acme --apply
# paste the new exports
npm run vercel:customer -- --slug acme --apply
npm run provision:customer -- --with-org \
  --email admin@acme.test \
  --password 'choose-a-long-password'
```

Local SQLite wipe:

```bash
rm -f "$PROCUREMENT_DB_PATH" "$PROCUREMENT_DB_PATH"-wal "$PROCUREMENT_DB_PATH"-shm
npm run db:migrate
```

---

## 10. Troubleshooting

### Turso SQL parse error at startup

Symptom: logs contain `SQL string could not be parsed: unexpected end of input` while schema is applied.

Cause: Turso’s HTTP API parses one statement at a time. An earlier bug split `schema.sql` on every semicolon, including semicolons inside `--` comments and string literals, and sent a truncated `CREATE TABLE`. The splitter in `server/src/tursoHttp.js` (`splitSqlScript`) keeps those semicolons inside the statement.

What to do: deploy the current release (do not hand-split `schema.sql` on semicolons and paste the pieces). If a new schema edit brings the error back, a comment or string in `schema.sql` contains a semicolon and the splitter missed it. That is a code fix, not an env change. `npm run db:migrate -- --turso` on the laptop reproduces it before you redeploy.

### Vercel functions path error

Symptom: deploy fails with `unmatched-function-pattern`.

Cause: CLI 59 only accepts `vercel.json` `functions` keys for files under `api/`. A root `app.js` key is invalid.

What to do: leave the committed `vercel.json` as it is (`api/index.js`, `includeFiles` = `server/src/schema.sql`, rewrite `/api/(.*)` → `/api`). Do not point `functions` at `server/src/app.js`.

### Missing Turso env (HTTP 503 / `TursoConfigError`)

Symptom: HTML setup page, or JSON `{ "error": "TursoConfigError" }` on `/api/*`. Smoke adds a hint to set the three variables on Production and Preview and Redeploy.

Cause: `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are not both visible to **that** deployment. Partial credentials are also refused on the laptop CLIs (they will not open SQLite instead).

What to do: `npm run vercel:customer -- --slug acme --apply`, or set both variables (and `SESSION_SECRET`) on Production and Preview in the dashboard, then Redeploy. Wait until Ready. A deployment that was built before the variables existed keeps failing until it is replaced.

### Turso HTTP 401 / token rejected

Symptom: 503 whose detail says the token was rejected, and mentions `turso db tokens create`.

Cause: `TURSO_AUTH_TOKEN` is an org or platform JWT (`turso auth token`), or a token minted for a different database.

What to do: `turso db tokens create procureflow-acme`, export it, `npm run vercel:customer -- --slug acme --apply`.

### Not logged in, or the CLI is missing

Symptom: the command exits before any create or delete. Exit **127** means the binary was not on `PATH`.

What to do:

```bash
turso auth login && turso auth whoami
vercel login && vercel whoami
vercel switch
```

Install commands are in section 2. `TURSO_CLI` and `VERCEL_CLI` can point at a binary that is not on `PATH`.

### Linked to the wrong project, or the wrong team

Symptom: `--apply` says this directory is linked to another project and refuses to retarget. Or offboard says the Vercel project was not found and the database was **not** destroyed.

What to do: `vercel switch` to the team that owns `procureflow-<slug>`. Run from a checkout linked to that project, or from a checkout with no `.vercel/project.json`. Do not delete `.vercel/project.json` until you know which customer it was linked to.

### Preview URL broken, Production works

Preview is missing the variables, or that Preview deployment was built before they were saved. `vercel:customer --apply` sets Preview as well as Production, but it only redeploys Production. Rebuild the Preview (open a new Preview deployment) after the env save. Old Previews do not pick up env edits.

### `SESSION_SECRET` missing, or everyone is logged out after a redeploy

Customer deploys must set `SESSION_SECRET`. If you changed it, every `pf_session` cookie is invalid. That is what rotation does. Put the same secret on Production and Preview for that one project.

### Smoke fails, laptop migrate worked

- `BASE_URL` must be the origin only.
- The Production deployment you are hitting must be Ready and must have been built after the env was saved.
- `npm run db:status` with the same `TURSO_*` should show `turso-http` and the user count you expect.
- Increase `VERCEL_READY_TIMEOUT_MS` if `--apply` timed out while the dashboard still shows Building, then re-run. If the state was `ERROR` or `CANCELED`, read the build log (section 5.7) and redeploy. Do not treat a timeout as a successful onboard.

### Stale client on your laptop

`npm start` serves the first directory that contains `index.html` among `client/dist`, `public/`, and the same folders under the current working directory. If you edited React and did not rebuild, you are looking at the old bundle.

What to do: `npm run dev` for a live Vite UI (port 3000, API on 5000), or `npm run build` before `npm start`. Vercel does not use that leftover dist as the source of the UI. Its build command rebuilds `public/`. A stale UI on a customer URL means the last Production deployment did not include your commit, not a leftover local folder.

### Login fails: users exist, nobody has a password

Typical of a **legacy seed from before auth** (`users` rows, empty `user_credentials`). Login returns 401. `bootstrapNeeded` is false, so the UI will not offer Create the first admin. `bootstrap-admin` exits 2.

| Situation | Fix |
| --- | --- |
| Disposable demo database | `npm run seed` (destructive) and use `ProcureFlow!demo` |
| An admin can already sign in | Administration → Users → Set password |
| Nobody can sign in and you must keep the customer | Wipe and recreate (section 9), then migrate, `bootstrap-org`, and `bootstrap-admin`. Bootstrap will not run while any user row exists |

Do not put the demo password on a tenant you intend to keep.

### `better-sqlite3` will not load

Local SQLite needs the optional dependency `better-sqlite3`. Re-run `npm install` at the repo root on the same Node version you use to start the app. Turso mode does not need it. Vercel must not be forced onto SQLite.

### PR submit fails on a new customer

There is no cost center, or no FY 2026 budget, or no department head (and no user with role `approver` in that department). Run `npm run bootstrap-org`, create users, then map heads. Catalog and suppliers are also empty until someone adds them.

### Password rejected

The minimum length is 8 characters. The CLI and the bootstrap API both enforce that. An inactive user gets **403**, not a wrong-password **401**.

### SSO fails closed (`sso_not_configured`)

`IDENTITY_PROVIDER` is `oidc` or `saml` (or some other non-`local` value) and a required setting is missing or invalid, so `ssoReady` is false. Start and callback set no cookie. A JSON client sees **503** `sso_not_configured`. The login page may instead land on `/?sso_error=sso_not_configured` when `APP_BASE_URL` is set. Password login still works unless `LOCAL_LOGIN=0`.

What to do: compare the project env with section 3.1. `APP_BASE_URL` must be the origin only. OIDC issuer and SAML entry point must be HTTPS unless you are on a local mock (`OIDC_ALLOW_INSECURE` / `SAML_ALLOW_INSECURE`). Do not set those insecure flags on a customer project. Both SAML signature flags false is rejected. Redeploy after the env edit. `GET /api/auth/config` then shows `ssoReady: true`.

### SQL cleanup of audit rows fails

`UPDATE` or `DELETE` on `audit_logs`, `sso_login_events`, `sso_assertion_uses`, or `compliance_audit_events` aborts with an append-only error. That is expected. Destroy the database (section 9) or, for a disposable demo file only, `npm run seed` (it drops the tables). Do not disable the triggers to “fix” a report. Use the verification report (section 8.7) when a total looks wrong.

### Git push did not deploy

`vercel project add` does not connect GitHub. Either `vercel deploy --prod --yes` from a linked checkout, or connect the repo in the dashboard (section 5.1).

---

## 11. Security checklist

- [ ] Customer A and customer B have different Turso URLs, different Vercel projects, and different `SESSION_SECRET` values.
- [ ] `TURSO_AUTH_TOKEN` is a **database** token from `turso db tokens create`, not an org JWT.
- [ ] `SESSION_SECRET` is set on Production and Preview and stored only in Vercel and the password manager. It is not the dev default.
- [ ] `DEMO_PERSONA_SWITCHER` is unset on the customer project.
- [ ] `npm run seed` was not run against this database (or you accepted a full wipe).
- [ ] The first admin was created with `POST /api/auth/bootstrap` or `npm run bootstrap-admin`. The password is not `ProcureFlow!demo`.
- [ ] Business APIs require `pf_session`. You are not relying on a user id in the JSON body.
- [ ] If SSO is off, `IDENTITY_PROVIDER` is unset or `local`. If it is on, the IdP secret (`OIDC_CLIENT_SECRET` or `SAML_IDP_CERT`) is only in this project’s env, Production and Preview, and `ssoReady` is true after redeploy. `OIDC_ALLOW_INSECURE` and `SAML_ALLOW_INSECURE` are unset.
- [ ] Provisioning is still off unless this customer asked for just-in-time users. The default role is not taken from the IdP. The first admin was not created by SSO.
- [ ] API keys, if any, were copied once into the password manager. `WEBHOOK_SIGNING_SECRET` is set only on this customer’s Production and Preview, not in git and not in the database.
- [ ] `.env`, tokens, and `*.db` are not in git. `vercel.json` does not contain secrets.
- [ ] Preview and Production both have the three database variables. You redeployed after the last env edit.
- [ ] `BASE_URL=https://<this-customer>.vercel.app npm run smoke` exited 0 after that redeploy.
- [ ] Extra people were created in Administration → Users with their own passwords, or they sign in through the IdP against accounts you created.
- [ ] An admin or finance user can open **Audit & Compliance → Verification** and the findings list is empty (section 8.7). CSV export is expected to append a `COMPLIANCE_EXPORT` row.
- [ ] You have not planned a SQL `DELETE` of audit rows. Offboard destroys the database instead.
- [ ] Offboard, when you use it, is followed by deleting the password-manager copies, removing leftover IdP env vars (or deleting the Vercel project), and revoking the Turso token in Turso. The script does not revoke the token, does not remove SSO env vars, and does not delete the Vercel project.
- [ ] A Turso dump or platform snapshot exists before any `turso db destroy`.

---

## 12. Command index

Dry-run is the default only for the customer CLIs `onboard:customer`, `turso:customer`, `vercel:customer`, and `offboard:customer`. Those four print a plan and do not call Turso, Vercel, or the database until `--apply`. `offboard:customer --apply` also requires `--confirm-slug`. `provision:customer`, `db:migrate`, `db:status`, `bootstrap-org`, `bootstrap-admin`, `smoke`, and `seed` run immediately and have no `--dry-run` flag. `--help` prints the flags.

| Command | What it does |
| --- | --- |
| `npm run onboard:customer -- --slug <slug>` | Plan. |
| `npm run onboard:customer -- --slug <slug> --apply --email … --password '…' --smoke` | Turso + Vercel project, link, env, wait for Ready, migrate, org skeleton, first admin, smoke. |
| `npm run turso:customer -- --slug <slug> --apply` | Create or reuse the database, print exports. |
| `npm run vercel:customer -- --slug <slug> --apply` | Link, set Production and Preview, redeploy, wait for Ready. |
| `npm run provision:customer -- --with-org --email … --password '…'` | Migrate, org skeleton, first admin. Never seeds. |
| `npm run db:migrate -- --turso` | Schema, including `compliance_audit_events` and the append-only triggers. `--seed` wipes. |
| `npm run db:status` | Mode, tables, user count. No secrets. |
| `npm run bootstrap-org` | Five cost centers and FY 2026 budgets. |
| `npm run bootstrap-admin -- --email … --password '…'` | First admin only (`POST /api/auth/bootstrap` is the UI equivalent). Exit 2 if users exist. Optional `--name` and `--title`. |
| `npm run smoke` | HTTP checks. Set `BASE_URL`. Optional `--email` and `--password` together. |
| `npm run offboard:customer -- --slug <slug> --apply --confirm-slug <slug>` | Strip the three env vars, then `turso db destroy`. Leaves the Vercel project and any SSO env vars. |
| `npm run seed` | Destructive demo. Drops application tables and loads personas. Not for a live customer. |

There is no npm script for SSO settings or compliance reports. Those are environment variables (section 3.1) and `GET /api/compliance/…` for an admin or finance session (section 8.7).
