# Rounding App — NestJS and MySQL

Five NestJS applications share **one MySQL 8.4+ database**. Each application uses modules, controllers, and injectable services. The gateway routes authenticated requests; the domain services manage their own tables within the shared database.

| Application                           | Responsibility                                            | Port |
| ------------------------------------- | --------------------------------------------------------- | ---- |
| [Gateway](services/gateway)           | Public routing, authentication, Swagger                   | 3002 |
| [Patient](services/patient-service)   | Patient events, visits, assignments, clinical projections | 3101 |
| [Charge](services/charge-service)     | Drafts, offline synchronization, submissions, outbox      | 3102 |
| [Billing](services/billing-service)   | External delivery, retries, reconciliation                | 3103 |
| [Billing mock](services/billing-mock) | Optional simulated hospital billing                       | 4001 |

## Database setup — required once

The standalone script is [database/schema.sql](database/schema.sql). **Applications do not create tables, alter schemas, migrate local files, or seed data during startup.**

1. Copy `.env.example` to `.env` and configure `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`.
2. Start your existing MySQL server, or run `docker compose up -d mysql`.
3. Run `database/schema.sql` manually and create the application database account.
4. Insert your hospital configuration into `hospitals` explicitly.

Follow [database/README.md](database/README.md) for the exact commands, account permissions, local versus Docker billing URLs, and test database setup. The schema contains no sample patients or hospital seeds. Patient data enters through the integration API; charge data enters through the charge API.

## Run

With Node.js 22.13+ and a provisioned MySQL database:

```sh
npm ci
npm run demo:start
```

`demo:start` builds and launches all five applications. Set `DEMO_MODE=true` for demo credentials and the billing simulator; this flag does not populate the database. Applications load `.env` from the repository root. Individual services can also run with `npm run dev -w @rounding/patient-service` or their equivalent workspace name.

For Docker, provision the MySQL schema and account first, then:

```sh
docker compose up -d --build
docker compose ps
```

Swagger: **http://127.0.0.1:3002/docs/**. OpenAPI JSON: `/docs/json`.

Docker stores MySQL data in one `mysql-data` volume. Domain services have no database-file volumes. `docker compose down` preserves the database. The root MySQL credential is used only for database administration; applications use `DB_USER`/`DB_PASSWORD`.

## Authentication and data access

| Demo token             | Hospital | Role              |
| ---------------------- | -------- | ----------------- |
| `demo-provider-one`    | HOSP-001 | Provider PROV-789 |
| `demo-provider-two`    | HOSP-002 | Provider PROV-789 |
| `demo-integration-one` | HOSP-001 | Integration       |
| `demo-integration-two` | HOSP-002 | Integration       |
| `demo-admin-one`       | HOSP-001 | Administrator     |

Register the hospital IDs you use before calling domain endpoints. For non-demo deployments configure `AUTH_TOKENS`, `PATIENT_SERVICE_TOKEN`, `BILLING_SERVICE_TOKEN`, and `BILLING_TOKEN` explicitly.

- Push patient events: `POST /v1/integrations/patient-events` with an integration token.
- Read assigned patients: `GET /v1/patients` with a provider token.
- Save charges: `POST /v1/charges`; synchronize offline edits: `POST /v1/sync`.
- Queue billing: `POST /v1/submissions`; read status: `GET /v1/submissions/:id`.
- Read audit records: `GET /v1/admin/audit?service=patient|charge|billing` with an admin token. Records share an increasing database sequence and are filtered by service and hospital.

See [API examples](docs/API.md) and [IDE requests](examples/requests.http). `npm run demo` explicitly publishes synthetic events and exercises the APIs; it requires HOSP-001 and HOSP-002 to have been registered manually.

## Verification

```sh
npm run typecheck
npm test
```

Set `MYSQL_TEST_URL` to a dedicated database ending in `_test` to run the MySQL tests. These fixtures create/reset only that test database and run serially. Without this setting, database tests are explicitly skipped. Coverage includes HTTP contracts, pooled transaction rollback, concurrent idempotent writes, tenant isolation, revisions, retries, lease fencing, and graceful shutdown.

The services use asynchronous `mysql2` connection pools and InnoDB transactions. Hospital row locks serialize related writes; competing workers claim jobs with `FOR UPDATE SKIP LOCKED`. Charge and billing records use different table names in the same database, avoiding accidental state collisions. External network calls remain outside database transactions.

See [architecture](docs/ARCHITECTURE.md), [operations](docs/OPERATIONS.md), and [patient integration](docs/INTEGRATION.md). Existing local database files are left untouched and are not used by this version.
