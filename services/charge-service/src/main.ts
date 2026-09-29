import {
  serviceConfig,
  secret,
  background,
  listen,
} from "@rounding/platform/runtime";
import { Store } from "./store.js";
import { buildChargeApi } from "./app.js";
import { patientClient } from "./patient-client.js";
import { billingClient, Dispatcher } from "./dispatcher.js";
const cfg = serviceConfig("charges", 3102);
const store = new Store();
await store.connect();
const app = await buildChargeApi(
  store,
  cfg.credentials,
  patientClient(
    process.env.PATIENT_SERVICE_URL ?? "http://127.0.0.1:3101",
    secret("patient", cfg.demo),
  ),
);
const dispatcher = new Dispatcher(
  store,
  billingClient(
    process.env.BILLING_SERVICE_URL ?? "http://127.0.0.1:3103",
    secret("billing", cfg.demo),
  ),
);
background(app, async () => {
  await dispatcher.tick();
});
await listen(app, cfg, store);
