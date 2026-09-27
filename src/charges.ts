import { randomUUID } from "node:crypto";
import { Store, timestamp, type Json } from "./db.js";
import {
  check,
  digest,
  type Principal,
  type SaveCharge,
  type Submit,
} from "./contracts.js";
import { assigned } from "./patients.js";

export function viewCharge(row: Json) {
  return {
    chargeId: row.id,
    ...JSON.parse(row.body),
    version: row.version,
    status: row.status,
    error: row.error ? JSON.parse(row.error) : null,
    submissionId: row.submission,
  };
}

function authorizeVisit(
  store: Store,
  p: Principal,
  visitId: string,
  date: string,
) {
  const visit = store.entity(p.hospital, "visit", visitId);
  check(
    visit && assigned(store, p.hospital, p.provider, visitId, true),
    404,
    "VISIT_NOT_FOUND",
  );
  const serviceDay = Date.parse(date);
  check(
    serviceDay <= Date.parse(timestamp().slice(0, 10)),
    422,
    "FUTURE_SERVICE_DATE",
  );
  check(
    serviceDay >= Date.parse(visit.admissionDate.slice(0, 10)),
    422,
    "SERVICE_BEFORE_ADMISSION",
  );
  if (visit.dischargeDate)
    check(
      serviceDay <= Date.parse(visit.dischargeDate.slice(0, 10)),
      422,
      "SERVICE_AFTER_DISCHARGE",
    );
  return visit;
}

export function save(store: Store, p: Principal, input: SaveCharge) {
  return store.transaction(() => {
    const hash = digest(input);
    const prior = store.get(
      "SELECT * FROM operations WHERE hospital=? AND provider=? AND id=?",
      p.hospital,
      p.provider,
      input.operationId,
    );
    if (prior) {
      check(prior.digest === hash, 409, "OPERATION_ID_REUSED");
      return JSON.parse(prior.response);
    }
    authorizeVisit(store, p, input.charge.visitId, input.charge.dateOfService);
    const old = store.get(
      "SELECT * FROM charges WHERE hospital=? AND id=?",
      p.hospital,
      input.chargeId,
    );
    check(!old || old.provider === p.provider, 404, "CHARGE_NOT_FOUND");
    check(
      (old?.version ?? 0) === input.expectedVersion,
      409,
      "VERSION_CONFLICT",
      { current: old ? viewCharge(old) : null },
    );
    check(
      !old || ["DRAFT", "REJECTED"].includes(old.status),
      409,
      "CHARGE_LOCKED",
    );
    check(
      !old || old.visit === input.charge.visitId,
      409,
      "CHARGE_VISIT_IMMUTABLE",
    );
    const version = input.expectedVersion + 1;
    store.run(
      `INSERT INTO charges(hospital,id,provider,visit,body,version,status) VALUES (?,?,?,?,?,?,'DRAFT')
      ON CONFLICT(hospital,id) DO UPDATE SET body=excluded.body,version=excluded.version,status='DRAFT',error=NULL,submission=NULL`,
      p.hospital,
      input.chargeId,
      p.provider,
      input.charge.visitId,
      JSON.stringify(input.charge),
      version,
    );
    const result = { chargeId: input.chargeId, version, status: "DRAFT" };
    store.run(
      "INSERT INTO operations VALUES (?,?,?,?,?)",
      p.hospital,
      p.provider,
      input.operationId,
      hash,
      JSON.stringify(result),
    );
    store.audit(
      p.hospital,
      p.provider,
      old ? "CHARGE_UPDATED" : "CHARGE_CREATED",
      input.chargeId,
    );
    return result;
  });
}

export function submissionView(row: Json) {
  return {
    submissionId: row.id,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_at ? new Date(row.next_at).toISOString() : null,
    error: row.error,
    billing: row.response ? JSON.parse(row.response) : null,
  };
}

export function submitCharges(store: Store, p: Principal, input: Submit) {
  return store.transaction(() => {
    const hash = digest({ ...input, chargeIds: [...input.chargeIds].sort() });
    const prior = store.get(
      "SELECT * FROM submissions WHERE hospital=? AND provider=? AND client_key=?",
      p.hospital,
      p.provider,
      input.clientSubmissionId,
    );
    if (prior) {
      check(prior.digest === hash, 409, "SUBMISSION_KEY_REUSED");
      return submissionView(prior);
    }
    const rows = input.chargeIds.map((identifier) => {
      const row = store.get(
        "SELECT * FROM charges WHERE hospital=? AND id=? AND provider=?",
        p.hospital,
        identifier,
        p.provider,
      );
      check(row, 404, "CHARGE_NOT_FOUND");
      check(row.status === "DRAFT", 409, "CHARGE_NOT_DRAFT");
      return row;
    });
    const visitId = rows[0]!.visit;
    check(
      rows.every((row) => row.visit === visitId),
      422,
      "ONE_VISIT_PER_SUBMISSION",
    );
    const charges = rows.map((row) => ({
      chargeId: row.id,
      ...JSON.parse(row.body),
    }));
    const visit = authorizeVisit(store, p, visitId, charges[0]!.dateOfService);
    charges.forEach((c) => authorizeVisit(store, p, visitId, c.dateOfService));
    const patient = store.entity(p.hospital, "patient", visit.patientId);
    const provider = store.entity(p.hospital, "provider", p.provider);
    check(patient?.mrn && provider?.npi, 422, "BILLING_IDENTIFIERS_MISSING");
    const submissionId = randomUUID();
    const payload = {
      submissionId,
      hospitalId: p.hospital,
      providerId: p.provider,
      providerNpi: provider.npi,
      patientId: patient.id,
      patientMrn: patient.mrn,
      visitId,
      charges: charges.map(({ visitId: _, ...charge }) => charge),
      submittedAt: timestamp(),
      clientSubmissionId: submissionId,
    };
    // The submission row is the transactional outbox, including an immutable payload.
    store.run(
      `INSERT INTO submissions(hospital,id,provider,client_key,digest,payload,status) VALUES (?,?,?,?,?,?,'QUEUED')`,
      p.hospital,
      submissionId,
      p.provider,
      input.clientSubmissionId,
      hash,
      JSON.stringify(payload),
    );
    for (const row of rows) {
      store.run(
        "UPDATE charges SET status='QUEUED',submission=?,version=version+1 WHERE hospital=? AND id=?",
        submissionId,
        p.hospital,
        row.id,
      );
      store.audit(p.hospital, p.provider, "CHARGE_QUEUED", row.id);
    }
    store.audit(p.hospital, p.provider, "SUBMISSION_QUEUED", submissionId);
    return submissionView(
      store.get(
        "SELECT * FROM submissions WHERE hospital=? AND id=?",
        p.hospital,
        submissionId,
      )!,
    );
  });
}

export function retrySubmission(
  store: Store,
  p: Principal,
  identifier: string,
) {
  return store.transaction(() => {
    const row = store.get(
      "SELECT * FROM submissions WHERE hospital=? AND id=? AND provider=?",
      p.hospital,
      identifier,
      p.provider,
    );
    check(row, 404, "SUBMISSION_NOT_FOUND");
    check(
      ["RETRY", "REVIEW"].includes(row.status),
      409,
      "SUBMISSION_NOT_RETRYABLE",
    );
    // Preserve first_attempt and payload: retries must never acquire a new billing key.
    store.run(
      "UPDATE submissions SET status='RETRY',next_at=0 WHERE hospital=? AND id=?",
      p.hospital,
      identifier,
    );
    store.audit(
      p.hospital,
      p.provider,
      "SUBMISSION_RETRY_REQUESTED",
      identifier,
    );
    return { submissionId: identifier, status: "RETRY" };
  });
}
