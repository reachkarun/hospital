import { Store } from "./db.js";
import { buildMock } from "./mock-billing.js";

if (process.env.DEMO_MODE !== "true")
  throw new Error("Mock billing is only available with DEMO_MODE=true");
const store = new Store(
  process.env.MOCK_DATABASE_PATH ?? "data/mock-billing.db",
);
const app = buildMock(
  store,
  process.env.BILLING_TOKEN ?? "demo-billing-secret",
);
app.addHook("onClose", async () => store.close());
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.MOCK_PORT ?? 4001),
});
