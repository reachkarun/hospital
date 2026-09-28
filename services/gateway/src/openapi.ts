import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { zodToJsonSchema } from "zod-to-json-schema";
import { envelope, saveCharge, submit, syncBatch } from "@rounding/contracts";
import { sampleEvent } from "@rounding/contracts/sample";

export function registerDocumentation(app: FastifyInstance) {
  const draft = {
    operationId: "swagger-save-001",
    chargeId: "swagger-charge-001",
    expectedVersion: 0,
    charge: {
      visitId: "VISIT-001",
      serviceCode: "99213",
      quantity: 1,
      dateOfService: "2026-01-15",
      modifiers: ["25"],
      notes: "Synthetic Swagger encounter",
    },
  };
  const jsonSchema = (schema: Parameters<typeof zodToJsonSchema>[0]) =>
    zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" });
  const paths: Record<string, any> = {};
  function operation(
    method: string,
    path: string,
    summary: string,
    tag: string,
    options: {
      role?: string;
      schema?: object;
      example?: unknown;
      status?: string;
      paging?: "string" | "integer";
      public?: boolean;
    } = {},
  ) {
    const parameters: object[] = [];
    if (path.includes("{id}"))
      parameters.push({
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
        example: path.includes("visits")
          ? "VISIT-001"
          : path.includes("charges")
            ? "swagger-charge-001"
            : undefined,
      });
    if (options.paging)
      parameters.push(
        {
          name: "after",
          in: "query",
          schema: {
            type: options.paging,
            default: options.paging === "integer" ? 0 : "",
          },
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
      );
    const response = {
      description: "Successful response",
      content: {
        "application/json": {
          schema: { type: "object", additionalProperties: true },
        },
      },
    };
    paths[path] ??= {};
    paths[path][method] = {
      summary,
      tags: [tag],
      operationId: `${method}_${path.replace(/[^a-zA-Z0-9]+/g, "_")}`,
      description: options.public
        ? "Public endpoint."
        : `Required role: ${options.role ?? "provider"}. Hospital scope comes from the bearer token.`,
      ...(options.public ? { security: [] } : {}),
      parameters,
      ...(options.schema
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: options.schema,
                  example: options.example,
                },
              },
            },
          }
        : {}),
      responses: {
        [options.status ?? "200"]: response,
        ...(!options.public
          ? {
              "400": { description: "Invalid request" },
              "401": { description: "Missing or invalid bearer token" },
              "403": { description: "Wrong role or hospital" },
              "404": {
                description: "Resource not found in your authorized scope",
              },
              "409": {
                description: "Stale version, reused key, or locked charge",
              },
              "422": { description: "Business validation failed" },
              "429": { description: "Rate limited; honor Retry-After" },
              "503": {
                description:
                  "Temporary failure; retry with the same operation key",
              },
            }
          : {}),
      },
    };
  }
  operation("get", "/health", "Check API health", "Health", { public: true });
  operation("get", "/v1/me", "Inspect authenticated identity", "Identity", {
    role: "provider, integration, or admin",
  });
  operation("get", "/v1/patients", "List assigned patients", "Patients", {
    paging: "string",
  });
  operation(
    "get",
    "/v1/visits/{id}",
    "Read a visit and patient clinical data",
    "Patients",
  );
  operation(
    "post",
    "/v1/charges",
    "Create or update a draft charge",
    "Charges",
    { schema: jsonSchema(saveCharge), example: draft },
  );
  operation("get", "/v1/charges", "List your charges", "Charges", {
    paging: "string",
  });
  operation(
    "get",
    "/v1/charges/{id}",
    "Read charge status and version",
    "Charges",
  );
  operation(
    "post",
    "/v1/sync",
    "Sync offline edits with per-operation results",
    "Offline sync",
    {
      schema: jsonSchema(syncBatch),
      example: { operations: [draft] },
      status: "207",
    },
  );
  operation(
    "post",
    "/v1/submissions",
    "Queue draft charges for billing",
    "Billing",
    {
      schema: jsonSchema(submit),
      example: {
        clientSubmissionId: "swagger-batch-001",
        chargeIds: ["swagger-charge-001"],
      },
      status: "202",
    },
  );
  operation(
    "get",
    "/v1/submissions/{id}",
    "Inspect billing submission and acknowledgment",
    "Billing",
  );
  operation(
    "post",
    "/v1/submissions/{id}/retry",
    "Retry or reconcile without resetting the idempotency window",
    "Billing",
  );
  operation(
    "post",
    "/v1/integrations/patient-events",
    "Consume a source-system event",
    "Patient integration",
    {
      role: "integration",
      schema: jsonSchema(envelope),
      example: { ...sampleEvent(), messageId: "swagger-event-001" },
    },
  );
  paths["/v1/integrations/patient-events"].post.responses["202"] = {
    description: "Durably retained for dependency replay or schema review",
  };
  operation(
    "get",
    "/v1/admin/inbox",
    "Inspect patient event processing state",
    "Administration",
    { role: "admin", paging: "integer" },
  );
  operation(
    "post",
    "/v1/admin/inbox/replay",
    "Replay waiting patient events",
    "Administration",
    { role: "admin" },
  );
  operation(
    "get",
    "/v1/admin/audit",
    "Read the hospital audit trail",
    "Administration",
    { role: "admin", paging: "integer" },
  );
  paths["/v1/admin/audit"].get.parameters.push({
    name: "service",
    in: "query",
    schema: {
      type: "string",
      enum: ["patient", "charge", "billing"],
      default: "charge",
    },
    description:
      "Each service owns its audit sequence. Historical monolith audit is retained by charge.",
  });
  operation(
    "get",
    "/v1/admin/metrics",
    "Read hospital queue counts",
    "Administration",
    { role: "admin" },
  );
  app.register(swagger, {
    mode: "static",
    specification: {
      document: {
        openapi: "3.0.3",
        info: {
          title: "Rounding App API",
          version: "1.0.0",
          description:
            "Use Authorize to enter a bearer token (without the Bearer prefix). Demo provider: demo-provider-one; integration: demo-integration-one; admin: demo-admin-one. Start with GET /v1/me or GET /v1/patients. Create a draft, submit its charge ID, then poll the returned submission ID. Use new operation/charge/batch IDs for a new workflow; identical IDs intentionally replay earlier results. Demo tokens apply only in demo mode.",
        },
        servers: [{ url: "/", description: "This running API" }],
        components: {
          securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
        },
        security: [{ bearerAuth: [] }],
        paths,
      },
    },
  });
  app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      persistAuthorization: false,
    },
    staticCSP: true,
  });
}
