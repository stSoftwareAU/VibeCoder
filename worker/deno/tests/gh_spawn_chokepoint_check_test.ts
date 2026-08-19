/**
 * Tests for the `gh` spawn chokepoint quality-gate check (Issue #3703).
 *
 * The scanner is exercised behaviourally: literal file contents for the
 * content scanner, and real temporary directories for the directory walk
 * (including the allowlisted chokepoint file itself).
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import {
  scanContentForGhSpawn,
  scanDirectoriesForGhSpawn,
} from "../lib/gh_spawn_chokepoint_check.ts";

Deno.test("scanContentForGhSpawn - flags a direct gh spawn", () => {
  const violations = scanContentForGhSpawn(
    [
      "async function run(args: string[]) {",
      '  const command = new Deno.Command("gh", { args });',
      "  return await command.output();",
      "}",
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 2);
  assertEquals(violations[0]?.file, "worker/deno/lib/example.ts");
});

Deno.test("scanContentForGhSpawn - ignores other binaries and the chokepoint helper", () => {
  const violations = scanContentForGhSpawn(
    [
      'const git = new Deno.Command("git", { args });',
      "const out = await runGhOrThrow(args);",
      'const res = await spawnGh(args, { stdout: "null" });',
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForGhSpawn - ignores comments mentioning the pattern", () => {
  const violations = scanContentForGhSpawn(
    [
      "/**",
      ' * Never write `new Deno.Command("gh", …)` here.',
      " */",
      '// legacy: new Deno.Command("gh", { args })',
      "export const x = 1;",
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations, []);
});

Deno.test("scanDirectoriesForGhSpawn - walks directories and honours the allowlist", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmpDir}/worker/deno/lib`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/worker/deno/commands`, { recursive: true });

    // The chokepoint itself is allowed to spawn gh.
    await Deno.writeTextFile(
      `${tmpDir}/worker/deno/lib/gh_spawn.ts`,
      'const c = new Deno.Command("gh", { args });\n',
    );
    // A compliant caller.
    await Deno.writeTextFile(
      `${tmpDir}/worker/deno/lib/good.ts`,
      "const out = await runGhOrThrow(args);\n",
    );
    // A bypassing caller.
    await Deno.writeTextFile(
      `${tmpDir}/worker/deno/commands/bad.ts`,
      'const c = new Deno.Command("gh", { args: ["pr", "merge"] });\n',
    );

    const result = await scanDirectoriesForGhSpawn(tmpDir, [
      "worker/deno/lib",
      "worker/deno/commands",
    ]);

    assertEquals(result.filesScanned, 2);
    assertEquals(result.violations.length, 1);
    assertEquals(result.violations[0]?.file, "worker/deno/commands/bad.ts");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("scanDirectoriesForGhSpawn - missing directories yield no violations", async () => {
  const result = await scanDirectoriesForGhSpawn("/nonexistent-root-xyz", [
    "worker/deno/lib",
  ]);
  assertEquals(result.filesScanned, 0);
  assertEquals(result.violations, []);
});

// The production tree must satisfy the invariant this check enforces.
Deno.test("scanDirectoriesForGhSpawn - the worker tree has no direct gh spawns", async () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const result = await scanDirectoriesForGhSpawn(repoRoot, [
    "worker/deno/lib",
    "worker/deno/commands",
  ]);
  assertEquals(
    result.violations.map((v) => `${v.file}:${v.line}`),
    [],
  );
});
