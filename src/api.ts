import Fastify, { LogController, type FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import { Store } from "./db.js";
import {
  check,
  DomainError,
  id,
  saveCharge,
  submit,
  syncBatch,
  type Principal,
} from "./contracts.js";
import { consume, replayWaiting, assigned } from "./patients.js";
import {
  retrySubmission,
  save,
  submissionView,
  submitCharges,
  viewCharge,
} from "./charges.js";
import type { Credentials } from "./config.js";
import { registerDocumentation } from "./openapi.js";

const pagination = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const resourceId = (req: FastifyRequest) =>
  id.parse((req.params as { id: string }).id);

export function buildApi(
  store: Store,
  credentials: Credentials,
  options: { logger?: boolean; rateLimit?: number } = {},
) {
  const app = Fastify({
    logger: options.logger ? { level: "info" } : false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1_048_576,
    requestTimeout: 15_000,
  });
  const principals = new WeakMap<FastifyRequest, Principal>();
  const keys = Object.entries(credentials).map(([token, principal]) => ({
    hash: createHash("sha256").update(token).digest(),
    principal,
  }));
  const limits = new Map<Principal, { start: number; count: number }>();
  const principal = (
    req: FastifyRequest,
    roles: Principal["role"][] = ["provider"],
  ) => {
    const p = principals.get(req);
    check(p, 401, "UNAUTHORIZED");
    check(roles.includes(p.role), 403, "FORBIDDEN");
    return p;
  };
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .header("x-request-id", req.id);
    const route = req.routeOptions.url;
    if (route === "/health" || route === "/docs" || route?.startsWith("/docs/")) return;
    const header = req.headers.authorization;
    check(header && header.startsWith("Bearer "), 401, "UNAUTHORIZED");
    const hash = createHash("sha256").update(header.slice(7)).digest();
    let p: Principal | undefined;
    for (const entry of keys)
      if (timingSafeEqual(hash, entry.hash)) p = entry.principal;
    check(p, 401, "UNAUTHORIZED");
    check(
      store.get("SELECT id FROM hospitals WHERE id=?", p.hospital),
      401,
      "UNAUTHORIZED",
    );
    const now = Date.now();
    const bucket = limits.get(p);
    if (!bucket || now - bucket.start >= 60_000)
      limits.set(p, { start: now, count: 1 });
    else {
      bucket.count++;
      if (bucket.count > (options.rateLimit ?? 120)) {
        reply.header(
          "retry-after",
          Math.ceil((60_000 - (now - bucket.start)) / 1000),
        );
        throw new DomainError(429, "RATE_LIMITED");
      }
    }
    principals.set(req, p);
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof DomainError)
      return reply
        .code(error.status)
        .send({
          error: { code: error.code, details: error.details },
          requestId: req.id,
        });
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send({
          error: {
            code: "INVALID_REQUEST",
            fields: error.issues.map((i) => ({
              path: i.path.join("."),
              code: i.code,
            })),
          },
          requestId: req.id,
        });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply
        .code(status)
        .send({ error: { code: "INVALID_HTTP_REQUEST" }, requestId: req.id });
    // Do not log error messages, request URLs, bodies, headers, or query values (PHI).
    app.log.error(
      { requestId: req.id, code: "INTERNAL_ERROR" },
      "Request failed",
    );
    return reply
      .code(503)
      .send({ error: { code: "TEMPORARILY_UNAVAILABLE" }, requestId: req.id });
  });
  app.get("/health", async () => {
    store.get("SELECT 1");
    return { status: "ok" };
  });
  app.get("/v1/me", async (req) =>
    principal(req, ["provider", "integration", "admin"]),
  );

  app.get("/v1/patients", async (req) => {
    const p = principal(req);
    const q = z
      .object({
        after: z.string().max(100).default(""),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    const rows = store.all(
      `SELECT DISTINCT e.id,e.body FROM entities e JOIN entities a ON a.hospital=e.hospital
      AND a.kind='assignment' AND json_extract(a.body,'$.patientId')=e.id
      WHERE e.hospital=? AND e.kind='patient' AND json_extract(a.body,'$.providerId')=?
      AND json_extract(a.body,'$.active')=1 AND e.id>? ORDER BY e.id LIMIT ?`,
      p.hospital,
      p.provider,
      q.after,
      q.limit,
    );
    store.audit(p.hospital, p.provider, "PATIENT_LIST_READ", "patient-list");
    return {
      items: rows.map((row) => JSON.parse(row.body)),
      nextCursor: rows.length === q.limit ? rows.at(-1)!.id : null,
    };
  });
  app.get("/v1/visits/:id", async (req) => {
    const p = principal(req);
    const identifier = resourceId(req);
    const visit = store.entity(p.hospital, "visit", identifier);
    check(
      visit && assigned(store, p.hospital, p.provider, identifier, true),
      404,
      "VISIT_NOT_FOUND",
    );
    store.audit(p.hospital, p.provider, "VISIT_READ", identifier);
    return {
      ...visit,
      patient: store.entity(p.hospital, "patient", visit.patientId),
    };
  });
  app.post("/v1/charges", async (req) =>
    save(store, principal(req), saveCharge.parse(req.body)),
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
    const identifier = resourceId(req);
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
    const results = batch.operations.map((op) => {
      try {
        return {
          operationId: op.operationId,
          status: 200,
          result: save(store, p, op),
        };
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        return {
          operationId: op.operationId,
          status: error.status,
          error: { code: error.code, details: error.details },
        };
      }
    });
    return reply.code(207).send({ results });
  });
  app.post("/v1/submissions", async (req, reply) =>
    reply
      .code(202)
      .send(submitCharges(store, principal(req), submit.parse(req.body))),
  );
  app.get("/v1/submissions/:id", async (req) => {
    const p = principal(req);
    const identifier = resourceId(req);
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
    retrySubmission(store, principal(req), resourceId(req)),
  );
  app.post("/v1/integrations/patient-events", async (req, reply) => {
    const p = principal(req, ["integration"]);
    const result = consume(store, p.hospital, req.body);
    return reply.code(result.status === "APPLIED" ? 200 : 202).send(result);
  });
  app.get("/v1/admin/inbox", async (req) => {
    const p = principal(req, ["admin"]);
    const q = pagination.parse(req.query);
    store.audit(p.hospital, p.provider, "INBOX_READ", "inbox");
    return {
      items: store.all(
        "SELECT rowid AS cursor,id,status,error,received_at FROM inbox WHERE hospital=? AND rowid>? ORDER BY rowid LIMIT ?",
        p.hospital,
        q.after,
        q.limit,
      ),
    };
  });
  app.post("/v1/admin/inbox/replay", async (req) => {
    const p = principal(req, ["admin"]);
    return { results: replayWaiting(store, p.hospital) };
  });
  app.get("/v1/admin/audit", async (req) => {
    const p = principal(req, ["admin"]);
    const q = pagination.parse(req.query);
    store.audit(p.hospital, p.provider, "AUDIT_READ", "audit");
    return {
      items: store.all(
        "SELECT * FROM audit WHERE hospital=? AND sequence>? ORDER BY sequence LIMIT ?",
        p.hospital,
        q.after,
        q.limit,
      ),
    };
  });
  app.get("/v1/admin/metrics", async (req) => {
    const p = principal(req, ["admin"]);
    return {
      submissions: store.all(
        "SELECT status,COUNT(*) AS count FROM submissions WHERE hospital=? GROUP BY status",
        p.hospital,
      ),
      events: store.all(
        "SELECT status,COUNT(*) AS count FROM inbox WHERE hospital=? GROUP BY status",
        p.hospital,
      ),
    };
  });
  registerDocumentation(app);
  return app;
}
