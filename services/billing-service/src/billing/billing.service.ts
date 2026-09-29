import { Injectable } from "@nestjs/common";
import { check } from "@rounding/contracts";
import { Store } from "../store.js";
import { receiveJob, state } from "./billing-jobs.js";
@Injectable()
export class BillingService {
  constructor(private readonly store: Store) {}
  async get(p: { hospital: string; id: string }) {
    const { store } = this;
    const row = await store.get(
      "SELECT * FROM billing_submissions WHERE hospital=? AND id=?",
      p.hospital,
      p.id,
    );
    check(row, 404, "JOB_NOT_FOUND");
    return state(row);
  }
  async retry(
    p: {
      hospital: string;
      id: string;
    },
    op: {
      operationId: string;
    },
  ) {
    const { store } = this;
    return await store.transaction(async () => {
      await store.lockHospital(p.hospital);
      const row = await store.get(
        "SELECT * FROM billing_submissions WHERE hospital=? AND id=?",
        p.hospital,
        p.id,
      );
      check(row, 404, "JOB_NOT_FOUND");
      if (
        !(await store.get(
          "SELECT operation FROM billing_retry_receipts WHERE hospital=? AND id=? AND operation=?",
          p.hospital,
          p.id,
          op.operationId,
        ))
      ) {
        if (["RETRY", "REVIEW"].includes(row.status))
          await store.run(
            "UPDATE billing_submissions SET status='RETRY',next_at=0 WHERE hospital=? AND id=?",
            p.hospital,
            p.id,
          );
        await store.run(
          "INSERT INTO billing_retry_receipts VALUES (?,?,?)",
          p.hospital,
          p.id,
          op.operationId,
        );
        await store.audit(
          p.hospital,
          "charge-service",
          "BILLING_RETRY_REQUESTED",
          p.id,
        );
      }
      // Never alter first_attempt, payload, key, or a SENDING lease.
      return state(
        (await store.get(
          "SELECT * FROM billing_submissions WHERE hospital=? AND id=?",
          p.hospital,
          p.id,
        ))!,
      );
    });
  }
  async receive(input: unknown) {
    return await receiveJob(this.store, input);
  }
  async metrics(hospital: string) {
    return {
      submissions: await this.store.all(
        "SELECT status,COUNT(*) AS count FROM billing_submissions WHERE hospital=? GROUP BY status",
        hospital,
      ),
    };
  }
}
