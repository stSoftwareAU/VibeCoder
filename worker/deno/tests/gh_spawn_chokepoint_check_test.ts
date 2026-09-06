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

Deno.test("scanContentForGhSpawn - flags a variable binary handed a gh argv literal", () => {
  // The shape Issue #1227 records: `language_detector.ts` spawned `cmd[0]`
  // and its callers passed `["gh", "api", …]`.
  const violations = scanContentForGhSpawn(
    [
      "function createDefaultRunCommand() {",
      "  return async (cmd: string[]) => {",
      "    const command = new Deno.Command(cmd[0]!, { args: cmd.slice(1) });",
      "    return await command.output();",
      "  };",
      "}",
      "const runner = createDefaultRunCommand();",
      'await runner(["gh", "api", `repos/${repo}/languages`]);',
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 3);
});

Deno.test("scanContentForGhSpawn - a variable binary that delegates gh to the chokepoint is clean", () => {
  const violations = scanContentForGhSpawn(
    [
      'import { spawnGh } from "./gh_spawn.ts";',
      "function createDefaultRunCommand() {",
      "  return async (cmd: string[]) => {",
      '    if (cmd[0] === "gh") return await spawnGh(cmd.slice(1));',
      "    const command = new Deno.Command(cmd[0]!, { args: cmd.slice(1) });",
      "    return await command.output();",
      "  };",
      "}",
      'await createDefaultRunCommand()(["gh", "api", "repos/o/r/languages"]);',
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForGhSpawn - a generic runner that never names gh is clean", () => {
  const violations = scanContentForGhSpawn(
    [
      "export async function runCommand(cmd: string[]) {",
      "  const command = new Deno.Command(cmd[0]!, { args: cmd.slice(1) });",
      "  return await command.output();",
      "}",
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

// The production tree must satisfy the invariant this check enforces —
// literal `gh` spawns and variable-binary ones alike (Issue #1227).
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
