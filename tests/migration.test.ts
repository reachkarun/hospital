import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { migrate } from "../scripts/migrate-monolith.js";
import { Store as PatientStore } from "../services/patient-service/src/store.js";
import { Store as ChargeStore } from "../services/charge-service/src/store.js";
import { Store as BillingStore } from "../services/billing-service/src/store.js";
import { seed } from "../services/patient-service/src/seed.js";
import {
  save,
  submitCharges,
} from "../services/charge-service/src/charge/charge-operations.js";
import { saveCharge, digest } from "@rounding/contracts";
import { demoCredentials } from "@rounding/platform/config";

test("offline migration preserves external key, first attempt, revisions and receipts, and is restartable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rounding-migration-"));
  const source = join(directory, "legacy.db");
  try {
    const p = new PatientStore(source);
    seed(p, "http://billing-mock:4001/api/v1");
    p.close();
    const c = new ChargeStore(source);
    const principal = demoCredentials["demo-provider-one"]!;
    const resolve = async () => ({
      hospitalId: "HOSP-001",
      providerId: "PROV-789",
      visitId: "VISIT-001",
      patientId: "PAT-456",
      patientMrn: "SYNTHETIC-HOSP-001",
      providerNpi: "1234567890",
      admissionDate: "2026-01-14T08:00:00Z",
    });
    await save(
      c,
      principal,
      saveCharge.parse({
        operationId: "legacy-op",
        chargeId: "legacy-charge",
        expectedVersion: 0,
        charge: {
          visitId: "VISIT-001",
          serviceCode: "99213",
          quantity: 1,
          dateOfService: "2026-01-15",
        },
      }),
      resolve,
    );
    const sub = await submitCharges(
      c,
      principal,
      { clientSubmissionId: "legacy-mobile-key", chargeIds: ["legacy-charge"] },
      resolve,
    );
    const oldFirst = Date.now() - 90_000_000;
    c.run(
      "UPDATE submissions SET status='SENDING',attempts=2,first_attempt=?,lease_until=?",
      oldFirst,
      Date.now() + 60_000,
    );
    const original = c.get("SELECT * FROM submissions")!;
    c.close();
    const paths = {
      patient: join(directory, "patient.db"),
      charge: join(directory, "charge.db"),
      billing: join(directory, "billing.db"),
    };
    assert.equal(migrate(source, paths).charges, 1);
    assert.equal(migrate(source, paths).charges, 1);
    const billing = new BillingStore(paths.billing);
    const job = billing.get("SELECT * FROM submissions")!;
    assert.equal(job.id, sub.submissionId);
    assert.equal(job.payload, original.payload);
    assert.equal(job.first_attempt, oldFirst);
    assert.equal(
      job.client_key,
      JSON.parse(original.payload).clientSubmissionId,
    );
    assert.equal(job.digest, digest(JSON.parse(original.payload)));
    assert.equal(job.status, "RETRY");
    assert.equal(job.lease_until, 0);
    billing.close();
    const charge = new ChargeStore(paths.charge);
    assert.equal(
      charge.get("SELECT client_key FROM submissions")!.client_key,
      "legacy-mobile-key",
    );
    assert.equal(
      charge.get("SELECT COUNT(*) AS n FROM charge_revisions")!.n,
      2,
    );
    assert.equal(charge.get("SELECT COUNT(*) AS n FROM operations")!.n, 1);
    charge.close();
    const retained = new ChargeStore(source);
    assert.equal(
      retained.get("SELECT status FROM submissions")!.status,
      "SENDING",
    );
    retained.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("each project has its own build manifest and no cross-service implementation imports", () => {
  for (const service of [
    "gateway",
    "patient-service",
    "charge-service",
    "billing-service",
    "billing-mock",
  ]) {
    const directory = join(process.cwd(), "services", service);
    const pkg = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
    assert.ok(pkg.scripts.build && pkg.scripts.start);
    assert.ok(
      readFileSync(join(directory, "Dockerfile"), "utf8").includes(
        `services/${service}/dist`,
      ),
    );
    const sourceRoot = join(directory, "src");
    for (const file of readdirSync(sourceRoot, {
      recursive: true,
      encoding: "utf8",
    }).filter((f) => f.endsWith(".ts"))) {
      const sourcePath = join(sourceRoot, file);
      const source = readFileSync(sourcePath, "utf8");
      for (const match of source.matchAll(
        /(?:from\s+|import\s*\()['"]([^'"]+)['"]/g,
      )) {
        const specifier = match[1]!;
        assert.doesNotMatch(
          specifier,
          /^@rounding\/(?:patient-service|charge-service|billing-service|gateway|billing-mock)(?:\/|$)/,
        );
        if (specifier.startsWith(".")) {
          const target = relative(
            sourceRoot,
            resolve(dirname(sourcePath), specifier),
          );
          assert.ok(
            target !== ".." &&
              !target.startsWith(`..${sep}`) &&
              !isAbsolute(target),
            `${sourcePath} imports outside its service: ${specifier}`,
          );
        }
      }
    }
  }
});
