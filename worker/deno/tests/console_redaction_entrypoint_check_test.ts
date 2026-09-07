/**
 * Tests for the console-redaction entry-point check (Issue #1280).
 *
 * The scanner is exercised behaviourally: literal file contents for the
 * content scanner, real temporary directories for the walk, and the
 * production tree for the invariant the check exists to hold.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  scanContentForMissingRedaction,
  scanDirectoriesForMissingRedaction,
} from "../lib/console_redaction_entrypoint_check.ts";

Deno.test("scanContentForMissingRedaction - flags an entry point that never installs the patch", () => {
  const violations = scanContentForMissingRedaction(
    [
      "async function main(): Promise<void> {",
      "  console.log(await runChecks());",
      "}",
      "",
      "if (import.meta.main) {",
      "  await main();",
      "}",
    ].join("\n"),
    "worker/deno/example.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 5);
  assertEquals(violations[0]?.file, "worker/deno/example.ts");
});

Deno.test("scanContentForMissingRedaction - an entry point that installs the patch is clean", () => {
  const violations = scanContentForMissingRedaction(
    [
      'import { installConsoleRedaction } from "./lib/console_redaction.ts";',
      "",
      "async function main(): Promise<void> {",
      "  installConsoleRedaction();",
      "  console.log(await runChecks());",
      "}",
      "",
      "if (import.meta.main) {",
      "  await main();",
      "}",
    ].join("\n"),
    "worker/deno/example.ts",
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForMissingRedaction - a module with no entry-point guard is not an entry point", () => {
  const violations = scanContentForMissingRedaction(
    [
      "export function helper(): string {",
      '  return "no console patch needed here";',
      "}",
    ].join("\n"),
    "worker/deno/lib/helper.ts",
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForMissingRedaction - comments mentioning the guard do not count", () => {
  const violations = scanContentForMissingRedaction(
    [
      "/**",
      " * A module documenting `if (import.meta.main)` blocks.",
      " */",
      "// if (import.meta.main) { await main(); }",
      "export const x = 1;",
    ].join("\n"),
    "worker/deno/lib/docs.ts",
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForMissingRedaction - a commented-out install does not satisfy the check", () => {
  const violations = scanContentForMissingRedaction(
    [
      "// installConsoleRedaction();",
      "if (import.meta.main) {",
      "  await main();",
      "}",
    ].join("\n"),
    "worker/deno/example.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 2);
});

Deno.test("scanDirectoriesForMissingRedaction - walks directories and skips tests", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmpDir}/worker/deno/lib`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/worker/deno/tests`, { recursive: true });

    await Deno.writeTextFile(
      `${tmpDir}/worker/deno/bad.ts`,
      "if (import.meta.main) {\n  await main();\n}\n",
    );
    await Deno.writeTextFile(
      `${tmpDir}/worker/deno/lib/good.ts`,
      "if (import.meta.main) {\n  installConsoleRedaction();\n  run();\n}\n",
    );
    // Test files are driven by `deno test`, never spawned as their own
    // process, so the walk must not reach them.
    await Deno.writeTextFile(
      `${tmpDir}/worker/deno/tests/fixture_test.ts`,
      "if (import.meta.main) {\n  await main();\n}\n",
    );

    const result = await scanDirectoriesForMissingRedaction(tmpDir, [
      "worker/deno",
    ]);

    assertEquals(result.filesScanned, 2);
    assertEquals(result.violations.length, 1);
    assertEquals(result.violations[0]?.file, "worker/deno/bad.ts");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("scanDirectoriesForMissingRedaction - missing directories yield no violations", async () => {
  const result = await scanDirectoriesForMissingRedaction(
    "/nonexistent-root-xyz",
    ["worker/deno"],
  );
  assertEquals(result.filesScanned, 0);
  assertEquals(result.violations, []);
});

// The production tree must satisfy the invariant this check enforces: this is
// the regression test for Issue #1280 — it fails against the unfixed tree,
// where quality.ts, setup_cli.ts, gh_guard_cli.ts, test_shard_files.ts and
// unit_test_runner.ts all print without patching the console.
Deno.test("scanDirectoriesForMissingRedaction - every worker entry point installs console redaction", async () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const result = await scanDirectoriesForMissingRedaction(repoRoot, [
    "worker/deno",
  ]);
  assertEquals(
    result.violations.map((v) => `${v.file}:${v.line}`),
    [],
  );
});
