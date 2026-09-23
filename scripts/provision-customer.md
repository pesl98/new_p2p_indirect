# Provision a ProcureFlow customer (operator checklist)

**System manual** (capabilities + deploy overview): [docs/SYSTEM_MANUAL.md](../docs/SYSTEM_MANUAL.md). **Walkthrough:** [docs/CUSTOMER_ONBOARDING.md](../docs/CUSTOMER_ONBOARDING.md) — preferred: `npm run onboard:customer -- --slug <customer>` then `--apply --email … --password …` (creates/links the Vercel project when this clone is not already linked to it). Stepped: `turso:customer --apply` → `vercel:customer --apply` → `provision:customer -- --with-org` → smoke → first login. Technical reference: [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md). Isolation = **one Turso DB or SQLite file per customer** (not `org_id`). Env keys: [`.env.example`](../.env.example).

Login is a per-tenant httpOnly session (`SESSION_SECRET`). Header persona switcher is **demo-only** (`DEMO_PERSONA_SWITCHER=1`). Empty DB after migrate has 0 users and 0 departments — bootstrap the org skeleton, then the first admin. **Do not seed** a live tenant.

Real-customer sequence (preferred): **`npm run onboard:customer -- --slug <customer> --apply --email … --password … --smoke`**. `--apply` waits until the Production deployment is Ready before smoke runs. Stepped: **`turso:customer --apply` → `vercel:customer --apply` (project add + link if needed, then env, redeploy, and the same Ready wait) → `provision:customer -- --with-org` → smoke**. Wrapper for migrate + optional org + optional admin: `npm run provision:customer -- --with-org`. Turso DB + database token + `SESSION_SECRET`: `npm run turso:customer`. Vercel project ensure + Production+Preview env + redeploy + Ready wait: `npm run vercel:customer`. GitHub auto-deploy is not connected by `vercel project add`.

Three tiers: empty schema (`db:migrate`) → org skeleton (`bootstrap-org`, non-destructive) → destructive demo (`seed`).

## Customer A (Turso + Vercel)

```bash
# Preferred one-command (dry-run first; --with-org is default on this command)
npm run onboard:customer -- --slug acme
# --apply creates/links procureflow-acme unless this clone is already linked to it:
npm run onboard:customer -- --slug acme --apply \
  --email admin@acme.test --password 'choose-a-long-password' \
  --smoke

# Stepped (same sequence; copy Turso export lines by hand)
npm run turso:customer -- --slug acme                 # dry-run (no Turso mutation)
npm run turso:customer -- --slug acme --apply         # create/reuse classic libSQL + print exports
# copy the printed export TURSO_* / SESSION_SECRET lines into this shell

# vercel:customer --apply runs:
#   vercel project add procureflow-acme
#   vercel link --yes --project procureflow-acme
# (skipped if already linked to that name; fails closed if linked to a different project)
vercel login                                          # once; vercel switch if you have multiple teams
npm run vercel:customer -- --slug acme                # dry-run (no Vercel network)
npm run vercel:customer -- --slug acme --apply        # ensure + link + env + redeploy, then wait until Production is Ready

# Empty tenant — no demo personas
npm run db:migrate
npm run db:status
npm run bootstrap-org
npm run bootstrap-admin -- --email admin@acme.test --password 'choose-a-long-password'
# equivalent: npm run provision:customer -- --with-org --email admin@acme.test --password 'choose-a-long-password'

# Demo only (WIPES this DB): npm run seed
```

### Vercel project `procureflow-acme`

- [ ] New Vercel project `procureflow-acme` (do not share this project with another customer). `--apply` runs `vercel project add` (reuses the project if it already exists)
- [ ] Root directory = repo root; build comes from `vercel.json` (`npm run build`)
- [ ] Linked with `vercel link --yes --project procureflow-acme` (skipped if already linked to that name)
- [ ] GitHub auto-deploy is a separate dashboard step if you want git-push deploys (`vercel project add` does not connect GitHub; laptop `vercel deploy --prod` / redeploy does)
- [ ] `npm run vercel:customer -- --slug acme --apply` sets **Production and Preview**: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SESSION_SECRET` (this customer’s values only; refuses to invent secrets)
- [ ] Leave `DEMO_PERSONA_SWITCHER` unset (the script will not set it)
- [ ] Redeploy is part of `--apply`, which then waits until that Production deployment is Ready (`VERCEL_READY_TIMEOUT_MS`, default 4 minutes). Old Previews keep stale env until rebuilt.
- [ ] Never paste another customer’s Turso URL here
- [ ] `TURSO_AUTH_TOKEN` is from `npm run turso:customer -- --apply` / `turso db tokens create` (database token, **not** an org JWT)
- [ ] Database is classic libSQL (`turso:customer` / `turso db create`, **not** `--tursodb`)

```bash
# After deploy — replace the hostname
export BASE_URL=https://procureflow-acme.vercel.app
npm run smoke
# optional login check:
npm run smoke -- --email admin@acme.test --password 'choose-a-long-password'
```

First login: open the Production URL, sign in as the bootstrap admin, then **Administration → Users** for everyone else. Cost centers: [CUSTOMER_ONBOARDING.md §11](../docs/CUSTOMER_ONBOARDING.md#11-cost-centers-and-department-approvers-bootstrap-org) (`npm run bootstrap-org`; no create-department UI; map heads after users exist).

## Customer B (must be a different database)

```bash
# Preferred: npm run onboard:customer -- --slug beta --apply --email admin@beta.test --password '…'
npm run turso:customer -- --slug beta --apply         # separate DB + new SESSION_SECRET

# Second Vercel project. Do not paste Acme’s URL.
# If this clone is still linked to procureflow-acme, --apply fails closed (does not retarget).
npm run vercel:customer -- --slug beta --apply
npm run provision:customer -- --with-org --email admin@beta.test --password 'choose-a-long-password'

BASE_URL=https://procureflow-beta.vercel.app npm run smoke
```

## Local SQLite pair (no Turso)

```bash
unset TURSO_DATABASE_URL TURSO_AUTH_TOKEN

export PROCUREMENT_DB_PATH="$PWD/server/data/acme.db"
npm run provision:customer -- --with-org --email admin@acme.test --password 'choose-a-long-password'
npm start
BASE_URL=http://127.0.0.1:5000 npm run smoke

# Other terminal / later: customer B is a different file
export PROCUREMENT_DB_PATH="$PWD/server/data/beta.db"
npm run db:migrate && npm run db:status
```

`db:migrate` applies schema + existing migrations only. `bootstrap-org` inserts the default five cost centers + FY budgets (idempotent). `--seed` is opt-in and destructive.

```bash
npm run bootstrap-org
npm run bootstrap-org -- --json
npm run db:migrate -- --seed     # demo wipe + personas
npm run db:migrate -- --turso    # fail-closed if TURSO_* missing
npm run db:status -- --json
npm run smoke -- --json
npm run onboard:customer -- --help
npm run turso:customer -- --help
npm run vercel:customer -- --help
npm run offboard:customer -- --help
```

## Wipe / rollback / deprovision

```bash
# SQLite
rm -f "$PROCUREMENT_DB_PATH" "$PROCUREMENT_DB_PATH"-wal "$PROCUREMENT_DB_PATH"-shm
npm run db:migrate

# Deprovision (preferred): dry-run, then strip Production+Preview customer env and destroy the DB.
# --apply does nothing destructive unless --confirm-slug matches the normalized slug.
# Does not delete the Vercel project. Does not seed. Fails closed if this checkout
# is linked to a different Vercel project.
npm run offboard:customer -- --slug acme
npm run offboard:customer -- --slug acme --apply --confirm-slug acme

# Turso data wipe, then recreate (not deprovision — Vercel env stays)
turso db destroy procureflow-acme --yes
# recreate: npm run turso:customer -- --slug acme --apply
# then npm run vercel:customer -- --slug acme --apply + db:migrate

# Re-seed demo (destructive)
npm run seed
```

Never commit `*.db`, `.env`, or tokens.
