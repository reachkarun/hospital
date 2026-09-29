import { Store } from "./store.js";
import { consume } from "./patient/patient-events.js";
import { sampleEvent } from "@rounding/contracts/sample";
export function seed(store: Store, billingUrl: string) {
  for (const [hospital, name] of [
    ["HOSP-001", "Memorial Demo Hospital"],
    ["HOSP-002", "City Demo Medical Center"],
  ] as const) {
    store.run(
      "INSERT INTO hospitals VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",
      hospital,
      name,
      billingUrl,
    );
    if (
      !store.get(
        "SELECT id FROM inbox WHERE hospital=? AND id=?",
        hospital,
        "seed-assignment-001",
      )
    )
      consume(store, hospital, sampleEvent(hospital));
  }
}
