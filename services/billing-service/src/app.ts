import { z } from "zod";
import { check, digest, id } from "@rounding/contracts";
import { billingRequest } from "@rounding/contracts/internal";
import { createHttp } from "@rounding/platform/http";
import type { Credentials } from "@rounding/platform/config";
import type { Json } from "@rounding/platform/db";
import { Store } from "./store.js";

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
export function buildBillingApi(
  store: Store,
  credentials: Credentials,
  serviceToken: string,
) {
  const { app, principal } = createHttp(credentials, {
    service: "billing",
    database: store,
    serviceToken,
  });
  app.put("/internal/v1/jobs", async (req) => receiveJob(store, req.body));
  app.get("/internal/v1/jobs/:hospital/:id", async (req) => {
    const p = z.object({ hospital: id, id }).parse(req.params);
    const row = store.get(
      "SELECT * FROM submissions WHERE hospital=? AND id=?",
      p.hospital,
      p.id,
    );
    check(row, 404, "JOB_NOT_FOUND");
    return state(row);
  });
  app.post("/internal/v1/jobs/:hospital/:id/retries", async (req) => {
    const p = z.object({ hospital: id, id }).parse(req.params);
    const op = z.object({ operationId: id }).strict().parse(req.body);
    return store.transaction(() => {
      const row = store.get(
        "SELECT * FROM submissions WHERE hospital=? AND id=?",
        p.hospital,
        p.id,
      );
      check(row, 404, "JOB_NOT_FOUND");
      if (
        !store.get(
          "SELECT operation FROM retry_receipts WHERE hospital=? AND id=? AND operation=?",
          p.hospital,
          p.id,
          op.operationId,
        )
      ) {
        if (["RETRY", "REVIEW"].includes(row.status))
          store.run(
            "UPDATE submissions SET status='RETRY',next_at=0 WHERE hospital=? AND id=?",
            p.hospital,
            p.id,
          );
        store.run(
          "INSERT INTO retry_receipts VALUES (?,?,?)",
          p.hospital,
          p.id,
          op.operationId,
        );
        store.audit(
          p.hospital,
          "charge-service",
          "BILLING_RETRY_REQUESTED",
          p.id,
        );
      }
      // Never alter first_attempt, payload, key, or a SENDING lease.
      return state(
        store.get(
          "SELECT * FROM submissions WHERE hospital=? AND id=?",
          p.hospital,
          p.id,
        )!,
      );
    });
  });
  app.get("/v1/admin/metrics", async (req) => ({
    submissions: store.all(
      "SELECT status,COUNT(*) AS count FROM submissions WHERE hospital=? GROUP BY status",
      principal(req, ["admin"]).hospital,
    ),
  }));
  return app;
}
