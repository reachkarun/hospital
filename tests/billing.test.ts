import { test, testDatabaseConfig, seed, seedHospitals } from "./database.js";
import assert from "node:assert/strict";
import { Store } from "../services/billing-service/src/store.js";
import {
  BillingWorker,
  type BillingTransport,
} from "../services/billing-service/src/worker.js";
import { receiveJob } from "../services/billing-service/src/billing/billing-jobs.js";
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
async function setup() {
  const s = new Store(testDatabaseConfig());
  await seedHospitals(s, "http://external/api/v1");
  await receiveJob(s, payload());
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
test("billing service owns only delivery state, and durable job IDs reject changed payloads", async () => {
  const s = await setup();
  assert.equal((await receiveJob(s, payload())).submissionId, "job-one");
  await assert.rejects(
    async () => await receiveJob(s, { ...payload(), patientMrn: "changed" }),
    /BILLING_JOB_ID_REUSED/,
  );
  assert.equal(
    await s.get("SELECT id FROM charge_submissions LIMIT 1"),
    undefined,
  );
  assert.equal(
    await s.get("SELECT id FROM patient_entities LIMIT 1"),
    undefined,
  );
  await s.close();
});
test("billing outage retries with exponential backoff", async () => {
  const s = await setup();
  let time = 100000;
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
  assert.equal(
    (await s.get("SELECT status FROM billing_submissions"))!.status,
    "RETRY",
  );
  assert.equal(await worker.tick(), false);
  time += 1000;
  await worker.tick();
  assert.equal(
    (await s.get("SELECT status FROM billing_submissions"))!.status,
    "ACCEPTED",
  );
  await s.close();
});
test("lost external acknowledgment reconciles without another POST", async () => {
  const s = await setup();
  let time = 100000;
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
  assert.equal(
    (await s.get("SELECT status FROM billing_submissions"))!.status,
    "ACCEPTED",
  );
  await s.close();
});
test("24-hour idempotency expiry never permits blind resubmission", async () => {
  const s = await setup();
  let time = 100000;
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
    (await s.get("SELECT status,error FROM billing_submissions"))!.error,
    "IDEMPOTENCY_WINDOW_EXPIRED",
  );
  await s.close();
});
test("summary-only lookup repeats the identical request inside the safe window", async () => {
  const s = await setup();
  let time = 100000;
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
  await s.close();
});
test("Retry-After, permanent validation failure, and malformed acknowledgments are handled", async () => {
  const s = await setup();
  let time = 100000;
  let count = 0;
  const worker = new BillingWorker(
    s,
    transport({
      submit: async () =>
        ++count === 1
          ? { status: 429, body: {}, retryAfter: 60000 }
          : { status: 400, body: {} },
    }),
    () => time,
    () => 0,
  );
  await worker.tick();
  time += 30000;
  assert.equal(await worker.tick(), false);
  time += 30000;
  await worker.tick();
  assert.equal(
    (await s.get("SELECT status FROM billing_submissions"))!.status,
    "FAILED",
  );
  await s.run("DELETE FROM billing_submissions");
  await s.close();
  const bad = await setup();
  await new BillingWorker(
    bad,
    transport({
      submit: async () => ({
        status: 200,
        body: { submissionId: "job-one", status: "ACCEPTED" },
      }),
    }),
  ).tick();
  assert.equal(
    (await bad.get("SELECT status FROM billing_submissions"))!.status,
    "RETRY",
  );
  await bad.close();
});
test("competing worker leases fence an obsolete response", async () => {
  const s = await setup();
  let time = 100000;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const slow = new BillingWorker(
    s,
    transport({
      submit: async (_u, _h, p) => {
        started!();
        await gate;
        return { status: 200, body: ack(p) };
      },
    }),
    () => time,
  );
  const first = slow.tick();
  await startedPromise;
  const other = new BillingWorker(
    s,
    transport({ submit: async () => ({ status: 400, body: {} }) }),
    () => time,
  );
  assert.equal(await other.tick(), false);
  time += 60001;
  await other.tick();
  release();
  await first;
  assert.equal(
    (await s.get("SELECT status FROM billing_submissions"))!.status,
    "FAILED",
  );
  await s.close();
});
test("retry ceiling parks work for review", async () => {
  const s = await setup();
  let time = 100000;
  const worker = new BillingWorker(
    s,
    transport({ submit: async () => ({ status: 503, body: {} }) }),
    () => time,
    () => 0,
  );
  for (let n = 0; n < 10; n++) {
    await worker.tick();
    time += 60000;
  }
  assert.equal(
    (await s.get("SELECT status FROM billing_submissions"))!.status,
    "REVIEW",
  );
  assert.equal(await worker.tick(), false);
  await s.close();
});
