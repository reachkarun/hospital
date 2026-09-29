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
  async list(
    p: Principal,
    q: {
      after: string;
      limit: number;
    },
  ) {
    const { store } = this;
    const rows = await store.all(
      "SELECT * FROM charges WHERE hospital=? AND provider=? AND id>? ORDER BY id LIMIT ?",
      p.hospital,
      p.provider,
      q.after,
      q.limit,
    );
    await store.audit(
      p.hospital,
      p.provider,
      "CHARGE_LIST_READ",
      "charge-list",
    );
    return {
      items: rows.map(viewCharge),
      nextCursor: rows.length === q.limit ? rows.at(-1)!.id : null,
    };
  }
  async get(p: Principal, identifier: string) {
    const { store } = this;
    const row = await store.get(
      "SELECT * FROM charges WHERE hospital=? AND provider=? AND id=?",
      p.hospital,
      p.provider,
      identifier,
    );
    check(row, 404, "CHARGE_NOT_FOUND");
    await store.audit(p.hospital, p.provider, "CHARGE_READ", identifier);
    return viewCharge(row);
  }
  async submission(p: Principal, identifier: string) {
    const { store } = this;
    const row = await store.get(
      "SELECT * FROM charge_submissions WHERE hospital=? AND provider=? AND id=?",
      p.hospital,
      p.provider,
      identifier,
    );
    check(row, 404, "SUBMISSION_NOT_FOUND");
    await store.audit(p.hospital, p.provider, "SUBMISSION_READ", identifier);
    return submissionView(row);
  }
  async save(p: Principal, input: z.infer<typeof saveCharge>) {
    return await save(this.store, p, input, this.resolve);
  }
  async submit(p: Principal, input: z.infer<typeof submit>) {
    return await submitCharges(this.store, p, input, this.resolve);
  }
  async retry(p: Principal, identifier: string) {
    return await retrySubmission(this.store, p, identifier);
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
  async metrics(hospital: string) {
    return {
      submissions: await this.store.all(
        "SELECT status,COUNT(*) AS count FROM charge_submissions WHERE hospital=? GROUP BY status",
        hospital,
      ),
    };
  }
}
