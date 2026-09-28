import Fastify, { LogController, type FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { ZodError, z } from "zod";
import { check, DomainError, type Principal } from "@rounding/contracts";
import type { Credentials } from "./config.js";
import type { Database } from "./db.js";

const hash = (s: string) => createHash("sha256").update(s).digest();
export function createHttp(
  credentials: Credentials,
  options: {
    service: string;
    serviceToken?: string;
    logger?: boolean;
    rateLimit?: number;
    database?: Database;
  },
) {
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1_048_576,
    requestTimeout: 15_000,
  });
  const identities = new WeakMap<FastifyRequest, Principal>();
  const keys = Object.entries(credentials).map(([token, p]) => ({
    hash: hash(token),
    p,
  }));
  const buckets = new Map<Principal, { start: number; count: number }>();
  const principal = (
    req: FastifyRequest,
    roles: Principal["role"][] = ["provider"],
  ) => {
    const p = identities.get(req);
    check(p, 401, "UNAUTHORIZED");
    check(roles.includes(p.role), 403, "FORBIDDEN");
    return p;
  };
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .header("x-request-id", req.id);
    const route = req.routeOptions.url ?? "";
    if (route === "/health" || route === "/docs" || route.startsWith("/docs/"))
      return;
    if (route.startsWith("/internal/")) {
      const token = req.headers["x-service-token"];
      check(
        options.serviceToken &&
          typeof token === "string" &&
          timingSafeEqual(hash(token), hash(options.serviceToken)),
        401,
        "SERVICE_UNAUTHORIZED",
      );
      return;
    }
    const token = req.headers.authorization;
    check(token?.startsWith("Bearer "), 401, "UNAUTHORIZED");
    const p = keys.find((k) =>
      timingSafeEqual(hash(token!.slice(7)), k.hash),
    )?.p;
    check(p, 401, "UNAUTHORIZED");
    if (options.database)
      check(
        options.database.get("SELECT id FROM hospitals WHERE id=?", p.hospital),
        401,
        "UNAUTHORIZED",
      );
    const now = Date.now();
    const bucket = buckets.get(p);
    if (!bucket || now - bucket.start >= 60_000)
      buckets.set(p, { start: now, count: 1 });
    else if (++bucket.count > (options.rateLimit ?? 240)) {
      reply.header(
        "retry-after",
        Math.ceil((60_000 - now + bucket.start) / 1000),
      );
      throw new DomainError(429, "RATE_LIMITED");
    }
    identities.set(req, p);
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError)
      return reply
        .code(err.status)
        .send({
          error: { code: err.code, details: err.details },
          requestId: req.id,
        });
    if (err instanceof ZodError)
      return reply
        .code(400)
        .send({
          error: {
            code: "INVALID_REQUEST",
            fields: err.issues.map((i) => ({
              path: i.path.join("."),
              code: i.code,
            })),
          },
          requestId: req.id,
        });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply
        .code(status)
        .send({ error: { code: "INVALID_HTTP_REQUEST" }, requestId: req.id });
    app.log.error(
      { requestId: req.id, code: "INTERNAL_ERROR" },
      "Request failed",
    );
    return reply
      .code(503)
      .send({ error: { code: "TEMPORARILY_UNAVAILABLE" }, requestId: req.id });
  });
  app.get("/health", async () => {
    options.database?.get("SELECT 1");
    return { status: "ok", service: options.service };
  });
  app.get("/v1/me", async (req) =>
    principal(req, ["provider", "integration", "admin"]),
  );
  if (options.database) {
    const db = options.database;
    app.get("/v1/admin/audit", async (req) => {
      const p = principal(req, ["admin"]);
      const q = z
        .object({
          after: z.coerce.number().int().nonnegative().default(0),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(req.query);
      db.audit(p.hospital, p.provider, "AUDIT_READ", "audit");
      return {
        service: options.service,
        items: db.all(
          "SELECT * FROM audit WHERE hospital=? AND sequence>? ORDER BY sequence LIMIT ?",
          p.hospital,
          q.after,
          q.limit,
        ),
      };
    });
  }
  return { app, principal };
}
