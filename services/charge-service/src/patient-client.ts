import { encounterContext } from "@rounding/contracts/internal";
import { internalJson } from "@rounding/platform/client";
import type { ResolveEncounter } from "./charge/charge-operations.js";
export const patientClient =
  (url: string, token: string): ResolveEncounter =>
  async (p, visitId) =>
    encounterContext.parse(
      await internalJson(`${url}/internal/v1/encounters/resolve`, token, {
        hospitalId: p.hospital,
        providerId: p.provider,
        visitId,
      }),
    );
