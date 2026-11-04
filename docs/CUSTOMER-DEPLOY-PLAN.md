# Customer deploy plan

Scoping note for the owner. This pull request is documentation only. It does not change the app, the CLIs, or [SPRINT-LOG.md](SPRINT-LOG.md) (another pull request owns that register).

Revised after the architect review of PR #76 (head `349f3df`). The current-state section stands. The target workflow and the sprint order below replace the first draft: separate secrets per environment, slug-bound credentials, migrations that can fail closed, and a registry that is not a file on one laptop.

The priority is a repeatable install per customer: **one Vercel project, one Turso group, one production database, and one preview database per customer**. Feature sprints wait until that path is boring.

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

Laptop with both `TURSO_*` unset uses `better-sqlite3` (`PROCUREMENT_DB_PATH` or `server/data/procurement.db`). Vercel requires Turso. A half-set URL/token pair is refused. The function talks to classic libSQL over HTTPS `POST /v2/pipeline` ([server/src/tursoHttp.js](../server/src/tursoHttp.js)). It does not load a native libsql addon. `vercel.json` builds the Vite client into `public/` and runs two Node functions (`api/index.js`, `api/invoice-proposal-upload.js`), both bundling `server/src/schema.sql`. There is no `regions` key and no cron in `vercel.json`.

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
| `npm run bootstrap-admin` | First admin on an empty user table. Exits once any user exists. | [server/src/bootstrapAdmin.js](../server/src/bootstrapAdmin.js), [server/src/usersService.js](../server/src/usersService.js) `bootstrapFirstAdmin` |
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

Production and a laptop with `VERCEL_ENV` unset keep using `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`. Tests: [server/src/dbConfig.test.js](../server/src/dbConfig.test.js). A preview pair alone is enough to boot when no production URL is visible.

The operator manual tells a human to create `procureflow-<slug>-preview` by hand and to set the preview variables by hand ([DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §4.2.1). `onboard:customer`, `turso:customer`, and `vercel:customer` do not create that database and do not write `TURSO_PREVIEW_*`. `vercel:customer` still copies the **production** URL, the production token, and `SESSION_SECRET` onto the Preview environment (`CUSTOMER_ENV_KEYS` × `VERCEL_ENV_TARGETS`). After a finished onboard, a Preview deployment is therefore fail-closed, and the production token is present in Preview env, which is what the `allow` hatch would use.

Vercel Preview is one environment per project, shared by every git branch and every preview URL. Sprint 8.0 is one preview database per customer, not one per branch.

### 1.4 Session cookie (why a shared secret crosses environments)

`signSessionToken` ([server/src/auth.js](../server/src/auth.js) lines 95–104) signs `{ uid, iat, exp }` with HMAC-SHA256 and `SESSION_SECRET`. `verifySessionToken` (lines 106–126) checks the signature, that `uid` is a positive integer, and that `exp` is in the future. It does not read an environment, an audience, or a session version. `attachSession` (lines 181–196) loads `users.id = uid` from whichever database this process opened.

The cookie header ([server/src/auth.js](../server/src/auth.js) lines 146–159) is `Path=/`, `HttpOnly`, `SameSite=Lax`, and `Secure` when `VERCEL` or `NODE_ENV=production`. It sets no `Domain`, so a browser stores it for the host that set it and does not send a preview-host cookie to the production host on its own. Presenting that same cookie value to the other host still verifies when both hosts share `SESSION_SECRET`. User ids start at 1 in every database, so a Preview login for uid 1 is a Production session for uid 1.

`setUserPassword` ([server/src/usersService.js](../server/src/usersService.js) lines 267–270) writes a new bcrypt hash and does not change the cookie. Existing sessions keep working until `exp` (7 days). `bootstrapFirstAdmin` (lines 273–279) returns 409 once any user exists, so there is no operator command that replaces a lost admin.

### 1.5 Env, secrets, and the stale shell

The CLIs write three keys and nothing else: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SESSION_SECRET`. They never set `DEMO_PERSONA_SWITCHER`. They do not generate `PORTAL_TOKEN_SECRET`, `CRON_SECRET`, or `WEBHOOK_SIGNING_SECRET`.

Credential reuse does not look at the slug:

| Behavior | Where |
| --- | --- |
| An exported `SESSION_SECRET` is kept as-is. Nothing checks that it was minted for this slug. | [server/src/tursoCustomer.js](../server/src/tursoCustomer.js) `resolveSessionSecret`, lines 248–257 |
| Vercel apply only checks that the three strings are non-empty. It does not check that the URL host is `procureflow-<slug>`. | [server/src/vercelCustomer.js](../server/src/vercelCustomer.js) `missingCustomerEnvKeys`, lines 164–166 |
| Onboard copies whatever Turso just minted over the shell, including a new token. | [server/src/onboardCustomer.js](../server/src/onboardCustomer.js) `enrichEnvWithTursoExports`, lines 258–265 |
| Every `turso:customer --apply` calls `turso db tokens create`, even when a token is already exported. | [server/src/tursoCustomer.js](../server/src/tursoCustomer.js) line 612 |

A shell left over from customer A, then `onboard:customer --slug beta`, can write A’s `SESSION_SECRET` into B’s project, or point B at A’s database. A second apply mints another database token and pushes it. Old tokens stay valid. A fresh shell with no `SESSION_SECRET` mints a new one and the next Vercel apply signs everyone out.

`turso:customer --apply` prints full `export` lines on stdout. `--json` redacts to the last four characters. The first-admin password is a CLI argument.

Everything else is a dashboard or `vercel env add` step, documented and not scripted:

| Concern | App support | How it is set today |
| --- | --- | --- |
| Session | HMAC `pf_session`, `SESSION_SECRET` | Minted by `turso:customer`, then copied to Preview |
| First admin | `bootstrap-admin` / onboard `--email` `--password` | Password is a CLI argument. Refuses once any user exists. |
| Custom domain | App reads `APP_BASE_URL` for SSO redirects, supplier links, and CORS | Dashboard. [DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §5.5. Scripts do not call `vercel domains`. |
| SSO | OIDC and SAML mint the same cookie. Unknown users rejected unless provisioning is on. Secrets stay in env. | [DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §3.1, [server/src/sso.js](../server/src/sso.js), [server/src/ssoConfig.js](../server/src/ssoConfig.js) |
| SMTP | `MAIL_PROVIDER=smtp` plus `MAIL_FROM` and `MAIL_SMTP_URL`. Default is copy-link. | [server/src/mail/providers/smtp.js](../server/src/mail/providers/smtp.js). Not written by the CLIs. |
| Webhooks | `WEBHOOK_TARGET_URL`, `WEBHOOK_SIGNING_SECRET` | [DEPLOYMENT.md](DEPLOYMENT.md) §2.2. Secret is not generated at install. |
| Supplier portal | `PORTAL_TOKEN_SECRET` (minimum 32 characters) or publish returns 503 | Not written by the CLIs. |
| Sourcing tick | `CRON_SECRET` on `/api/sourcing/tick`. Safe to run twice. Unset means 401. | Documented as a `vercel.json` cron the repo does not ship ([DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) sourcing section). |

Region: `turso db create` is invoked with no `--group` and no `--location`. The database lands in the org’s default group. The scripts cannot move it later ([DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §4.2). `turso db tokens invalidate` invalidates every token in the group, not one database. Invalidating a token for a customer who still shares the default group invalidates every other customer in that group. New databases must not be created until each customer has a group of their own.

GitHub: `vercel project add` does not attach the repo. Production is `vercel deploy --prod` / `vercel redeploy` from a laptop. Git-push deploys are a dashboard step per project. Vercel env is not marked Sensitive by these scripts, so a later `env pull` can read the values back.

### 1.6 Schema and upgrades

[server/src/db.js](../server/src/db.js) `applySchema` runs `schema.sql` and then a fixed sequence of idempotent migrations (`CREATE TABLE IF NOT EXISTS`, column checks, and table rebuilds). There is no `schema_migrations` table and no version integer. [server/src/provision.js](../server/src/provision.js) `EXPECTED_TABLES` is the progress signal `db:status` prints (table count and user count). A column added to an existing table does not change that count.

Rebuilds are multi-statement scripts executed through `exec`, which does not wrap `BEGIN`/`COMMIT`:

| Rebuild | SQL | How it runs |
| --- | --- | --- |
| `approval_requests` CHECK gains `waiting` | [server/src/db.js](../server/src/db.js) lines 31–50 | `database.exec` at line 61 |
| `invoice_exception_dispositions` CHECK gains `short_pay` / `buyer_response` | lines 157–177 | `database.exec` at line 212 |
| `purchase_requisitions` CHECK gains `skipped` | lines 514–544, with `PRAGMA foreign_keys` off in the same script (lines 540–544) | `database.exec` at line 568 |

[server/src/tursoHttp.js](../server/src/tursoHttp.js) `exec` (lines 469–476) splits the script and sends one pipeline of `execute` requests, then `close`, with no `BEGIN` and no `COMMIT`. Statements outside a transaction store send no baton (file header, lines 5–8). Each statement autocommits. If a later statement fails, the earlier ones stay. `batch` (lines 325–346) is the pipeline that sends `BEGIN`, the statements, `COMMIT`, and `close`. The rebuilds do not use it.

`openDatabase` ([server/src/db.js](../server/src/db.js) lines 748–758) calls `applySchema` whenever `options.migrate` is not `false`. The request path uses the default, so every cold start runs those rebuilds. Nothing takes a lock. Two overlapping cold starts can both decide a rebuild is required.

[DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §7 says to run `npm run db:migrate` on the laptop before replacing Production. That is one customer at a time, because one checkout links to one project and the CLIs refuse to retarget. A git push does not migrate Turso. There is no command that walks every customer, no snapshot before the migrate, and no canary.

One repair lives outside `applySchema`: [server/scripts/invoice-proposal-pdf-column.js](../server/scripts/invoice-proposal-pdf-column.js) (read-only unless `--apply`). A fleet runner should not invoke one-off repairs unless that release says to.

### 1.7 Backups, PITR, and offboarding

[DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §4.5 and §8.4: the scripts do not take backups and do not restore them. Vercel Instant Rollback restores code, env stays, rows stay.

Turso point-in-time recovery is already on for a database. It is not a switch these scripts flip. Retention is 24 hours on the Free plan and 10, 30, or 90 days on paid plans. `turso db destroy` ends that history with the database. PITR does not survive offboard. A dump taken before destroy is the copy that still exists afterwards. The dump command on the Turso CLI is `turso db shell <db> .dump`. There is no `turso db dump` in the manual’s pinned CLI, and this repo does not call the shell.

Offboard (PR #40), after `--confirm-slug` matches the normalized slug:

1. Stops if this checkout is linked to a different project.
2. Checks `vercel whoami` and `turso auth whoami`.
3. `vercel env rm` for the three `CUSTOMER_ENV_KEYS` on Production and Preview.
4. `turso db destroy procureflow-<slug> --yes`. No dump first.

It does not destroy `procureflow-<slug>-preview`. It does not remove `TURSO_PREVIEW_*`, SSO, SMTP, webhook, portal, or cron keys. It does not revoke database tokens. It does not delete the Vercel project: the manual records that `vercel project rm` on CLI 59.26.0 has no `--yes`. It does not touch password-manager copies or a local SQLite file. Domains and the GitHub connection stay with the project ([DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §9).

### 1.8 CI and repo visibility

[.github/workflows/test.yml](../.github/workflows/test.yml) on pull requests and pushes to `main`:

- `npm ci` and `npm test` on Node 22
- client production build
- `npm audit --omit=dev --audit-level=high` at the root and in `client/`

Nothing in CI deploys, migrates a database, or checks that release N still runs on schema N−1. `package.json` allows Node `>=18`. `vercel project add` does not set the project’s Node version.

`pesl98/new_p2p_indirect` is a **public** GitHub repository. A committed file of real customer slugs, hostnames, or domains would publish that list. Secrets are already gitignored (`.env`, `.vercel/`, `*.db`). There is no customer registry in the tree. The only inventory today is the operator’s shell and password manager.

### 1.9 What is already good

Keep these. Later sprints extend them.

- One database and one Vercel project per customer, classic libSQL over HTTP.
- Dry-run by default. `--apply` to mutate. Offboard also requires `--confirm-slug`.
- Fail-closed on a half-set Turso pair, on a wrong Vercel link, and on Preview using the production database.
- Onboard waits until Production is Ready before smoke.
- Empty customer data path is migrate → org skeleton → first admin. Demo seed is a separate destructive command.
- `batch()` already exists for a single pipeline transaction. Rebuilds need to move onto it. The client does not need a new transport.
- SSO, SMTP, webhooks, and audit tables already exist in the product. The gap is wiring them into the operator path, not building them again.
- CLI tests mock the process runner, so fleet commands can be tested without cloud credentials.

---

## 2. Gaps, ranked by impact

The architect confirmed the five gaps from the first draft (preview left manual while production credentials are copied onto it, no fleet upgrade, no schema version, re-apply mints credentials, backups and offboard stop short). The lines in §1 add three sharper edges: a shared `SESSION_SECRET` is a cross-environment session, a stale shell crosses customers, and rebuilds autocommit on every cold start. Token invalidate is group-wide, so the default Turso group is a shared blast radius.

| Rank | Gap | Why it hurts |
| --- | --- | --- |
| 1 | Production `SESSION_SECRET` and the production Turso token are written onto Preview. The cookie carries only `uid` and `exp`. | A Preview login, replayed on Production, is that uid. The browser will not send the cookie across hosts by itself. Anyone who can copy the value can. The `allow` hatch would also open the production database with the token that is already sitting in Preview env. |
| 2 | Exported `TURSO_*` and `SESSION_SECRET` are reused with no slug check. Re-apply always mints a new database token. | [server/src/tursoCustomer.js](../server/src/tursoCustomer.js) lines 248–257 and 612, [server/src/vercelCustomer.js](../server/src/vercelCustomer.js) lines 164–166, [server/src/onboardCustomer.js](../server/src/onboardCustomer.js) lines 258–265. Customer B can receive customer A’s secret or database. A second onboard rotates the token and can rotate the session secret. |
| 3 | Schema changes are unversioned rebuilds. They autocommit, they run on every cold start, and nothing locks them. | [server/src/db.js](../server/src/db.js) lines 31–50, 157–177, 514–544, and 748–758. A failed statement leaves the earlier statements applied. Two cold starts can rebuild the same table. `db:status` cannot say which customers are current. |
| 4 | New databases join the org’s default group, and `turso db tokens invalidate` is group-wide. | Revoking one customer’s tokens revokes every customer that still shares the group. The database cannot be moved later. This has to be decided before any more databases are created. |
| 5 | Preview database is still a manual step, while Preview fail-closes without one. | A finished onboard leaves Preview at 503 `preview_db_unconfigured`. |
| 6 | Inventory and secrets live on one laptop. Vercel env is readable back. | There is no private registry, no drift report, and no action log. `env pull` can reprint secrets. A lost laptop is a lost customer list. |
| 7 | Destroy ends PITR, and offboard does not dump first. | Retention is 24 hours (Free) or 10/30/90 days (paid) only while the database exists. Offboard removes three env keys and the production database. The preview database, the other secrets, domains, and the project remain. |
| 8 | Custom domain, SSO, and SMTP are a second procedure. | The product code is done. `APP_BASE_URL` has to match the hostname. This is real work and it is behind the safety gaps above. |
| 9 | CI never deploys, migrates, or checks N against N−1. | [.github/workflows/test.yml](../.github/workflows/test.yml) is unit tests, the client build, and `npm audit`. |

`PORTAL_TOKEN_SECRET`, `CRON_SECRET`, and `WEBHOOK_SIGNING_SECRET` are also unset after install. Sourcing and webhooks then fail closed until someone hand-writes secrets. That is part of Deploy 1, not a separate product sprint.

Docs are already ahead of the CLIs on preview, domain, SSO, mail, and the per-customer upgrade loop. The PITR paragraph in [DEPLOY_MANUAL.md](DEPLOY_MANUAL.md) §4.5 is behind the facts in §1.7 here. Change the runbooks in the same pull request as the CLI they describe. [server/src/provision.test.js](../server/src/provision.test.js) locks phrases in those files. Do not add a fifth procedure that contradicts them.

---

## 3. Target workflow

Keep the names that already exist. `provision:customer` stays “migrate this database, optional org skeleton, optional first admin”. `onboard:customer` stays the install command.

```bash
# Install. Dry-run, then apply. Second apply is a no-op.
npm run onboard:customer -- --slug acme
npm run onboard:customer -- --slug acme --apply \
  --email admin@acme.example --password-stdin --smoke

# Read-only fleet picture. Writes nothing to a customer project or database.
npm run customers:inventory

# One customer, then the rest. Canary first. Stop on the first failure.
npm run upgrade:customers -- --slug acme
npm run upgrade:customers -- --apply --canary acme

# Dump, then destroy. Dump failure does not destroy.
npm run offboard:customer -- --slug acme
npm run offboard:customer -- --slug acme --apply --confirm-slug acme
```

`--password` can remain as a compatibility flag. New docs prefer `--password-stdin`.

### 3.1 Secrets per environment

Production and Preview each get their own values. Preview never receives a production secret. That includes `SESSION_SECRET`, `TURSO_AUTH_TOKEN`, `TURSO_DATABASE_URL`, `PORTAL_TOKEN_SECRET`, `CRON_SECRET`, and `WEBHOOK_SIGNING_SECRET`. It also includes leaving `TURSO_PRODUCTION_DATABASE_URL` and `ALLOW_PREVIEW_PRODUCTION_DATABASE` unset. A preview pair alone already boots ([server/src/dbConfig.test.js](../server/src/dbConfig.test.js)).

| Key | Production | Preview |
| --- | --- | --- |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | This customer’s production database | Unset |
| `TURSO_PREVIEW_DATABASE_URL` / `TURSO_PREVIEW_AUTH_TOKEN` | Unset | This customer’s preview database |
| `SESSION_SECRET` | Minted for production | A different mint |
| `PORTAL_TOKEN_SECRET` | Minted at install, ≥ 32 characters | A different mint |
| `CRON_SECRET` | Minted at install | A different mint |
| `WEBHOOK_SIGNING_SECRET` | Minted at install | A different mint |

`WEBHOOK_TARGET_URL` stays unset until a person supplies the receiver. Generating the signing secret does not turn delivery on. `SOURCING_ENABLED` stays unset. Generating `PORTAL_TOKEN_SECRET` and `CRON_SECRET` does not turn the module or the cron on. The cron entry stays out of `vercel.json` until question 8 is answered.

Session token, in the same change as the split secrets. `signSessionToken` adds `env` (`production`, `preview`, or `local`) to the payload. `verifySessionToken` returns null when `env` is missing or does not equal this process: `VERCEL_ENV` when it is `production` or `preview`, otherwise `local`. A cookie signed for preview fails on production even if the secrets were copied by mistake. Shipping this signs everyone out once, because today’s cookies have no `env`. Say that in the release note.

Vercel env writes use the CLI’s sensitive flag, confirmed against `vercel env add --help` in that sprint. Sensitive values are not read back with `env pull`. The secrets manager in §3.3 is the copy the operator can read. Until that sprint lands, install still writes the values to Vercel and stores them in the password manager, per environment, and does not print them on a re-run.

### 3.2 Slug-bound credentials, and a no-op re-run

Refuse the shell when it points at someone else.

- If `TURSO_DATABASE_URL` is set, its host must be `procureflow-<slug>`, using the same host comparison as `sameDatabaseHost` in [server/src/dbConfig.js](../server/src/dbConfig.js). Any other host exits non-zero before a Turso or Vercel call.
- If `TURSO_AUTH_TOKEN` is set, the URL must be set and must already have matched this slug. A token with no URL, or with another customer’s URL, is refused.
- If `SESSION_SECRET` is set, `PROCUREFLOW_SECRET_SLUG` must equal the normalized slug. A secret with a missing or different marker is refused. It is not reused and it is not overwritten.
- The same rules apply to the preview variable names and the host `procureflow-<slug>-preview`.
- When the URL matches and the token is already present, do not call `turso db tokens create`. `enrichEnvWithTursoExports` must not replace that token with a newly minted one.
- When the slug marker matches, do not mint a new `SESSION_SECRET`.

A second `onboard:customer --apply` for the same slug creates no group, no database, no token, and no secret, and it does not redeploy when the env names and hosts already match. The definition of done for Deploy 1 is this no-op, plus the two checks in §4.

### 3.3 One group per customer

Before creating a database, create or reuse Turso group `procureflow-<slug>` in the fleet location (§5 question 3). Create `procureflow-<slug>` and `procureflow-<slug>-preview` with `--group procureflow-<slug>`. Do not pass `--tursodb`. Do not create new databases in the org default group.

`turso db tokens invalidate` stays out of Deploy 1. It invalidates every token in the group. Deploy 4 may call it only after inventory shows that group contains only this customer’s two databases. Operator migrate uses a short-lived database token (`turso db tokens create` with the expiry flag the CLI documents) and does not invalidate at the end of the run. Invalidating the operator token would also invalidate the token Vercel is using.

### 3.4 Region

`vercel.json` gets a top-level `regions` array for the one fleet region that matches the Turso location. Every customer project built from this repo deploys there. A per-customer region would diverge from the committed file, so it is not the plan unless question 3 says customers differ. Deploy 1 does not add databases in a location that `regions` does not match.

### 3.5 Registry, inventory, secrets manager

The public repo does not hold real slugs. A gitignored file on one laptop is not the registry either.

| Store | Holds | Does not hold |
| --- | --- | --- |
| Private git repo | Slug, status, Vercel project, Turso group, database names, location, production host, schema version applied, last dump time | Tokens, session secrets, SMTP URLs, IdP secrets |
| Secrets manager | Per-environment secrets from §3.1, keyed by slug and environment | Customer rows |
| Vercel env | The same values, marked Sensitive, on the matching environment only | The operator’s source of truth |
| Turso | The databases | A copy of the Vercel secrets |

`npm run customers:inventory` is read-only. It lists projects and databases from the Vercel and Turso APIs, joins them to the private repo on the `procureflow-<slug>` names, and prints drift: project without a database, database without a project, missing preview database, database still in the default group, a production key name present on Preview, `regions` disagreeing with the group location, schema history behind the code. It does not create, deploy, migrate, or write env.

Operator commands append one line to an action log in the private repo: time, actor, command, slug, dry-run or apply, exit code. The line has no secret values and no dump body.

### 3.6 Migrations

Numbered files under `server/migrations/` (`0001_name.sql`, then `0002_…`). A `schema_migrations` table records version, name, and applied-at. `db:status --json` prints the highest applied version and the versions still missing. `EXPECTED_TABLES` stays a sanity check, not the version.

Rules:

- A rebuild runs inside `database.batch()`, so `BEGIN` … `COMMIT` is one pipeline. `exec` stays available for single statements. Rebuild SQL is not sent through `exec`.
- The request path opens the database with `migrate: false`. If `schema_migrations` is behind the code’s head, the process returns 503 `schema_behind` and does not rebuild. Cold start is not a migration runner and takes no schema lock because it writes no schema.
- The upgrader is the only writer. It inserts the history row in the same `batch()` as that version’s statements. A second runner finds the row and does not apply the version again.
- Expand/contract. An expand-only version (new table, new nullable column, new index) is valid while the previous release is still serving. A contract (drop column, tighten a CHECK, rebuild that removes a column the old code still writes) ships in a later version, after the release that stopped writing the old shape is the one in production. A pull request that adds a contract in the same version as the code which still needs the old shape fails review.
- CI runs an N−1 check. Apply every migration except the last one, run the previous release’s read path against that schema, then apply the last migration and run the new code. A contract migration is refused by that job when the previous release still selects the dropped shape. The job does not need a live Turso org: it uses the HTTP client against a stub, or SQLite, for the schema, and the pipeline test below for autocommit.
- Required test, in the migration sprint: a stub `POST /v2/pipeline` applies each `execute` outside an explicit transaction as its own commit. `exec` of a two-statement script whose second statement errors must leave the first statement’s row in place. `batch()` of the same script must leave no row. That test is what stops a later change from sending a rebuild through `exec` again.

The one-off PDF-column repair stays manual. The upgrader does not run it.

### 3.7 Upgrade

`upgrade:customers` reads the private registry. It does not `vercel env pull` secrets. It reads the production token from the secrets manager, or mints a short-lived token as in §3.3.

Order for one customer:

1. Refuse to rewrite `.vercel/project.json` when it names another project. Deploy with the project flag the installed CLI documents. If that flag does not exist, stop. Do not `vercel link` over another customer.
2. `turso db shell <db> .dump` for production, to a path outside the repo. Dump failure stops the run. No migration.
3. Apply pending migrations to production. Failure stops the run. The previous deployment is still serving.
4. Deploy Production and wait until Ready. Smoke.
5. Dump the preview database, then migrate it. A failure here stops the fleet. The report says production for this slug already moved and preview did not.

`--canary <slug>` runs that slug first. The rest start only after the canary’s production deploy and preview migrate both succeed. Any failure stops the command. Later slugs are not started. There is no continue-on-error. There is no `--seed`.

### 3.8 Backups, restore, recover, offboard

Dump command: `turso db shell <db> .dump`. Output path outside the git repo. Refuse a path inside the work tree. The dump body is not copied to stdout.

PITR remains the short undo while the database still exists (24 hours, or 10/30/90 days). It is not the offboard copy and it is not the restore drill. The drill restores a dump into a **new** database name, runs `db:status`, then destroys the drill database. Restore never overwrites the live URL.

Deploy 1’s offboard change is the gate: `turso db destroy` runs only after a dump of that same database succeeds in the same invocation. Destroy of the preview database, token revoke, and project delete are Deploy 4.

`admin:recover` is the lost-admin path. `bootstrap-admin` stays the empty-database command and keeps returning 409 when any user exists. Recover sets a new password on an existing admin email and bumps `users.session_version`. The session payload gains `ver`. `attachSession` rejects a token whose `ver` is not that user’s current version. `setUserPassword` bumps the same column, so a password reset kills that user’s cookies. Other users stay signed in. A missing `ver` is rejected once this code is in production (one forced login, called out in the release note, same as the `env` claim).

Deploy 4 offboard, after `--confirm-slug`:

1. Wrong Vercel link → stop.
2. Dump preview, then production. A failed dump stops before any destroy.
3. Remove every customer key this program writes, on both environments, including preview keys and the generated secrets. A missing key is success.
4. Destroy the preview database, then the production database.
5. `turso db tokens invalidate` for group `procureflow-<slug>` only when inventory shows that group has no other database. Otherwise stop before invalidate and say so.
6. Delete the slug’s secrets-manager entries. Mark the private-repo row `offboarded`. Append the action log.
7. Print what a person still deletes: the Vercel project (until `vercel project rm` has a non-interactive confirm), and DNS.

### 3.9 Domain, SSO, SMTP

These stay optional and they are the last sprint. A customer can go live on `https://procureflow-<slug>.vercel.app` with password login and copy-link mail.

When the private repo has a hostname or an IdP for that slug, a dry-run prints key names and targets, never values. Apply writes them only after the whole set validates. Preview SSO and preview SMTP use their own keys. Production values are not copied. `SSO_PROVISIONING` stays off unless the file sets it. DNS at the registrar stays a person.

### 3.10 What stays a person

- `vercel login`, `turso auth login`, and `vercel switch`.
- The fleet location, until question 3 is answered. Deploy 1 records the answer in `vercel.json` and in the group’s `--location`.
- DNS, and SPF/DKIM if SMTP is turned on later.
- The webhook receiver URL.
- Choosing SSO provisioning and the default role.
- Connecting GitHub, if question 6 says yes.
- Deleting the Vercel project after offboard.
- Running the restore drill on a schedule once Deploy 4 exists. The product does not email the first-admin password.

---

## 4. Sprint breakdown

Five steps. Deploy 3 is two pull requests (3a then 3b) so the runner cannot ship before the history table does. Names stay clear of the product sprint numbers in [SPRINT-LOG.md](SPRINT-LOG.md). Register them from the implementation pull request, not from this one.

Tests use a fake process runner and fixture files. No live Turso, Vercel, or DNS. `npm test` stays the CI gate. Doc updates that change operator steps land in the same pull request as the CLI, in the files [server/src/provision.test.js](../server/src/provision.test.js) already reads.

### Deploy 1 — Safe install

**Scope**

- Create group `procureflow-<slug>` and both databases in it. Preview database included. No `--tursodb`. No default group.
- Per-environment secrets from §3.1, including a generated `PORTAL_TOKEN_SECRET`, `CRON_SECRET`, and `WEBHOOK_SIGNING_SECRET` on each environment. No production secret, production URL, or production token on Preview.
- `env` claim on the session token. Verifier rejects a missing or mismatched claim when `VERCEL_ENV` is `production` or `preview`.
- Slug checks from §3.2. Re-apply does not mint a token over one that already matches the host, and does not mint a session secret when the slug marker matches.
- `regions` in `vercel.json` for the fleet region. Group `--location` matches it.
- Offboard dumps with `turso db shell <db> .dump` and refuses to destroy if that dump fails. Token invalidate is not called.
- Manual paragraph for databases already in the default group: they stay there until a person recreates them. Do not call `tokens invalidate` on that group.

**Definition of done**

- A second `onboard:customer --apply` for the same slug changes nothing: no new group, database, token, secret, or redeploy.
- A fresh Preview deployment opens `procureflow-<slug>-preview` and its env has none of the production secret values.
- A shell holding customer A’s `TURSO_*` or `SESSION_SECRET` cannot write those values into customer B’s project. The command exits non-zero and does not spawn Turso or Vercel.

**Tests**

- Dry-run lists `turso group create procureflow-acme` and `turso db create procureflow-acme-preview --group procureflow-acme`, and does not pass `--tursodb`.
- Preview env plan has the preview pair and the preview mints. It does not contain the production token, the production URL, or the production `SESSION_SECRET`.
- A fixture cookie signed with the preview secret and `env: "preview"` fails `verifySessionToken` under the production secret and under `VERCEL_ENV=production`. A payload with no `env` fails when `VERCEL_ENV` is `production` or `preview`.
- Exported URL host `procureflow-beta` with `--slug acme` exits non-zero before spawn. Exported `SESSION_SECRET` without `PROCUREFLOW_SECRET_SLUG=acme` does the same.
- A second apply, with the matching URL and token already present, does not spawn `turso db tokens create` and does not call `generateSessionSecret`.
- Offboard with a failing dump does not spawn `turso db destroy`. Offboard without `--confirm-slug` mutates nothing.
- `vercel.json` contains `regions`. Existing [server/src/dbConfig.test.js](../server/src/dbConfig.test.js) cases stay, including the `allow` hatch.

**Risks**

- The `env` claim signs every current user out once.
- Databases already in the default group cannot be moved. Invalidate on that group is a fleet outage. The sprint must not call it.
- `new-p2p-indirect` may still have production credentials on Preview. Remove them in the same window as the first real apply, or leave that project out of the run.
- Host comparison has to match `sameDatabaseHost`. A false mismatch mints a spare token. A false match keeps the wrong database.

### Deploy 2 — Read-only inventory, action log, secrets manager

**Scope**

- Private repo for customer rows (§3.5). Public repo gains an example row with slug `example` only, no secrets and no `libsql://` URL.
- `customers:inventory` as specified. Drift only. No mutation.
- Append-only action log in the private repo.
- Secrets manager becomes the source of truth. Vercel env written as Sensitive, after confirming the CLI flag. Operator runs use a short-lived Turso token and do not invalidate afterwards.
- Install and offboard from Deploy 1 read and write the manager instead of the shell. The slug checks stay.

**Acceptance**

- Inventory over a fixture of two projects and one database prints the missing database and does not spawn `db create`, `env add`, or `deploy`.
- A production key name listed on Preview is drift. The value is not printed.
- Action log fixture lines contain the slug and the exit code and none of the fixture secret strings.
- A unit test rejects a private-repo row that contains a key named like a token or a `libsql://` value.
- Sensitive flag is present on the env-add argv the sprint verified.

**Risks**

- Sensitive env cannot be read back. A bug that treats `env pull` as the source of truth will see empty secrets and mint replacements. Tests should fail if the inventory or the upgrader calls `env pull`.
- The private repo is now part of the blast radius. It holds names, not tokens. Access to it is an owner decision (question 4).

### Deploy 3a — Numbered migrations

**Scope**

- `server/migrations/` and `schema_migrations`, as in §3.6.
- Existing rebuilds move to `batch()`. Boot uses `migrate: false` and returns 503 `schema_behind` when history is behind the code. Boot does not rebuild.
- Expand/contract rule. N−1 CI job.
- The autocommit partial-failure test in §3.6.

**Acceptance**

- The stub pipeline test: `exec` leaves the first row when the second statement errors; `batch()` leaves none.
- A memory database records each applied version once. Applying twice does not throw and does not duplicate the history row.
- Opening the server database when history is behind does not call `batch` or `exec` for a rebuild, and the health error code is `schema_behind`.
- CI fails a fixture contract migration that drops a column the previous release still selects.
- `db:status --json` includes the applied version and omits tokens.

**Risks**

- Turning off boot migrate means a deploy that races ahead of the upgrader 503s until Deploy 3b has run. That is the point. Do not merge 3a to a live customer project until 3b can migrate that project, or keep 3a dark behind the upgrader landing in the same release window.
- Moving a rebuild into `batch()` changes failure behavior for databases that were mid-rebuild. Run it first on a copy.

### Deploy 3b — Upgrader

**Scope**

- `upgrade:customers` from §3.7. Canary first. Stop on the first failure. No continue-on-error.
- Dump before migrate. Deploy only after the production migrate succeeds.
- Does not retarget `.vercel/project.json`. Does not seed. Does not `env pull`.

**Acceptance**

- Dry-run prints the canary, then the other slug, and does not spawn dump, migrate, or deploy.
- A mocked migrate failure on the canary does not spawn deploy and does not start the second slug.
- A mocked preview failure after a successful production deploy does not start the second slug, and the report names both facts.
- With `.vercel/project.json` aimed at a different project, the file bytes are unchanged.
- Dump failure does not spawn migrate.

**Risks**

- Sequential deploys are slow. Do not parallelize in this sprint.
- A canary that is not a real customer proves nothing. Question 10 asks which slug that is.

### Deploy 4 — Backups, restore drill, recover, full offboard

**Scope**

- Scheduled dump of each active customer (operator schedule, not a `vercel.json` cron). Retention days come from question 5. The command itself does not invent a number.
- Restore drill: new database name, `db:status`, destroy the drill database.
- `admin:recover` and `session_version` / `ver` from §3.8. `setUserPassword` bumps the version. `bootstrap-admin` still refuses when users exist.
- Full offboard from §3.8, including group-scoped token invalidate only when the group is exclusive.

**Acceptance**

- `--out` inside the work tree exits non-zero and does not spawn `turso`.
- A mocked dump writes outside the repo and the body is not on stdout.
- Recover on a database that already has users sets a password and bumps `session_version`. A token with the old `ver` fails `attachSession`. `bootstrap-admin` on that database still exits with the 409 path.
- Offboard invalidate argv is absent when the fixture group contains a third database. It is present, and named `procureflow-acme`, when the group contains only the two expected databases.
- Destroy argv order is preview, then production, and both come after a successful dump.

**Risks**

- A dump is personal data. Where it lives is question 5. The command’s help text says the file is sensitive.
- `turso db shell <db> .dump` on a large database is a long HTTP session. The drill is the proof it can be restored, not a dashboard checkbox.
- Bumping `session_version` on every password change signs that user out. That is intended. Call it out in the admin UI copy in the same pull request.

### Deploy 5 — Domain, SSO, and SMTP

**Scope**

- Optional hostname, OIDC, SAML, and SMTP from §3.9, after Deploy 1’s secret split. Production values are not copied to Preview.
- Domain attach only after reading the installed Vercel CLI help and recording the command in the manual.

**Acceptance**

- OIDC with a missing client secret writes zero env keys.
- SAML with both signing flags off writes zero env keys.
- A file that does not set `SSO_PROVISIONING` leaves it unset.
- Captured stdout and stderr do not contain the fixture `MAIL_SMTP_URL` or the fixture client secret.
- The domain command’s project name is `procureflow-<slug>`.

**Risks**

- PEM newlines through `vercel env add` stdin. Test a multi-line fixture.
- Preview SSO that reuses the production redirect URL fails in a confusing way. Separate preview keys are required. Default is production-only.

---

## 5. Open questions

Decisions already taken in this revision, so the sprints do not re-open them:

- Preview does not receive production secrets. Session tokens carry `env`.
- A stale shell cannot supply another customer’s URL or secret. Re-apply does not mint a token over a matching one.
- One Turso group per customer, before any new database. `tokens invalidate` is group-wide and is not a routine operator tool.
- Migrations are numbered, rebuilds run in `batch()`, boot does not migrate, the upgrader stops on the first failure, and it dumps first.
- The customer list lives in a private repo plus the Vercel and Turso APIs. Secrets live in a secrets manager. Vercel copies are Sensitive.
- Dumps are `turso db shell <db> .dump`. PITR is automatic and dies with the database.

Still open:

1. **Hostname.** Default until Deploy 5: `https://procureflow-<slug>.vercel.app`. Is the real scheme the customer’s own host, a subdomain we control, or the `vercel.app` name until a customer asks?

2. **Who pays.** Default: the operator’s current Turso org and Vercel team. One group, two databases, and one project per customer. Should each customer have their own org and team? Who is invoiced?

3. **Fleet region.** Deploy 1 needs one Turso location and the matching `vercel.json` `regions` entry. Which location, for a Netherlands customer? If customers ever differ, the committed `regions` array is the wrong tool and this plan has to change.

4. **Private repo and secrets manager.** Which private repo, who can read it, and which secrets manager? The public repo stays empty of real slugs.

5. **Dump retention.** PITR is 24 hours on Free and 10, 30, or 90 days on paid, and only until destroy. How many dumps do we keep, where, and who may restore?

6. **How code ships.** Default: `upgrade:customers` deploys from the operator. Do you want git-push on each customer project, or one CI job with a Vercel token?

7. **Preview data.** Default: one preview database per customer, empty unless someone passes `--preview-demo`. Every open pull request on that project shares it. Per-branch databases are a different design.

8. **Sourcing cron.** Deploy 1 mints `CRON_SECRET` and does not add a cron. Should a later sprint add the 15-minute tick for every customer, or only when sourcing is on?

9. **Node on Vercel.** CI is Node 22. `engines` is `>=18`. `project add` does not pin it. Should Deploy 1 set 22 when the CLI can do that without a prompt?

10. **Existing installs.** Which slugs already exist, which of them share the default Turso group, and which slug is the canary for the first `upgrade:customers --apply`? `new-p2p-indirect` is the one the manual already names.

11. **Project delete.** Offboard leaves the Vercel project until `vercel project rm` can take a non-interactive confirm. Should that be a second flag when the CLI grows one?

12. **First-admin handoff.** Default: the operator types the password on stdin and puts it in the password manager. The app does not email it. Is that the handoff you want?
