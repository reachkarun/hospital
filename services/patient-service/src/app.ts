import { createApplication } from "@rounding/platform/http";
import { PatientModule } from "./patient/patient.module.js";
export async function buildPatientApi(
  ...args: Parameters<typeof PatientModule.register>
) {
  const app = await createApplication(PatientModule.register(...args));
  return app;
}
