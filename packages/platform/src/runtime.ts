import type { FastifyInstance } from "fastify";
import { config } from "./config.js";
import type { Database } from "./db.js";

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
  app: FastifyInstance,
  tick: () => Promise<unknown>,
  delay = 500,
) {
  let running = true;
  const task = (async () => {
    while (running) {
      try {
        await tick();
      } catch {
        app.log.error(
          { code: "BACKGROUND_TICK_FAILED" },
          "Background task failed",
        );
      }
      if (running) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  })();
  // Fastify onClose hooks run in reverse order. Drain background IO in preClose,
  // before any onClose hook can close the service's database connection.
  app.addHook("preClose", async () => {
    running = false;
    await task;
  });
}
export async function listen(
  app: FastifyInstance,
  cfg: { host: string; port: number },
  db?: Database,
) {
  // Background work has already drained in preClose before storage is closed.
  if (db) app.addHook("onClose", async () => db.close());
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void app.close();
    });
  await app.listen({ host: cfg.host, port: cfg.port });
}
