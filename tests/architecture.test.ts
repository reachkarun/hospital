import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
test("each project has its own build manifest and no cross-service implementation imports", () => {
  for (const service of [
    "gateway",
    "patient-service",
    "charge-service",
    "billing-service",
    "billing-mock",
  ]) {
    const directory = join(process.cwd(), "services", service);
    const pkg = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
    assert.ok(pkg.scripts.build && pkg.scripts.start);
    assert.ok(
      readFileSync(join(directory, "Dockerfile"), "utf8").includes(
        `services/${service}/dist`,
      ),
    );
    const sourceRoot = join(directory, "src");
    for (const file of readdirSync(sourceRoot, {
      recursive: true,
      encoding: "utf8",
    }).filter((f) => f.endsWith(".ts"))) {
      const sourcePath = join(sourceRoot, file);
      const source = readFileSync(sourcePath, "utf8");
      for (const match of source.matchAll(
        /(?:from\s+|import\s*\()['"]([^'"]+)['"]/g,
      )) {
        const specifier = match[1]!;
        assert.doesNotMatch(
          specifier,
          /^@rounding\/(?:patient-service|charge-service|billing-service|gateway|billing-mock)(?:\/|$)/,
        );
        if (specifier.startsWith(".")) {
          const target = relative(
            sourceRoot,
            resolve(dirname(sourcePath), specifier),
          );
          assert.ok(
            target !== ".." &&
              !target.startsWith(`..${sep}`) &&
              !isAbsolute(target),
            `${sourcePath} imports outside its service: ${specifier}`,
          );
        }
      }
    }
  }
});
