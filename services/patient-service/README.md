# Patient service project

Owns patient/provider/visit/assignment projections, clinical source data, durable event inbox, ordering clocks and audit. A local replay loop handles missing prerequisites. Exposes public patient/integration APIs plus the authenticated `/internal/v1/encounters/resolve` contract for Charge service. No Charge or Billing database access.

From repository root: `npm run build:shared`, then `npm run build -w @rounding/patient-service`. Run with `npm run start -w @rounding/patient-service` or `npm run dev -w @rounding/patient-service`. Set `DEMO_MODE=true` for seeds and demo credentials.

Default port: **3101**. Private database: `DATABASE_PATH` or `data/patients.db`. Internal credential: `PATIENT_SERVICE_TOKEN`. Docker volume: `patient-data`. Deploy independently: `docker compose up -d --build --no-deps patient-service`.
