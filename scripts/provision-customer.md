# Provision a ProcureFlow customer (operator checklist)

**System manual** (capabilities + deploy overview): [docs/SYSTEM_MANUAL.md](../docs/SYSTEM_MANUAL.md). **Walkthrough:** [docs/CUSTOMER_ONBOARDING.md](../docs/CUSTOMER_ONBOARDING.md) (`turso:customer --apply` → Vercel project → `vercel:customer --apply` → `provision:customer -- --with-org` → smoke → first login). Technical reference: [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md). Isolation = **one Turso DB or SQLite file per customer** (not `org_id`). Env keys: [`.env.example`](../.env.example).

Login is a per-tenant httpOnly session (`SESSION_SECRET`). Header persona switcher is **demo-only** (`DEMO_PERSONA_SWITCHER=1`). Empty DB after migrate has 0 users and 0 departments — bootstrap the org skeleton, then the first admin. **Do not seed** a live tenant.

Real-customer sequence: **`turso:customer --apply` → (human) create/link Vercel project → `vercel:customer --apply` → `provision:customer -- --with-org` → smoke**. Wrapper for migrate + optional org + optional admin: `npm run provision:customer -- --with-org`. Turso DB + database token + `SESSION_SECRET`: `npm run turso:customer`. Vercel Production+Preview env + redeploy: `npm run vercel:customer`.

Three tiers: empty schema (`db:migrate`) → org skeleton (`bootstrap-org`, non-destructive) → destructive demo (`seed`).

## Customer A (Turso + Vercel)

```bash
npm run turso:customer -- --slug acme                 # dry-run (no Turso mutation)
npm run turso:customer -- --slug acme --apply         # create/reuse classic libSQL + print exports
# copy the printed export TURSO_* / SESSION_SECRET lines into this shell

# Vercel project procureflow-acme must already exist (dashboard import; root = repo root)
vercel login                                          # once
vercel link --yes --project procureflow-acme          # once per clone
npm run vercel:customer -- --slug acme                # dry-run (no Vercel network)
npm run vercel:customer -- --slug acme --apply        # Production + Preview env + redeploy

# Empty tenant — no demo personas
npm run db:migrate
npm run db:status
npm run bootstrap-org
npm run bootstrap-admin -- --email admin@acme.test --password 'choose-a-long-password'
# equivalent: npm run provision:customer -- --with-org --email admin@acme.test --password 'choose-a-long-password'

# Demo only (WIPES this DB): npm run seed
```

### Vercel project `procureflow-acme`

- [ ] New Vercel project (do not share this project with another customer)
- [ ] Root directory = repo root; build comes from `vercel.json` (`npm run build`)
- [ ] `vercel link --yes --project procureflow-acme`
- [ ] `npm run vercel:customer -- --slug acme --apply` sets **Production and Preview**: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SESSION_SECRET` (this customer’s values only; refuses to invent secrets)
- [ ] Leave `DEMO_PERSONA_SWITCHER` unset (the script will not set it)
- [ ] Redeploy is part of `--apply` (old Previews keep stale env until rebuilt)
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
npm run turso:customer -- --slug beta --apply         # separate DB + new SESSION_SECRET

# Second Vercel project (or clone). Do not paste Acme’s URL.
vercel link --yes --project procureflow-beta
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
npm run turso:customer -- --help
npm run vercel:customer -- --help
```

## Wipe / rollback

```bash
# SQLite
rm -f "$PROCUREMENT_DB_PATH" "$PROCUREMENT_DB_PATH"-wal "$PROCUREMENT_DB_PATH"-shm
npm run db:migrate

# Turso (irreversible)
turso db destroy procureflow-acme --yes
# recreate: npm run turso:customer -- --slug acme --apply
# then npm run vercel:customer -- --slug acme --apply + db:migrate

# Re-seed demo (destructive)
npm run seed
```

Never commit `*.db`, `.env`, or tokens.
