# Rounding App — Node.js microservices

Five independently built/deployed TypeScript projects in one npm-workspace repository. The former monolithic `src/` application has been replaced; services communicate through authenticated HTTP APIs and **never read another service's database**.

| Project                                     | Owns                                                                                | Default port | Database/volume        |
| ------------------------------------------- | ----------------------------------------------------------------------------------- | ------------ | ---------------------- |
| [Gateway](services/gateway)                 | Public API routing, aggregate Swagger, authentication                               | **3002**     | None                   |
| [Patient service](services/patient-service) | Patients, providers, visits, assignments, source inbox, event ordering              | 3101         | `patient-data`         |
| [Charge service](services/charge-service)   | Drafts, offline operations, revisions, submission outbox, billing result projection | 3102         | `charge-data`          |
| [Billing service](services/billing-service) | Durable billing jobs, external retries, reconciliation, idempotency age             | 3103         | `billing-service-data` |
| [Billing mock](services/billing-mock)       | Simulated hospital billing, persistent receipts, failure injection                  | 4001         | `billing-data`         |

Each project has a `package.json`, `tsconfig.json`, Dockerfile, entrypoint and README. Only versioned wire contracts and infrastructure helpers live in `packages/`; there are no shared domain repositories or cross-service source imports. SQLite is private to each service, so storage can be replaced independently.

For a detailed presentation script, design explanations, failure scenarios, demo steps, and panel questions, see the [interview guide](docs/INTERVIEW_GUIDE.md).

Each application uses **NestJS modules → controllers → services**, with Nest's standard Express adapter. Decorated modules register providers with Nest's dependency injection container, controllers handle HTTP validation and responses, and injectable service classes implement application workflows. Shared Nest guards, exception filters, and lifecycle hooks handle authentication, errors, and shutdown. See [code organization](docs/ARCHITECTURE.md#code-organization) for the folder layout and extension guidelines.

## Start with Docker

For a new installation:

```sh
docker compose up --build -d --wait
```

**Swagger: http://localhost:3002/docs/**

Click **Authorize**, enter `demo-provider-one` (without `Bearer`), then try `GET /v1/patients`. Use `demo-integration-one` for patient source messages and `demo-admin-one` for admin endpoints. The OpenAPI document is at `/docs/json`.

Only the gateway and mock publish host ports. Domain services are private on Docker's network; each has its own health check and named data volume. Set `API_HOST_PORT` to override port 3002. `docker compose down` preserves data. Avoid `down -v` unless you intend to erase the service databases.

**Upgrading the previously installed monolith?** Follow [the migration procedure](docs/MIGRATION.md) before first starting the new services. It retains the old volume and imports all patient, charge, receipt and billing state without resetting the 24-hour clock.

## Local development

Requires Node.js 22.13+ and npm. Node 22's SQLite experimental warning is expected.

```sh
npm ci
npm run build
npm run demo:start
```

`demo:start` starts all five processes with separate local databases under `data/`; it does not import `data/rounding.db` automatically. Do not run the local stack on ports already occupied by Docker.

To develop or rebuild just one project after building the shared packages:

```sh
npm run build:shared
npm run build -w @rounding/charge-service
npm run dev -w @rounding/charge-service
```

For manual starts, explicitly set `DEMO_MODE=true` (PowerShell: `$env:DEMO_MODE='true'`). Defaults for downstream URLs use the localhost service ports in the table. Each project can run independently; unavailable dependencies yield retryable failures rather than requiring all services to start together.

Rebuild/deploy only a selected Docker project:

```sh
docker compose up -d --build --no-deps charge-service
```

## Exercise and verify

Against either Docker or the local stack:

```sh
npm ci
npm run build:shared
npm run demo
```

The repeatable demo exercises duplicate broker events, offline draft conflicts, duplicate mobile submissions, a billing outage, partial acceptance, correction of rejected items, a lost acknowledgment, tenant isolation, and audit access. `API_URL` and `MOCK_URL` override its default localhost addresses.

```sh
npm test
npm run typecheck
npm audit
```

Tests use separate database files and real HTTP between service instances. They also cover service outages, duplicate delivery after a lost inter-service response, external idempotency expiry, worker fencing, schema quarantine, migration restartability, and project boundaries.

## Authentication and API

| Token                  | Hospital | Role              |
| ---------------------- | -------- | ----------------- |
| `demo-provider-one`    | HOSP-001 | Provider PROV-789 |
| `demo-provider-two`    | HOSP-002 | Provider PROV-789 |
| `demo-integration-one` | HOSP-001 | Source broker     |
| `demo-integration-two` | HOSP-002 | Source broker     |
| `demo-admin-one`       | HOSP-001 | Administrator     |

External API routes remain the same. Hospital identity is derived from credentials at the gateway and independently revalidated by each domain service. Internal encounter/job APIs require distinct service credentials and are not exposed by the gateway. Mock controls use `demo-billing-secret`.

Audit logs now belong to their owning services: `GET /v1/admin/audit?service=patient|charge|billing`; each has an independent sequence cursor. Default is `charge`, which also retains imported monolith audit records. `/v1/admin/metrics` aggregates counts under `patient`, `charge`, and `billing`.

See [API examples](docs/API.md), [IDE HTTP requests](examples/requests.http), [architecture and ER diagrams](docs/ARCHITECTURE.md), [patient integration specification](docs/INTEGRATION.md), [operations](docs/OPERATIONS.md), and [migration](docs/MIGRATION.md).

## Reliability and limits

Saving a new draft or queuing a new submission resolves its encounter through Patient service first, outside the local transaction. The result is a point-in-time authorization/encounter snapshot. If Patient is unavailable, new edits/submissions return a retryable error; committed duplicate receipts and existing charge reads remain available.

Charge service commits charge locks and an immutable outbox request atomically. Its dispatcher delivers that request to Billing with a permanent internal submission ID. Billing persists before acknowledging and can continue processing while Charge is down. Charge later polls the durable job state and atomically projects item results into its own database. Lost responses at either boundary are safe to replay.

External billing has only a **24-hour idempotency window**. Billing service retains the original key and first-attempt timestamp, queries before retrying, and stops blind POSTs after **23 hours**. Unresolved charges remain locked in `REVIEW`; neither inter-service delivery nor manual retry resets the clock. Accepted charges are never included in a corrected batch. Indefinite exactly-once progress still requires stronger guarantees from the external billing system.

Microservice boundaries do not make SQLite horizontally scalable: each service is a single-host deployment with a private durable database. PostgreSQL per service is the next step for replicas across hosts. HTTP outbox polling is deliberate; no Kafka/RabbitMQ installation is needed for this take-home. Demo authentication, transport, encryption/retention and observability require production hardening before real PHI use.
