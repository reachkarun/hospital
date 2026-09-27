import { buildApi } from "./api.js";
import { config } from "./config.js";
import { Store } from "./db.js";
import { seed } from "./seed.js";

const cfg = config();
const store = new Store(cfg.database);
if (cfg.demo) seed(store, cfg.billingUrl);
const app = buildApi(store, cfg.credentials, { logger: true });
app.addHook("onClose", async () => store.close());
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: cfg.host, port: cfg.port });
