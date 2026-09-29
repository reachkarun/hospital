import { Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  check,
  DomainError,
  saveCharge,
  submit,
  syncBatch,
  type Principal,
} from "@rounding/contracts";
import { Store } from "../store.js";
import {
  save,
  submitCharges,
  retrySubmission,
  viewCharge,
  submissionView,
  type ResolveEncounter,
} from "./charge-operations.js";
@Injectable()
export class ChargeService {
  constructor(
    private readonly store: Store,
    private readonly resolve: ResolveEncounter,
  ) {}
  list(p: Principal, q: { after: string; limit: number }) {
    const { store } = this;
    const rows = store.all(
      "SELECT * FROM charges WHERE hospital=? AND provider=? AND id>? ORDER BY id LIMIT ?",
      p.hospital,
      p.provider,
      q.after,
      q.limit,
    );
    store.audit(p.hospital, p.provider, "CHARGE_LIST_READ", "charge-list");
    return {
      items: rows.map(viewCharge),
      nextCursor: rows.length === q.limit ? rows.at(-1)!.id : null,
    };
  }
  get(p: Principal, identifier: string) {
    const { store } = this;
    const row = store.get(
      "SELECT * FROM charges WHERE hospital=? AND provider=? AND id=?",
      p.hospital,
      p.provider,
      identifier,
    );
    check(row, 404, "CHARGE_NOT_FOUND");
    store.audit(p.hospital, p.provider, "CHARGE_READ", identifier);
    return viewCharge(row);
  }
  submission(p: Principal, identifier: string) {
    const { store } = this;
    const row = store.get(
      "SELECT * FROM submissions WHERE hospital=? AND provider=? AND id=?",
      p.hospital,
      p.provider,
      identifier,
    );
    check(row, 404, "SUBMISSION_NOT_FOUND");
    store.audit(p.hospital, p.provider, "SUBMISSION_READ", identifier);
    return submissionView(row);
  }
  save(p: Principal, input: z.infer<typeof saveCharge>) {
    return save(this.store, p, input, this.resolve);
  }
  submit(p: Principal, input: z.infer<typeof submit>) {
    return submitCharges(this.store, p, input, this.resolve);
  }
  retry(p: Principal, identifier: string) {
    return retrySubmission(this.store, p, identifier);
  }
  async sync(p: Principal, batch: z.infer<typeof syncBatch>) {
    const results = [];
    // Preserve operation order within a batch, including edits to the same charge.
    for (const op of batch.operations) {
      try {
        results.push({
          operationId: op.operationId,
          status: 200,
          result: await this.save(p, op),
        });
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        results.push({
          operationId: op.operationId,
          status: error.status,
          error: { code: error.code, details: error.details },
        });
      }
    }
    return { results };
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
