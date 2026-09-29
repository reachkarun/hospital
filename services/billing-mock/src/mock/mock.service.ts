import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import { Database as Store, timestamp } from "@rounding/platform/db";
import { digest } from "@rounding/contracts";
import { requestSchema, modeSchema } from "./mock.schemas.js";
@Injectable()
export class MockService {
  constructor(private readonly store: Store) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS mock_results(hospital TEXT,id TEXT,client_key TEXT,digest TEXT,response TEXT,created_at INTEGER,
    PRIMARY KEY(hospital,id),UNIQUE(hospital,client_key));
    CREATE TABLE IF NOT EXISTS mock_modes(hospital TEXT PRIMARY KEY,mode TEXT NOT NULL,remaining INTEGER NOT NULL);`);
  }
  setMode(p: z.infer<typeof modeSchema>) {
    this.store.run(
      "INSERT INTO mock_modes VALUES (?,?,?) ON CONFLICT(hospital) DO UPDATE SET mode=excluded.mode,remaining=excluded.remaining",
      p.hospitalId,
      p.mode,
      p.remaining,
    );
    return p;
  }
  submit(p: z.infer<typeof requestSchema>) {
    const { store } = this;
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
    return result;
  }
  get(hospital: string, identifier: string) {
    const row = this.store.get(
      "SELECT response FROM mock_results WHERE hospital=? AND id=?",
      hospital,
      identifier,
    );
    return row
      ? { code: 200, body: JSON.parse(row.response) }
      : { code: 404, body: { error: "NOT_FOUND" } };
  }
}
