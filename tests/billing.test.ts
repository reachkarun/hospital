import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../services/billing-service/src/store.js";
import {
  BillingWorker,
  type BillingTransport,
} from "../services/billing-service/src/worker.js";
import { receiveJob } from "../services/billing-service/src/app.js";
import { seedHospitals } from "@rounding/platform/runtime";
import type { Json } from "@rounding/platform/db";

export function payload(id = "job-one") {
  return {
    submissionId: id,
    hospitalId: "HOSP-001",
    providerId: "PROV-789",
    providerNpi: "1234567890",
    patientId: "PAT-456",
    patientMrn: "SYNTHETIC-HOSP-001",
    visitId: "VISIT-001",
    submittedAt: "2026-01-15T12:00:00Z",
    clientSubmissionId: id,
    charges: [
      {
        chargeId: "charge-one",
        serviceCode: "99213",
        quantity: 1,
        dateOfService: "2026-01-15",
        modifiers: [],
        notes: null,
      },
    ],
  };
}
function setup() {
  const s = new Store();
  seedHospitals(s, "http://external/api/v1");
  receiveJob(s, payload());
  return s;
}
function ack(p: Json) {
  return {
    submissionId: p.submissionId,
    status: "ACCEPTED",
    billingReference: "BILL-123",
    acceptedCharges: p.charges.map((c: Json) => ({
      chargeId: c.chargeId,
      status: "ACCEPTED",
    })),
    rejectedCharges: [],
  };
}
function transport(
  overrides: Partial<BillingTransport> = {},
): BillingTransport {
  return {
    lookup: async () => ({ status: 404, body: {} }),
    submit: async (_u, _h, p) => ({ status: 200, body: ack(p) }),
    ...overrides,
  };
}

test("billing service owns only delivery state, and durable job IDs reject changed payloads", () => {
  const s = setup();
  assert.equal(receiveJob(s, payload()).submissionId, "job-one");
  assert.throws(
    () => receiveJob(s, { ...payload(), patientMrn: "changed" }),
    /BILLING_JOB_ID_REUSED/,
  );
  assert.equal(
    s.get("SELECT name FROM sqlite_master WHERE name='charges'"),
    undefined,
  );
  assert.equal(
    s.get("SELECT name FROM sqlite_master WHERE name='entities'"),
    undefined,
  );
  s.close();
});
test("billing outage retries with exponential backoff", async () => {
  const s = setup();
  let time = 100_000;
  let count = 0;
  const worker = new BillingWorker(
    s,
    transport({
      submit: async (_u, _h, p) =>
        ++count === 1
          ? { status: 503, body: {} }
          : { status: 200, body: ack(p) },
    }),
    () => time,
    () => 0,
  );
  await worker.tick();
  assert.equal(s.get("SELECT status FROM submissions")!.status, "RETRY");
  assert.equal(await worker.tick(), false);
  time += 1000;
  await worker.tick();
  assert.equal(s.get("SELECT status FROM submissions")!.status, "ACCEPTED");
  s.close();
});
test("lost external acknowledgment reconciles without another POST", async () => {
  const s = setup();
  let time = 100_000;
  let count = 0;
  let receipt: Json = {};
  const worker = new BillingWorker(
    s,
    transport({
      submit: async (_u, _h, p) => {
        count++;
        receipt = ack(p);
        throw new Error("lost response");
      },
      lookup: async () => ({ status: 200, body: receipt }),
    }),
    () => time,
    () => 0,
  );
  await worker.tick();
  time += 1000;
  await worker.tick();
  assert.equal(count, 1);
  assert.equal(s.get("SELECT status FROM submissions")!.status, "ACCEPTED");
  s.close();
});
test("24-hour idempotency expiry never permits blind resubmission", async () => {
  const s = setup();
  let time = 100_000;
  let count = 0;
  const worker = new BillingWorker(
    s,
    transport({
      submit: async () => {
        count++;
        throw new Error("timeout");
      },
    }),
    () => time,
    () => 0,
  );
  await worker.tick();
  time += 24 * 60 * 60 * 1000;
  await worker.tick();
  assert.equal(count, 1);
  assert.equal(
    s.get("SELECT status,error FROM submissions")!.error,
    "IDEMPOTENCY_WINDOW_EXPIRED",
  );
  s.close();
});
test("summary-only lookup repeats the identical request inside the safe window", async () => {
  const s = setup();
  let time = 100_000;
  const requests: Json[] = [];
  const worker = new BillingWorker(
    s,
    transport({
      submit: async (_u, _h, p) => {
        requests.push(p);
        if (requests.length === 1) throw new Error("lost");
        return { status: 200, body: ack(p) };
      },
      lookup: async () => ({
        status: 200,
        body: { submissionId: "job-one", status: "ACCEPTED" },
      }),
    }),
    () => time,
    () => 0,
  );
  await worker.tick();
  time += 1000;
  await worker.tick();
  assert.deepEqual(requests[0], requests[1]);
  s.close();
});
test("Retry-After, permanent validation failure, and malformed acknowledgments are handled", async () => {
  const s = setup();
  let time = 100_000;
  let count = 0;
  const worker = new BillingWorker(
    s,
    transport({
      submit: async () =>
        ++count === 1
          ? { status: 429, body: {}, retryAfter: 60_000 }
          : { status: 400, body: {} },
    }),
    () => time,
    () => 0,
  );
  await worker.tick();
  time += 30_000;
  assert.equal(await worker.tick(), false);
  time += 30_000;
  await worker.tick();
  assert.equal(s.get("SELECT status FROM submissions")!.status, "FAILED");
  s.close();
  const bad = setup();
  await new BillingWorker(
    bad,
    transport({
      submit: async () => ({
        status: 200,
        body: { submissionId: "job-one", status: "ACCEPTED" },
      }),
    }),
  ).tick();
  assert.equal(bad.get("SELECT status FROM submissions")!.status, "RETRY");
  bad.close();
});
test("competing worker leases fence an obsolete response", async () => {
  const s = setup();
  let time = 100_000;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const slow = new BillingWorker(
    s,
    transport({
      submit: async (_u, _h, p) => {
        await gate;
        return { status: 200, body: ack(p) };
      },
    }),
    () => time,
  );
  const first = slow.tick();
  const other = new BillingWorker(
    s,
    transport({ submit: async () => ({ status: 400, body: {} }) }),
    () => time,
  );
  assert.equal(await other.tick(), false);
  time += 60_001;
  await other.tick();
  release();
  await first;
  assert.equal(s.get("SELECT status FROM submissions")!.status, "FAILED");
  s.close();
});
test("retry ceiling parks work for review", async () => {
  const s = setup();
  let time = 100_000;
  const worker = new BillingWorker(
    s,
    transport({ submit: async () => ({ status: 503, body: {} }) }),
    () => time,
    () => 0,
  );
  for (let n = 0; n < 10; n++) {
    await worker.tick();
    time += 60_000;
  }
  assert.equal(s.get("SELECT status FROM submissions")!.status, "REVIEW");
  assert.equal(await worker.tick(), false);
  s.close();
});
