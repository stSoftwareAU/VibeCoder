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
  type IndirectSpawnRules,
  scanContentForDirectSpawn,
  scanDirectoriesForDirectSpawn,
} from "../lib/spawn_chokepoint_scan.ts";

const DOCKER_SPAWN = /new\s+Deno\.Command\s*\(\s*["'`]docker["'`]/;

/** The indirection rules a check supplies for a `docker` chokepoint. */
const DOCKER_RULES: IndirectSpawnRules = {
  wrapperPattern: /\brunWithTimeout\s*\(\s*["'`]docker["'`]/,
  argvHeadPattern: /\(\s*\[?\s*["'`]docker["'`]\s*,/,
  chokepointImportPattern: /from\s+["'`][^"'`]*docker_spawn\.ts["'`]/,
};

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

Deno.test("scanContentForDirectSpawn - matches a literal spawn split across lines", () => {
  const violations = scanContentForDirectSpawn(
    [
      "const c = new Deno.Command(",
      '  "docker",',
      '  { args: ["ps"] },',
      ");",
    ].join("\n"),
    "worker/deno/lib/example.ts",
    DOCKER_SPAWN,
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 1);
});

Deno.test("scanContentForDirectSpawn - flags a generic wrapper called with the literal binary", () => {
  const violations = scanContentForDirectSpawn(
    [
      "const result = await runWithTimeout(",
      '  "docker",',
      '  ["ps", "--all"],',
      "  { timeoutMs },",
      ");",
    ].join("\n"),
    "worker/deno/lib/example.ts",
    DOCKER_SPAWN,
    DOCKER_RULES,
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 1);
});

Deno.test("scanContentForDirectSpawn - flags an indirect spawn in a file that routes the binary", () => {
  const violations = scanContentForDirectSpawn(
    [
      "function runner(cmd: string[]) {",
      "  const command = new Deno.Command(cmd[0]!, {",
      "    args: cmd.slice(1),",
      "  });",
      "  return command.output();",
      "}",
      'export const ps = () => runner(["docker", "ps"]);',
    ].join("\n"),
    "worker/deno/lib/example.ts",
    DOCKER_SPAWN,
    DOCKER_RULES,
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 2);
});

Deno.test("scanContentForDirectSpawn - an indirect spawn of another binary is left alone", () => {
  const violations = scanContentForDirectSpawn(
    [
      "function runner(cmd: string[]) {",
      "  const command = new Deno.Command(cmd[0]!, { args: cmd.slice(1) });",
      "  return command.output();",
      "}",
      'export const ls = () => runner(["podman", "ps"]);',
    ].join("\n"),
    "worker/deno/lib/example.ts",
    DOCKER_SPAWN,
    DOCKER_RULES,
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForDirectSpawn - a file importing the chokepoint is not flagged for indirection", () => {
  const violations = scanContentForDirectSpawn(
    [
      'import { spawnDocker } from "./docker_spawn.ts";',
      "function runner(cmd: string[]) {",
      '  if (cmd[0] === "docker") return spawnDocker(cmd.slice(1));',
      "  const command = new Deno.Command(cmd[0]!, { args: cmd.slice(1) });",
      "  return command.output();",
      "}",
      'export const ps = () => runner(["docker", "ps"]);',
    ].join("\n"),
    "worker/deno/lib/example.ts",
    DOCKER_SPAWN,
    DOCKER_RULES,
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForDirectSpawn - without rules the indirection is invisible", () => {
  const violations = scanContentForDirectSpawn(
    [
      "const command = new Deno.Command(cmd[0]!, { args: cmd.slice(1) });",
      'export const ps = () => runner(["docker", "ps"]);',
    ].join("\n"),
    "worker/deno/lib/example.ts",
    DOCKER_SPAWN,
  );
  assertEquals(violations, []);
});

Deno.test("scanDirectoriesForDirectSpawn - indirectExempt skips the indirection rule only", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmpDir}/src`, { recursive: true });
    const indirect = [
      "const command = new Deno.Command(cmd[0]!, { args: cmd.slice(1) });",
      'export const ps = () => runner(["docker", "ps"]);',
      "",
    ].join("\n");
    await Deno.writeTextFile(`${tmpDir}/src/gap.ts`, indirect);
    await Deno.writeTextFile(
      `${tmpDir}/src/gap_direct.ts`,
      indirect + 'const c = new Deno.Command("docker", { args });\n',
    );

    const result = await scanDirectoriesForDirectSpawn(tmpDir, ["src"], {
      pattern: DOCKER_SPAWN,
      allowlist: new Set<string>(),
      rules: DOCKER_RULES,
      indirectExempt: new Set(["src/gap.ts", "src/gap_direct.ts"]),
    });

    // The exempt file's indirection is forgiven; its literal spawn is not.
    assertEquals(
      result.violations.map((v) => v.file),
      ["src/gap_direct.ts"],
    );
    assertEquals(result.violations[0]?.line, 3);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
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
