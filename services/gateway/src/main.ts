import { serviceConfig, listen } from "@rounding/platform/runtime";
import { buildGateway } from "./app.js";

const cfg = serviceConfig("gateway", 3002);
const app = await buildGateway(cfg.credentials, {
  patient: process.env.PATIENT_SERVICE_URL ?? "http://127.0.0.1:3101",
  charge: process.env.CHARGE_SERVICE_URL ?? "http://127.0.0.1:3102",
  billing: process.env.BILLING_SERVICE_URL ?? "http://127.0.0.1:3103",
});
await listen(app, cfg);
