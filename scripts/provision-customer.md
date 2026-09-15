# Provision a ProcureFlow customer (operator checklist)

Full narrative: [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md). Isolation = **one Turso DB or SQLite file per customer** (not `org_id`).

Persona switcher is **demo auth, not SSO**. Empty DB after migrate has no users. `GET /api/users` cannot create them — use `db:bootstrap`.

## Customer A (Turso + Vercel)

```bash
turso db create procureflow-acme
export TURSO_DATABASE_URL="$(turso db show procureflow-acme --url)"
export TURSO_AUTH_TOKEN="$(turso db tokens create procureflow-acme)"

npm run db:migrate
npm run db:status
# Real tenant people (non-destructive JSON; copy/edit the example):
cp scripts/customer-org.example.json ./acme-org.json
# edit acme-org.json then:
npm run db:bootstrap -- --file ./acme-org.json
# Demo only: npm run seed   (WIPES this DB)

# Vercel project "procureflow-acme": set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
# on Production and Preview, deploy, then:
curl -s https://<acme>.vercel.app/api/health
curl -s https://<acme>.vercel.app/api/users
```

## Customer B (must be a different database)

```bash
turso db create procureflow-beta
export TURSO_DATABASE_URL="$(turso db show procureflow-beta --url)"
export TURSO_AUTH_TOKEN="$(turso db tokens create procureflow-beta)"

npm run db:migrate
npm run db:status
npm run db:bootstrap -- --file ./beta-org.json

# Second Vercel project (or clone). Do not paste Acme’s URL/token.
curl -s https://<beta>.vercel.app/api/health
```

## Local SQLite pair (no Turso)

```bash
unset TURSO_DATABASE_URL TURSO_AUTH_TOKEN

export PROCUREMENT_DB_PATH="$PWD/server/data/acme.db"
npm run db:migrate && npm run db:bootstrap -- --file ./acme-org.json && npm run db:status

export PROCUREMENT_DB_PATH="$PWD/server/data/beta.db"
npm run db:migrate && npm run db:bootstrap -- --file ./beta-org.json && npm run db:status
```

`db:migrate` applies schema + existing migrations only. `db:bootstrap` inserts org rows (skips existing codes/emails). `--seed` is opt-in and destructive.

```bash
npm run db:migrate -- --seed     # demo wipe + personas
npm run db:migrate -- --turso    # fail-closed if TURSO_* missing
npm run db:status -- --json
npm run db:bootstrap -- --file scripts/customer-org.example.json
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
