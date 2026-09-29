# MySQL database setup

All applications connect to one MySQL 8.4+ database, `rounding_app`. The gateway remains stateless. `schema.sql` is the authoritative, standalone database script. Application startup performs no DDL, migrations, hospital insertion, or patient seeding. `DEMO_MODE` controls authentication and the optional billing simulator only.

1. Copy `.env.example` to `.env` and choose application and local MySQL root passwords. Point `DB_HOST`, `DB_PORT`, and the other `DB_*` settings at your server.
2. If using the supplied local database container, run `docker compose up -d mysql`.
3. Connect with MySQL Workbench or the `mysql` client as an administrator and execute `database/schema.sql`. For the local container:

   ```sh
   docker compose cp database/schema.sql mysql:/tmp/rounding-schema.sql
   docker compose exec mysql mysql -uroot -p
   ```

   At the MySQL prompt:

   ```sql
   SOURCE /tmp/rounding-schema.sql;
   CREATE USER 'rounding_app'@'%' IDENTIFIED BY 'replace-with-your-application-password';
   GRANT SELECT, INSERT, UPDATE, DELETE ON rounding_app.* TO 'rounding_app'@'%';
   ```

   Use the same application password in `.env`. Account creation is a one-time administrative step. For an existing MySQL server, restrict the account host to your application network rather than `%`. The runtime account needs no CREATE, ALTER, DROP, or TRIGGER permission.

4. Register your actual hospitals explicitly. The bearer token's hospital ID must exist before using domain APIs:

   ```sql
   INSERT INTO rounding_app.hospitals (id, name, billing_url)
   VALUES ('HOSP-001', 'Your Hospital', 'http://billing-mock:4001/api/v1');
   ```

   Use the actual external billing API URL in production. For locally running Node applications, use `http://127.0.0.1:4001/api/v1`. Register any additional hospital IDs used by your credentials. This is configuration data, not a startup seed.

5. Start the applications with `docker compose up -d --build`, or run `npm run demo:start` for local Node processes. Existing APIs read and write MySQL using a connection pool. Ingest patient data through `POST /v1/integrations/patient-events`; save and submit charges through the charge APIs. The database starts empty apart from hospital configuration you entered explicitly.

## Tables and transactions

- Shared: `hospitals`, `audit` (audit records include a `service` discriminator).
- Patient: `patient_entities`, `patient_field_clocks`, `patient_inbox`.
- Charge: `charges`, `charge_revisions`, `charge_operations`, `charge_submissions`.
- Billing: `billing_submissions`, `billing_retry_receipts`.
- Optional external simulator: `mock_modes`, `mock_results`.

Charge and billing submission state have different tables in the same database. InnoDB transactions use one pooled connection per asynchronous transaction. Hospital row locks serialize related idempotent writes, and worker claims use `FOR UPDATE SKIP LOCKED`. Revision triggers record charge changes; audit/revision triggers reject updates and deletes. Existing tenant checks, idempotency keys, and lease fencing remain in application services.

`DB_POOL_SIZE` is per process: four database-using processes can use up to four times that number of connections. Use a trusted private network for MySQL and configure server-side encrypted transport when connecting remotely.

The schema script creates missing objects without dropping business data. Future schema changes should be reviewed and applied explicitly; running the script again does not alter existing columns. Legacy local database files are not read or migrated automatically, and are left untouched.

## Tests

Set `MYSQL_TEST_URL` to a disposable database whose name ends in `_test`, then run `npm test`. For example in PowerShell:

```powershell
$env:MYSQL_TEST_URL = 'mysql://root:your-password@127.0.0.1:3306/rounding_app_test'
npm test
```

The test account must be able to create this database, tables, and triggers. Test fixtures apply the same schema and truncate only this explicitly selected test database. Tests run serially to avoid interfering with each other's data. Without `MYSQL_TEST_URL`, database integration tests are reported as skipped; HTTP-only and architecture checks still run. Test-only sample data is never loaded by an application process.
