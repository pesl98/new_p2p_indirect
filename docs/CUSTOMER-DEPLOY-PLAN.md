# Customer deploy plan

Scoping note for the owner. This pull request is documentation only. It does not change the app, the CLIs, or [SPRINT-LOG.md](SPRINT-LOG.md) (another pull request owns that register).

The priority is a repeatable install per customer: **one Vercel project and one Turso database (plus a separate preview database) per customer**, then the same path for env, schema, first admin, hostname, SSO, mail, upgrades, backups, and offboarding. Feature sprints wait until this path is boring.

The isolation model is already the right one. What is missing is the fleet around it: a registry, a preview database inside the happy path, an upgrade that visits every customer, and backups.

---

## 1. Current state

### 1.1 Isolation (already decided)

There is no shared-row `org_id`. Customer A and customer B are two Turso databases and two Vercel projects. Pointing both projects at one URL merges them. `tenant_settings` is a singleton inside one customer database (SSO provisioning switch and default role). It is not a list of customers.

| Piece | Where |
| --- | --- |
| Model | [ARCHITECTURE.md](ARCHITECTURE.md) “Customer isolation = DB per tenant”; [DEPLOYMENT.md](DEPLOYMENT.md) “Isolation model”; [DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §1 |
| Operator procedure | [DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) (PR [#41](https://github.com/pesl98/new_p2p_indirect/pull/41)) |
| Short runbook | [CUSTOMER_ONBOARDING.md](CUSTOMER_ONBOARDING.md), checklist [scripts/provision-customer.md](../scripts/provision-customer.md) |
| Env names, no secrets | [.env.example](../.env.example) |
| Product behavior of SSO, mail, webhooks | [SYSTEM_MANUAL.md](SYSTEM_MANUAL.md), [DEPLOYMENT.md](DEPLOYMENT.md) §2.1 and §2.2 |

Laptop with both `TURSO_*` unset uses `better-sqlite3` (`PROCUREMENT_DB_PATH` or `server/data/procurement.db`). Vercel requires Turso. A half-set URL/token pair is refused. The function talks to classic libSQL over HTTPS `POST /v2/pipeline` ([server/src/tursoHttp.js](../server/src/tursoHttp.js)). It does not load a native libsql addon. `vercel.json` builds the Vite client into `public/` and runs two Node functions (`api/index.js`, `api/invoice-proposal-upload.js`), both bundling `server/src/schema.sql`. There is no cron in `vercel.json`.

### 1.2 Commands that exist today

All of these are dry-run unless `--apply` is passed. They shell out to `turso` and `vercel` on `PATH` (`TURSO_CLI`, `VERCEL_CLI` override the binary). They use the CLI’s current Turso org and Vercel team. They do not pass `--scope`. A checkout whose `.vercel/project.json` names a different project stops. They do not retarget that link.

| Script | What it does | Source |
| --- | --- | --- |
| `npm run onboard:customer -- --slug <slug>` | Chains Turso create/reuse, Vercel project add + link, three env vars, Production redeploy, wait until Ready, then provision. `--with-org` defaults on. `--smoke` optional. Never seeds. | [server/src/onboardCustomer.js](../server/src/onboardCustomer.js), [server/scripts/onboard-customer.js](../server/scripts/onboard-customer.js) |
| `npm run turso:customer -- --slug <slug>` | `turso db create procureflow-<slug>` (no `--group`, no `--location`, no `--tursodb`), then URL, then `turso db tokens create`, then a 32-byte `SESSION_SECRET` unless one is already exported. Reuses an existing database. Never destroys. | [server/src/tursoCustomer.js](../server/src/tursoCustomer.js) |
| `npm run vercel:customer -- --slug <slug>` | `vercel project add` + `vercel link`, writes `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `SESSION_SECRET` to **Production and Preview**, redeploys, polls `vercel inspect --json` until Ready (default 4 minutes, `VERCEL_READY_TIMEOUT_MS`). Does not connect GitHub. | [server/src/vercelCustomer.js](../server/src/vercelCustomer.js) (`CUSTOMER_ENV_KEYS`, `VERCEL_ENV_TARGETS`) |
| `npm run provision:customer` | Schema + optional `--with-org` + optional first admin. This is **not** the full customer install. The full install is `onboard:customer`. | [server/src/provisionCustomer.js](../server/src/provisionCustomer.js), [server/src/provision.js](../server/src/provision.js) |
| `npm run db:migrate` / `db:status` | `applySchema`, or a read-only table/user count. `--seed` is the destructive demo wipe. `--turso` fails closed when `TURSO_*` are unset. | [server/scripts/db-migrate.js](../server/scripts/db-migrate.js), [server/scripts/db-status.js](../server/scripts/db-status.js) |
| `npm run bootstrap-org` | Idempotent five cost centers and fiscal-year budgets. Does not wipe. | [server/scripts/bootstrap-org.js](../server/scripts/bootstrap-org.js) |
| `npm run bootstrap-admin` | First admin on an empty user table. Exits once any user exists. | [server/src/bootstrapAdmin.js](../server/src/bootstrapAdmin.js) |
| `npm run db:seed:preview` | Demo personas on a Preview database only. Second run is a no-op. Refuses a database that already has other users or departments. | [server/src/previewSeed.js](../server/src/previewSeed.js) |
| `npm run seed` | Destructive demo wipe of whatever database the shell points at. Password `ProcureFlow!demo`. | [server/src/seed.js](../server/src/seed.js) |
| `npm run smoke` | `/api/health`, auth config, users. Optional login. | [server/scripts/smoke.js](../server/scripts/smoke.js) |
| `npm run offboard:customer -- --slug <slug>` | With `--apply --confirm-slug <slug>`: removes the three customer env keys from Production and Preview, then `turso db destroy` on the production database name. Leaves the Vercel project. | PR [#40](https://github.com/pesl98/new_p2p_indirect/pull/40), [server/src/offboardCustomer.js](../server/src/offboardCustomer.js) |

`package.json` and `server/package.json` both expose these scripts. Tests inject a fake process runner (no live Turso or Vercel): [server/src/onboardCustomer.test.js](../server/src/onboardCustomer.test.js), [server/src/tursoCustomer.test.js](../server/src/tursoCustomer.test.js), [server/src/vercelCustomer.test.js](../server/src/vercelCustomer.test.js), [server/src/offboardCustomer.test.js](../server/src/offboardCustomer.test.js), [server/src/provision.test.js](../server/src/provision.test.js). [server/src/provision.test.js](../server/src/provision.test.js) also locks phrases in the runbooks, including the exact offboard command in [DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) and the “onboard before the stepped Turso path” order in [CUSTOMER_ONBOARDING.md](CUSTOMER_ONBOARDING.md). A later CLI change has to update those docs in the same pull request.

### 1.3 Preview versus production (Sprint 8.0)

PR [#55](https://github.com/pesl98/new_p2p_indirect/pull/55). When `VERCEL_ENV=preview`, [server/src/dbConfig.js](../server/src/dbConfig.js) opens `TURSO_PREVIEW_DATABASE_URL` / `TURSO_PREVIEW_AUTH_TOKEN` only.

| Condition | Result |
| --- | --- |
| Preview URL or token missing | 503 `preview_db_unconfigured`. No local SQLite file. |
| Preview host equals the production host (`libsql://`, `https://`, regional `name.<region>.turso.io` count as the same database) | 503 `preview_db_matches_production` |
| Preview token equals `TURSO_AUTH_TOKEN` | 503 `preview_db_token_matches_production` |
| `ALLOW_PREVIEW_PRODUCTION_DATABASE=allow` and the preview pair is missing or illegal | Serves the production database and logs an error. `1` and `true` do nothing. |

Production and a laptop with `VERCEL_ENV` unset keep using `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`. Tests: [server/src/dbConfig.test.js](../server/src/dbConfig.test.js).

The operator manual tells a human to create `procureflow-<slug>-preview` by hand and to set the preview variables by hand ([DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §4.2.1). `onboard:customer`, `turso:customer`, and `vercel:customer` do not create that database and do not write `TURSO_PREVIEW_*`. `vercel:customer` still copies the **production** URL and token onto the Preview environment. After a finished onboard, a Preview deployment is therefore fail-closed, and the production token is present in Preview env, which is what the `allow` hatch would use.

Vercel Preview is one environment per project, shared by every git branch and every preview URL. Sprint 8.0 is one preview database per customer, not one per branch.

### 1.4 Env, secrets, domain, SSO, mail

The CLIs write three keys and nothing else: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SESSION_SECRET`. They never set `DEMO_PERSONA_SWITCHER`.

Everything else is a dashboard or `vercel env add` step, documented and not scripted:

| Concern | App support | How it is set today |
| --- | --- | --- |
| Session | HMAC `pf_session`, `SESSION_SECRET` | Minted by `turso:customer` |
| First admin | `bootstrap-admin` / onboard `--email` `--password` | Password is a CLI argument |
| Custom domain | App reads `APP_BASE_URL` for SSO redirects, supplier links, and CORS | Dashboard. [DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §5.5. Scripts do not call `vercel domains`. |
| SSO | OIDC and SAML mint the same cookie. Unknown users rejected unless provisioning is on. Secrets stay in env. | [DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §3.1, [server/src/sso.js](../server/src/sso.js), [server/src/ssoConfig.js](../server/src/ssoConfig.js) |
| SMTP | `MAIL_PROVIDER=smtp` plus `MAIL_FROM` and `MAIL_SMTP_URL`. Default is copy-link. | [server/src/mail/providers/smtp.js](../server/src/mail/providers/smtp.js). Not written by the CLIs. |
| Webhooks | `WEBHOOK_TARGET_URL`, `WEBHOOK_SIGNING_SECRET` | [DEPLOYMENT.md](DEPLOYMENT.md) §2.2 |
| Sourcing tick | `CRON_SECRET` on `/api/sourcing/tick`. Safe to run twice. | Documented as a `vercel.json` cron the repo does not ship ([DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §8, sourcing). |
| Currency, OCR, fiscal year | Env allowlists, fail closed on a bad currency | [.env.example](../.env.example) |

`turso:customer --apply` prints full `export` lines on stdout. `--json` redacts to the last four characters. A second `--apply` always runs `turso db tokens create` again (a new token, old one still valid). A second `--apply` in a shell that does not already export `SESSION_SECRET` mints a new secret and, once `vercel:customer` runs, signs every user out.

Region: `turso db create` is invoked with no `--group` and no `--location`. The database lands in the org’s default group. The scripts cannot move it later ([DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §4.2).

GitHub: `vercel project add` does not attach the repo. Production is `vercel deploy --prod` / `vercel redeploy` from a laptop. Git-push deploys are a dashboard step per project.

### 1.5 Schema and upgrades

[server/src/db.js](../server/src/db.js) `applySchema` runs `schema.sql` and then a fixed sequence of idempotent migrations (`CREATE TABLE IF NOT EXISTS`, column checks, a few table rebuilds). `openDatabase` calls it on startup, so the first request of a new deployment migrates that process’s database. [DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §7 still says to run `npm run db:migrate` on the laptop **before** replacing Production, so a bad migration leaves the previous deployment serving.

There is no `schema_migrations` table and no version integer. [server/src/provision.js](../server/src/provision.js) `EXPECTED_TABLES` is the progress signal `db:status` prints (table count and user count). A column added to an existing table does not change that count.

Upgrades are a hand loop, one customer at a time, because one checkout links to one project and the CLIs refuse to retarget ([DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §7). A git push does not migrate Turso. There is no command that walks every customer.

One repair lives outside `applySchema`: [server/scripts/invoice-proposal-pdf-column.js](../server/scripts/invoice-proposal-pdf-column.js) (read-only unless `--apply`). A fleet runner should not invoke one-off repairs unless that release says to.

### 1.6 Backups and offboarding

[DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §4.5 and §8.4: the scripts do not take backups and do not restore them. Vercel Instant Rollback restores code, env stays, rows stay. Point-in-time restore, if the Turso plan has it, is a dashboard setting per database and is not turned on by `turso:customer`.

Offboard (PR #40), after `--confirm-slug` matches the normalized slug:

1. Stops if this checkout is linked to a different project.
2. Checks `vercel whoami` and `turso auth whoami`.
3. `vercel env rm` for the three `CUSTOMER_ENV_KEYS` on Production and Preview.
4. `turso db destroy procureflow-<slug> --yes`.

It does not destroy `procureflow-<slug>-preview`. It does not remove `TURSO_PREVIEW_*`, SSO, SMTP, webhook, or `APP_BASE_URL` keys. It does not revoke database tokens. It does not delete the Vercel project: the manual records that `vercel project rm` on CLI 59.26.0 has no `--yes`. It does not touch password-manager copies or a local SQLite file. Domains and the GitHub connection stay with the project ([DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §9).

### 1.7 CI

[.github/workflows/test.yml](../.github/workflows/test.yml) on pull requests and pushes to `main`:

- `npm ci` and `npm test` on Node 22
- client production build
- `npm audit --omit=dev --audit-level=high` at the root and in `client/`

Nothing in CI deploys, migrates a database, or reads a customer list. `package.json` allows Node `>=18`. `vercel project add` does not set the project’s Node version.

### 1.8 Repo visibility

`pesl98/new_p2p_indirect` is a **public** GitHub repository. A committed file of real customer slugs, hostnames, or domains would publish that list. Secrets are already gitignored (`.env`, `.vercel/`, `*.db`). There is no customer registry in the tree.

### 1.9 What is already good

Keep these. Later sprints extend them.

- One database and one Vercel project per customer, classic libSQL over HTTP.
- Dry-run by default. `--apply` to mutate. Offboard also requires `--confirm-slug`.
- Fail-closed on a half-set Turso pair, on a wrong Vercel link, and on Preview using the production database.
- Onboard waits until Production is Ready before smoke.
- Empty customer data path is migrate → org skeleton → first admin. Demo seed is a separate destructive command.
- SSO, SMTP, webhooks, and audit tables already exist in the product. The gap is wiring them into the operator path, not building them again.
- CLI tests mock the process runner, so fleet commands can be tested without cloud credentials.

---

## 2. Gaps, ranked by impact

Impact means “how many customers this blocks or puts at risk”, not how many lines of code it is.

| Rank | Gap | Why it hurts |
| --- | --- | --- |
| 1 | Preview database is a manual step, while Preview fail-closes. Production URL and token are still copied onto Preview. | A completed `onboard:customer --apply` leaves every Preview deployment at 503 `preview_db_unconfigured`. The production token sits in Preview env, which is the credential the `allow` hatch would use. PR previews of a customer project are not safe or usable. |
| 2 | No customer registry, and no command that upgrades every customer. One checkout can be linked to only one project. | [DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §7 is a hand loop. A release reaches only the project someone deployed from that laptop. Others keep old code. `applySchema` on cold start migrates only the database that process opens. This is the scaling limit on “one project per customer”. |
| 3 | No schema version. | `db:status` counts tables in `EXPECTED_TABLES`. A new column on an existing table is invisible. An upgrade runner cannot say which customers are current, and a reviewer cannot see that a migration shipped without a version bump. |
| 4 | Re-running Turso/onboard is not idempotent for credentials. | Every `turso:customer --apply` calls `turso db tokens create` (old tokens stay valid). A fresh shell also mints a new `SESSION_SECRET`. The next Vercel apply rotates the cookie key and signs everyone out. Create-if-missing for the database itself is already idempotent. |
| 5 | Backups are a calendar reminder. | Offboard and `turso db destroy` delete the only copy. Instant Rollback does not restore rows. Nothing in `package.json` dumps or snapshots a database, and nothing records that a backup happened. |
| 6 | Offboard covers the three original env keys and the production database name. | The preview database from Sprint 8.0, preview tokens, IdP secrets, `MAIL_SMTP_URL` (credentials in the URL), webhook secret, domains, and the Vercel project all remain. A customer marked “gone” can still have a live database and live secrets. |
| 7 | Custom domain, SSO, and SMTP are a second procedure after the CLI. | The product code is done. `APP_BASE_URL` has to match the hostname or SSO redirects and supplier links are wrong. Forgetting Preview vs Production, or enabling `SSO_PROVISIONING` by accident, is easy when the steps are a checklist instead of a dry-run. |
| 8 | First-admin password is a process argument, and Turso apply prints full export lines. | Shell history and `ps` see `--password`. Fine for one operator on one laptop. It gets worse as soon as a fleet command is scripted or logged. `--json` already redacts. Human stdout does not. |
| 9 | Region, Vercel team, Node version, GitHub connection, and the sourcing cron are outside the CLI. | A Netherlands customer lands in whatever group the Turso CLI defaults to, and the database cannot be moved later. `project add` does not pin Node (CI is 22, `engines` is `>=18`). Git-push deploys are per-project dashboard work. The tick cron is documented and absent from `vercel.json`, so RFQs close on the next read after the deadline unless someone adds cron by hand. |
| 10 | CI never deploys or migrates. | [.github/workflows/test.yml](../.github/workflows/test.yml) is unit tests, the client build, and `npm audit`. A migration that fails on Turso HTTP shows up when an operator points `db:migrate` at a customer. |

Docs are already ahead of the CLIs on preview, domain, SSO, mail, backup, and the per-customer upgrade loop. The work is to make the commands match the manual, then shorten the manual. Four overlapping runbooks ([DEPLOY_MANUAL.md](DEPLOY_MANUAL.md), [CUSTOMER_ONBOARDING.md](CUSTOMER_ONBOARDING.md), [DEPLOYMENT.md](DEPLOYMENT.md), [scripts/provision-customer.md](../scripts/provision-customer.md)) plus README phrases are locked by tests. Change them in the same pull request as the CLI they describe. Do not add a fifth procedure that contradicts them.

---

## 3. Target workflow

Keep the names that already exist. `provision:customer` stays “migrate this database, optional org skeleton, optional first admin”. Folding Turso and Vercel into that name would make every current runbook and test lie.

`onboard:customer` stays the single install command. New verbs follow the same shape: dry-run by default, `--apply` to mutate, `--slug` for one customer, no secrets in the git tree, no seed on a production database.

```bash
# Install (dry-run, then apply). Preview database included.
npm run onboard:customer -- --slug acme
npm run onboard:customer -- --slug acme --apply \
  --email admin@acme.example --password-stdin --smoke

# This database only (unchanged role)
npm run provision:customer -- --with-org --email admin@acme.example --password-stdin

# Every active customer. Sequential. One failure does not skip the rest.
npm run upgrade:customers
npm run upgrade:customers -- --apply
npm run upgrade:customers -- --apply --only acme

# Dump outside the repo
npm run backup:customer -- --slug acme
npm run backup:customer -- --slug acme --apply --out "$HOME/procureflow-backups"

# Remove
npm run offboard:customer -- --slug acme
npm run offboard:customer -- --slug acme --apply --confirm-slug acme
```

`--password` can remain as a compatibility flag. New docs and the orchestrator should prefer `--password-stdin` so the password is not in `ps`.

### 3.1 Registry (no secrets)

Because the GitHub repo is public, the registry that holds real customers is gitignored. Commit a schema and a fake example only.

| Path | Committed? | Contents |
| --- | --- | --- |
| `ops/customers.example.json` | Yes | One row, slug `example`. Shows the fields. |
| `ops/customers.json` | No (gitignored) | One row per real customer. |
| `ops/customers/<slug>.local.env` | No (gitignored) | Optional domain, SSO, and SMTP values for that slug. |

Suggested row (names, not tokens):

```json
{
  "slug": "acme",
  "status": "active",
  "project": "procureflow-acme",
  "database": "procureflow-acme",
  "previewDatabase": "procureflow-acme-preview",
  "group": null,
  "location": null,
  "productionHost": "procureflow-acme.vercel.app",
  "customDomain": null,
  "schemaVersion": null,
  "lastBackupAt": null
}
```

`status` is `active` or `offboarded`. Upgrade and backup skip `offboarded`. The file must not grow keys whose names contain `TOKEN`, `SECRET`, `PASSWORD`, or `KEY`, and must not contain `libsql://` URLs. A unit test rejects a fixture that does. URLs and tokens stay in Turso, in Vercel env, and in the password manager.

`onboard --apply` upserts the row. `offboard --apply` sets `status` to `offboarded` and clears `schemaVersion` / `lastBackupAt`. Dry-run prints the row it would write.

If the owner later wants the list in git, that belongs in a private repo. It does not belong in this public one. Question 5 below.

### 3.2 Install, idempotent

`onboard:customer --slug acme` dry-run prints the plan and exits 0. It does not call the network and does not invent secrets. `--apply` does the following. Each step is safe to repeat.

1. **Identity.** Normalize the slug (existing rules: lowercase, letters, digits, hyphens, no leading or trailing hyphen, max 48). Default names `procureflow-<slug>` and `procureflow-<slug>-preview`. Refuse `--tursodb`.
2. **Link check.** If `.vercel/project.json` names a different project, stop before any Turso or Vercel mutation. Same rule as today.
3. **Production database.** `turso db create` only when `turso db show` says it is missing. Pass `--group` / `--location` only when the registry row or flags set them. Same org otherwise.
4. **Preview database.** Same create-if-missing, same group and location as production, name `procureflow-<slug>-preview`.
5. **Credentials.** If Vercel Production already has a `TURSO_DATABASE_URL` whose host is this database, keep that token and the existing `SESSION_SECRET`. Mint a database token or a session secret only when the matching value is absent. Do not print a full token on a reuse. Never call `turso auth token`.
6. **Vercel project.** `vercel project add` and `vercel link` as today, skipped when already linked to this project. Still no GitHub import.
7. **Env split.**
   - Production: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SESSION_SECRET`.
   - Preview: `TURSO_PREVIEW_DATABASE_URL`, `TURSO_PREVIEW_AUTH_TOKEN`, `SESSION_SECRET`, and `TURSO_PRODUCTION_DATABASE_URL` (host check only, no token).
   - Do not write the production token onto Preview. Do not write preview variables onto Production.
   - Leave `ALLOW_PREVIEW_PRODUCTION_DATABASE` unset.
8. **Deploy.** Redeploy Production (or `vercel deploy --prod` when none exists) and wait until Ready, as today.
9. **Schema.** `applySchema` on the production database, then `bootstrap-org` unless `--no-org`. First admin only when the user table is empty. Never `npm run seed`.
10. **Preview schema.** `applySchema` on the preview database. `db:seed:preview` only when `--preview-demo` is passed. Default is an empty preview schema, because the demo password is public.
11. **Optional extras** from `ops/customers/<slug>.local.env`, when the file exists and `--with-extras` is passed (Deploy sprint 3). Absent file skips this step.
12. **Smoke** when `--smoke` is set, against the production host.
13. **Registry row** written with no secrets. `schemaVersion` set from the code constant after a successful migrate.

A second `--apply` with the same slug creates nothing, mints nothing, and exits 0.

### 3.3 Upgrade every customer

`upgrade:customers` reads gitignored `ops/customers.json`.

Dry-run lists each `active` row: project, database names, the migrate command, and the deploy command. It does not pull env and does not print secrets.

`--apply`, sequential, one customer at a time:

1. Refuse to rewrite `.vercel/project.json` when it points at someone else. Pass the project explicitly (`vercel deploy --prod --yes` with the project flag the installed CLI documents). Confirm that flag in the sprint before hardcoding it. A missing non-interactive form is a stop, not an excuse to `vercel link` over another customer.
2. Read Production env into a temp file (mode `0600`) via `vercel env pull` or the equivalent the CLI documents. Delete the file in a `finally`. Do not mint a new Turso token just to migrate.
3. `db:migrate` against that production URL. On failure, record it, leave the previous deployment in place, and continue to the next customer.
4. Deploy Production and wait until Ready.
5. Migrate the preview database the same way (preview env pull). A preview failure is recorded and does not roll back the production deploy that already succeeded. The report says so.
6. Smoke the production host. Update `schemaVersion` on success.
7. Exit non-zero if any customer failed. Print a one-line status per slug. `--only <slug>` limits the run. There is no `--seed`.

Code constant `SCHEMA_VERSION` in [server/src/db.js](../server/src/db.js) increments in the same change as any new migration function. `applySchema` writes `schema_meta` (single row: version, applied-at). `db:status --json` includes `schemaVersion`. Cold start may still migrate, and the laptop-or-fleet migrate **before** deploy stays the rule.

The one-off PDF-column repair stays manual. Upgrade does not run it.

### 3.4 Domain, SSO, SMTP

These stay optional. A customer can go live on `https://procureflow-<slug>.vercel.app` with password login and copy-link mail.

When `ops/customers/<slug>.local.env` exists, a dry-run prints **key names and targets**, never values. `--apply` writes them only after the whole set for that feature validates:

| Feature | Required inputs | Vercel targets | Fail closed when |
| --- | --- | --- | --- |
| Hostname | `customDomain` and/or `APP_BASE_URL` | `APP_BASE_URL` on Production. Preview only if the file has `PREVIEW_APP_BASE_URL`. | `APP_BASE_URL` is not `https` or has a path. |
| Domain attach | hostname | Vercel project domain API or CLI, after reading `--help` on the installed CLI and recording the flag in the manual. | The command would attach the hostname to a project other than `procureflow-<slug>`. |
| OIDC | `IDENTITY_PROVIDER=oidc`, issuer, client id, client secret, `APP_BASE_URL` | Production, and Preview only if preview SSO values are present as their own keys | Any required key missing. Do not write a partial IdP. |
| SAML | provider `saml` plus the required cert and issuer keys already listed in [DEPLOYMENT.md](DEPLOYMENT.md) §2.1 | Same | Both assertion and response signing requested off, or any required key missing. |
| Provisioning | explicit `SSO_PROVISIONING=1` in the file | Same targets as the IdP | Default remains off. The command never turns it on by itself. |
| SMTP | `MAIL_PROVIDER=smtp`, `MAIL_FROM`, `MAIL_SMTP_URL` | Production. Preview only with a separate preview URL key. | `smtp` selected and from-address or URL missing. |

DNS records are printed for the operator to create. The command cannot complete DNS at the customer’s registrar. Smoke after the domain answers, using `BASE_URL=https://<custom-domain>`.

`MAIL_SMTP_URL` and IdP secrets are piped on stdin to `vercel env add`, same pattern as today’s three keys. They must not appear in stdout, stderr, or the registry.

### 3.5 Backups

`backup:customer --slug acme` dry-run prints the dump command and the output path. `--apply` writes a dump **outside the git repo** (refuse a path inside the work tree). The sprint confirms the Turso CLI’s dump or snapshot command against `turso --help` before hardcoding a flag. The registry stores `lastBackupAt` only, not the file path if that path would leak a home directory the owner cares about — storing the timestamp is enough; the path can be in the human stdout of that run.

Restore is a **new** database name, then `vercel:customer` pointed at that name after a human checks the data. Restore never overwrites the live database URL in place.

Retention (how many dumps, where they live, who may decrypt them) is question 4. Until that is answered, the command writes one file and the operator copies it. The sprint does not invent a retention number.

### 3.6 Offboard

Same confirmation as today. Extended order:

1. Wrong Vercel link → stop, destroy nothing.
2. Both CLIs logged in.
3. Remove the three customer keys **and** `TURSO_PREVIEW_DATABASE_URL`, `TURSO_PREVIEW_AUTH_TOKEN`, `TURSO_PRODUCTION_DATABASE_URL`, plus SSO, SMTP, webhook, and `APP_BASE_URL` keys when they are present. A missing key is success.
4. `turso db destroy` on the preview database, then the production database. Already-gone is success.
5. Registry `status=offboarded`.
6. Print the leftovers a human still deletes: Vercel project (until `vercel project rm` has a non-interactive confirm), domains that disappear with the project, token revoke if `turso db tokens --help` grows an invalidate command, password-manager entries, local SQLite files.

Do not delete the Vercel project from the script until the installed CLI can do it non-interactively with an explicit confirm. The current manual is right to refuse `project rm` without `--yes`.

### 3.7 What stays a person

- `vercel login`, `turso auth login`, and `vercel switch` to the right team.
- DNS at the customer’s registrar, and SPF/DKIM for their mail domain.
- Choosing whether SSO provisioning is on, and the default role.
- Connecting GitHub for git-push deploys, if question 7 says yes.
- Turning on Turso point-in-time in the dashboard if the plan includes it and the CLI cannot.
- Deleting the Vercel project and the password-manager item after offboard.
- Deciding the questions in §5. The sprints should not guess them.

---

## 4. Sprint breakdown

Four small sprints. Each one is shippable on its own and leaves install safer than it found it. They are named Deploy 1–4 so they do not collide with the product sprint numbers in [SPRINT-LOG.md](SPRINT-LOG.md). Register them there from the implementation pull request, not from this one.

Tests follow the existing style: fake `spawn` / injected runner, fixture files in `os.tmpdir()`, assertions on argv and on redacted stdout. No live Turso, Vercel, or DNS. `npm test` stays the CI gate.

Doc updates that change operator steps land in the same pull request, in [DEPLOY_MANUAL.md](DEPLOY_MANUAL.md), [CUSTOMER_ONBOARDING.md](CUSTOMER_ONBOARDING.md), [DEPLOYMENT.md](DEPLOYMENT.md), [scripts/provision-customer.md](../scripts/provision-customer.md), and the README lines those tests already read.

### Deploy 1 — Registry and preview database on the install path

**Scope**

- Gitignored registry plus committed `ops/customers.example.json` (slug `example` only).
- `onboard:customer` and `turso:customer` create `procureflow-<slug>-preview` if missing, same group/location behavior as production.
- Env write matches §3.2 step 7. Stop copying the production token onto Preview.
- Re-apply reuses an existing matching URL, token, and `SESSION_SECRET`.
- Registry upsert on successful apply. Writer rejects secret-shaped keys and `libsql://` values.
- One paragraph in the manual for customers already installed the old way: create the preview database, set preview env, remove the production token from Preview, redeploy Preview.

**Acceptance**

- Dry-run for slug `acme` lists `turso db create procureflow-acme-preview` and does not pass `--tursodb`.
- Production env plan is the three existing keys. Preview env plan is the preview pair, `SESSION_SECRET`, and `TURSO_PRODUCTION_DATABASE_URL`. The production token is not in the Preview plan.
- A second apply, with a fake Vercel env that already matches the host, does not spawn `turso db tokens create` and does not generate a new session secret.
- A checkout linked to another project is unchanged (no `project.json` write, no Turso spawn).
- Registry file after a fake apply contains the row and none of the token strings the fake runner returned.
- Existing [server/src/dbConfig.test.js](../server/src/dbConfig.test.js) cases stay as they are, including the `allow` hatch.

**Risks**

- The project `new-p2p-indirect` described in [DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §4.2.1 may still have Production credentials on Preview. Shipping the new env writer without the one-time cleanup on that project changes what the next Preview deploy sees. Do the cleanup in the same window as the first real `--apply`, or skip that project until someone does.
- Host comparison for “token already installed” must use the same normalization as `sameDatabaseHost` in [server/src/dbConfig.js](../server/src/dbConfig.js). A false mismatch would mint a spare token. A false match would keep a token that points at the wrong database.
- Reuse means reading Vercel env. The test double must prove the token never reaches stdout.

### Deploy 2 — Schema version and upgrade-all

**Scope**

- `SCHEMA_VERSION` and `schema_meta`, written at the end of `applySchema`. `db:status` prints it.
- `npm run upgrade:customers` as in §3.3, including `--only` and continue-on-error.
- Spike, then hardcode, a non-interactive `vercel deploy` that takes a project name without retargeting `.vercel/project.json`. If that flag does not exist, stop the sprint and report it. Do not fall back to `vercel link`.
- Temp env pull, deleted in `finally`.

**Acceptance**

- A memory database reports the constant after `applySchema`. Running `applySchema` twice does not throw and does not change the version.
- `db:status --json` includes `schemaVersion` and still omits tokens.
- Dry-run over a two-row fixture prints two plans and does not spawn migrate, deploy, or seed.
- A mocked failure on customer 2 still runs customer 3, exits non-zero, and does not update customer 2’s `schemaVersion`.
- With `.vercel/project.json` aimed at a different project, the file bytes are unchanged after a dry-run and after a mocked apply.
- Pulled env content does not appear in captured stdout or stderr.

**Risks**

- `schema_meta` is itself a migration. It has to be additive (`CREATE TABLE IF NOT EXISTS`) so existing customer databases pick it up on the next migrate.
- Vercel rate limits if someone later parallelizes the loop. Keep the first version sequential.
- Env pull may be interactive on some CLI versions. The spike is part of the sprint, not a follow-up.
- Migrating preview after a successful production deploy can leave preview behind if the preview pull fails. The report must say which database was migrated. Do not hide that behind a single green slug.

### Deploy 3 — Domain, SSO, and SMTP as optional inputs

**Scope**

- Gitignored `ops/customers/<slug>.local.env`.
- Validation and env writes from §3.4, including stdin for secret values.
- Domain attach only after the sprint reads the installed Vercel CLI help and records the exact command in the manual.
- Offboard’s removal list grows to the preview database and the extra keys (destroy behavior for the preview database can land here if Deploy 4 has not merged; do not wait on backups to stop leaking the preview database).
- `--password-stdin` on onboard and bootstrap-admin.

**Acceptance**

- OIDC with a missing client secret writes zero env keys.
- SAML with both signing flags off writes zero env keys.
- A file that does not mention `SSO_PROVISIONING` leaves that variable unset.
- Captured stdout and stderr for an SMTP apply do not contain the fixture `MAIL_SMTP_URL`.
- Domain dry-run prints the command the sprint verified, and the project name in that command is `procureflow-<slug>`.
- Offboard dry-run lists `procureflow-<slug>-preview` and the extra key names. Offboard without `--confirm-slug` still mutates nothing.
- `--password-stdin` feeds bootstrap and does not put the password in `process.argv`.

**Risks**

- PEM certificates and newlines through `vercel env add` stdin. Test with a multi-line fixture. A stripped newline breaks SAML in production and the unit test will still look green if it only checks the exit code.
- Attaching a domain the team does not own fails at Vercel. The command should surface that stderr (redacted) and leave the registry `customDomain` unset.
- Preview SSO pointed at the production IdP redirect URL will fail open in confusing ways. Separate preview keys are required for preview SSO. Default is production-only.

### Deploy 4 — Backups and the rest of offboard

**Scope**

- `backup:customer` as in §3.5, after confirming the Turso dump/snapshot flag.
- Restore runbook in [DEPLOY_MANUAL.md](DEPLOY_MANUAL.md): new database name, never overwrite the live URL.
- Offboard destroys the preview database as well as production, if Deploy 3 did not already.
- Token revoke only if the CLI help shows a non-interactive invalidate. Otherwise the manual keeps the human step.
- Registry `lastBackupAt` and `status=offboarded`.

**Acceptance**

- `--out` inside the work tree exits non-zero and does not spawn `turso`.
- Dry-run does not create a file.
- A mocked dump writes under `--out` and updates `lastBackupAt`. The dump body is not copied to stdout.
- Offboard `--apply` without a matching `--confirm-slug` does not spawn `env rm` or `db destroy`.
- Offboard with confirm destroys preview first, then production, in the mocked argv log.
- `npm test` green. No backup file and no `ops/customers.json` in `git status`.

**Risks**

- A dump of a real customer is personal data on a laptop disk. The sprint does not upload it anywhere. Where it should live is question 4. Until then, the command’s help text says the file is sensitive and the operator moves it.
- `turso db dump` (or whatever the help text calls it) may not exist on the CLI version the manual pins (Turso CLI v1.0.32). If it does not, the sprint documents the verified alternative (dashboard snapshot, or a SQL dump through the HTTP pipeline) and does not invent a flag.
- Destroying preview and production in one command is what offboard is for. A bug in name construction could destroy the wrong database. Tests should assert the full names, and the slug confirm stays mandatory.

---

## 5. Open questions for the owner

These change the shape of Deploy 1–4. Defaults are what the sprints will do if you do not answer. Say if a default is wrong.

1. **Hostname.** Default: ship on `https://procureflow-<slug>.vercel.app`, and attach a customer domain later via the optional file. Is the real scheme the customer’s own host (`inkoop.customer.nl`), a subdomain we control (`acme.<our-domain>`), or the `vercel.app` name until a specific customer asks?

2. **Who pays.** Default: the operator’s existing Turso org and Vercel team, one database and one project per customer, no pass-through billing in the product. Should each customer have their own Turso org and Vercel team instead? Who is invoiced?

3. **Region.** Default: Turso’s current org default group, which is what `turso db create` already does, and the same group for the preview database. For Netherlands customers, which location do you want, and should it be a flag (`--location`) required for every new slug?

4. **Backups.** Default: one dump file outside the repo, operator copies it, no retention number in code. How many days do you keep, where (laptop, encrypted disk, object storage), and who is allowed to restore a customer?

5. **Registry and the public repo.** Default: real slugs stay in gitignored `ops/customers.json` on the operator machine (and nowhere in GitHub). Do you want that file in a private repo instead, and is a public list of customer slugs ever acceptable?

6. **Preview data.** Default: one shared preview database per customer, empty unless someone passes `--preview-demo`. Every open pull request on that Vercel project shares it. Is that enough, or do you need a database per branch? Per-branch databases are a different design (Vercel Preview env is not per branch).

7. **How code ships.** Default: keep laptop `vercel deploy --prod` per project, driven by `upgrade:customers`. GitHub stays a manual attachment. Do you want git-push deploys connected on each customer project, or one CI job with a Vercel token that runs the upgrade command?

8. **SSO at go-live.** Default: password login, SSO only when that customer’s local env file is present, provisioning off. Is any customer waiting on OIDC or SAML before the first production URL is useful?

9. **Mail.** Default: copy-link (`MAIL_PROVIDER` unset). SMTP only when the customer file has their relay. Do you want a shared transactional provider instead of each customer’s own SMTP?

10. **Node on Vercel.** Default: leave the account default, and document “set 22 if the build fails”. CI is Node 22. Should Deploy 1 pin the project to 22 when the CLI can do that non-interactively?

11. **Project delete.** Default: offboard leaves the Vercel project for a human, because CLI 59.26.0 has no `project rm --yes`. When a safe flag exists, should delete become part of `--confirm-slug`, or a second flag (`--delete-project`)?

12. **Sourcing cron.** Default: leave `vercel.json` without crons, so deadlines close on the next read. Should a later deploy sprint add the 15-minute tick for every customer, or only when `CRON_SECRET` is set?

13. **First-admin password delivery.** Default: operator types it on stdin and stores it in the password manager. The app does not email it. Is that the handoff you want with the customer?

14. **Existing installs.** Default: Deploy 1’s manual cleanup for any project that already has production Turso credentials on Preview, including `new-p2p-indirect` if that project is still live. Which slugs exist today, and which of them are allowed to be touched by the first real `upgrade:customers --apply`?
