import { z } from "zod";
import { Store, type Json } from "../store.js";
import {
  check,
  digest,
  envelope,
  id,
  instant,
  day,
  type Event,
} from "@rounding/contracts";
const clinical = z
  .array(z.union([z.string().max(500), z.record(z.unknown())]))
  .max(200);
const patient = z
  .object({
    id,
    mrn: z.string().min(1).max(100),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    dateOfBirth: day,
    gender: z.string().max(30),
    address: z.record(z.string()).optional(),
    phone: z.string().max(40).optional(),
    emergencyContact: z.record(z.string()).optional(),
    allergies: clinical.optional(),
    conditions: clinical.optional(),
    medications: clinical.optional(),
  })
  .strip();
const provider = z.object({
  id,
  npi: z.string().regex(/^\d{10}$/),
  name: z.string().min(1),
  specialty: z.string().optional(),
});
const location = z.object({
  room: z.string().max(100),
  bed: z.string().max(100),
  unit: z.string().max(100),
});
const visit = location.extend({
  id,
  admissionDate: instant,
  status: z.literal("ACTIVE"),
  admittingDiagnosis: z.string().max(2000).optional(),
});
const payloads: Record<string, z.ZodTypeAny> = {
  PATIENT_ASSIGNMENT: z.object({
    assignmentId: id,
    patient,
    provider,
    visit,
    assignedAt: instant,
  }),
  PATIENT_UNASSIGNMENT: z.object({
    assignmentId: id,
    patientId: id,
    providerId: id,
    visitId: id,
    unassignedAt: instant,
  }),
  PATIENT_UPDATE: z.object({
    patientId: id,
    mrn: z.string().optional(),
    changes: z.record(
      z.object({ old: z.unknown().optional(), new: z.unknown() }),
    ),
    updatedAt: instant,
  }),
  VISIT_ADMISSION: z.object({ patient, visit }),
  VISIT_LOCATION_CHANGE: z.object({
    visitId: id,
    patientId: id,
    newLocation: location,
    changedAt: instant,
  }),
  VISIT_DISCHARGE: z.object({
    visitId: id,
    patientId: id,
    dischargeDate: instant,
    dischargeStatus: z.string(),
    dischargeInstructions: z.string().max(4000).optional(),
    providerId: id.optional(),
  }),
};
class Waiting extends Error {}
class Invalid extends Error {}
/** Field clocks preserve independent updates delivered out of order. */
async function merge(
  store: Store,
  e: Event,
  kind: string,
  identifier: string,
  patch: Json,
) {
  const body = (await store.entity(e.hospitalId, kind, identifier)) ?? {
    id: identifier,
  };
  const stamp = `${new Date(e.timestamp).toISOString()}|${e.messageId}`;
  for (const [field, value] of Object.entries(patch)) {
    if (field === "id" || value === undefined) continue;
    const clock = await store.get(
      "SELECT stamp FROM patient_field_clocks WHERE hospital=? AND kind=? AND entity_id=? AND field=?",
      e.hospitalId,
      kind,
      identifier,
      field,
    );
    if (!clock || clock.stamp < stamp) {
      body[field] = value;
      await store.run(
        "INSERT INTO patient_field_clocks VALUES (?,?,?,?,?) AS incoming ON DUPLICATE KEY UPDATE stamp=incoming.stamp",
        e.hospitalId,
        kind,
        identifier,
        field,
        stamp,
      );
    }
  }
  await store.run(
    "INSERT INTO patient_entities VALUES (?,?,?,?) AS incoming ON DUPLICATE KEY UPDATE body=incoming.body",
    e.hospitalId,
    kind,
    identifier,
    JSON.stringify(body),
  );
}
async function requireEntity(
  store: Store,
  e: Event,
  kind: string,
  identifier: string,
) {
  const result = await store.entity(e.hospitalId, kind, identifier);
  if (!result) throw new Waiting("MISSING_DEPENDENCY");
  return result;
}
async function apply(store: Store, e: Event) {
  if (e.version !== "1.0" || !payloads[e.eventType])
    throw new Invalid("UNSUPPORTED_SCHEMA");
  const parsed = payloads[e.eventType]!.safeParse(e.payload);
  if (!parsed.success) throw new Invalid("INVALID_PAYLOAD");
  const p = parsed.data;
  if (
    e.eventType === "PATIENT_ASSIGNMENT" ||
    e.eventType === "VISIT_ADMISSION"
  ) {
    const oldVisit = await store.entity(e.hospitalId, "visit", p.visit.id);
    if (oldVisit && oldVisit.patientId !== p.patient.id)
      throw new Invalid("VISIT_PATIENT_MISMATCH");
    if (p.assignmentId) {
      const old = await store.entity(
        e.hospitalId,
        "assignment",
        p.assignmentId,
      );
      if (
        old &&
        (old.patientId !== p.patient.id ||
          old.providerId !== p.provider.id ||
          old.visitId !== p.visit.id)
      )
        throw new Invalid("ASSIGNMENT_ID_REUSED");
    }
    await merge(store, e, "patient", p.patient.id, p.patient);
    await merge(store, e, "visit", p.visit.id, {
      ...p.visit,
      patientId: p.patient.id,
    });
    if (p.provider) {
      await merge(store, e, "provider", p.provider.id, p.provider);
      await merge(store, e, "assignment", p.assignmentId, {
        patientId: p.patient.id,
        providerId: p.provider.id,
        visitId: p.visit.id,
        active: true,
        assignedAt: p.assignedAt,
      });
    }
  } else if (e.eventType === "PATIENT_UPDATE") {
    await requireEntity(store, e, "patient", p.patientId);
    const changes = Object.fromEntries(
      Object.entries(p.changes).map(([k, v]) => [k, (v as Json).new]),
    );
    const patch = patient
      .omit({ id: true })
      .partial()
      .strict()
      .safeParse(changes);
    if (!patch.success || Object.keys(changes).length === 0)
      throw new Invalid("INVALID_PATIENT_CHANGES");
    await merge(store, e, "patient", p.patientId, patch.data);
  } else if (e.eventType === "PATIENT_UNASSIGNMENT") {
    // Tombstones can arrive before assignments; later replay cannot reactivate them.
    const old = await store.entity(e.hospitalId, "assignment", p.assignmentId);
    if (
      old &&
      (old.patientId !== p.patientId ||
        old.providerId !== p.providerId ||
        old.visitId !== p.visitId)
    )
      throw new Invalid("ASSIGNMENT_ID_REUSED");
    await merge(store, e, "assignment", p.assignmentId, {
      patientId: p.patientId,
      providerId: p.providerId,
      visitId: p.visitId,
      active: false,
      unassignedAt: p.unassignedAt,
    });
  } else {
    const current = await requireEntity(store, e, "visit", p.visitId);
    if (current.patientId !== p.patientId)
      throw new Invalid("VISIT_PATIENT_MISMATCH");
    if (e.eventType === "VISIT_LOCATION_CHANGE")
      await merge(store, e, "visit", p.visitId, p.newLocation);
    else {
      if (Date.parse(p.dischargeDate) < Date.parse(current.admissionDate))
        throw new Invalid("DISCHARGE_BEFORE_ADMISSION");
      await merge(store, e, "visit", p.visitId, {
        status: "DISCHARGED",
        dischargeDate: p.dischargeDate,
        dischargeStatus: p.dischargeStatus,
        dischargeInstructions: p.dischargeInstructions,
      });
    }
  }
}
async function processStored(store: Store, e: Event) {
  let status = "APPLIED";
  let error: string | null = null;
  await store.exec("SAVEPOINT event_apply");
  try {
    await apply(store, e);
    await store.exec("RELEASE SAVEPOINT event_apply");
  } catch (err) {
    await store.exec("ROLLBACK TO SAVEPOINT event_apply");
    await store.exec("RELEASE SAVEPOINT event_apply");
    if (!(err instanceof Waiting || err instanceof Invalid)) throw err;
    status = err instanceof Waiting ? "WAITING" : "QUARANTINED";
    error = err.message;
  }
  await store.run(
    "UPDATE patient_inbox SET status=?,error=? WHERE hospital=? AND id=?",
    status,
    error,
    e.hospitalId,
    e.messageId,
  );
  await store.audit(
    e.hospitalId,
    `broker:${e.source}`,
    `PATIENT_EVENT_${status}`,
    e.messageId,
  );
  return { messageId: e.messageId, status, error };
}
export async function consume(store: Store, hospital: string, input: unknown) {
  const e = envelope.parse(input);
  check(e.hospitalId === hospital, 403, "HOSPITAL_MISMATCH");
  return await store.transaction(async () => {
    await store.lockHospital(hospital);
    const hash = digest(e);
    const old = await store.get(
      "SELECT * FROM patient_inbox WHERE hospital=? AND id=?",
      hospital,
      e.messageId,
    );
    if (old) {
      check(old.digest === hash, 409, "MESSAGE_ID_REUSED");
      await store.audit(
        hospital,
        `broker:${e.source}`,
        "PATIENT_EVENT_DUPLICATE",
        e.messageId,
      );
      return {
        messageId: e.messageId,
        status: old.status,
        error: old.error,
        duplicate: true,
      };
    }
    await store.run(
      "INSERT INTO patient_inbox(hospital,id,digest,body,status,received_at) VALUES (?,?,?,?,?,?)",
      hospital,
      e.messageId,
      hash,
      JSON.stringify(e),
      "RECEIVED",
      new Date().toISOString(),
    );
    const result = await processStored(store, e);
    // Bounded dependency replay after upstream entities become available.
    if (result.status === "APPLIED")
      await replayWaitingInTransaction(store, hospital);
    return { ...result, duplicate: false };
  });
}
async function replayWaitingInTransaction(store: Store, hospital: string) {
  const rows = await store.all(
    "SELECT body FROM patient_inbox WHERE hospital=? AND status='WAITING' ORDER BY JSON_UNQUOTE(JSON_EXTRACT(body,'$.timestamp')),id LIMIT 100",
    hospital,
  );
  const results = [];
  for (const row of rows)
    results.push(await processStored(store, JSON.parse(row.body)));
  return results;
}
export async function replayWaiting(store: Store, hospital: string) {
  return await store.transaction(async () => {
    await store.lockHospital(hospital);
    return await replayWaitingInTransaction(store, hospital);
  });
}
export async function assigned(
  store: Store,
  hospital: string,
  providerId: string,
  visitId: string,
  includeHistorical = false,
) {
  return (
    await store.all(
      "SELECT body FROM patient_entities WHERE hospital=? AND kind='assignment' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.providerId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.visitId'))=?",
      hospital,
      providerId,
      visitId,
    )
  )
    .map((row) => JSON.parse(row.body))
    .some((a) => a.active || (includeHistorical && a.assignedAt));
}
