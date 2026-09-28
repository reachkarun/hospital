import { randomUUID } from "node:crypto";
import { check, digest } from "@rounding/contracts";
import { validateAck } from "@rounding/contracts/billing";
import { jobState } from "@rounding/contracts/internal";
import { internalJson } from "@rounding/platform/client";
import { Store, type Json } from "./store.js";

export interface BillingJobs {
  deliver(payload: Json): Promise<unknown>;
  retry(hospital: string, id: string, operationId: string): Promise<unknown>;
}
export const billingClient = (url: string, token: string): BillingJobs => ({
  deliver: (payload) =>
    internalJson(`${url}/internal/v1/jobs`, token, payload, "PUT"),
  retry: (hospital, id, operationId) =>
    internalJson(
      `${url}/internal/v1/jobs/${encodeURIComponent(hospital)}/${encodeURIComponent(id)}/retries`,
      token,
      { operationId },
    ),
});

/** Durable HTTP outbox + idempotent status projection. This service never calls external billing. */
export class Dispatcher {
  constructor(
    private store: Store,
    private jobs: BillingJobs,
    private clock: () => number = Date.now,
  ) {}
  async tick() {
    const row = this.store.transaction<Json | undefined>(() => {
      const candidate = this.store.get(
        "SELECT * FROM submissions WHERE status IN ('QUEUED','SENDING','RETRY') AND dispatch_at<=? AND dispatch_lease<=? ORDER BY dispatch_at,id LIMIT 1",
        this.clock(),
        this.clock(),
      );
      if (!candidate) return;
      const token = randomUUID();
      this.store.run(
        "UPDATE submissions SET dispatch_lease=?,dispatch_token=? WHERE hospital=? AND id=?",
        this.clock() + 30_000,
        token,
        candidate.hospital,
        candidate.id,
      );
      return { ...candidate, dispatch_token: token };
    });
    if (!row) return false;
    try {
      const payload = JSON.parse(row.payload);
      let result = await this.jobs.deliver(payload);
      if (row.retry_request)
        result = await this.jobs.retry(row.hospital, row.id, row.retry_request);
      const remote = jobState.parse(result);
      check(
        remote.hospitalId === row.hospital &&
          remote.providerId === row.provider &&
          remote.submissionId === row.id &&
          remote.payloadDigest === digest(payload),
        502,
        "BILLING_STATE_MISMATCH",
      );
      const terminalAck = ["ACCEPTED", "PARTIAL", "REJECTED"].includes(
        remote.status,
      );
      const ack = remote.acknowledgment
        ? validateAck(remote.acknowledgment, row)
        : null;
      check(
        !terminalAck || (ack && ack.status === remote.status),
        502,
        "BILLING_STATE_INVALID",
      );
      this.store.transaction(() => {
        const current = this.store.get(
          "SELECT * FROM submissions WHERE hospital=? AND id=?",
          row.hospital,
          row.id,
        );
        if (!current || current.dispatch_token !== row.dispatch_token) return;
        // If a concurrent provider requested retry, preserve that command and poll again.
        const newerRetry =
          current.retry_request && current.retry_request !== row.retry_request;
        const nextStatus =
          newerRetry && !terminalAck && remote.status !== "FAILED"
            ? "RETRY"
            : remote.status;
        this.store.run(
          "UPDATE submissions SET status=?,attempts=?,first_attempt=?,next_at=?,response=?,error=?,dispatch_at=?,dispatch_lease=0,dispatch_token=NULL,retry_request=? WHERE hospital=? AND id=?",
          nextStatus,
          remote.attempts,
          remote.firstAttempt,
          remote.nextAt,
          ack ? JSON.stringify(ack) : null,
          remote.error,
          this.clock() + 1000,
          newerRetry ? current.retry_request : null,
          row.hospital,
          row.id,
        );
        if (terminalAck && ack)
          for (const item of [...ack.acceptedCharges, ...ack.rejectedCharges]) {
            this.store.run(
              "UPDATE charges SET status=?,error=?,version=version+1 WHERE hospital=? AND id=? AND submission=? AND status='QUEUED'",
              item.status,
              item.error ? JSON.stringify(item.error) : null,
              row.hospital,
              item.chargeId,
              row.id,
            );
            this.store.audit(
              row.hospital,
              "billing-service",
              `CHARGE_${item.status}`,
              item.chargeId,
            );
          }
        if (remote.status === "FAILED")
          this.store.run(
            "UPDATE charges SET status='REJECTED',error=?,version=version+1 WHERE hospital=? AND submission=? AND status='QUEUED'",
            JSON.stringify({
              code: remote.error,
              message: "Correct the rejected submission.",
            }),
            row.hospital,
            row.id,
          );
        if (current.status !== nextStatus)
          this.store.audit(
            row.hospital,
            "billing-service",
            `SUBMISSION_${nextStatus}`,
            row.id,
          );
      });
    } catch {
      // A lost PUT response is not a lost job. Send the same immutable ID on redelivery.
      this.store.run(
        "UPDATE submissions SET dispatch_at=?,dispatch_lease=0,dispatch_token=NULL WHERE hospital=? AND id=? AND dispatch_token=?",
        this.clock() + 2000,
        row.hospital,
        row.id,
        row.dispatch_token,
      );
    }
    return true;
  }
}
