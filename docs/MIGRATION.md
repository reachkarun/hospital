# Migrating the installed monolith

The migration is offline and non-destructive. The original `take_home_assignment_rounding-data` volume remains available, and the existing billing mock's receipt volume is reused. Never run old and new writers concurrently during migration.

From the repository root:

```sh
npm ci
npm test
docker compose build
docker compose -f compose.migration.yaml build
docker compose -f compose.monolith.yaml stop api worker
docker compose -f compose.migration.yaml run --rm migrate
docker compose up -d --wait
```

The migration container mounts the old database **read-only** and writes new Patient, Charge, and Billing volumes. It first copies the stopped database and any WAL into a temporary directory so SQLite can reconstruct its sidecar index without writing to the original volume. It copies source entities/inbox/clocks, charges/revisions, mobile operation and submission receipts, immutable billing requests and acknowledgments. Historical audit records are retained in Charge service; new audit events belong to their service.

For Billing jobs, the migration retains the existing submission ID, payload's `clientSubmissionId`, first-attempt timestamp, attempt count and acknowledgment. It translates the old mobile receipt digest into the billing payload digest for the new internal API. Old SENDING jobs become RETRY with no live lease so Billing reconciles before sending. No new external billing key is created. Charge's receipt still preserves the original mobile key.

Each destination commits its import plus a migration receipt atomically. Rerunning skips completed destinations, allowing recovery if import stopped between databases. A nonempty destination without a migration receipt is rejected rather than overwritten. Keep new services stopped until all three imports succeed. This is a one-time import, not a live synchronization tool.

After verification, stopped old containers can be removed with `docker compose -f compose.monolith.yaml rm api worker`; do not remove the old volume. The archived Compose file references the already-built monolith images and is for inspection/pre-cutover recovery only. Once the new stack accepts writes, switching back to the old database is unsafe without a planned reverse migration and billing reconciliation.

For local files, stop local old writers and set:

```powershell
$env:LEGACY_DATABASE_PATH='data/rounding.db'
$env:PATIENT_DATABASE_PATH='data/patients.db'
$env:CHARGE_DATABASE_PATH='data/charges.db'
$env:BILLING_DATABASE_PATH='data/billing.db'
node dist/scripts/migrate-monolith.js
```

`npm run build` compiles that script. Fresh installations need no migration; `docker compose up --build -d --wait` initializes synthetic seed data in the independent stores.
