# Onboard a new ProcureFlow customer

The step-by-step install is **[DEPLOY_MANUAL.md](DEPLOY_MANUAL.md)**. Follow that manual from the top. This file only keeps older links from landing on a second, drifting copy of the same steps.

Start with `npm run onboard:customer` (dry-run, then `--apply`). The stepped path, when you need to repeat one stage, is `npm run turso:customer` and then `npm run vercel:customer`.

The manual is the place for `turso db create procureflow-<slug>` (classic libSQL, never `--tursodb`), a database token rather than an org JWT, Production and Preview, `DEMO_PERSONA_SWITCHER`, `npm run db:migrate`, `bootstrap-org`, `bootstrap-admin`, `provision:customer` with `--with-org`, `npm run smoke`, and `SESSION_SECRET`. A second Turso DB is a second customer. Do not seed a live tenant. A legacy seed from before auth is in the manual’s troubleshooting section.

Deprovision:

```bash
npm run offboard:customer -- --slug acme --apply --confirm-slug acme
```

Technical pointer (also redirects): [DEPLOYMENT.md](DEPLOYMENT.md). What the product can do: [SYSTEM_MANUAL.md](SYSTEM_MANUAL.md).
