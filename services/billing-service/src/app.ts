import { createApplication } from "@rounding/platform/http";
import { BillingModule } from "./billing/billing.module.js";

export async function buildBillingApi(
  ...args: Parameters<typeof BillingModule.register>
) {
  const app = await createApplication(BillingModule.register(...args));

  return app;
}
