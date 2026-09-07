/**
 * Tests for the redact-after-truncate quality-gate check (Issue #1257).
 *
 * The scanner is exercised behaviourally: literal file contents for the
 * content scanner, a real temporary directory for the walk, and the worker's
 * own source tree for the invariant the gate enforces.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  scanContentForRedactInversion,
  scanDirectoriesForRedactInversion,
} from "../lib/redact_truncate_order_check.ts";

Deno.test("scanContentForRedactInversion - flags a truncation inside redactSecrets", () => {
  const violations = scanContentForRedactInversion(
    [
      "function render(log: string, maxBytes: number): string {",
      "  return redactSecrets(truncateLogTail(log, maxBytes));",
      "}",
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 2);
  assertEquals(violations[0]?.file, "worker/deno/lib/example.ts");
});

Deno.test("scanContentForRedactInversion - flags a slice inside a multi-line call", () => {
  const violations = scanContentForRedactInversion(
    [
      "const stderrTail = redactSecrets(",
      '  stderr.trim().split("\\n").slice(-5).join("\\n"),',
      ");",
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 1);
});

Deno.test("scanContentForRedactInversion - flags a pre-truncated branded constructor", () => {
  const violations = scanContentForRedactInversion(
    "const snippet = redactedTail(output.slice(-500), 500);",
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations.length, 1);
});

Deno.test("scanContentForRedactInversion - accepts the compliant order", () => {
  const violations = scanContentForRedactInversion(
    [
      "const tail = truncateLogTail(redactSecrets(log), maxBytes);",
      'const lines = redactSecrets(text).split("\\n").slice(-400).join("\\n");',
      "const snippet = redactedTail(output, 500);",
      'const joined = joinRedacted([head, tail], "\\n");',
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForRedactInversion - ignores the shape in comments", () => {
  const violations = scanContentForRedactInversion(
    [
      "/**",
      " * Never write redactSecrets(truncateLogTail(log, maxBytes)).",
      " */",
      "const tail = truncateLogTail(redactSecrets(log), maxBytes);",
      "// redactSecrets(output.slice(-500)) is the inversion",
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForRedactInversion - ignores a slice inside a string literal", () => {
  const violations = scanContentForRedactInversion(
    'const note = redactSecrets("use .slice( only after redacting");',
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations, []);
});

Deno.test("scanDirectoriesForRedactInversion - walks a directory and skips tests", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/worker/deno/lib`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/worker/deno/lib/offender.ts`,
      "const tail = redactSecrets(log.slice(-500));\n",
    );
    await Deno.writeTextFile(
      `${root}/worker/deno/lib/clean.ts`,
      "const tail = redactSecrets(log).slice(-500);\n",
    );
    await Deno.writeTextFile(
      `${root}/worker/deno/lib/offender_test.ts`,
      "const tail = redactSecrets(log.slice(-500));\n",
    );

    const result = await scanDirectoriesForRedactInversion(root, [
      "worker/deno/lib",
    ]);
    assertEquals(result.filesScanned, 2);
    assertEquals(result.violations.length, 1);
    assertEquals(result.violations[0]?.file, "worker/deno/lib/offender.ts");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scanDirectoriesForRedactInversion - the worker source tree is clean", async () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const result = await scanDirectoriesForRedactInversion(repoRoot, [
    "worker/deno/lib",
    "worker/deno/commands",
  ]);
  assert(result.filesScanned > 0, "scanned no files");
  assertEquals(
    result.violations.map((v) => `${v.file}:${v.line}`),
    [],
  );
});
