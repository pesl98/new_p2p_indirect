# Provision a ProcureFlow customer (operator checklist)

**Walkthrough:** [docs/CUSTOMER_ONBOARDING.md](../docs/CUSTOMER_ONBOARDING.md) (Turso → Vercel → env → migrate → bootstrap → smoke → first login). Technical reference: [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md). Isolation = **one Turso DB or SQLite file per customer** (not `org_id`). Env keys: [`.env.example`](../.env.example).

Login is a per-tenant httpOnly session (`SESSION_SECRET`). Header persona switcher is **demo-only** (`DEMO_PERSONA_SWITCHER=1`). Empty DB after migrate has 0 users — bootstrap the first admin next. **Do not seed** a live tenant.

Real-customer sequence: **migrate → bootstrap-admin → smoke**. Wrapper (no Turso/Vercel CLI): `npm run provision:customer`.

## Customer A (Turso + Vercel)

```bash
turso db create procureflow-acme
export TURSO_DATABASE_URL="$(turso db show procureflow-acme --url)"
export TURSO_AUTH_TOKEN="$(turso db tokens create procureflow-acme)"
export SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"

# Empty tenant — no demo personas
npm run db:migrate
npm run db:status
npm run bootstrap-admin -- --email admin@acme.test --password 'choose-a-long-password'
# equivalent: npm run provision:customer -- --email admin@acme.test --password 'choose-a-long-password'

# Demo only (WIPES this DB): npm run seed
```

### Vercel project `procureflow-acme`

- [ ] New Vercel project (do not share this project with another customer)
- [ ] Root directory = repo root; build comes from `vercel.json` (`npm run build`)
- [ ] Env **Production and Preview**: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SESSION_SECRET` (this customer’s values only)
- [ ] Leave `DEMO_PERSONA_SWITCHER` unset
- [ ] **Redeploy** after saving env (old Previews keep stale env)
- [ ] Never paste another customer’s Turso URL here
- [ ] `TURSO_AUTH_TOKEN` is from `turso db tokens create` (database token, **not** an org JWT)
- [ ] Database is classic libSQL (`turso db create`, **not** `--tursodb`)

```bash
# After deploy — replace the hostname
export BASE_URL=https://<acme>.vercel.app
npm run smoke
# optional login check:
npm run smoke -- --email admin@acme.test --password 'choose-a-long-password'
```

First login: open the Production URL, sign in as the bootstrap admin, then **Administration → Users** for everyone else. Optional departments / department heads: [CUSTOMER_ONBOARDING.md](../docs/CUSTOMER_ONBOARDING.md#11-optional-departments-and-department-approvers) (no create-department UI; insert SQL then map heads).

## Customer B (must be a different database)

```bash
turso db create procureflow-beta
export TURSO_DATABASE_URL="$(turso db show procureflow-beta --url)"
export TURSO_AUTH_TOKEN="$(turso db tokens create procureflow-beta)"
export SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"

npm run provision:customer -- --email admin@beta.test --password 'choose-a-long-password'

# Second Vercel project (or clone). Replace Turso URL/token + SESSION_SECRET.
# Production + Preview, then Redeploy. Do not paste Acme’s URL.
BASE_URL=https://<beta>.vercel.app npm run smoke
```

## Local SQLite pair (no Turso)

```bash
unset TURSO_DATABASE_URL TURSO_AUTH_TOKEN

export PROCUREMENT_DB_PATH="$PWD/server/data/acme.db"
npm run provision:customer -- --email admin@acme.test --password 'choose-a-long-password'
npm start
BASE_URL=http://127.0.0.1:5000 npm run smoke

# Other terminal / later: customer B is a different file
export PROCUREMENT_DB_PATH="$PWD/server/data/beta.db"
npm run db:migrate && npm run db:status
```

`db:migrate` applies schema + existing migrations only. `--seed` is opt-in and destructive.

```bash
npm run db:migrate -- --seed     # demo wipe + personas
npm run db:migrate -- --turso    # fail-closed if TURSO_* missing
npm run db:status -- --json
npm run smoke -- --json
```

## Wipe / rollback

```bash
# SQLite
rm -f "$PROCUREMENT_DB_PATH" "$PROCUREMENT_DB_PATH"-wal "$PROCUREMENT_DB_PATH"-shm
npm run db:migrate

# Turso (irreversible)
turso db destroy procureflow-acme --yes
# recreate + new token + update Vercel env + Redeploy + db:migrate

# Re-seed demo (destructive)
npm run seed
```

Never commit `*.db`, `.env`, or tokens.
