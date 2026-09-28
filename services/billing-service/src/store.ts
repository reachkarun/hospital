import { Database } from "@rounding/platform/db";
export { timestamp, type Json } from "@rounding/platform/db";
export class Store extends Database {
  constructor(path = ":memory:") {
    super(path);
    this.db.exec(`
CREATE TABLE IF NOT EXISTS submissions(
        hospital TEXT NOT NULL REFERENCES hospitals(id),id TEXT NOT NULL,provider TEXT NOT NULL,
        client_key TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0,lease_token TEXT,first_attempt INTEGER,
        response TEXT,error TEXT,PRIMARY KEY(hospital,id),UNIQUE(hospital,provider,client_key));
      CREATE INDEX IF NOT EXISTS submissions_due ON submissions(status,next_at,lease_until);
      CREATE TABLE IF NOT EXISTS retry_receipts(hospital TEXT,id TEXT,operation TEXT,PRIMARY KEY(hospital,id,operation));
`);
  }
}
