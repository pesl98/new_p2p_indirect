# ProcureFlow customer deployment

The operator manual is **[DEPLOY_MANUAL.md](DEPLOY_MANUAL.md)**. Use that document to deploy, run, update, and remove a customer install. This page no longer repeats the procedure.

[CUSTOMER_ONBOARDING.md](CUSTOMER_ONBOARDING.md) is the same kind of pointer. Capabilities stay in [SYSTEM_MANUAL.md](SYSTEM_MANUAL.md). Env key names (no values) stay in [`.env.example`](../.env.example).

The manual covers one project per customer and no shared-row `org_id` multi-tenancy, `SESSION_SECRET`, the persona switcher left off, `npm run db:migrate`, `npm run db:status`, `npm run smoke`, `bootstrap-admin`, `bootstrap-org`, `provision:customer -- --with-org`, `npm run turso:customer`, `npm run vercel:customer -- --apply`, and `npm run onboard:customer`. Env edits need a Redeploy. Deprovision is `npm run offboard:customer`.
