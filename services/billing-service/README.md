# Billing service project

Owns durable external-delivery jobs, first-attempt timestamps, leases, retry command receipts, validated acknowledgments and audit. Its HTTP API accepts an immutable job idempotently from Charge. Its worker alone calls hospital billing systems. It has no charge or patient tables.

From repository root: `npm run build:shared`, then `npm run build -w @rounding/billing-service`. Run with `npm run start -w @rounding/billing-service` or `npm run dev -w @rounding/billing-service`. Set `DEMO_MODE=true` for seeds/credentials.

Default port: **3103**. Private database: `DATABASE_PATH` or `data/billing.db`. Internal credential: `BILLING_SERVICE_TOKEN`. External credential: `BILLING_TOKEN`; demo hospital endpoint: `BILLING_URL`. Production endpoints are stored in this service's own hospital configuration. Docker volume: `billing-service-data`. Deploy: `docker compose up -d --build --no-deps billing-service`.

Retries retain the original external key and payload, reconcile before POST, and stop blind submissions after 23 hours. Manual retry and repeated internal PUT never reset first-attempt age. After expiry, incomplete/absent external results require REVIEW instead of duplicate billing risk.
