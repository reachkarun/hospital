import type { INestApplication } from "@nestjs/common";
import { config } from "./config.js";
import type { Database } from "./db.js";
import { ApplicationLifecycle } from "./lifecycle.js";

export function serviceConfig(name: string, port: number) {
  const cfg = config();
  return {
    ...cfg,
    database: process.env.DATABASE_PATH ?? `data/${name}.db`,
    port: Number(process.env.PORT ?? port),
  };
}
export function secret(name: "patient" | "billing", demo: boolean) {
  const value =
    process.env[`${name.toUpperCase()}_SERVICE_TOKEN`] ??
    (demo ? `demo-${name}-service-secret` : "");
  if (!value)
    throw new Error(`${name.toUpperCase()}_SERVICE_TOKEN is required`);
  return value;
}
export function seedHospitals(db: Database, billingUrl: string) {
  for (const [id, name] of [
    ["HOSP-001", "Memorial Demo Hospital"],
    ["HOSP-002", "City Demo Medical Center"],
  ])
    db.run(
      "INSERT INTO hospitals VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",
      id!,
      name!,
      billingUrl,
    );
}
export function background(
  app: INestApplication,
  tick: () => Promise<unknown>,
  delay = 500,
) {
  app.get(ApplicationLifecycle).start(tick, delay);
}
export async function listen(
  app: INestApplication,
  cfg: { host: string; port: number },
  db?: Database,
) {
  if (db) app.get(ApplicationLifecycle).ownDatabase(db);
  app.enableShutdownHooks(["SIGINT", "SIGTERM"]);
  await app.listen(cfg.port, cfg.host);
}
