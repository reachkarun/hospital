import Fastify from "fastify";
import { z } from "zod";
import { Database as Store, timestamp } from "@rounding/platform/db";
import { chargeData, digest, id, instant } from "@rounding/contracts";

const requestSchema = z.object({
  submissionId: id,
  clientSubmissionId: id,
  hospitalId: id,
  providerId: id,
  providerNpi: z.string().regex(/^\d{10}$/),
  patientId: id,
  patientMrn: z.string().min(1),
  visitId: id,
  submittedAt: instant,
  charges: z
    .array(chargeData.omit({ visitId: true }).extend({ chargeId: id }))
    .min(1)
    .max(100),
});

/** Standalone mock with persistent deduplication and deterministic failure injection. */
export function buildMock(store: Store, token: string) {
  store.db
    .exec(`CREATE TABLE IF NOT EXISTS mock_results(hospital TEXT,id TEXT,client_key TEXT,digest TEXT,response TEXT,created_at INTEGER,
    PRIMARY KEY(hospital,id),UNIQUE(hospital,client_key));
    CREATE TABLE IF NOT EXISTS mock_modes(hospital TEXT PRIMARY KEY,mode TEXT NOT NULL,remaining INTEGER NOT NULL);`);
  const app = Fastify({ bodyLimit: 1_048_576 });
  app.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions.url === "/health") return;
    if (req.headers.authorization !== `Bearer ${token}`)
      return reply.code(401).send({ error: "UNAUTHORIZED" });
  });
  app.get("/health", async () => ({ status: "ok" }));
  app.post("/admin/mode", async (req, reply) => {
    const parsed = z
      .object({
        hospitalId: id,
        mode: z.enum(["healthy", "outage", "rate-limit", "lost-ack"]),
        remaining: z.number().int().min(0).default(1),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MODE" });
    const p = parsed.data;
    store.run(
      "INSERT INTO mock_modes VALUES (?,?,?) ON CONFLICT(hospital) DO UPDATE SET mode=excluded.mode,remaining=excluded.remaining",
      p.hospitalId,
      p.mode,
      p.remaining,
    );
    return p;
  });
  app.post("/api/v1/charges/submit", async (req, reply) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR" } });
    const p = parsed.data;
    if (p.hospitalId !== req.headers["x-hospital-id"])
      return reply.code(403).send({ error: "HOSPITAL_MISMATCH" });
    const result = store.transaction(() => {
      const hash = digest(p);
      const old = store.get(
        "SELECT * FROM mock_results WHERE hospital=? AND client_key=?",
        p.hospitalId,
        p.clientSubmissionId,
      );
      if (old && Date.now() - old.created_at < 86_400_000)
        return old.digest === hash
          ? { code: 200, body: JSON.parse(old.response) }
          : { code: 409, body: { error: "KEY_REUSED" } };
      const mode = store.get(
        "SELECT * FROM mock_modes WHERE hospital=?",
        p.hospitalId,
      );
      const active = mode && mode.remaining > 0;
      if (active)
        store.run(
          "UPDATE mock_modes SET remaining=remaining-1 WHERE hospital=?",
          p.hospitalId,
        );
      if (active && ["outage", "rate-limit"].includes(mode.mode))
        return {
          code: mode.mode === "outage" ? 503 : 429,
          body: { error: { code: "SERVICE_UNAVAILABLE" } },
        };
      const acceptedCharges = p.charges
        .filter((c) => c.serviceCode !== "99999" && !c.modifiers.includes("99"))
        .map((c) => ({
          chargeId: c.chargeId,
          billingCode: [c.serviceCode, ...c.modifiers].join("-"),
          status: "ACCEPTED",
        }));
      const rejectedCharges = p.charges
        .filter((c) => c.serviceCode === "99999" || c.modifiers.includes("99"))
        .map((c) => ({
          chargeId: c.chargeId,
          status: "REJECTED",
          error: {
            code: "INVALID_SERVICE_CODE_OR_MODIFIER",
            message:
              "Demo rejection: correct service code 99999 or modifier 99.",
          },
        }));
      const response = {
        submissionId: p.submissionId,
        status: !rejectedCharges.length
          ? "ACCEPTED"
          : !acceptedCharges.length
            ? "REJECTED"
            : "PARTIAL",
        acceptedAt: timestamp(),
        billingReference: `BILL-${p.submissionId}`,
        acceptedCharges,
        rejectedCharges,
      };
      // Durable receipt survives mock restarts. Expired keys are not promised deduplication.
      if (old)
        store.run(
          "DELETE FROM mock_results WHERE hospital=? AND client_key=?",
          p.hospitalId,
          p.clientSubmissionId,
        );
      store.run(
        "INSERT INTO mock_results VALUES (?,?,?,?,?,?) ON CONFLICT(hospital,id) DO UPDATE SET response=excluded.response,created_at=excluded.created_at",
        p.hospitalId,
        p.submissionId,
        p.clientSubmissionId,
        hash,
        JSON.stringify(response),
        Date.now(),
      );
      return active && mode.mode === "lost-ack"
        ? { code: 503, body: { error: { code: "ACK_LOST_AFTER_COMMIT" } } }
        : { code: 200, body: response };
    });
    if (result.code === 429) reply.header("retry-after", "2");
    return reply.code(result.code).send(result.body);
  });
  app.get("/api/v1/charges/submissions/:id", async (req, reply) => {
    const hospital = req.headers["x-hospital-id"];
    if (typeof hospital !== "string")
      return reply.code(400).send({ error: "HOSPITAL_REQUIRED" });
    const identifier = (req.params as { id: string }).id;
    const row = store.get(
      "SELECT response FROM mock_results WHERE hospital=? AND id=?",
      hospital,
      identifier,
    );
    return row
      ? JSON.parse(row.response)
      : reply.code(404).send({ error: "NOT_FOUND" });
  });
  return app;
}
