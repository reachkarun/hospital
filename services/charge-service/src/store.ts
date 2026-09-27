import { Database } from '@rounding/platform/db';
export { timestamp, type Json } from '@rounding/platform/db';
export class Store extends Database {
 constructor(path = ':memory:') { super(path); this.db.exec(`
CREATE TABLE IF NOT EXISTS charges(
        hospital TEXT NOT NULL REFERENCES hospitals(id),id TEXT NOT NULL,provider TEXT NOT NULL,
        visit TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,
        error TEXT,submission TEXT,PRIMARY KEY(hospital,id));
      CREATE INDEX IF NOT EXISTS charges_owner ON charges(hospital,provider,id);
      CREATE TABLE IF NOT EXISTS charge_revisions(
        hospital TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,
        status TEXT NOT NULL,error TEXT,submission TEXT,at TEXT NOT NULL,PRIMARY KEY(hospital,id,version));
      CREATE TRIGGER IF NOT EXISTS charge_insert_revision AFTER INSERT ON charges
        BEGIN INSERT INTO charge_revisions VALUES(new.hospital,new.id,new.version,new.body,new.status,new.error,new.submission,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
      CREATE TRIGGER IF NOT EXISTS charge_update_revision AFTER UPDATE ON charges
        BEGIN INSERT INTO charge_revisions VALUES(new.hospital,new.id,new.version,new.body,new.status,new.error,new.submission,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
      CREATE TRIGGER IF NOT EXISTS revision_no_update BEFORE UPDATE ON charge_revisions
        BEGIN SELECT RAISE(ABORT,'revisions are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS revision_no_delete BEFORE DELETE ON charge_revisions
        BEGIN SELECT RAISE(ABORT,'revisions are append-only'); END;
      CREATE TABLE IF NOT EXISTS operations(
        hospital TEXT NOT NULL,provider TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,
        response TEXT NOT NULL,PRIMARY KEY(hospital,provider,id));
      CREATE TABLE IF NOT EXISTS submissions(
        hospital TEXT NOT NULL REFERENCES hospitals(id),id TEXT NOT NULL,provider TEXT NOT NULL,
        client_key TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0,lease_token TEXT,first_attempt INTEGER,
        response TEXT,error TEXT,PRIMARY KEY(hospital,id),UNIQUE(hospital,provider,client_key));
      CREATE INDEX IF NOT EXISTS submissions_due ON submissions(status,next_at,lease_until);
      
`);
 const columns = this.all('PRAGMA table_info(submissions)').map(c => c.name);
 for (const [name, definition] of Object.entries({dispatch_at:'INTEGER NOT NULL DEFAULT 0',dispatch_lease:'INTEGER NOT NULL DEFAULT 0',dispatch_token:'TEXT',retry_request:'TEXT'})) { if (!columns.includes(name)) this.db.exec('ALTER TABLE submissions ADD COLUMN '+name+' '+definition); }
 }
}
