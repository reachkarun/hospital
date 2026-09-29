import { AsyncLocalStorage } from "node:async_hooks";
import {
  createPool,
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { check } from "@rounding/contracts";
import { databaseConfig, type DatabaseConfig } from "./config.js";

export const timestamp = () => new Date().toISOString();
export type Json = Record<string, any>;
type SqlValue = string | number | null;

/** MySQL access only. Database structure is provisioned explicitly with database/schema.sql. */
export class Database {
  private readonly pool: Pool;
  private readonly transactions = new AsyncLocalStorage<PoolConnection>();
  private closing?: Promise<void>;

  constructor(
    options: DatabaseConfig = databaseConfig(),
    readonly service = "platform",
  ) {
    this.pool = createPool({
      ...options,
      waitForConnections: true,
      queueLimit: 100,
      timezone: "Z",
      charset: "utf8mb4_bin",
      jsonStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      multipleStatements: false,
      connectTimeout: 10_000,
    });
  }

  async connect() {
    try {
      await this.get("SELECT 1");
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.transactions.getStore())
      throw new Error("Nested transactions must use explicit savepoints");
    for (let attempt = 0; ; attempt++) {
      const connection = await this.pool.getConnection();
      try {
        await connection.query(
          "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
        );
        await connection.beginTransaction();
        const result = await this.transactions.run(connection, fn);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        const code = (error as { code?: string }).code;
        if (
          attempt >= 2 ||
          !["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(code ?? "")
        )
          throw error;
      } finally {
        connection.release();
      }
    }
  }

  /** Serialize related writes, including missing-row/idempotency checks, across service instances. */
  async lockHospital(hospital: string) {
    if (!this.transactions.getStore())
      throw new Error("Hospital locks require a transaction");
    check(
      await this.get(
        "SELECT id FROM hospitals WHERE id=? FOR UPDATE",
        hospital,
      ),
      404,
      "HOSPITAL_NOT_FOUND",
    );
  }

  async get(sql: string, ...args: SqlValue[]): Promise<Json | undefined> {
    return (await this.all(sql, ...args))[0];
  }
  async all(sql: string, ...args: SqlValue[]): Promise<Json[]> {
    const connection = this.transactions.getStore() ?? this.pool;
    const [rows] = await connection.execute<RowDataPacket[]>(
      { sql, timeout: 15_000 },
      args,
    );
    return rows;
  }
  async run(sql: string, ...args: SqlValue[]) {
    const connection = this.transactions.getStore() ?? this.pool;
    const [result] = await connection.execute<ResultSetHeader>(
      { sql, timeout: 15_000 },
      args,
    );
    return result;
  }
  async exec(sql: string) {
    const connection = this.transactions.getStore() ?? this.pool;
    await connection.query(sql);
  }
  async audit(
    hospital: string,
    actor: string,
    action: string,
    resource: string,
  ) {
    await this.run(
      "INSERT INTO audit(service,hospital,actor,action,resource,at) VALUES (?,?,?,?,?,?)",
      this.service,
      hospital,
      actor,
      action,
      resource,
      timestamp(),
    );
  }
  close() {
    return (this.closing ??= this.pool.end());
  }
}
