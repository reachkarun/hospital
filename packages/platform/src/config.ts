import { z } from "zod";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import type { Principal } from "@rounding/contracts";

const envFile = new URL("../../../.env", import.meta.url);
if (existsSync(envFile)) loadEnvFile(fileURLToPath(envFile));

const databaseSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  user: z.string().min(1),
  password: z.string().min(1),
  database: z.string().regex(/^[a-zA-Z0-9_]+$/),
  connectionLimit: z.coerce.number().int().min(1).max(100),
});
export type DatabaseConfig = z.infer<typeof databaseSchema>;
export function databaseConfig(): DatabaseConfig {
  return databaseSchema.parse({
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: process.env.DB_PORT ?? 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME ?? "rounding_app",
    connectionLimit: process.env.DB_POOL_SIZE ?? 10,
  });
}

export type Credentials = Record<string, Principal>;
export const demoCredentials: Credentials = {
  "demo-provider-one": {
    hospital: "HOSP-001",
    provider: "PROV-789",
    role: "provider",
  },
  "demo-provider-two": {
    hospital: "HOSP-002",
    provider: "PROV-789",
    role: "provider",
  },
  "demo-integration-one": {
    hospital: "HOSP-001",
    provider: "broker",
    role: "integration",
  },
  "demo-integration-two": {
    hospital: "HOSP-002",
    provider: "broker",
    role: "integration",
  },
  "demo-admin-one": { hospital: "HOSP-001", provider: "admin", role: "admin" },
};
const credentialSchema = z.record(
  z.string().min(16),
  z
    .object({
      hospital: z.string().min(1),
      provider: z.string().min(1),
      role: z.enum(["provider", "integration", "admin"]),
    })
    .strict(),
);
export function config() {
  const demo = process.env.DEMO_MODE === "true";
  const credentials = process.env.AUTH_TOKENS
    ? credentialSchema.parse(JSON.parse(process.env.AUTH_TOKENS))
    : demo
      ? demoCredentials
      : null;
  if (!credentials || !Object.keys(credentials).length)
    throw new Error("Set AUTH_TOKENS or explicitly enable DEMO_MODE=true");
  const billingToken =
    process.env.BILLING_TOKEN ?? (demo ? "demo-billing-secret" : "");
  if (!billingToken) throw new Error("BILLING_TOKEN is required");
  return {
    demo,
    credentials,
    billingToken,
    billingUrl: process.env.BILLING_URL ?? "http://127.0.0.1:4001/api/v1",
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? "127.0.0.1",
  };
}
