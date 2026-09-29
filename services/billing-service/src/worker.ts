import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store, type Json } from "./store.js";
export type BillingResponse = {
  status: number;
  body: Json;
  retryAfter?: number;
};
export interface BillingTransport {
  submit(
    url: string,
    hospital: string,
    payload: Json,
  ): Promise<BillingResponse>;
  lookup(
    url: string,
    hospital: string,
    submissionId: string,
  ): Promise<BillingResponse>;
}
export class HttpBilling implements BillingTransport {
  constructor(
    private readonly token: string,
    private readonly timeoutMs = 5000,
  ) {}
  private async request(
    url: string,
    hospital: string,
    method: string,
    payload?: Json,
  ): Promise<BillingResponse> {
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-hospital-id": hospital,
        "x-correlation-id": payload?.submissionId ?? randomUUID(),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    // Bound untrusted responses; error bodies are never logged or stored verbatim.
    const reader = response.body?.getReader();
    let text = "";
    let size = 0;
    if (reader) {
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1048576) {
          await reader.cancel();
          throw new Error("BILLING_RESPONSE_TOO_LARGE");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    }
    let body: Json = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* protocol validation handles empty/invalid JSON */
    }
    const retry = response.headers.get("retry-after");
    const retryMs =
      retry === null
        ? undefined
        : /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : Date.parse(retry) - Date.now();
    return {
      status: response.status,
      body,
      retryAfter:
        retryMs !== undefined && Number.isFinite(retryMs)
          ? Math.max(0, retryMs)
          : undefined,
    };
  }
  submit(url: string, hospital: string, payload: Json) {
    return this.request(`${url}/charges/submit`, hospital, "POST", payload);
  }
  lookup(url: string, hospital: string, identifier: string) {
    return this.request(
      `${url}/charges/submissions/${encodeURIComponent(identifier)}`,
      hospital,
      "GET",
    );
  }
}
import { validateAck } from "@rounding/contracts/billing";
export class BillingWorker {
  constructor(
    private store: Store,
    private transport: BillingTransport,
    private clock: () => number = Date.now,
    private random: () => number = Math.random,
  ) {}
  private async claim(): Promise<Json | undefined> {
    const now = this.clock();
    return await this.store.transaction(async () => {
      const row = await this.store.get(
        `SELECT s.*,h.billing_url FROM billing_submissions s JOIN hospitals h ON h.id=s.hospital
        WHERE (s.status IN ('QUEUED','RETRY') AND s.next_at<=?) OR (s.status='SENDING' AND s.lease_until<=?)
        ORDER BY s.next_at,s.id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        now,
        now,
      );
      if (!row) return;
      const token = randomUUID();
      await this.store.run(
        `UPDATE billing_submissions SET status='SENDING',attempts=attempts+1,lease_token=?,lease_until=?,first_attempt=COALESCE(first_attempt,?) WHERE hospital=? AND id=?`,
        token,
        now + 60000,
        now,
        row.hospital,
        row.id,
      );
      await this.store.audit(
        row.hospital,
        "billing-worker",
        "BILLING_ATTEMPT",
        row.id,
      );
      return {
        ...row,
        lease_token: token,
        attempts: row.attempts + 1,
        first_attempt: row.first_attempt ?? now,
      };
    });
  }
  private async finish(
    row: Json,
    status: string,
    error: string | null,
    ack: Json | null = null,
    delay = 0,
  ) {
    await this.store.transaction(async () => {
      const current = await this.store.get(
        "SELECT lease_token FROM billing_submissions WHERE hospital=? AND id=? FOR UPDATE",
        row.hospital,
        row.id,
      );
      if (current?.lease_token !== row.lease_token) return; // Fencing: expired worker cannot commit.
      await this.store.run(
        "UPDATE billing_submissions SET status=?,error=?,response=?,next_at=?,lease_until=0,lease_token=NULL WHERE hospital=? AND id=?",
        status,
        error,
        ack ? JSON.stringify(ack) : null,
        delay ? this.clock() + delay : 0,
        row.hospital,
        row.id,
      );
      await this.store.audit(
        row.hospital,
        "billing-worker",
        `BILLING_${status}`,
        row.id,
      );
    });
  }
  private async retry(row: Json, code: string, retryAfter?: number) {
    if (row.attempts >= 10) {
      await this.finish(row, "REVIEW", "RETRY_LIMIT_REACHED");
      return;
    }
    const backoff = Math.min(30000, 1000 * 2 ** Math.min(row.attempts - 1, 5));
    await this.finish(
      row,
      "RETRY",
      code,
      null,
      Math.max(retryAfter ?? 0, backoff + Math.floor(this.random() * 500)),
    );
  }
  /** One leased job; no network IO inside a database transaction. */
  async tick(): Promise<boolean> {
    const row = await this.claim();
    if (!row) return false;
    try {
      if (row.attempts > 1) {
        const lookup = await this.transport.lookup(
          row.billing_url,
          row.hospital,
          row.id,
        );
        if (lookup.status === 200) {
          const ack = validateAck(lookup.body, row);
          if (ack) {
            await this.finish(row, ack.status, null, ack);
            return true;
          }
          // The assignment's lookup may return only a summary. Within the window,
          // replay retrieves the original per-item acknowledgment with the same key.
        }
        if (![200, 404].includes(lookup.status)) {
          await this.retry(
            row,
            "RECONCILIATION_UNAVAILABLE",
            lookup.retryAfter,
          );
          return true;
        }
      }
      // Conservative margin before the external 24-hour deduplication expiry.
      // Even a 404 cannot prove an earlier timed-out request did not commit.
      if (this.clock() - row.first_attempt >= 23 * 60 * 60 * 1000) {
        await this.finish(row, "REVIEW", "IDEMPOTENCY_WINDOW_EXPIRED");
        return true;
      }
      const response = await this.transport.submit(
        row.billing_url,
        row.hospital,
        JSON.parse(row.payload),
      );
      if (response.status === 200) {
        const ack = validateAck(response.body, row);
        if (ack) await this.finish(row, ack.status, null, ack);
        else await this.retry(row, "INVALID_BILLING_ACK");
      } else if (response.status === 400)
        await this.finish(row, "FAILED", "BILLING_VALIDATION_ERROR");
      else if (response.status === 429 || response.status >= 500)
        await this.retry(
          row,
          "BILLING_TEMPORARILY_UNAVAILABLE",
          response.retryAfter,
        );
      else
        await this.finish(
          row,
          "REVIEW",
          "BILLING_CONFIGURATION_OR_PROTOCOL_ERROR",
        );
    } catch {
      await this.retry(row, "BILLING_NETWORK_ERROR");
    }
    return true;
  }
}
