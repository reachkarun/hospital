import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const timestamp = () => new Date().toISOString();
export type Json = Record<string, any>;

export class Database {
  readonly db: DatabaseSync;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(COMMON_SCHEMA);
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

const COMMON_SCHEMA = "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS hospitals(id TEXT PRIMARY KEY,name TEXT NOT NULL,billing_url TEXT NOT NULL);\n      CREATE TABLE IF NOT EXISTS audit(\n        sequence INTEGER PRIMARY KEY AUTOINCREMENT,hospital TEXT NOT NULL,actor TEXT NOT NULL,\n        action TEXT NOT NULL,resource TEXT NOT NULL,at TEXT NOT NULL);\n      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit\n        BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;\n      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit\n        BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;\n      PRAGMA user_version=1;";
