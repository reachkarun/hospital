import { test, testDatabaseConfig, seed, seedHospitals } from "./database.js";
import assert from "node:assert/strict";
import { Store } from "../services/patient-service/src/store.js";
import { consume } from "../services/patient-service/src/patient/patient-events.js";
import { sampleEvent } from "@rounding/contracts/sample";
const hospital = "HOSP-001";
async function setup() {
  const s = new Store(testDatabaseConfig());
  await seed(s, "http://billing");
  return s;
}
test("patient duplicate receipts and changed-message detection are durable", async () => {
  const s = await setup();
  assert.equal((await consume(s, hospital, sampleEvent())).duplicate, true);
  await assert.rejects(
    async () =>
      await consume(s, hospital, { ...sampleEvent(), source: "changed" }),
    /MESSAGE_ID_REUSED/,
  );
  assert.deepEqual(
    (await s.entity(hospital, "patient", "PAT-456"))!.allergies,
    ["Penicillin"],
  );
  await s.close();
});
test("out-of-order independent fields converge and missing visit dependencies replay", async () => {
  const s = await setup();
  const base = sampleEvent();
  for (const [messageId, timestamp, changes] of [
    ["new", "2026-01-18T00:00:00Z", { phone: { new: "new" } }],
    [
      "old",
      "2026-01-17T00:00:00Z",
      { phone: { new: "old" }, allergies: { new: ["Late allergy"] } },
    ],
  ] as const)
    await consume(s, hospital, {
      ...base,
      messageId,
      timestamp,
      eventType: "PATIENT_UPDATE",
      payload: { patientId: "PAT-456", changes, updatedAt: timestamp },
    });
  assert.equal((await s.entity(hospital, "patient", "PAT-456"))!.phone, "new");
  assert.deepEqual(
    (await s.entity(hospital, "patient", "PAT-456"))!.allergies,
    ["Late allergy"],
  );
  const move = {
    ...base,
    messageId: "move",
    timestamp: "2026-01-17T00:00:00Z",
    eventType: "VISIT_LOCATION_CHANGE",
    payload: {
      patientId: "PAT-456",
      visitId: "LATE",
      newLocation: { room: "900", bed: "1", unit: "ICU" },
      changedAt: "2026-01-17T00:00:00Z",
    },
  };
  assert.equal((await consume(s, hospital, move)).status, "WAITING");
  await consume(s, hospital, {
    ...base,
    messageId: "admit",
    eventType: "VISIT_ADMISSION",
    payload: {
      patient: base.payload.patient,
      visit: { ...base.payload.visit, id: "LATE" },
    },
  });
  assert.equal((await s.entity(hospital, "visit", "LATE"))!.room, "900");
  await s.close();
});
test("unassignment tombstone survives late assignment and discharge is retained", async () => {
  const s = await setup();
  const base = sampleEvent();
  await consume(s, hospital, {
    ...base,
    messageId: "unassign",
    timestamp: "2026-01-17T00:00:00Z",
    eventType: "PATIENT_UNASSIGNMENT",
    payload: {
      assignmentId: "NEW",
      providerId: "PROV-789",
      patientId: "PAT-456",
      visitId: "VISIT-001",
      unassignedAt: "2026-01-17T00:00:00Z",
    },
  });
  await consume(s, hospital, {
    ...base,
    messageId: "late-assign",
    payload: { ...base.payload, assignmentId: "NEW" },
  });
  assert.equal((await s.entity(hospital, "assignment", "NEW"))!.active, false);
  await consume(s, hospital, {
    ...base,
    messageId: "discharge",
    timestamp: "2026-01-18T00:00:00Z",
    eventType: "VISIT_DISCHARGE",
    payload: {
      patientId: "PAT-456",
      visitId: "VISIT-001",
      dischargeDate: "2026-01-18T00:00:00Z",
      dischargeStatus: "HOME",
    },
  });
  assert.equal(
    (await s.entity(hospital, "visit", "VISIT-001"))!.status,
    "DISCHARGED",
  );
  await s.close();
});
test("invalid schemas and links quarantine without partial writes", async () => {
  const s = await setup();
  const base = sampleEvent();
  for (const event of [
    { ...base, messageId: "version", version: "2.0" },
    { ...base, messageId: "unknown", eventType: "NEW_EVENT" },
    { ...base, messageId: "bad", payload: {} },
    {
      ...base,
      messageId: "bad-link",
      payload: {
        ...base.payload,
        patient: { ...base.payload.patient, id: "WRONG" },
      },
    },
  ])
    assert.equal((await consume(s, hospital, event)).status, "QUARANTINED");
  assert.equal(await s.entity(hospital, "patient", "WRONG"), undefined);
  await s.close();
});
test("transaction failure rolls back inbox, projection, and audit for safe redelivery", async () => {
  const s = await setup();
  const event = { ...sampleEvent(), messageId: "rollback" };
  await s.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON audit FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected'",
  );
  await assert.rejects(
    async () => await consume(s, hospital, event),
    /injected/,
  );
  assert.equal(
    await s.get("SELECT id FROM patient_inbox WHERE id=?", "rollback"),
    undefined,
  );
  await s.exec("DROP TRIGGER fail_audit");
  assert.equal((await consume(s, hospital, event)).status, "APPLIED");
  await s.close();
});
