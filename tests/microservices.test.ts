import { httpRequest } from "./http.js";
import type { TestContext } from "node:test";
import { test, testDatabaseConfig, seed, seedHospitals } from "./database.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store as PatientStore } from "../services/patient-service/src/store.js";
import { Store as ChargeStore } from "../services/charge-service/src/store.js";
import { Store as BillingStore } from "../services/billing-service/src/store.js";
import { buildPatientApi } from "../services/patient-service/src/app.js";
import { buildChargeApi } from "../services/charge-service/src/app.js";
import { buildBillingApi } from "../services/billing-service/src/app.js";
import { buildGateway } from "../services/gateway/src/app.js";
import { buildMock } from "../services/billing-mock/src/app.js";
import {
  BillingWorker,
  HttpBilling,
} from "../services/billing-service/src/worker.js";
import {
  Dispatcher,
  billingClient,
} from "../services/charge-service/src/dispatcher.js";
import { patientClient } from "../services/charge-service/src/patient-client.js";
import { Database, type Json } from "@rounding/platform/db";
import { demoCredentials } from "@rounding/platform/config";
import { sampleEvent } from "@rounding/contracts/sample";
const headers = { authorization: "Bearer demo-provider-one" };
const draft = (id = "one", code = "99213", version = 0) => ({
  operationId: `op-${id}-${version}`,
  chargeId: id,
  expectedVersion: version,
  charge: {
    visitId: "VISIT-001",
    serviceCode: code,
    quantity: 1,
    dateOfService: "2026-01-15",
    notes: "Synthetic note",
  },
});
async function fixture(t: TestContext) {
  const patient = new PatientStore(testDatabaseConfig());
  const charge = new ChargeStore(testDatabaseConfig());
  const billing = new BillingStore(testDatabaseConfig());
  const mockStore = new Database(testDatabaseConfig());
  const mock = await buildMock(mockStore, "external-secret");
  await mock.listen(0, "127.0.0.1");
  const mockUrl = await mock.getUrl();
  await seed(patient, `${mockUrl}/api/v1`);
  await seedHospitals(charge, `${mockUrl}/api/v1`);
  await seedHospitals(billing, `${mockUrl}/api/v1`);
  const patientApi = await buildPatientApi(
    patient,
    demoCredentials,
    "patient-secret",
  );
  await patientApi.listen(0, "127.0.0.1");
  const patientUrl = await patientApi.getUrl();
  const billingApi = await buildBillingApi(
    billing,
    demoCredentials,
    "billing-secret",
  );
  await billingApi.listen(0, "127.0.0.1");
  const billingUrl = await billingApi.getUrl();
  const chargeApi = await buildChargeApi(
    charge,
    demoCredentials,
    patientClient(patientUrl, "patient-secret"),
  );
  await chargeApi.listen(0, "127.0.0.1");
  const chargeUrl = await chargeApi.getUrl();
  const gateway = await buildGateway(demoCredentials, {
    patient: patientUrl,
    charge: chargeUrl,
    billing: billingUrl,
  });
  await gateway.listen(0, "127.0.0.1");
  let time = Date.now();
  const jobs = billingClient(billingUrl, "billing-secret");
  const dispatcher = new Dispatcher(charge, jobs, () => time);
  const worker = new BillingWorker(
    billing,
    new HttpBilling("external-secret"),
    () => time,
    () => 0,
  );
  const pump = async () => {
    time += 3000;
    await dispatcher.tick();
    await worker.tick();
    time += 3000;
    await dispatcher.tick();
  };
  const request = async (
    url: string,
    payload?: Json,
    token = "demo-provider-one",
  ) =>
    httpRequest(gateway, {
      method: payload === undefined ? "GET" : "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });
  t.after(async () => {
    await Promise.all([
      gateway.close(),
      chargeApi.close(),
      patientApi.close(),
      billingApi.close(),
      mock.close(),
    ]);
    await patient.close();
    await charge.close();
    await billing.close();
    await mockStore.close();
  });
  return {
    patient,
    charge,
    billing,
    gateway,
    patientApi,
    billingApi,
    chargeApi,
    mock,
    mockStore,
    jobs,
    pump,
    dispatcher,
    worker,
    request,
    advance: () => {
      time += 3000;
    },
  };
}
test("shared MySQL database, service auth, gateway routing, and Swagger request examples", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.charge.get("SELECT DATABASE() AS name"))!.name,
    testDatabaseConfig().database,
  );
  assert.equal(
    (await f.patient.get("SELECT DATABASE() AS name"))!.name,
    testDatabaseConfig().database,
  );
  assert.equal(
    (
      await httpRequest(f.patientApi, {
        method: "POST",
        url: "/internal/v1/encounters/resolve",
        payload: {
          hospitalId: "HOSP-001",
          providerId: "PROV-789",
          visitId: "VISIT-001",
        },
        headers,
      })
    ).statusCode,
    401,
  );
  assert.equal((await httpRequest(f.gateway, "/v1/patients")).statusCode, 401);
  assert.equal((await f.request("/internal/v1/jobs")).statusCode, 404);
  assert.equal((await httpRequest(f.gateway, "/docs/")).statusCode, 200);
  assert.equal(
    (await httpRequest(f.gateway, "/docs/swagger-ui-bundle.js")).statusCode,
    200,
  );
  const doc = (await httpRequest(f.gateway, "/docs/json")).json();
  assert.equal(doc.components.securitySchemes.bearerAuth.scheme, "bearer");
  assert.equal(
    (
      await f.request(
        "/v1/charges",
        doc.paths["/v1/charges"].post.requestBody.content["application/json"]
          .example,
      )
    ).statusCode,
    200,
  );
  assert.equal((await f.request("/v1/patients")).json().items.length, 1);
});
test("offline receipts, version conflicts, charge revisions, and tenant isolation survive service split", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/v1/charges", draft())).json().version, 1);
  assert.equal((await f.request("/v1/charges", draft())).json().version, 1);
  const altered = draft();
  altered.charge.quantity = 2;
  assert.equal((await f.request("/v1/charges", altered)).statusCode, 409);
  const result = await f.request("/v1/sync", {
    operations: [draft("two"), { ...draft(), operationId: "stale" }],
  });
  assert.equal(result.statusCode, 207);
  assert.equal(result.json().results[1].error.details.current.version, 1);
  assert.equal(
    (await f.request("/v1/charges/one", undefined, "demo-provider-two"))
      .statusCode,
    404,
  );
  assert.equal(
    (await f.request("/v1/charges", draft("one", "36415", 1))).json().version,
    2,
  );
  assert.equal(
    (await f.charge.get(
      "SELECT COUNT(*) AS n FROM charge_revisions WHERE id=?",
      "one",
    ))!.n,
    2,
  );
  await assert.rejects(
    async () => await f.charge.run("DELETE FROM charge_revisions"),
    /append-only/,
  );
});
test("Patient outage does not prevent exact draft retries or existing charge reads", async (t) => {
  const f = await fixture(t);
  await f.request("/v1/charges", draft());
  await f.patientApi.close();
  assert.equal((await f.request("/v1/charges", draft())).statusCode, 200);
  assert.equal((await f.request("/v1/charges/one")).statusCode, 200);
  assert.equal((await f.request("/v1/charges", draft("new"))).statusCode, 503);
  assert.equal(
    await f.charge.get("SELECT id FROM charges WHERE id=?", "new"),
    undefined,
  );
});
test("durable HTTP handoff and eventual result projection finish end-to-end", async (t) => {
  const f = await fixture(t);
  await f.request("/v1/charges", draft());
  const request = { clientSubmissionId: "batch", chargeIds: ["one"] };
  const queued = await f.request("/v1/submissions", request);
  assert.equal(queued.statusCode, 202);
  const identifier = queued.json().submissionId;
  assert.equal(
    (await f.request("/v1/submissions", request)).json().submissionId,
    identifier,
  );
  assert.equal(
    (
      await f.request("/v1/submissions", {
        ...request,
        clientSubmissionId: "different",
      })
    ).statusCode,
    409,
  );
  assert.equal(
    await f.billing.get("SELECT id FROM billing_submissions"),
    undefined,
  );
  await f.pump();
  assert.equal(
    (await f.request(`/v1/submissions/${identifier}`)).json().status,
    "ACCEPTED",
  );
  assert.equal((await f.request("/v1/charges/one")).json().status, "ACCEPTED");
  assert.equal(
    (await f.mockStore.get("SELECT COUNT(*) AS n FROM mock_results"))!.n,
    1,
  );
});
test("lost service-to-service receipt replays one billing job without duplicate external effects", async (t) => {
  const f = await fixture(t);
  await f.request("/v1/charges", draft());
  await f.request("/v1/submissions", {
    clientSubmissionId: "lost",
    chargeIds: ["one"],
  });
  const lossy = new Dispatcher(
    f.charge,
    {
      ...f.jobs,
      deliver: async (payload) => {
        await f.jobs.deliver(payload);
        throw new Error("lost HTTP response");
      },
    },
    () => 100000,
  );
  await lossy.tick();
  assert.equal(
    (await f.billing.get("SELECT COUNT(*) AS n FROM billing_submissions"))!.n,
    1,
  );
  await f.pump();
  assert.equal(
    (await f.billing.get("SELECT COUNT(*) AS n FROM billing_submissions"))!.n,
    1,
  );
  assert.equal((await f.request("/v1/charges/one")).json().status, "ACCEPTED");
});
test("partial acceptance corrects only rejected charges, retains reference and billing idempotency", async (t) => {
  const f = await fixture(t);
  await f.request("/v1/charges", draft("good"));
  await f.request("/v1/charges", draft("bad", "99999"));
  const queued = await f.request("/v1/submissions", {
    clientSubmissionId: "partial",
    chargeIds: ["good", "bad"],
  });
  await f.pump();
  const result = (
    await f.request(`/v1/submissions/${queued.json().submissionId}`)
  ).json();
  assert.equal(result.status, "PARTIAL");
  assert.ok(result.billing.billingReference);
  assert.equal(
    (await f.request("/v1/charges", draft("good", "99213", 3))).statusCode,
    409,
  );
  assert.equal(
    (await f.request("/v1/charges", draft("bad", "36415", 3))).statusCode,
    200,
  );
  await f.request("/v1/submissions", {
    clientSubmissionId: "corrected",
    chargeIds: ["bad"],
  });
  await f.pump();
  assert.equal((await f.request("/v1/charges/bad")).json().status, "ACCEPTED");
  assert.equal(
    (await f.mockStore.get("SELECT COUNT(*) AS n FROM mock_results"))!.n,
    2,
  );
});
test("billing service unavailable leaves charge outbox durable and charges locked", async (t) => {
  const f = await fixture(t);
  await f.request("/v1/charges", draft());
  await f.billingApi.close();
  assert.equal(
    (
      await f.request("/v1/submissions", {
        clientSubmissionId: "outage",
        chargeIds: ["one"],
      })
    ).statusCode,
    202,
  );
  await f.dispatcher.tick();
  assert.equal(
    (await f.charge.get("SELECT status FROM charge_submissions"))!.status,
    "QUEUED",
  );
  assert.equal(
    (await f.request("/v1/charges", draft("one", "99213", 2))).statusCode,
    409,
  );
});
test("manual retry command is durable and idempotent without changing external first-attempt age", async (t) => {
  const f = await fixture(t);
  await f.request("/v1/charges", draft());
  const queued = await f.request("/v1/submissions", {
    clientSubmissionId: "expired",
    chargeIds: ["one"],
  });
  const identifier = queued.json().submissionId;
  await f.dispatcher.tick();
  const firstAttempt = Date.now() - 86400000;
  await f.billing.run(
    "UPDATE billing_submissions SET status='REVIEW',attempts=1,first_attempt=?,error='IDEMPOTENCY_WINDOW_EXPIRED'",
    firstAttempt,
  );
  f.advance();
  await f.dispatcher.tick();
  assert.equal(
    (await f.request(`/v1/submissions/${identifier}/retry`, {})).statusCode,
    200,
  );
  f.advance();
  await f.dispatcher.tick();
  assert.equal(
    (await f.billing.get("SELECT first_attempt FROM billing_submissions"))!
      .first_attempt,
    firstAttempt,
  );
  await f.worker.tick();
  f.advance();
  await f.dispatcher.tick();
  assert.equal(
    (await f.request(`/v1/submissions/${identifier}`)).json().status,
    "REVIEW",
  );
  assert.equal(
    (await f.mockStore.get("SELECT COUNT(*) AS n FROM mock_results"))!.n,
    0,
  );
});
test("post-discharge service dates and source integration roles remain enforced", async (t) => {
  const f = await fixture(t);
  const event = {
    ...sampleEvent(),
    messageId: "discharge",
    timestamp: "2026-01-16T12:00:00Z",
    eventType: "VISIT_DISCHARGE",
    payload: {
      patientId: "PAT-456",
      visitId: "VISIT-001",
      dischargeDate: "2026-01-16T12:00:00Z",
      dischargeStatus: "HOME",
    },
  };
  assert.equal(
    (await f.request("/v1/integrations/patient-events", event)).statusCode,
    403,
  );
  assert.equal(
    (
      await f.request(
        "/v1/integrations/patient-events",
        event,
        "demo-integration-one",
      )
    ).statusCode,
    200,
  );
  assert.equal((await f.request("/v1/charges", draft())).statusCode, 200);
  const late = draft("late");
  late.charge.dateOfService = "2026-01-17";
  assert.equal((await f.request("/v1/charges", late)).statusCode, 422);
  assert.equal(
    (
      await f.request(
        "/v1/admin/audit?service=patient",
        undefined,
        "demo-admin-one",
      )
    ).json().service,
    "patient",
  );
});
