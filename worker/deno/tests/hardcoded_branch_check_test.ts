/**
 * Tests for hardcoded_branch_check.ts (Issue #1182).
 *
 * Verifies the quality gate check that detects hardcoded default branch
 * names in Deno source files to prevent assumptions about repo conventions.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  scanDirectoriesForHardcodedBranches,
  scanFileForHardcodedBranches,
  scanLineForHardcodedBranch,
} from "../lib/hardcoded_branch_check.ts";

// =============================================================================
// scanLineForHardcodedBranch — single-line detection
// =============================================================================

Deno.test("scanLineForHardcodedBranch - detects branch variable assigned 'main'", () => {
  assertEquals(scanLineForHardcodedBranch('let defaultBranch = "main";'), true);
});

Deno.test("scanLineForHardcodedBranch - detects branch variable assigned 'master'", () => {
  assertEquals(
    scanLineForHardcodedBranch('const baseBranch = "master";'),
    true,
  );
});

Deno.test("scanLineForHardcodedBranch - detects branch variable assigned 'Develop'", () => {
  assertEquals(scanLineForHardcodedBranch('let branch = "Develop";'), true);
});

Deno.test("scanLineForHardcodedBranch - detects single-quoted branch assignment", () => {
  assertEquals(scanLineForHardcodedBranch("let defaultBranch = 'main';"), true);
});

Deno.test("scanLineForHardcodedBranch - detects nullish coalescing fallback", () => {
  assertEquals(
    scanLineForHardcodedBranch('const branch = getDefault() ?? "main";'),
    true,
  );
});

Deno.test("scanLineForHardcodedBranch - detects OR fallback", () => {
  assertEquals(
    scanLineForHardcodedBranch('const branch = getDefault() || "master";'),
    true,
  );
});

Deno.test("scanLineForHardcodedBranch - detects array with multiple branch names", () => {
  assertEquals(
    scanLineForHardcodedBranch(
      'const candidates = ["Develop", "main", "master"];',
    ),
    true,
  );
});

Deno.test("scanLineForHardcodedBranch - detects array with two branch names", () => {
  assertEquals(scanLineForHardcodedBranch('["main", "master"]'), true);
});

Deno.test("scanLineForHardcodedBranch - ignores non-branch variable with 'main'", () => {
  assertEquals(
    scanLineForHardcodedBranch('const reason = "main entry point";'),
    false,
  );
});

Deno.test("scanLineForHardcodedBranch - ignores comment lines", () => {
  assertEquals(
    scanLineForHardcodedBranch('// let defaultBranch = "main";'),
    false,
  );
});

Deno.test("scanLineForHardcodedBranch - ignores lines with allow-list marker", () => {
  assertEquals(
    scanLineForHardcodedBranch(
      'let defaultBranch = "main"; // allow-hardcoded-branch',
    ),
    false,
  );
});

Deno.test("scanLineForHardcodedBranch - ignores array with only one branch name", () => {
  assertEquals(
    scanLineForHardcodedBranch('const list = ["main", "something-else"];'),
    false,
  );
});

Deno.test("scanLineForHardcodedBranch - ignores unrelated string assignments", () => {
  assertEquals(scanLineForHardcodedBranch('const name = "main";'), false);
});

Deno.test("scanLineForHardcodedBranch - ignores import statements", () => {
  assertEquals(
    scanLineForHardcodedBranch('import { main } from "./main.ts";'),
    false,
  );
});

Deno.test("scanLineForHardcodedBranch - detects backtick template with branch var", () => {
  assertEquals(scanLineForHardcodedBranch("let defaultBranch = `main`;"), true);
});

// =============================================================================
// scanFileForHardcodedBranches — file-level scanning
// =============================================================================

Deno.test("scanFileForHardcodedBranches - returns violations with line numbers", () => {
  const content = [
    'import { something } from "./mod.ts";',
    "",
    "function getDefault() {",
    '  let defaultBranch = "main";',
    "  return defaultBranch;",
    "}",
  ].join("\n");

  const violations = scanFileForHardcodedBranches(content, "lib/example.ts");
  assertEquals(violations.length, 1);
  assertEquals(violations[0]!.line, 4);
  assertEquals(violations[0]!.file, "lib/example.ts");
});

Deno.test("scanFileForHardcodedBranches - returns empty for clean file", () => {
  const content = [
    "const branch = await getDefaultBranch(repo);",
    "console.log(branch);",
  ].join("\n");

  const violations = scanFileForHardcodedBranches(content, "lib/clean.ts");
  assertEquals(violations.length, 0);
});

Deno.test("scanFileForHardcodedBranches - respects allow-list comments", () => {
  const content = [
    'let defaultBranch = "main"; // allow-hardcoded-branch',
    'let otherBranch = "master";',
  ].join("\n");

  const violations = scanFileForHardcodedBranches(content, "lib/mixed.ts");
  assertEquals(violations.length, 1);
  assertEquals(violations[0]!.line, 2);
});

Deno.test("scanFileForHardcodedBranches - detects array violations", () => {
  const content = 'const candidates = ["Develop", "main", "master"];';
  const violations = scanFileForHardcodedBranches(content, "lib/array.ts");
  assertEquals(violations.length, 1);
});

Deno.test("scanFileForHardcodedBranches - multiple violations in one file", () => {
  const content = [
    'let baseBranch = "main";',
    'const defaultBranch = "master";',
    'const candidates = ["main", "master"];',
  ].join("\n");

  const violations = scanFileForHardcodedBranches(content, "lib/multi.ts");
  assertEquals(violations.length, 3);
});

// =============================================================================
// scanDirectoriesForHardcodedBranches — directory scanning
// =============================================================================

Deno.test("scanDirectoriesForHardcodedBranches - scans .ts files and finds violations", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const libDir = `${tmpDir}/lib`;
  Deno.mkdirSync(libDir, { recursive: true });

  Deno.writeTextFileSync(
    `${libDir}/example.ts`,
    'let defaultBranch = "main";\n',
  );

  const result = await scanDirectoriesForHardcodedBranches([libDir]);
  assertEquals(result.violations.length, 1);
  assertEquals(result.filesScanned >= 1, true);

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("scanDirectoriesForHardcodedBranches - skips test files", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const libDir = `${tmpDir}/lib`;
  Deno.mkdirSync(libDir, { recursive: true });

  Deno.writeTextFileSync(
    `${libDir}/example_test.ts`,
    'let defaultBranch = "main";\n',
  );

  const result = await scanDirectoriesForHardcodedBranches([libDir]);
  assertEquals(result.violations.length, 0);

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("scanDirectoriesForHardcodedBranches - skips non-ts files", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const libDir = `${tmpDir}/lib`;
  Deno.mkdirSync(libDir, { recursive: true });

  Deno.writeTextFileSync(
    `${libDir}/readme.md`,
    'let defaultBranch = "main";\n',
  );

  const result = await scanDirectoriesForHardcodedBranches([libDir]);
  assertEquals(result.violations.length, 0);
  assertEquals(result.filesScanned, 0);

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("scanDirectoriesForHardcodedBranches - returns clean result for compliant files", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const libDir = `${tmpDir}/lib`;
  Deno.mkdirSync(libDir, { recursive: true });

  Deno.writeTextFileSync(
    `${libDir}/clean.ts`,
    "const branch = await getDefaultBranch(repo);\n",
  );

  const result = await scanDirectoriesForHardcodedBranches([libDir]);
  assertEquals(result.violations.length, 0);
  assertEquals(result.filesScanned, 1);

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});

Deno.test("scanDirectoriesForHardcodedBranches - handles missing directory gracefully", async () => {
  const result = await scanDirectoriesForHardcodedBranches([
    "/nonexistent/path",
  ]);
  assertEquals(result.violations.length, 0);
  assertEquals(result.filesScanned, 0);
});

Deno.test("scanDirectoriesForHardcodedBranches - scans subdirectories", async () => {
  const tmpDir = Deno.makeTempDirSync();
  const subDir = `${tmpDir}/lib/sub`;
  Deno.mkdirSync(subDir, { recursive: true });

  Deno.writeTextFileSync(
    `${subDir}/nested.ts`,
    'let baseBranch = "master";\n',
  );

  const result = await scanDirectoriesForHardcodedBranches([`${tmpDir}/lib`]);
  assertEquals(result.violations.length, 1);

  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
});
