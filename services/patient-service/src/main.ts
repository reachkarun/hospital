import {
  serviceConfig,
  secret,
  background,
  listen,
} from "@rounding/platform/runtime";
import { Store } from "./store.js";
import { buildPatientApi } from "./app.js";
import { replayWaiting } from "./patient/patient-events.js";
const cfg = serviceConfig("patients", 3101);
const store = new Store();
await store.connect();
const app = await buildPatientApi(
  store,
  cfg.credentials,
  secret("patient", cfg.demo),
);
background(
  app,
  async () => {
    for (const h of await store.all("SELECT id FROM hospitals"))
      await replayWaiting(store, h.id);
  },
  1000,
);
await listen(app, cfg, store);
