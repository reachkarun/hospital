import assert from "node:assert/strict";
import { test, testDatabaseConfig, seed } from "./database.js";
import { Database } from "@rounding/platform/db";
import { saveCharge } from "@rounding/contracts";
import { Store as PatientStore } from "../services/patient-service/src/store.js";
import { Store as ChargeStore } from "../services/charge-service/src/store.js";
import { PatientService } from "../services/patient-service/src/patient/patient.service.js";
import { ChargeService } from "../services/charge-service/src/charge/charge.service.js";

test("MySQL pools isolate concurrent transactions and roll back only their own writes", async (t) => {
  const db = new Database(testDatabaseConfig(), "test");
  t.after(() => db.close());
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM hospitals"))!.n, 0);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const failing = db.transaction(async () => {
    await db.audit("hospital", "test", "ROLLBACK", "inside");
    entered();
    await gate;
    throw new Error("rollback-test");
  });
  const rejected = assert.rejects(failing, /rollback-test/);
  await started;
  try {
    await db.audit("hospital", "test", "COMMIT", "outside");
  } finally {
    release();
  }
  await rejected;
  assert.deepEqual(
    (await db.all("SELECT resource FROM audit")).map((row) => row.resource),
    ["outside"],
  );
});

test("MySQL persists data across pools and serializes duplicate saves and version conflicts", async (t) => {
  const patients = new PatientStore(testDatabaseConfig());
  const first = new ChargeStore(testDatabaseConfig());
  const second = new ChargeStore(testDatabaseConfig());
  t.after(async () => {
    await Promise.all([patients.close(), first.close(), second.close()]);
  });
  await seed(patients, "http://billing");
  const patientService = new PatientService(patients);
  const resolve = async (
    p: { hospital: string; provider: string },
    visitId: string,
  ) =>
    patientService.resolveEncounter({
      hospitalId: p.hospital,
      providerId: p.provider,
      visitId,
    });
  const a = new ChargeService(first, resolve);
  const b = new ChargeService(second, resolve);
  const principal = {
    hospital: "HOSP-001",
    provider: "PROV-789",
    role: "provider" as const,
  };
  const input = saveCharge.parse({
    operationId: "same-operation",
    chargeId: "same-charge",
    expectedVersion: 0,
    charge: {
      visitId: "VISIT-001",
      serviceCode: "99213",
      quantity: 1,
      dateOfService: "2026-01-15",
    },
  });
  const saved = await Promise.all([
    a.save(principal, input),
    b.save(principal, input),
  ]);
  assert.deepEqual(saved[0], saved[1]);
  assert.equal(
    (await first.get("SELECT COUNT(*) AS n FROM charge_operations"))!.n,
    1,
  );
  const edits = await Promise.allSettled([
    a.save(principal, { ...input, operationId: "edit-a", expectedVersion: 1 }),
    b.save(principal, { ...input, operationId: "edit-b", expectedVersion: 1 }),
  ]);
  assert.equal(
    edits.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const conflict = edits.find((result) => result.status === "rejected");
  assert.equal(
    conflict?.status === "rejected" && conflict.reason.code,
    "VERSION_CONFLICT",
  );
  await first.close();
  assert.equal((await b.get(principal, "same-charge")).version, 2);
  assert.equal(
    (await second.get("SELECT COUNT(*) AS n FROM charge_revisions"))!.n,
    2,
  );
});
