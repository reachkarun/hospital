import { z } from "zod";
import { chargeData, id, instant } from "@rounding/contracts";
export const requestSchema = z.object({
  submissionId: id,
  clientSubmissionId: id,
  hospitalId: id,
  providerId: id,
  providerNpi: z.string().regex(/^\d{10}$/),
  patientId: id,
  patientMrn: z.string().min(1),
  visitId: id,
  submittedAt: instant,
  charges: z
    .array(chargeData.omit({ visitId: true }).extend({ chargeId: id }))
    .min(1)
    .max(100),
});

export const modeSchema = z.object({
  hospitalId: id,
  mode: z.enum(["healthy", "outage", "rate-limit", "lost-ack"]),
  remaining: z.number().int().min(0).default(1),
});
