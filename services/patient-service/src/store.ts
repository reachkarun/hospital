import { Database, type Json } from '@rounding/platform/db';
export { timestamp, type Json } from '@rounding/platform/db';
export class Store extends Database {
 constructor(path = ':memory:') { super(path); this.db.exec(`
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
      
`); }
  entity(hospital: string, kind: string, id: string): Json | undefined {
    const row = this.get(
      "SELECT body FROM entities WHERE hospital=? AND kind=? AND id=?",
      hospital,
      kind,
      id,
    );
    return row ? JSON.parse(row.body) : undefined;
  }
}
