import { z } from "zod";
type Json = Record<string, any>;
const accepted = z.object({
  chargeId: z.string(),
  status: z.literal("ACCEPTED"),
  billingCode: z.string().optional(),
});
const rejected = z.object({
  chargeId: z.string(),
  status: z.literal("REJECTED"),
  error: z.object({ code: z.string().max(100), message: z.string().max(1000) }),
});
const acknowledgment = z.object({
  submissionId: z.string(),
  status: z.enum(["ACCEPTED", "PARTIAL", "REJECTED"]),
  billingReference: z.string().max(200).optional(),
  acceptedAt: z.string().optional(),
  acceptedCharges: z.array(accepted).max(100).default([]),
  rejectedCharges: z.array(rejected).max(100).default([]),
});

export function validateAck(body: Json, row: Json): Json | null {
  const parsed = acknowledgment.safeParse(body);
  if (!parsed.success || parsed.data.submissionId !== row.id) return null;
  const ack = parsed.data;
  const expected = new Set<string>(
    JSON.parse(row.payload).charges.map((c: Json) => c.chargeId),
  );
  const all = [...ack.acceptedCharges, ...ack.rejectedCharges];
  if (
    all.length !== expected.size ||
    new Set(all.map((c) => c.chargeId)).size !== expected.size ||
    all.some((c) => !expected.has(c.chargeId))
  )
    return null;
  if (ack.acceptedCharges.length && !ack.billingReference) return null;
  if (ack.status === "ACCEPTED" && ack.rejectedCharges.length) return null;
  if (ack.status === "REJECTED" && ack.acceptedCharges.length) return null;
  if (
    ack.status === "PARTIAL" &&
    (!ack.acceptedCharges.length || !ack.rejectedCharges.length)
  )
    return null;
  return ack;
}
