/** Behavioural script-source classifier inputs (Issue #4766). */

import { assertEquals } from "@std/assert";
import { isIntegrationTestSource } from "../lib/integration_test_manifest.ts";

Deno.test("integration classifier recognises a required real ShellCheck", () => {
  const imported =
    'import { requireRealShellcheck } from "./support/shellcheck_support.ts";';
  assertEquals(isIntegrationTestSource(imported), false);
  assertEquals(
    isIntegrationTestSource(`${imported}\n// await requireRealShellcheck()`),
    false,
  );
  assertEquals(
    isIntegrationTestSource(`${imported}\nawait requireRealShellcheck()`),
    true,
  );
});

Deno.test("integration classifier recognises launched harness descriptors, not unused imports or comments", () => {
  const imported =
    'import { BASH_LAUNCHER, runLauncher } from "./fixtures/launcher_harness.ts";';
  assertEquals(isIntegrationTestSource(imported), false);
  assertEquals(
    isIntegrationTestSource(
      `${imported}\n// runLauncher(harness, BASH_LAUNCHER);`,
    ),
    false,
  );
  assertEquals(
    isIntegrationTestSource(
      `${imported}\n/* runLauncher(harness, BASH_LAUNCHER); */`,
    ),
    false,
  );
  for (const quote of ['"', "'", "`"]) {
    assertEquals(
      isIntegrationTestSource(
        `${imported}\nconst example = ${quote}runLauncher(harness, BASH_LAUNCHER)${quote};`,
      ),
      false,
    );
  }
  assertEquals(
    isIntegrationTestSource(
      `${imported}\nawait runLauncher(harness, BASH_LAUNCHER);`,
    ),
    true,
  );
  assertEquals(
    isIntegrationTestSource("await runLauncher(harness, BASH_LAUNCHER);"),
    false,
  );
  assertEquals(
    isIntegrationTestSource([
      "const example = `",
      imported,
      "`;",
      "await runLauncher(harness, BASH_LAUNCHER);",
    ].join("\n")),
    false,
  );
  const descriptor = ["POWERSHELL", "LAUNCHER"].join("_");
  assertEquals(
    isIntegrationTestSource(
      `import { ${descriptor}, spawnLauncher } from "./fixtures/launcher_harness.ts";\nspawnLauncher(harness, ${descriptor}!);`,
    ),
    true,
  );
});

Deno.test("integration classifier rejects long malformed harness imports and launch arguments", () => {
  assertEquals(
    isIntegrationTestSource("import {".repeat(20_000)),
    false,
  );
  const imported =
    'import { BASH_LAUNCHER, runLauncher } from "./fixtures/launcher_harness.ts";';
  assertEquals(
    isIntegrationTestSource(
      `${imported}\nrunLauncher(${" ".repeat(100_000)});`,
    ),
    false,
  );
});
