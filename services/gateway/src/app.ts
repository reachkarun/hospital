import { createApplication } from "@rounding/platform/http";
import { GatewayModule } from "./gateway/gateway.module.js";
import { registerDocumentation } from "./openapi.js";
export async function buildGateway(
  ...args: Parameters<typeof GatewayModule.register>
) {
  const app = await createApplication(GatewayModule.register(...args));
  registerDocumentation(app);
  return app;
}
