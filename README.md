# Rounding App backend

Node.js 22 + TypeScript backend for [the assignment](TAKE_HOME_ASSIGNMENT.md). Implements **all three core components**: patient sync, charge submission, and offline sync coordination. No frontend or external accounts are needed.

## Run locally

Requires Node.js **22.13+** (tested on 22.19) and npm. The built-in SQLite driver emits an experimental warning on Node 22; this is expected.

```sh
npm ci
npm run demo:start
```

This starts the API, a separate billing worker, and a persistent billing mock. Two hospitals and synthetic patients/providers/visits are seeded automatically. All data persists in `data/`. API: **http://127.0.0.1:3000/health**. Mock: **http://127.0.0.1:4001/health**. Use a second terminal:

```sh
npm run demo
```

The repeatable, assertion-backed demo publishes a source event twice, saves offline drafts, detects a stale edit, recovers from a billing outage, handles partial acceptance, corrects the rejected item, reconciles a lost acknowledgment, and verifies hospital isolation and audit access. Each run uses new charge and operation IDs. Ctrl+C stops the local processes.

If another application uses port 3000, select an alternate API port. In PowerShell, run `$env:PORT='3002'` before `npm run demo:start`; in the demo terminal, run `$env:API_URL='http://127.0.0.1:3002'` before `npm run demo`. Mock billing still uses port 4001.

## Run with Docker

```sh
docker compose up --build
```

Docker exposes the API on **http://localhost:3002** (set `API_HOST_PORT` to override).
Open **http://localhost:3002/docs/** for Swagger UI. Click **Authorize**, enter
`demo-provider-one` without a `Bearer` prefix, and use **Try it out**.
Use `demo-integration-one` for source events or `demo-admin-one` for audit/operations.
The OpenAPI JSON is at `/docs/json`. Local `npm run demo:start` exposes the same
documentation on its configured API port (3000 by default).

The build runs TypeScript compilation and the automated tests. Compose starts `api`, `worker`, and `billing-mock` with health checks and named persistent volumes. Ports are bound to localhost. For the local demo script against Docker, set `API_URL=http://localhost:3002` (PowerShell: `$env:API_URL='http://localhost:3002'`) before `npm run demo`. Alternatively run the demo inside the API container:

```sh
docker compose exec -e MOCK_URL=http://billing-mock:4001 api node dist/scripts/demo.js
```

`docker compose down` preserves data. `docker compose down -v` deliberately deletes demonstration data. Do not run the local stack and Docker stack simultaneously on the same ports.

## Validate

```sh
npm run typecheck
npm test
npm run build
npm audit
```

Tests cover transaction rollback, event deduplication and ordering, dependency replay, schema quarantine, offline conflicts, authorization, tenant isolation, charge validation, post-discharge billing, partial acceptance, retries, lost acknowledgments, stale worker fencing, idempotency expiry, and disk persistence.

## Demo authentication

Pass `Authorization: Bearer <token>`. Hospital and provider identity come from the token configuration, never from mobile request bodies or a hospital header.

| Token | Hospital | Role |
|---|---|---|
| `demo-provider-one` | HOSP-001 | PROV-789 provider |
| `demo-provider-two` | HOSP-002 | PROV-789 provider |
| `demo-integration-one` | HOSP-001 | Patient broker |
| `demo-integration-two` | HOSP-002 | Patient broker |
| `demo-admin-one` | HOSP-001 | Audit/operations administrator |

The mock uses `demo-billing-secret`, separate from API credentials. Demo credentials work only when explicitly configured with `DEMO_MODE=true`. They are for synthetic data only.

## API quick start

Use `curl.exe` in PowerShell or `curl` on macOS/Linux. JSON examples and a complete endpoint reference are in [docs/API.md](docs/API.md); [examples/requests.http](examples/requests.http) can be run with an IDE HTTP client.

```http
POST /v1/charges
Authorization: Bearer demo-provider-one
Content-Type: application/json

{
  "operationId": "device-a-edit-1",
  "chargeId": "charge-001",
  "expectedVersion": 0,
  "charge": {
    "visitId": "VISIT-001",
    "serviceCode": "99213",
    "quantity": 1,
    "dateOfService": "2026-01-15",
    "modifiers": ["25"],
    "notes": "Synthetic encounter note"
  }
}
```

Then `POST /v1/submissions` with `{"clientSubmissionId":"mobile-batch-001","chargeIds":["charge-001"]}` and poll `GET /v1/submissions/{submissionId}`. Charge saves never call billing. Only explicit submission queues work.

## Structure and design

| File | Responsibility |
|---|---|
| `src/api.ts` | HTTP routes, authentication, role checks, limits, safe errors |
| `src/contracts.ts` | Mobile contracts and domain errors |
| `src/patients.ts` | Six patient event types, inbox, deduplication, field clocks, replay |
| `src/charges.ts` | Draft versions, operation receipts, billing outbox transaction |
| `src/billing.ts` | HTTP adapter, leased worker, backoff, acknowledgment validation |
| `src/db.ts` | Tenant-scoped schema, transactions, audit and revision triggers |
| `src/mock-billing.ts` | Durable external mock, outage/rate-limit/lost-ack injection |
| `scripts/demo.ts` | Source-system mock publisher and end-to-end demonstration |

Read [architecture and ER diagrams](docs/ARCHITECTURE.md), [patient integration specification](docs/INTEGRATION.md), and [resiliency and walkthrough notes](docs/OPERATIONS.md).

## Scope and deliberate limits

This is a runnable single-host take-home implementation. SQLite keeps installation simple and provides durable transactional behavior; synchronous database work and one writer limit throughput. The application supports competing processes on the **same local database file**, not SQLite over network filesystems or replicas on multiple hosts. A PostgreSQL migration is the next step for horizontal scaling.

The patient broker is simulated by an authenticated HTTP delivery adapter; no live AMQP connection is claimed. The durable inbox and consumer are implemented independently of delivery. Event timestamps produce deterministic per-field projections; arbitrary late delivery cannot promise literal global timestamp execution order without a broker sequence/watermark contract.

Billing deduplicates for only 24 hours. The worker reuses the same billing key, reconciles retries, and stops blind resubmission after 23 hours. Unresolved outcomes enter `REVIEW`, keeping charges locked. **Unconditional exactly-once delivery across an unlimited outage is impossible with the supplied external contract**; this implementation favors avoiding duplicate billing over automatic progress after expiry.

Outside demo mode, configure `AUTH_TOKENS` as a JSON map of long bearer tokens to `{hospital,provider,role}` and `BILLING_TOKEN`. Hospital records and billing URLs must be provisioned by a trusted operator; demo seeding is disabled. API and worker use the same database path. This project does not provide production identity management, encryption at rest, retention automation, or a HIPAA compliance certification.
