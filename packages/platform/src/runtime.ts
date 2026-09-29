import type { INestApplication } from "@nestjs/common";
import { config } from "./config.js";
import type { Database } from "./db.js";
import { ApplicationLifecycle } from "./lifecycle.js";

export function serviceConfig(_name: string, port: number) {
  const cfg = config();
  return {
    ...cfg,
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
