import { before, beforeEach, test as nodeTest } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createConnection } from "mysql2/promise";
import type { DatabaseConfig } from "@rounding/platform/config";
import type { Database } from "@rounding/platform/db";
import { Store as PatientStore } from "../services/patient-service/src/store.js";
import { consume } from "../services/patient-service/src/patient/patient-events.js";
import { sampleEvent } from "@rounding/contracts/sample";

// Database tests are explicit and may only reset a dedicated database ending in _test.
export const test = process.env.MYSQL_TEST_URL ? nodeTest : nodeTest.skip;
export function testDatabaseConfig(): DatabaseConfig {
  const url = new URL(process.env.MYSQL_TEST_URL!);
  const database = url.pathname.slice(1);
  if (url.protocol !== "mysql:" || !/^[a-zA-Z0-9_]+_test$/.test(database))
    throw new Error(
      "MYSQL_TEST_URL must select a dedicated MySQL database ending in _test",
    );
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    connectionLimit: 5,
  };
}

before(async () => {
  if (!process.env.MYSQL_TEST_URL) return;
  const cfg = testDatabaseConfig();
  const connection = await createConnection({
    ...cfg,
    database: undefined,
    multipleStatements: true,
    connectTimeout: 30_000,
  });
  try {
    const schema = readFileSync(
      resolve("database/schema.sql"),
      "utf8",
    ).replaceAll("rounding_app", cfg.database);
    await connection.query(schema);
  } finally {
    await connection.end();
  }
});

beforeEach(async () => {
  if (!process.env.MYSQL_TEST_URL) return;
  const connection = await createConnection({
    ...testDatabaseConfig(),
    connectTimeout: 30_000,
  });
  try {
    await connection.query("SET FOREIGN_KEY_CHECKS=0");
    for (const table of [
      "audit",
      "patient_entities",
      "patient_field_clocks",
      "patient_inbox",
      "charges",
      "charge_revisions",
      "charge_operations",
      "charge_submissions",
      "billing_submissions",
      "billing_retry_receipts",
      "mock_results",
      "mock_modes",
      "hospitals",
    ])
      await connection.query(`TRUNCATE TABLE ${table}`);
    await connection.query("DROP TRIGGER IF EXISTS fail_audit");
    await connection.query("SET FOREIGN_KEY_CHECKS=1");
  } finally {
    await connection.end();
  }
});

export async function seedHospitals(store: Database, billingUrl: string) {
  for (const [id, name] of [
    ["HOSP-001", "Test Hospital One"],
    ["HOSP-002", "Test Hospital Two"],
  ])
    await store.run(
      "INSERT INTO hospitals VALUES (?,?,?) AS incoming ON DUPLICATE KEY UPDATE billing_url=incoming.billing_url",
      id!,
      name!,
      billingUrl,
    );
}
export async function seed(store: PatientStore, billingUrl: string) {
  await seedHospitals(store, billingUrl);
  for (const hospital of ["HOSP-001", "HOSP-002"])
    await consume(store, hospital, sampleEvent(hospital));
}
