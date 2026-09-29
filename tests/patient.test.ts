import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../services/patient-service/src/store.js";
import { seed } from "../services/patient-service/src/seed.js";
import { consume } from "../services/patient-service/src/patient/patient-events.js";
import { sampleEvent } from "@rounding/contracts/sample";
const hospital = "HOSP-001";
function setup() {
  const s = new Store();
  seed(s, "http://billing");
  return s;
}

test("patient duplicate receipts and changed-message detection are durable", () => {
  const s = setup();
  assert.equal(consume(s, hospital, sampleEvent()).duplicate, true);
  assert.throws(
    () => consume(s, hospital, { ...sampleEvent(), source: "changed" }),
    /MESSAGE_ID_REUSED/,
  );
  assert.deepEqual(s.entity(hospital, "patient", "PAT-456")!.allergies, [
    "Penicillin",
  ]);
  s.close();
});
test("out-of-order independent fields converge and missing visit dependencies replay", () => {
  const s = setup();
  const base = sampleEvent();
  for (const [messageId, timestamp, changes] of [
    ["new", "2026-01-18T00:00:00Z", { phone: { new: "new" } }],
    [
      "old",
      "2026-01-17T00:00:00Z",
      { phone: { new: "old" }, allergies: { new: ["Late allergy"] } },
    ],
  ] as const)
    consume(s, hospital, {
      ...base,
      messageId,
      timestamp,
      eventType: "PATIENT_UPDATE",
      payload: { patientId: "PAT-456", changes, updatedAt: timestamp },
    });
  assert.equal(s.entity(hospital, "patient", "PAT-456")!.phone, "new");
  assert.deepEqual(s.entity(hospital, "patient", "PAT-456")!.allergies, [
    "Late allergy",
  ]);
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
  assert.equal(consume(s, hospital, move).status, "WAITING");
  consume(s, hospital, {
    ...base,
    messageId: "admit",
    eventType: "VISIT_ADMISSION",
    payload: {
      patient: base.payload.patient,
      visit: { ...base.payload.visit, id: "LATE" },
    },
  });
  assert.equal(s.entity(hospital, "visit", "LATE")!.room, "900");
  s.close();
});
test("unassignment tombstone survives late assignment and discharge is retained", () => {
  const s = setup();
  const base = sampleEvent();
  consume(s, hospital, {
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
  consume(s, hospital, {
    ...base,
    messageId: "late-assign",
    payload: { ...base.payload, assignmentId: "NEW" },
  });
  assert.equal(s.entity(hospital, "assignment", "NEW")!.active, false);
  consume(s, hospital, {
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
  assert.equal(s.entity(hospital, "visit", "VISIT-001")!.status, "DISCHARGED");
  s.close();
});
test("invalid schemas and links quarantine without partial writes", () => {
  const s = setup();
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
    assert.equal(consume(s, hospital, event).status, "QUARANTINED");
  assert.equal(s.entity(hospital, "patient", "WRONG"), undefined);
  s.close();
});
test("transaction failure rolls back inbox, projection, and audit for safe redelivery", () => {
  const s = setup();
  const event = { ...sampleEvent(), messageId: "rollback" };
  s.db.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'injected'); END;",
  );
  assert.throws(() => consume(s, hospital, event), /injected/);
  assert.equal(s.get("SELECT id FROM inbox WHERE id=?", "rollback"), undefined);
  s.db.exec("DROP TRIGGER fail_audit");
  assert.equal(consume(s, hospital, event).status, "APPLIED");
  s.close();
});
