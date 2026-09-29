import { test, testDatabaseConfig, seed, seedHospitals } from "./database.js";
import assert from "node:assert/strict";
import { syncBatch, type Principal } from "@rounding/contracts";
import { Store as PatientStore } from "../services/patient-service/src/store.js";
import { PatientService } from "../services/patient-service/src/patient/patient.service.js";
import { Store as ChargeStore } from "../services/charge-service/src/store.js";
import { ChargeService } from "../services/charge-service/src/charge/charge.service.js";
const provider: Principal = {
  hospital: "HOSP-001",
  provider: "PROV-789",
  role: "provider",
};
test("patient service scopes queries and encounter access without an HTTP server", async (t) => {
  const store = new PatientStore(testDatabaseConfig());
  t.after(async () => await store.close());
  await seed(store, "http://billing");
  const service = new PatientService(store);
  const query = { after: "", limit: 50 };
  const first = await service.list(provider, query);
  const second = await service.list(
    { ...provider, hospital: "HOSP-002" },
    query,
  );
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].mrn, second.items[0].mrn);
  assert.deepEqual(
    (await service.list({ ...provider, provider: "unassigned" }, query)).items,
    [],
  );
  await assert.rejects(
    async () =>
      await service.visit({ ...provider, provider: "unassigned" }, "VISIT-001"),
    /VISIT_NOT_FOUND/,
  );
  assert.equal(
    (
      await service.resolveEncounter({
        hospitalId: provider.hospital,
        providerId: provider.provider,
        visitId: "VISIT-001",
      })
    ).patientMrn,
    first.items[0].mrn,
  );
});
test("charge service preserves sync order, partial failures, and durable replay", async (t) => {
  const patients = new PatientStore(testDatabaseConfig());
  const charges = new ChargeStore(testDatabaseConfig());
  t.after(async () => {
    await charges.close();
    await patients.close();
  });
  await seed(patients, "http://billing");
  await seedHospitals(charges, "http://billing");
  const patientService = new PatientService(patients);
  let resolving = true;
  const service = new ChargeService(charges, async (p, visitId) => {
    assert.ok(resolving, "a replay must use its committed receipt");
    return await patientService.resolveEncounter({
      hospitalId: p.hospital,
      providerId: p.provider,
      visitId,
    });
  });
  const batch = syncBatch.parse({
    operations: [0, 0, 1].map((version, index) => ({
      operationId: `operation-${index}`,
      chargeId: "same-charge",
      expectedVersion: version,
      charge: {
        visitId: "VISIT-001",
        serviceCode: "99213",
        quantity: index + 1,
        dateOfService: "2026-01-15",
      },
    })),
  });
  const outcome = await service.sync(provider, batch);
  assert.deepEqual(
    outcome.results.map((result) => result.status),
    [200, 409, 200],
  );
  assert.equal(outcome.results[1]?.error?.code, "VERSION_CONFLICT");
  assert.equal((await service.get(provider, "same-charge")).version, 2);
  assert.equal((await service.get(provider, "same-charge")).quantity, 3);
  resolving = false;
  const replay = await service.sync(provider, {
    operations: [batch.operations[0]!, batch.operations[2]!],
  });
  assert.deepEqual(replay.results, [outcome.results[0], outcome.results[2]]);
  await assert.rejects(
    async () =>
      await service.get({ ...provider, hospital: "HOSP-002" }, "same-charge"),
    /CHARGE_NOT_FOUND/,
  );
});
