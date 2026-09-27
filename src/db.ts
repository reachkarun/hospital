import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const timestamp = () => new Date().toISOString();
export type Json = Record<string, any>;

export class Store {
  readonly db: DatabaseSync;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS hospitals(id TEXT PRIMARY KEY,name TEXT NOT NULL,billing_url TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities(
        hospital TEXT NOT NULL REFERENCES hospitals(id),kind TEXT NOT NULL,id TEXT NOT NULL,
        body TEXT NOT NULL,PRIMARY KEY(hospital,kind,id));
      CREATE TABLE IF NOT EXISTS field_clocks(
        hospital TEXT NOT NULL,kind TEXT NOT NULL,entity_id TEXT NOT NULL,field TEXT NOT NULL,
        stamp TEXT NOT NULL,PRIMARY KEY(hospital,kind,entity_id,field));
      CREATE TABLE IF NOT EXISTS inbox(
        hospital TEXT NOT NULL REFERENCES hospitals(id),id TEXT NOT NULL,digest TEXT NOT NULL,
        body TEXT NOT NULL,status TEXT NOT NULL,error TEXT,received_at TEXT NOT NULL,
        PRIMARY KEY(hospital,id));
      CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(hospital,status);
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
      CREATE TABLE IF NOT EXISTS audit(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,hospital TEXT NOT NULL,actor TEXT NOT NULL,
        action TEXT NOT NULL,resource TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
        BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
        BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
      PRAGMA user_version=1;`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(sql: string, ...args: (string | number | null)[]): Json | undefined {
    return this.db.prepare(sql).get(...args) as Json | undefined;
  }
  all(sql: string, ...args: (string | number | null)[]): Json[] {
    return this.db.prepare(sql).all(...args) as Json[];
  }
  run(sql: string, ...args: (string | number | null)[]) {
    return this.db.prepare(sql).run(...args);
  }
  entity(hospital: string, kind: string, id: string): Json | undefined {
    const row = this.get(
      "SELECT body FROM entities WHERE hospital=? AND kind=? AND id=?",
      hospital,
      kind,
      id,
    );
    return row ? JSON.parse(row.body) : undefined;
  }
  audit(hospital: string, actor: string, action: string, resource: string) {
    this.run(
      "INSERT INTO audit(hospital,actor,action,resource,at) VALUES (?,?,?,?,?)",
      hospital,
      actor,
      action,
      resource,
      timestamp(),
    );
  }
  close() {
    this.db.close();
  }
}
