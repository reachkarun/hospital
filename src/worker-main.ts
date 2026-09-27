import { config } from "./config.js";
import { Store } from "./db.js";
import { BillingWorker, HttpBilling } from "./billing.js";
import { replayWaiting } from "./patients.js";

const cfg = config();
const store = new Store(cfg.database);
const worker = new BillingWorker(store, new HttpBilling(cfg.billingToken));
let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    running = false;
  });
let nextReplay = 0;
while (running) {
  try {
    if (Date.now() >= nextReplay) {
      for (const hospital of store.all("SELECT id FROM hospitals"))
        replayWaiting(store, hospital.id);
      nextReplay = Date.now() + 30_000;
    }
    if (!(await worker.tick()))
      await new Promise((resolve) => setTimeout(resolve, 500));
  } catch {
    console.error(JSON.stringify({ code: "WORKER_TICK_FAILED" }));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
store.close();
