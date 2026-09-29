import { existsSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const outputs = [
  "dist",
  "packages/contracts/dist",
  "packages/platform/dist",
  "services/patient-service/dist",
  "services/charge-service/dist",
  "services/billing-service/dist",
  "services/gateway/dist",
  "services/billing-mock/dist",
];
for (const output of outputs) {
  const target = resolve(root, output);
  if (!existsSync(target)) continue;
  const within = relative(root, realpathSync(target));
  if (
    !within ||
    within === ".." ||
    within.startsWith(`..${sep}`) ||
    isAbsolute(within)
  )
    throw new Error(`Build output is outside the workspace: ${target}`);
  rmSync(target, { recursive: true, force: true });
}
