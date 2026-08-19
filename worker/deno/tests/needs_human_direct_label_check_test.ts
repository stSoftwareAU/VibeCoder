/**
 * Tests for needs_human_direct_label_check.ts (Issue #2689).
 *
 * Verifies the quality gate check that ensures every `needs-human` label
 * application routes through the `escalateToHuman` helper. The scanning
 * functions are exercised with literal inputs (real function calls,
 * assert on returned violations) — no source-text grep masquerading as a
 * unit test.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  NEEDS_HUMAN_ALLOWLIST,
  scanContentForDirectNeedsHuman,
  scanDirectoriesForDirectNeedsHuman,
} from "../lib/needs_human_direct_label_check.ts";

// =============================================================================
// scanContentForDirectNeedsHuman — content-level detection
// =============================================================================

Deno.test("scanContent - flags addLabel with literal needs-human string", () => {
  const content = 'await ghClient.addLabel(repo, n, "needs-human");';
  const violations = scanContentForDirectNeedsHuman(content, "lib/example.ts");
  assertEquals(violations.length, 1);
  assertEquals(violations[0]!.line, 1);
  assertEquals(violations[0]!.file, "lib/example.ts");
});

Deno.test("scanContent - flags addLabel with single-quoted needs-human", () => {
  const content = "await client.addLabel(repo, n, 'needs-human');";
  const violations = scanContentForDirectNeedsHuman(content, "lib/example.ts");
  assertEquals(violations.length, 1);
});

Deno.test("scanContent - flags addLabel with needsHumanLabel variable", () => {
  const content = "await ghClient.addLabel(repo, num, needsHumanLabel);";
  const violations = scanContentForDirectNeedsHuman(content, "lib/example.ts");
  assertEquals(violations.length, 1);
});

Deno.test("scanContent - flags addLabelToIssue with literal needs-human", () => {
  const content = 'await addLabelToIssue(repo, n, "needs-human", deps);';
  const violations = scanContentForDirectNeedsHuman(content, "lib/example.ts");
  assertEquals(violations.length, 1);
});

Deno.test("scanContent - flags addLabelToIssue with needsHumanLabel variable", () => {
  const content = "await addLabelToIssue(repo, n, needsHumanLabel, deps);";
  const violations = scanContentForDirectNeedsHuman(content, "lib/example.ts");
  assertEquals(violations.length, 1);
});

Deno.test("scanContent - case-insensitive on the literal label string", () => {
  const content = 'addLabelToIssue(repo, n, "Needs-Human");';
  const violations = scanContentForDirectNeedsHuman(content, "lib/example.ts");
  assertEquals(violations.length, 1);
});

Deno.test("scanContent - records the line number of the violation", () => {
  const content = [
    "function foo() {",
    "  doSomething();",
    '  ghClient.addLabel(repo, n, "needs-human");',
    "}",
  ].join("\n");
  const violations = scanContentForDirectNeedsHuman(content, "lib/multi.ts");
  assertEquals(violations.length, 1);
  assertEquals(violations[0]!.line, 3);
});

Deno.test("scanContent - reports one violation per offending line", () => {
  const content = [
    'ghClient.addLabel(repo, a, "needs-human");',
    "addLabelToIssue(repo, b, needsHumanLabel);",
  ].join("\n");
  const violations = scanContentForDirectNeedsHuman(content, "lib/two.ts");
  assertEquals(violations.length, 2);
});

// --- negatives -------------------------------------------------------------

Deno.test("scanContent - clean file routing through escalateToHuman is allowed", () => {
  const content = [
    "await escalateToHuman({",
    "  ghClient, repo, target, needsHumanLabel,",
    '  reason: "blocked", nextStep: "review", logger,',
    "});",
  ].join("\n");
  const violations = scanContentForDirectNeedsHuman(content, "lib/clean.ts");
  assertEquals(violations.length, 0);
});

Deno.test("scanContent - ignores a trailing line comment mentioning the pattern", () => {
  const content =
    '  doWork(); // never call addLabel(repo, n, "needs-human") directly';
  const violations = scanContentForDirectNeedsHuman(content, "lib/note.ts");
  assertEquals(violations.length, 0);
});

Deno.test("scanContent - ignores block comments mentioning the pattern", () => {
  const content = [
    "/**",
    ' * Do not call addLabelToIssue(repo, n, "needs-human") here.',
    " */",
    "export function foo() {}",
  ].join("\n");
  const violations = scanContentForDirectNeedsHuman(content, "lib/doc.ts");
  assertEquals(violations.length, 0);
});

Deno.test("scanContent - block comment stripping keeps line numbers aligned", () => {
  const content = [
    "/* multi",
    "   line",
    "   comment */",
    'ghClient.addLabel(repo, n, "needs-human");',
  ].join("\n");
  const violations = scanContentForDirectNeedsHuman(content, "lib/align.ts");
  assertEquals(violations.length, 1);
  assertEquals(violations[0]!.line, 4);
});

Deno.test("scanContent - ignores addLabel with an unrelated label", () => {
  const content = 'ghClient.addLabel(repo, n, "failed");';
  const violations = scanContentForDirectNeedsHuman(content, "lib/other.ts");
  assertEquals(violations.length, 0);
});

// =============================================================================
// scanDirectoriesForDirectNeedsHuman — directory scanning + allowlist
// =============================================================================

Deno.test("scanDirectories - finds a violation in a scanned file", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const libDir = `${tmpDir}/worker/deno/lib`;
  Deno.mkdirSync(libDir, { recursive: true });
  Deno.writeTextFileSync(
    `${libDir}/offender.ts`,
    'ghClient.addLabel(repo, n, "needs-human");\n',
  );

  const result = await scanDirectoriesForDirectNeedsHuman(tmpDir, [
    "worker/deno/lib",
  ]);
  assertEquals(result.violations.length, 1);
  assertEquals(result.violations[0]!.file, "worker/deno/lib/offender.ts");
  assertEquals(result.filesScanned, 1);

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("scanDirectories - skips allowlisted helper file", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const libDir = `${tmpDir}/worker/deno/lib`;
  Deno.mkdirSync(libDir, { recursive: true });
  // The helper file is permitted to apply the label directly.
  const allowlisted = [...NEEDS_HUMAN_ALLOWLIST][0]!; // worker/deno/lib/needs_human_escalation.ts
  Deno.writeTextFileSync(
    `${tmpDir}/${allowlisted}`,
    "await ghClient.addLabel(repo, target.number, needsHumanLabel);\n",
  );

  const result = await scanDirectoriesForDirectNeedsHuman(tmpDir, [
    "worker/deno/lib",
  ]);
  assertEquals(result.violations.length, 0);
  // Allowlisted file is skipped before being read, so it is not counted.
  assertEquals(result.filesScanned, 0);

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("scanDirectories - scans nested subdirectories", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const subDir = `${tmpDir}/worker/deno/lib/phases`;
  Deno.mkdirSync(subDir, { recursive: true });
  Deno.writeTextFileSync(
    `${subDir}/nested.ts`,
    "addLabelToIssue(repo, n, needsHumanLabel);\n",
  );

  const result = await scanDirectoriesForDirectNeedsHuman(tmpDir, [
    "worker/deno/lib",
  ]);
  assertEquals(result.violations.length, 1);
  assertEquals(
    result.violations[0]!.file,
    "worker/deno/lib/phases/nested.ts",
  );

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("scanDirectories - clean tree yields no violations", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const libDir = `${tmpDir}/worker/deno/lib`;
  Deno.mkdirSync(libDir, { recursive: true });
  Deno.writeTextFileSync(
    `${libDir}/clean.ts`,
    "await escalateToHuman({ ghClient, repo, needsHumanLabel });\n",
  );

  const result = await scanDirectoriesForDirectNeedsHuman(tmpDir, [
    "worker/deno/lib",
  ]);
  assertEquals(result.violations.length, 0);
  assertEquals(result.filesScanned, 1);

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("scanDirectories - missing directory is handled gracefully", async () => {
  const result = await scanDirectoriesForDirectNeedsHuman(
    "/nonexistent/repo/root",
    ["worker/deno/lib"],
  );
  assertEquals(result.violations.length, 0);
  assertEquals(result.filesScanned, 0);
});
