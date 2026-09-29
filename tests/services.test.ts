import { test } from "node:test";
import assert from "node:assert/strict";
import { syncBatch, type Principal } from "@rounding/contracts";
import { seedHospitals } from "@rounding/platform/runtime";
import { Store as PatientStore } from "../services/patient-service/src/store.js";
import { seed } from "../services/patient-service/src/seed.js";
import { PatientService } from "../services/patient-service/src/patient/patient.service.js";
import { Store as ChargeStore } from "../services/charge-service/src/store.js";
import { ChargeService } from "../services/charge-service/src/charge/charge.service.js";

const provider: Principal = {
  hospital: "HOSP-001",
  provider: "PROV-789",
  role: "provider",
};

test("patient service scopes queries and encounter access without an HTTP server", (t) => {
  const store = new PatientStore();
  t.after(() => store.close());
  seed(store, "http://billing");
  const service = new PatientService(store);
  const query = { after: "", limit: 50 };
  const first = service.list(provider, query);
  const second = service.list({ ...provider, hospital: "HOSP-002" }, query);
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].mrn, second.items[0].mrn);
  assert.deepEqual(
    service.list({ ...provider, provider: "unassigned" }, query).items,
    [],
  );
  assert.throws(
    () => service.visit({ ...provider, provider: "unassigned" }, "VISIT-001"),
    /VISIT_NOT_FOUND/,
  );
  assert.equal(
    service.resolveEncounter({
      hospitalId: provider.hospital,
      providerId: provider.provider,
      visitId: "VISIT-001",
    }).patientMrn,
    first.items[0].mrn,
  );
});

test("charge service preserves sync order, partial failures, and durable replay", async (t) => {
  const patients = new PatientStore();
  const charges = new ChargeStore();
  t.after(() => {
    charges.close();
    patients.close();
  });
  seed(patients, "http://billing");
  seedHospitals(charges, "http://billing");
  const patientService = new PatientService(patients);
  let resolving = true;
  const service = new ChargeService(charges, async (p, visitId) => {
    assert.ok(resolving, "a replay must use its committed receipt");
    return patientService.resolveEncounter({
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
  assert.equal(service.get(provider, "same-charge").version, 2);
  assert.equal(service.get(provider, "same-charge").quantity, 3);
  resolving = false;
  const replay = await service.sync(provider, {
    operations: [batch.operations[0]!, batch.operations[2]!],
  });
  assert.deepEqual(replay.results, [outcome.results[0], outcome.results[2]]);
  assert.throws(
    () => service.get({ ...provider, hospital: "HOSP-002" }, "same-charge"),
    /CHARGE_NOT_FOUND/,
  );
});
