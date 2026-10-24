/**
 * Tests for the spawn-timeout quality-gate check (Issue #4248).
 *
 * The scanner is exercised on literal file contents. The directory walk is
 * exercised against a temporary tree and against this checkout, which must
 * report no offence.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  scanContentForSpawnTimeout,
  scanDirectoriesForSpawnTimeout,
  SPAWN_TIMEOUT_SCAN_DIRS,
} from "../lib/spawn_timeout_check.ts";

const FILE = "worker/deno/lib/example.ts";

Deno.test("scanContentForSpawnTimeout - a Deno.Command with no signal is an offence", () => {
  const offences = scanContentForSpawnTimeout(
    [
      "export async function probe() {",
      '  const command = new Deno.Command("ps", { args: ["-p", "1"] });',
      "  return await command.output();",
      "}",
    ].join("\n"),
    FILE,
  );
  assertEquals(offences.length, 1);
  assertEquals(offences[0]?.kind, "deno-command");
  assertEquals(offences[0]?.line, 2);
  assertEquals(offences[0]?.file, FILE);
});

Deno.test("scanContentForSpawnTimeout - the same spawn with a signal is clean", () => {
  const offences = scanContentForSpawnTimeout(
    [
      'const command = new Deno.Command("ps", {',
      '  args: ["-p", "1"],',
      "  signal: controller.signal,",
      "});",
    ].join("\n"),
    FILE,
  );
  assertEquals(offences, []);
});

Deno.test("scanContentForSpawnTimeout - signal named only inside a string is still an offence", () => {
  const offences = scanContentForSpawnTimeout(
    'const command = new Deno.Command("ps", { args: ["--signal", "9"] });',
    FILE,
  );
  assertEquals(offences.length, 1);
});

Deno.test("scanContentForSpawnTimeout - a URL in a string does not hide the next spawn", () => {
  const offences = scanContentForSpawnTimeout(
    [
      'const endpoint = "https://example.com/api";',
      'const command = new Deno.Command("curl", { args: [endpoint] });',
    ].join("\n"),
    FILE,
  );
  assertEquals(offences.length, 1);
  assertEquals(offences[0]?.line, 2);
});

Deno.test("scanContentForSpawnTimeout - a quote inside a regex does not hide the next spawn", () => {
  const offences = scanContentForSpawnTimeout(
    [
      "const quoted = /[\"']/;",
      'const command = new Deno.Command("ps", { args: [] });',
      'const other = "x";',
    ].join("\n"),
    FILE,
  );
  assertEquals(offences.length, 1);
  assertEquals(offences[0]?.line, 2);
});

Deno.test("scanContentForSpawnTimeout - a comment opener inside a string does not hide the next spawn", () => {
  const offences = scanContentForSpawnTimeout(
    [
      'const glob = "src/*";',
      'const command = new Deno.Command("ls", { args: [glob] });',
      'const tail = "*/";',
    ].join("\n"),
    FILE,
  );
  assertEquals(offences.length, 1);
  assertEquals(offences[0]?.line, 2);
});

Deno.test("scanContentForSpawnTimeout - a comment and a template example are not spawns", () => {
  const offences = scanContentForSpawnTimeout(
    [
      '// new Deno.Command("ps", { args: [] })',
      '/* new Deno.Command("ps", {}) */',
      "const help = `route it, not new Deno.Command(cmd[0]!, { args })`;",
      'const command = new Deno.Command("hostname", {',
      "  signal: controller.signal,",
      "});",
    ].join("\n"),
    FILE,
  );
  assertEquals(offences, []);
});

Deno.test("scanContentForSpawnTimeout - runWithTimeout with no timeoutMs is an offence", () => {
  const offences = scanContentForSpawnTimeout(
    [
      'import { runWithTimeout } from "./subprocess_timeout.ts";',
      'await runWithTimeout("df", ["-P", path]);',
    ].join("\n"),
    FILE,
  );
  assertEquals(offences.length, 1);
  assertEquals(offences[0]?.kind, "run-with-timeout");
  assertEquals(offences[0]?.line, 2);
});

Deno.test("scanContentForSpawnTimeout - runWithTimeout with timeoutMs is clean", () => {
  const withProperty = scanContentForSpawnTimeout(
    [
      'import { runWithTimeout } from "../lib/subprocess_timeout.ts";',
      'await runWithTimeout("df", ["-P", path], {',
      "  timeoutMs: 5_000,",
      "});",
    ].join("\n"),
    FILE,
  );
  const withShorthand = scanContentForSpawnTimeout(
    [
      'import { runWithTimeout } from "./subprocess_timeout.ts";',
      'await runWithTimeout("df", ["-P", path], { timeoutMs });',
    ].join("\n"),
    FILE,
  );
  assertEquals(withProperty, []);
  assertEquals(withShorthand, []);
});

Deno.test("scanContentForSpawnTimeout - a local helper of the same name is not the chokepoint", () => {
  const offences = scanContentForSpawnTimeout(
    [
      "async function runWithTimeout(command: string, timeoutSeconds: number) {",
      "  return timeoutSeconds;",
      "}",
      "await runWithTimeout(command, timeoutSeconds);",
    ].join("\n"),
    FILE,
  );
  assertEquals(offences, []);
});

Deno.test("scanDirectoriesForSpawnTimeout - the chokepoint file is skipped, a sibling is not", async () => {
  const root = await Deno.makeTempDir({ prefix: "spawn-timeout-" });
  try {
    const lib = `${root}/worker/deno/lib`;
    await Deno.mkdir(lib, { recursive: true });
    await Deno.writeTextFile(
      `${lib}/git_timeout.ts`,
      'new Deno.Command("git", { args: ["status"] });\n',
    );
    await Deno.writeTextFile(
      `${lib}/other.ts`,
      'new Deno.Command("ps", { args: ["-p", "1"] });\n',
    );
    const result = await scanDirectoriesForSpawnTimeout(
      root,
      ["worker/deno/lib"],
    );
    assertEquals(result.filesScanned, 1);
    assertEquals(result.offences.map((offence) => offence.file), [
      "worker/deno/lib/other.ts",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scanDirectoriesForSpawnTimeout - this checkout has no untimed spawn", async () => {
  const repoRoot = decodeURIComponent(
    new URL("../../../", import.meta.url).pathname,
  );
  const root = repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;
  const result = await scanDirectoriesForSpawnTimeout(
    root,
    SPAWN_TIMEOUT_SCAN_DIRS,
  );
  assertEquals(result.offences, []);
  assert(result.filesScanned > 0);
});
