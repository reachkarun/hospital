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

## Deploy all services with Docker

The commands below are instructions for you to run. They are not run automatically. Use a terminal in this repository's root directory. Install Docker Desktop with Linux containers and Docker Compose, and start Docker Desktop first.

### 1. Configure the environment

In PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env` before continuing:

- Set `DB_NAME=rounding_app` to match the supplied schema script.
- Set `DB_USER=rounding_app` and choose `DB_PASSWORD`.
- Choose a separate `MYSQL_ROOT_PASSWORD` for database administration.
- Keep `DEMO_MODE=true` to run all five applications, including the billing simulator, with demo credentials. This does not create application data.
- Set the service tokens and billing token as needed. Keep `.env` private and out of version control.

Docker Compose supplies `DB_HOST=mysql` and internal service URLs automatically. The `.env` host and URL examples are for running Node applications directly on your computer.

### 2. Start MySQL and apply the standalone schema

```powershell
docker compose up -d --wait mysql
docker compose cp database/schema.sql mysql:/tmp/rounding-schema.sql
docker compose exec mysql mysql -uroot -p
```

Enter `MYSQL_ROOT_PASSWORD` when prompted. Run the following **inside the MySQL prompt**, replacing the application password with the exact value of `DB_PASSWORD` in `.env`:

```sql
SOURCE /tmp/rounding-schema.sql;

CREATE USER 'rounding_app'@'%' IDENTIFIED BY 'your-application-password';
GRANT SELECT, INSERT, UPDATE, DELETE ON rounding_app.* TO 'rounding_app'@'%';

INSERT INTO rounding_app.hospitals (id, name, billing_url)
VALUES
  ('HOSP-001', 'Hospital One', 'http://billing-mock:4001/api/v1'),
  ('HOSP-002', 'Hospital Two', 'http://billing-mock:4001/api/v1');

EXIT;
```

These are first-time setup statements. If the application account or hospital records already exist, inspect and update those records rather than repeating the inserts. Use your actual hospital configuration when connecting to a real billing system. The two IDs above match the demo credentials and API demonstration.

Schema creation and hospital registration are manual. Restarting or rebuilding a service does not run them.

### 3. Build and start all applications

```powershell
docker compose up -d --build --wait
docker compose ps
```

This starts MySQL, gateway, patient-service, charge-service, billing-service, and billing-mock. Wait for their health checks to pass.

- Swagger UI: http://127.0.0.1:3002/docs/
- Gateway health: http://127.0.0.1:3002/health
- Billing simulator health: http://127.0.0.1:4001/health

Patient, Charge, and Billing use internal Docker network ports; their APIs are accessed through the gateway. After provisioning, publish patient events through the integration API before expecting patient records to appear.

### 4. Check logs or stop the deployment

```powershell
docker compose logs --tail=100 gateway patient-service charge-service billing-service billing-mock
docker compose logs -f --tail=100 patient-service
```

Press Ctrl+C to stop following logs; this does not stop the service.

```powershell
docker compose stop
docker compose start
```

To remove the service containers while preserving the database volume:

```powershell
docker compose down
```

Do not add `-v` unless you intend to delete the MySQL data volume. An existing MySQL volume retains its original root password; changing `MYSQL_ROOT_PASSWORD` in `.env` does not change that password in MySQL.

## Update the deployment after code changes

### Update one application

Save your changes, then rebuild and recreate only the changed application. For example:

```powershell
docker compose up -d --build --no-deps --wait patient-service
docker compose ps patient-service
docker compose logs --tail=100 patient-service
```

Replace `patient-service` with `charge-service`, `billing-service`, `gateway`, or `billing-mock` as appropriate. `--no-deps` leaves MySQL and other services running. A simple `docker compose restart` does **not** rebuild changed source code into the image.

### Update several applications or shared packages

Changes to `packages/contracts` or `packages/platform` can affect every application. Rebuild all five application images:

```powershell
docker compose up -d --build --no-deps --wait gateway patient-service charge-service billing-service billing-mock
docker compose ps
docker compose logs --tail=100 gateway patient-service charge-service billing-service billing-mock
```

Keep cross-service API changes backward compatible during the update. This Compose deployment has one container per application, so recreation can cause a brief interruption; it is not a zero-downtime rollout.

### Update environment variables

Edit `.env`, then recreate the affected containers so they receive the new values:

```powershell
docker compose up -d --force-recreate --no-deps --wait gateway patient-service charge-service billing-service billing-mock
```

If database credentials change, update the MySQL account as well. Editing `.env` alone does not create or modify database accounts. Coordinate service-token changes between the callers and the receiving service.

### Update the database structure

Application rebuilds never apply database changes. For a schema update:

1. Back up the MySQL database and retain the previous application version.
2. Prepare and review a separate SQL change script, for example `database/changes/001_add_column.sql` (an example filename, not a file supplied by this repository).
3. For changes incompatible with running applications, stop database-using applications before applying the SQL:

   ```powershell
   docker compose stop gateway patient-service charge-service billing-service billing-mock
   ```

4. Copy your change script and open an administrative MySQL session:

   ```powershell
   docker compose cp database/changes/001_add_column.sql mysql:/tmp/001_add_column.sql
   docker compose exec mysql mysql -uroot -p rounding_app
   ```

   Inside MySQL:

   ```sql
   SOURCE /tmp/001_add_column.sql;
   EXIT;
   ```

5. Rebuild/start the affected applications and verify their health and API behavior.

`schema.sql` creates missing objects; rerunning it does not change existing column definitions. MySQL DDL can commit implicitly, so do not rely on a transaction rollback to undo a schema change.

### Verify and recover from an update

Before deployment, run the checks yourself in a development environment:

```powershell
npm ci
npm run typecheck
npm test
```

Set `MYSQL_TEST_URL` to a disposable database ending in `_test` for the database tests. Never point it at the application database.

After deployment, check `docker compose ps`, review logs, open Swagger, and verify a read and write with appropriate test data. Retain the previous source revision or image before updating. If a code-only update fails, restore that version and rebuild/recreate the affected service using the same update command. Only roll back code if it is compatible with the current database schema; otherwise use the reviewed database recovery plan and backup.

## Run locally without application containers

With Node.js 22.13+ and a provisioned MySQL database:

```sh
npm ci
npm run demo:start
```

`demo:start` builds and launches all five applications. Set `DEMO_MODE=true` for demo credentials and the billing simulator; this flag does not populate the database. Applications load `.env` from the repository root. Individual services can also run with `npm run dev -w @rounding/patient-service` or their equivalent workspace name.

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
