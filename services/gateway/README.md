# Gateway project

Stateless public HTTP boundary. Routes patient/charge APIs, selects service-owned audit logs, aggregates metrics, and serves Swagger at `/docs/`. It has no database and cannot proxy internal service APIs.

From repository root: `npm run build:shared`, then `npm run build -w @rounding/gateway`. Run with `npm run start -w @rounding/gateway`; development uses `npm run dev -w @rounding/gateway`. Set `DEMO_MODE=true` for synthetic credentials.

Default port: **3002**. Dependencies: `PATIENT_SERVICE_URL` (3101), `CHARGE_SERVICE_URL` (3102), `BILLING_SERVICE_URL` (3103). Production credentials use `AUTH_TOKENS`. Docker: `docker compose up -d --build --no-deps gateway`. Its Dockerfile builds this project and shared packages independently.
