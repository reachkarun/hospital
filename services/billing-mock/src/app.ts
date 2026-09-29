import { createApplication } from "@rounding/platform/http";
import { MockModule } from "./mock/mock.module.js";

export async function buildMock(
  ...args: Parameters<typeof MockModule.register>
) {
  const app = await createApplication(MockModule.register(...args));

  return app;
}
