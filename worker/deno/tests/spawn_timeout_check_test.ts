/**
 * Tests for the spawn-timeout quality-gate check (Issue #4248).
 *
 * The scanner is exercised on literal file contents. The directory walk and
 * the shrink-only baseline are exercised against a temporary tree and against
 * this checkout.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  diffSpawnTimeoutBaseline,
  scanContentForSpawnTimeout,
  scanDirectoriesForSpawnTimeout,
  SPAWN_TIMEOUT_BASELINE,
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

Deno.test("diffSpawnTimeoutBaseline - a stale baseline entry fails and a known gap does not", () => {
  const offences = scanContentForSpawnTimeout(
    'new Deno.Command("ps", { args: ["-p", "1"] });',
    "worker/deno/lib/still_open.ts",
  );
  const diff = diffSpawnTimeoutBaseline(
    offences,
    new Set([
      "worker/deno/lib/still_open.ts",
      "worker/deno/lib/already_fixed.ts",
    ]),
  );
  assertEquals(diff.newOffences, []);
  assertEquals(diff.staleBaseline, ["worker/deno/lib/already_fixed.ts"]);
});

Deno.test("diffSpawnTimeoutBaseline - an offender outside the baseline fails", () => {
  const offences = scanContentForSpawnTimeout(
    'new Deno.Command("ps", {});',
    "worker/deno/lib/new_gap.ts",
  );
  const diff = diffSpawnTimeoutBaseline(offences, new Set());
  assertEquals(diff.staleBaseline, []);
  assertEquals(diff.newOffences.length, 1);
  assertEquals(diff.newOffences[0]?.file, "worker/deno/lib/new_gap.ts");
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

Deno.test("scanDirectoriesForSpawnTimeout - this checkout matches the shrink-only baseline", async () => {
  const repoRoot = decodeURIComponent(
    new URL("../../../", import.meta.url).pathname,
  );
  const root = repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;
  const result = await scanDirectoriesForSpawnTimeout(
    root,
    SPAWN_TIMEOUT_SCAN_DIRS,
  );
  const offending = [...new Set(result.offences.map((offence) => offence.file))]
    .sort();
  const baseline = [...SPAWN_TIMEOUT_BASELINE].sort();
  assertEquals(offending, baseline);
  const diff = diffSpawnTimeoutBaseline(
    result.offences,
    SPAWN_TIMEOUT_BASELINE,
  );
  assertEquals(diff.newOffences, []);
  assertEquals(diff.staleBaseline, []);
  assert(result.filesScanned > 0);
});
