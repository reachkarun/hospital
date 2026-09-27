import { z } from "zod";
import type { Principal } from "./contracts.js";

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
    database: process.env.DATABASE_PATH ?? "data/rounding.db",
    billingUrl: process.env.BILLING_URL ?? "http://127.0.0.1:4001/api/v1",
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? "127.0.0.1",
  };
}
