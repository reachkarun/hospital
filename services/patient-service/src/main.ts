import {
  serviceConfig,
  secret,
  background,
  listen,
} from "@rounding/platform/runtime";
import { Store } from "./store.js";
import { buildPatientApi } from "./app.js";
import { seed } from "./seed.js";
import { replayWaiting } from "./patient/patient-events.js";

const cfg = serviceConfig("patients", 3101);
const store = new Store(cfg.database);
if (cfg.demo) seed(store, cfg.billingUrl);
const app = await buildPatientApi(
  store,
  cfg.credentials,
  secret("patient", cfg.demo),
);
background(
  app,
  async () => {
    for (const h of store.all("SELECT id FROM hospitals"))
      replayWaiting(store, h.id);
  },
  1000,
);
await listen(app, cfg, store);
