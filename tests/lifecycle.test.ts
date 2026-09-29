import { test, testDatabaseConfig, seed, seedHospitals } from "./database.js";
import assert from "node:assert/strict";
import { Module } from "@nestjs/common";
import { createApplication, PlatformModule } from "@rounding/platform/http";
import { Database } from "@rounding/platform/db";
import { background, listen } from "@rounding/platform/runtime";
@Module({})
class LifecycleTestModule {}
test("graceful shutdown drains in-flight delivery before closing service storage", async () => {
  const app = await createApplication({
    module: LifecycleTestModule,
    imports: [PlatformModule.register({ service: "test", credentials: {} })],
  });
  const db = new Database(testDatabaseConfig());
  let release!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    release = resolve;
  });
  let committed = false;
  background(app, async () => {
    await inFlight;
    await db.get("SELECT 1");
    committed = true;
  });
  await listen(app, { host: "127.0.0.1", port: 0 }, db);
  const closing = app.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(await db.get("SELECT 1"));
  release();
  await closing;
  assert.equal(committed, true);
  await assert.rejects(async () => await db.get("SELECT 1"));
});
