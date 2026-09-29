import { Injectable } from "@nestjs/common";
import { check } from "@rounding/contracts";
import { Store } from "../store.js";
import { receiveJob, state } from "./billing-jobs.js";
@Injectable()
export class BillingService {
  constructor(private readonly store: Store) {}
  get(p: { hospital: string; id: string }) {
    const { store } = this;
    const row = store.get(
      "SELECT * FROM submissions WHERE hospital=? AND id=?",
      p.hospital,
      p.id,
    );
    check(row, 404, "JOB_NOT_FOUND");
    return state(row);
  }
  retry(p: { hospital: string; id: string }, op: { operationId: string }) {
    const { store } = this;
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
  }
  receive(input: unknown) {
    return receiveJob(this.store, input);
  }
  metrics(hospital: string) {
    return {
      submissions: this.store.all(
        "SELECT status,COUNT(*) AS count FROM submissions WHERE hospital=? GROUP BY status",
        hospital,
      ),
    };
  }
}
