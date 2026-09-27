import { createHash } from "node:crypto";
import { z } from "zod";

export const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.:-]+$/);
export const instant = z.string().datetime({ offset: true });
export const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const n = Date.parse(s);
    return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === s;
  }, "Invalid calendar date");
export const chargeData = z
  .object({
    visitId: id,
    serviceCode: z.string().regex(/^(\d{5}|[A-Z]\d{4})$/),
    quantity: z.number().int().min(1).max(999),
    dateOfService: day,
    modifiers: z
      .array(z.string().regex(/^[A-Z0-9]{2}$/))
      .max(4)
      .default([]),
    notes: z.string().max(2000).nullable().default(null),
    description: z.string().max(300).optional(),
  })
  .strict();
export const saveCharge = z
  .object({
    operationId: id,
    chargeId: id,
    expectedVersion: z.number().int().nonnegative(),
    charge: chargeData,
  })
  .strict();
export const syncBatch = z
  .object({ operations: z.array(saveCharge).min(1).max(100) })
  .strict();
export const submit = z
  .object({
    clientSubmissionId: id,
    chargeIds: z
      .array(id)
      .min(1)
      .max(100)
      .refine((a) => new Set(a).size === a.length, "Duplicate charge IDs"),
  })
  .strict();
export const envelope = z
  .object({
    messageId: id,
    eventType: z.string().min(1).max(80),
    timestamp: instant,
    source: id,
    hospitalId: id,
    correlationId: id.optional(),
    version: z.string().max(20),
    payload: z.record(z.unknown()),
  })
  .passthrough();
export type Event = z.infer<typeof envelope>;
export type SaveCharge = z.infer<typeof saveCharge>;
export type Submit = z.infer<typeof submit>;
export type Principal = {
  hospital: string;
  provider: string;
  role: "provider" | "integration" | "admin";
};

export class DomainError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}
export function check(
  condition: unknown,
  status: number,
  code: string,
  details?: unknown,
): asserts condition {
  if (!condition) throw new DomainError(status, code, details);
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
