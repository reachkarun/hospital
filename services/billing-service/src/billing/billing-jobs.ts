import { check, digest } from "@rounding/contracts";
import { billingRequest } from "@rounding/contracts/internal";
import type { Json } from "@rounding/platform/db";
import { Store } from "../store.js";
export function state(row: Json) {
  return {
    submissionId: row.id,
    hospitalId: row.hospital,
    providerId: row.provider,
    payloadDigest: row.digest,
    status: row.status,
    attempts: row.attempts,
    firstAttempt: row.first_attempt,
    nextAt: row.next_at,
    error: row.error,
    acknowledgment: row.response ? JSON.parse(row.response) : null,
  };
}
export function receiveJob(store: Store, raw: unknown) {
  const payload = billingRequest.parse(raw);
  return store.transaction(() => {
    const hash = digest(payload);
    const old = store.get(
      "SELECT * FROM submissions WHERE hospital=? AND id=?",
      payload.hospitalId,
      payload.submissionId,
    );
    if (old) {
      check(old.digest === hash, 409, "BILLING_JOB_ID_REUSED");
      return state(old);
    }
    check(
      store.get("SELECT id FROM hospitals WHERE id=?", payload.hospitalId),
      404,
      "HOSPITAL_NOT_FOUND",
    );
    const key = store.get(
      "SELECT id FROM submissions WHERE hospital=? AND provider=? AND client_key=?",
      payload.hospitalId,
      payload.providerId,
      payload.clientSubmissionId,
    );
    check(!key, 409, "BILLING_KEY_REUSED");
    store.run(
      "INSERT INTO submissions(hospital,id,provider,client_key,digest,payload,status) VALUES (?,?,?,?,?,?,'QUEUED')",
      payload.hospitalId,
      payload.submissionId,
      payload.providerId,
      payload.clientSubmissionId,
      hash,
      JSON.stringify(payload),
    );
    store.audit(
      payload.hospitalId,
      "charge-service",
      "BILLING_JOB_RECEIVED",
      payload.submissionId,
    );
    return state(
      store.get(
        "SELECT * FROM submissions WHERE hospital=? AND id=?",
        payload.hospitalId,
        payload.submissionId,
      )!,
    );
  });
}
