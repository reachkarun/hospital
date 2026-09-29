import { createApplication } from "@rounding/platform/http";
import { ChargeModule } from "./charge/charge.module.js";

export async function buildChargeApi(
  ...args: Parameters<typeof ChargeModule.register>
) {
  const app = await createApplication(ChargeModule.register(...args));

  return app;
}
