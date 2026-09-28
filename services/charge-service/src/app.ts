import { z } from "zod";
import {
  check,
  id,
  saveCharge,
  submit,
  syncBatch,
  DomainError,
} from "@rounding/contracts";
import type { Credentials } from "@rounding/platform/config";
import { createHttp } from "@rounding/platform/http";
import { Store } from "./store.js";
import {
  save,
  submitCharges,
  retrySubmission,
  viewCharge,
  submissionView,
  type ResolveEncounter,
} from "./charges.js";

export function buildChargeApi(
  store: Store,
  credentials: Credentials,
  resolve: ResolveEncounter,
) {
  const { app, principal } = createHttp(credentials, {
    service: "charge",
    database: store,
  });
  app.post("/v1/charges", async (req) =>
    save(store, principal(req), saveCharge.parse(req.body), resolve),
  );
  app.get("/v1/charges", async (req) => {
    const p = principal(req);
    const q = z
      .object({
        after: z.string().max(100).default(""),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
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
  });
  app.get("/v1/charges/:id", async (req) => {
    const p = principal(req);
    const identifier = id.parse((req.params as { id: string }).id);
    const row = store.get(
      "SELECT * FROM charges WHERE hospital=? AND provider=? AND id=?",
      p.hospital,
      p.provider,
      identifier,
    );
    check(row, 404, "CHARGE_NOT_FOUND");
    store.audit(p.hospital, p.provider, "CHARGE_READ", identifier);
    return viewCharge(row);
  });
  app.post("/v1/sync", async (req, reply) => {
    const p = principal(req);
    const batch = syncBatch.parse(req.body);
    const results = [];
    // Sequential per batch preserves edits to the same charge and bounds downstream work.
    for (const op of batch.operations) {
      try {
        results.push({
          operationId: op.operationId,
          status: 200,
          result: await save(store, p, op, resolve),
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
    return reply.code(207).send({ results });
  });
  app.post("/v1/submissions", async (req, reply) =>
    reply
      .code(202)
      .send(
        await submitCharges(
          store,
          principal(req),
          submit.parse(req.body),
          resolve,
        ),
      ),
  );
  app.get("/v1/submissions/:id", async (req) => {
    const p = principal(req);
    const identifier = id.parse((req.params as { id: string }).id);
    const row = store.get(
      "SELECT * FROM submissions WHERE hospital=? AND provider=? AND id=?",
      p.hospital,
      p.provider,
      identifier,
    );
    check(row, 404, "SUBMISSION_NOT_FOUND");
    store.audit(p.hospital, p.provider, "SUBMISSION_READ", identifier);
    return submissionView(row);
  });
  app.post("/v1/submissions/:id/retry", async (req) =>
    retrySubmission(
      store,
      principal(req),
      id.parse((req.params as { id: string }).id),
    ),
  );
  app.get("/v1/admin/metrics", async (req) => ({
    submissions: store.all(
      "SELECT status,COUNT(*) AS count FROM submissions WHERE hospital=? GROUP BY status",
      principal(req, ["admin"]).hospital,
    ),
  }));
  return app;
}
