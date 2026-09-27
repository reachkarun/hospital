import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store as PatientStore } from '../services/patient-service/src/store.js';
import { Store as ChargeStore } from '../services/charge-service/src/store.js';
import { Store as BillingStore } from '../services/billing-service/src/store.js';
import type { Database, Json } from '@rounding/platform/db';
import { digest } from '@rounding/contracts';

/** Offline, non-destructive import. Stop the old API/worker before invoking. */
export function migrate(sourcePath: string, paths: { patient: string; charge: string; billing: string }) {
  // A WAL-mode database on a read-only Docker mount may need writable sidecars.
  // With old writers stopped, copy the database and any WAL to a private temporary
  // directory. SQLite can reconstruct its own shared-memory index there while the
  // original database volume stays read-only and untouched.
  const snapshotDir = mkdtempSync(join(tmpdir(), 'rounding-import-'));
  const snapshot = join(snapshotDir, 'legacy.db');
  copyFileSync(sourcePath, snapshot);
  if (existsSync(`${sourcePath}-wal`)) copyFileSync(`${sourcePath}-wal`, `${snapshot}-wal`);
  const source = new DatabaseSync(snapshot, { readOnly: true });
  const patient = new PatientStore(paths.patient); const charge = new ChargeStore(paths.charge); const billing = new BillingStore(paths.billing);
  const copy = (target: Database, table: string, transform: (row: Json) => Json = row => row) => {
    const rows = source.prepare(`SELECT * FROM ${table}`).all() as Json[];
    for (const input of rows) {
      const row = transform({ ...input });
      const allowed = new Set(target.all(`PRAGMA table_info(${table})`).map(c => c.name));
      const columns = Object.keys(row).filter(c => allowed.has(c));
      target.run(`INSERT OR IGNORE INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...columns.map(c => row[c]));
    }
  };
  const run = (target: Database, tables: string[], emptyTable: string, billingMode = false) => {
    target.db.exec('CREATE TABLE IF NOT EXISTS migration_receipts(id TEXT PRIMARY KEY,at TEXT NOT NULL)');
    if (target.get('SELECT id FROM migration_receipts WHERE id=?', 'monolith-v1')) return;
    target.transaction(() => {
      if (target.get(`SELECT COUNT(*) AS n FROM ${emptyTable}`)!.n !== 0) throw new Error('Migration target is not empty; refusing to overwrite service data');
      copy(target, 'hospitals');
      for (const table of tables) copy(target, table, billingMode && table === 'submissions' ? row => {
        const payload = JSON.parse(row.payload);
        row.digest = digest(payload); row.client_key = payload.clientSubmissionId;
        if (row.status === 'SENDING') row.status = 'RETRY';
        row.lease_until = 0; row.lease_token = null;
        // Preserve submission ID, external client key, payload, first_attempt and attempts.
        return row;
      } : undefined);
      target.run("INSERT INTO migration_receipts VALUES ('monolith-v1',?)", new Date().toISOString());
    });
  };
  try {
    source.exec('BEGIN');
    run(patient, ['entities', 'field_clocks', 'inbox'], 'entities');
    run(billing, ['submissions'], 'submissions', true);
    run(charge, ['submissions', 'charges', 'charge_revisions', 'operations', 'audit'], 'charges');
    const counts = { patients: patient.get('SELECT COUNT(*) AS n FROM entities')!.n, charges: charge.get('SELECT COUNT(*) AS n FROM charges')!.n, billingJobs: billing.get('SELECT COUNT(*) AS n FROM submissions')!.n };
    source.exec('COMMIT'); return counts;
  } finally { source.close(); patient.close(); charge.close(); billing.close(); rmSync(snapshotDir, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = process.env.LEGACY_DATABASE_PATH;
  if (!source) throw new Error('LEGACY_DATABASE_PATH is required; stop old writers first');
  console.log(JSON.stringify(migrate(source, {
    patient: process.env.PATIENT_DATABASE_PATH ?? 'data/patients.db', charge: process.env.CHARGE_DATABASE_PATH ?? 'data/charges.db', billing: process.env.BILLING_DATABASE_PATH ?? 'data/billing.db',
  })));
}
