# External billing mock project

Standalone simulation of hospital billing. Persists idempotency receipts separately from application services. Supports accepted/rejected/partial results and `outage`, `rate-limit`, `lost-ack` controls at `/admin/mode`. This is a development dependency, not a production domain service.

From repository root: `npm run build:shared`, then `npm run build -w @rounding/billing-mock`. Run with `npm run start -w @rounding/billing-mock`. Requires `DEMO_MODE=true`.

Default port: **4001**. Database: `DATABASE_PATH` or `data/billing-mock.db`. Credential: `BILLING_TOKEN` (demo: `demo-billing-secret`). Existing Docker mock receipts remain in `billing-data` during the microservice migration. Deploy: `docker compose up -d --build --no-deps billing-mock`.
