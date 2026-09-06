/**
 * Tests for the scanning machinery shared by the `gh` and `git` spawn
 * chokepoint checks (Issue #1214).
 *
 * The two checks supply their own literal pattern and allowlist; everything
 * below is the behaviour they share, exercised directly against literal
 * content and real temporary directories.
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import {
  scanContentForDirectSpawn,
  scanContentForVariableBinarySpawn,
  scanDirectoriesForDirectSpawn,
  type VariableBinarySpawnOptions,
} from "../lib/spawn_chokepoint_scan.ts";

const DOCKER_SPAWN = /new\s+Deno\.Command\s*\(\s*["'`]docker["'`]/;

/** Variable-binary rules for a fictional `docker` chokepoint. */
const DOCKER_VARIABLE: VariableBinarySpawnOptions = {
  argvPattern: /["'`]docker["'`]\s*,/,
  delegationPattern: /from\s+["'][^"']*docker_spawn\.ts["']/,
  allowlist: new Set(["worker/deno/lib/exempt.ts"]),
};

/** A module that spawns a variable binary and names `docker` itself. */
const VARIABLE_BINARY_MODULE = [
  "async function run(cmd: string[]) {",
  "  const command = new Deno.Command(cmd[0]!, { args: cmd.slice(1) });",
  "  return await command.output();",
  "}",
  'const out = await run(["docker", "ps"]);',
].join("\n");

Deno.test("scanContentForDirectSpawn - records the line and the trimmed text", () => {
  const violations = scanContentForDirectSpawn(
    [
      "export function run() {",
      '  return new Deno.Command("docker", { args: ["ps"] });',
      "}",
    ].join("\n"),
    "worker/deno/lib/example.ts",
    DOCKER_SPAWN,
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 2);
  assertEquals(
    violations[0]?.text,
    'return new Deno.Command("docker", { args: ["ps"] });',
  );
});

Deno.test("scanContentForDirectSpawn - a pattern that does not match yields nothing", () => {
  const violations = scanContentForDirectSpawn(
    'const c = new Deno.Command("podman", { args });',
    "worker/deno/lib/example.ts",
    DOCKER_SPAWN,
  );
  assertEquals(violations, []);
});

Deno.test("scanDirectoriesForDirectSpawn - excludeTests skips co-located test files", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmpDir}/src/nested`, { recursive: true });
    const spawn = 'const c = new Deno.Command("docker", { args });\n';
    await Deno.writeTextFile(`${tmpDir}/src/a.ts`, spawn);
    await Deno.writeTextFile(`${tmpDir}/src/nested/b.ts`, spawn);
    await Deno.writeTextFile(`${tmpDir}/src/c_test.ts`, spawn);
    await Deno.writeTextFile(`${tmpDir}/src/allowed.ts`, spawn);

    const withTests = await scanDirectoriesForDirectSpawn(tmpDir, ["src"], {
      pattern: DOCKER_SPAWN,
      allowlist: new Set(["src/allowed.ts"]),
    });
    assertEquals(withTests.filesScanned, 3);
    assertEquals(withTests.violations.length, 3);

    const withoutTests = await scanDirectoriesForDirectSpawn(tmpDir, ["src"], {
      pattern: DOCKER_SPAWN,
      allowlist: new Set(["src/allowed.ts"]),
      excludeTests: true,
    });
    assertEquals(
      withoutTests.violations.map((v) => v.file).sort(),
      ["src/a.ts", "src/nested/b.ts"],
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Variable-binary spawns (Issue #1227)
// ---------------------------------------------------------------------------

Deno.test("scanContentForVariableBinarySpawn - flags a variable binary in a module that names the guarded binary", () => {
  const violations = scanContentForVariableBinarySpawn(
    VARIABLE_BINARY_MODULE,
    "worker/deno/lib/example.ts",
    DOCKER_VARIABLE,
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 2);
  assertEquals(
    violations[0]?.text,
    "const command = new Deno.Command(cmd[0]!, { args: cmd.slice(1) });",
  );
});

Deno.test("scanContentForVariableBinarySpawn - a generic runner that never names the binary is clean", () => {
  const violations = scanContentForVariableBinarySpawn(
    [
      "async function run(cmd: string[]) {",
      "  const command = new Deno.Command(cmd[0]!, { args: cmd.slice(1) });",
      "  return await command.output();",
      "}",
      'const out = await run(["podman", "ps"]);',
    ].join("\n"),
    "worker/deno/lib/example.ts",
    DOCKER_VARIABLE,
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForVariableBinarySpawn - a module that delegates to the chokepoint is clean", () => {
  const violations = scanContentForVariableBinarySpawn(
    [
      'import { spawnDocker } from "./docker_spawn.ts";',
      "async function run(cmd: string[]) {",
      '  if (cmd[0] === "docker") return await spawnDocker(cmd.slice(1));',
      "  const command = new Deno.Command(cmd[0]!, { args: cmd.slice(1) });",
      "  return await command.output();",
      "}",
    ].join("\n"),
    "worker/deno/lib/example.ts",
    DOCKER_VARIABLE,
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForVariableBinarySpawn - honours the false-positive allowlist", () => {
  const violations = scanContentForVariableBinarySpawn(
    VARIABLE_BINARY_MODULE,
    "worker/deno/lib/exempt.ts",
    DOCKER_VARIABLE,
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForVariableBinarySpawn - a literal binary is left to the literal pattern", () => {
  const violations = scanContentForVariableBinarySpawn(
    [
      'const c = new Deno.Command("docker", { args: ["ps"] });',
      'const argv = ["docker", "ps"];',
    ].join("\n"),
    "worker/deno/lib/example.ts",
    DOCKER_VARIABLE,
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForVariableBinarySpawn - ignores comments naming the binary", () => {
  const violations = scanContentForVariableBinarySpawn(
    [
      "/**",
      ' * Callers pass ["docker", "ps"] — never spawn it here.',
      " */",
      "const command = new Deno.Command(cmd[0]!, { args });",
    ].join("\n"),
    "worker/deno/lib/example.ts",
    DOCKER_VARIABLE,
  );
  assertEquals(violations, []);
});

Deno.test("scanDirectoriesForDirectSpawn - variableBinary rules are applied during the walk", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmpDir}/src`, { recursive: true });
    await Deno.writeTextFile(`${tmpDir}/src/evades.ts`, VARIABLE_BINARY_MODULE);

    const withoutRules = await scanDirectoriesForDirectSpawn(tmpDir, ["src"], {
      pattern: DOCKER_SPAWN,
      allowlist: new Set<string>(),
    });
    assertEquals(withoutRules.violations, []);

    const withRules = await scanDirectoriesForDirectSpawn(tmpDir, ["src"], {
      pattern: DOCKER_SPAWN,
      allowlist: new Set<string>(),
      variableBinary: DOCKER_VARIABLE,
    });
    assertEquals(withRules.violations.map((v) => `${v.file}:${v.line}`), [
      "src/evades.ts:2",
    ]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
