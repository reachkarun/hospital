import {
  serviceConfig,
  secret,
  background,
  listen,
} from "@rounding/platform/runtime";
import { Store } from "./store.js";
import { buildBillingApi } from "./app.js";
import { BillingWorker, HttpBilling } from "./worker.js";
const cfg = serviceConfig("billing", 3103);
const store = new Store();
await store.connect();
const app = await buildBillingApi(
  store,
  cfg.credentials,
  secret("billing", cfg.demo),
);
const worker = new BillingWorker(store, new HttpBilling(cfg.billingToken));
background(app, async () => {
  await worker.tick();
});
await listen(app, cfg, store);
