import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import {
  createApplication,
  Internal,
  PlatformModule,
} from "@rounding/platform/http";
import { httpRequest } from "./http.js";

@Controller()
class ProbeController {
  @Get("failure")
  failure() {
    throw new Error("private database connection details");
  }

  @Get("validation")
  validation(@Query() query: unknown) {
    return z.object({ limit: z.coerce.number().int().min(1) }).parse(query);
  }

  @Post("echo")
  @HttpCode(200)
  echo(@Body() body: unknown) {
    return body;
  }

  @Internal()
  @Post("internal/probe")
  @HttpCode(200)
  internal() {
    return { ok: true };
  }
}

@Module({})
class ProbeModule {}

async function fixture(t: TestContext, rateLimit = 240) {
  const app = await createApplication({
    module: ProbeModule,
    imports: [
      PlatformModule.register({
        service: "probe",
        rateLimit,
        serviceToken: "private-service-token",
        credentials: {
          "provider-token": {
            hospital: "hospital",
            provider: "provider",
            role: "provider",
          },
        },
      }),
    ],
    controllers: [ProbeController],
  });
  t.after(() => app.close());
  await app.listen(0, "127.0.0.1");
  return app;
}
const headers = { authorization: "Bearer provider-token" };

test("Nest guards distinguish public, provider, and internal service credentials", async (t) => {
  const app = await fixture(t);
  assert.equal((await httpRequest(app, "/health")).statusCode, 200);
  assert.equal((await httpRequest(app, "/v1/me")).statusCode, 401);
  const me = await httpRequest(app, { url: "/v1/me", headers });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().provider, "provider");
  for (const credentials of [headers, { "x-service-token": "incorrect" }]) {
    const result = await httpRequest(app, {
      url: "/internal/probe",
      method: "POST",
      headers: credentials,
    });
    assert.equal(result.statusCode, 401);
    assert.equal(result.json().error.code, "SERVICE_UNAUTHORIZED");
  }
  const internal = await httpRequest(app, {
    url: "/internal/probe",
    method: "POST",
    headers: { "x-service-token": "private-service-token" },
  });
  assert.equal(internal.statusCode, 200);
  assert.deepEqual(internal.json(), { ok: true });
});

test("Nest filters preserve safe errors, request IDs, and JSON body limits", async (t) => {
  const app = await fixture(t);
  const invalid = await httpRequest(app, {
    url: "/validation?limit=bad",
    headers,
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "INVALID_REQUEST");
  assert.equal(invalid.json().error.fields[0].path, "limit");
  assert.equal(invalid.headers.get("x-request-id"), invalid.json().requestId);
  assert.equal(invalid.headers.get("cache-control"), "no-store");
  assert.equal(invalid.headers.get("x-content-type-options"), "nosniff");
  assert.equal(invalid.headers.get("x-powered-by"), null);

  const failed = await httpRequest(app, { url: "/failure", headers });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().error.code, "TEMPORARILY_UNAVAILABLE");
  assert.doesNotMatch(failed.body, /private database|stack/);

  const malformed = await fetch(`${await app.getUrl()}/echo`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{broken",
  });
  assert.equal(malformed.status, 400);
  assert.equal(
    ((await malformed.json()) as { error: { code: string } }).error.code,
    "INVALID_HTTP_REQUEST",
  );
  const oversized = await httpRequest(app, {
    url: "/echo",
    method: "POST",
    headers,
    payload: { value: "x".repeat(1_048_576) },
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.json().error.code, "INVALID_HTTP_REQUEST");
  const valid = await httpRequest(app, {
    url: "/echo",
    method: "POST",
    headers,
    payload: { ok: true },
  });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(valid.json(), { ok: true });
  assert.equal((await httpRequest(app, "/missing")).statusCode, 404);
});

test("Nest authentication rate limits are isolated to each application", async (t) => {
  const app = await fixture(t, 2);
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await httpRequest(app, { url: "/v1/me", headers })).statusCode,
      200,
    );
  const limited = await httpRequest(app, { url: "/v1/me", headers });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "RATE_LIMITED");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  const separateApp = await fixture(t, 2);
  assert.equal(
    (await httpRequest(separateApp, { url: "/v1/me", headers })).statusCode,
    200,
  );
});
