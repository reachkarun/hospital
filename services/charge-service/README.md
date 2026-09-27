# Charge and offline sync service project

Owns drafts, optimistic versions, immutable charge revisions, mobile operation receipts, submission outbox, retry commands and projected billing results. It validates new work through Patient's HTTP encounter API and delivers immutable jobs to Billing through a leased outbox dispatcher. It never contacts external billing directly or opens Patient/Billing storage.

From repository root: `npm run build:shared`, then `npm run build -w @rounding/charge-service`. Run with `npm run start -w @rounding/charge-service` or `npm run dev -w @rounding/charge-service`. Set `DEMO_MODE=true` for seeds and credentials.

Default port: **3102**. Private database: `DATABASE_PATH` or `data/charges.db`. Dependencies: `PATIENT_SERVICE_URL`, `BILLING_SERVICE_URL`, and their distinct `PATIENT_SERVICE_TOKEN` / `BILLING_SERVICE_TOKEN`. Docker volume: `charge-data`. Deploy: `docker compose up -d --build --no-deps charge-service`.

Patient outage blocks new edits/submissions, while known receipts and reads still work. Billing outage leaves jobs durably queued; accepted results synchronize after recovery. Mobile API status may briefly lag Billing because synchronization is eventual.
