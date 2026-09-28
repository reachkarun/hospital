import { z } from "zod";
import { chargeData, id, instant } from "./index.js";

// Versioned wire contracts only. No service implementation or database schema is shared.
export const encounterRequest = z
  .object({ hospitalId: id, providerId: id, visitId: id })
  .strict();
export const encounterContext = encounterRequest
  .extend({
    patientId: id,
    patientMrn: z.string().min(1),
    providerNpi: z.string().regex(/^\d{10}$/),
    admissionDate: instant,
    dischargeDate: instant.optional(),
  })
  .strict();
export type Encounter = z.infer<typeof encounterContext>;
export const billingRequest = z
  .object({
    submissionId: id,
    hospitalId: id,
    providerId: id,
    providerNpi: z.string().regex(/^\d{10}$/),
    patientId: id,
    patientMrn: z.string().min(1),
    visitId: id,
    charges: z
      .array(chargeData.omit({ visitId: true }).extend({ chargeId: id }))
      .min(1)
      .max(100)
      .refine(
        (items) =>
          new Set(items.map((item) => item.chargeId)).size === items.length,
        "Duplicate charge IDs",
      ),
    submittedAt: instant,
    clientSubmissionId: id,
  })
  .strict();
export const jobState = z.object({
  submissionId: id,
  hospitalId: id,
  providerId: id,
  payloadDigest: z.string(),
  status: z.enum([
    "QUEUED",
    "SENDING",
    "RETRY",
    "REVIEW",
    "ACCEPTED",
    "PARTIAL",
    "REJECTED",
    "FAILED",
  ]),
  attempts: z.number().int().nonnegative(),
  firstAttempt: z.number().nullable(),
  nextAt: z.number(),
  error: z.string().nullable(),
  acknowledgment: z.record(z.unknown()).nullable(),
});
