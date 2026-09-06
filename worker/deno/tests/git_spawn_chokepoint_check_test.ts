/**
 * Tests for the `git` spawn chokepoint quality-gate check (Issue #1214).
 *
 * The scanner is exercised behaviourally: literal file contents for the
 * content scanner, and real temporary directories for the directory walk
 * (including the allowlisted chokepoint file itself).
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import {
  scanContentForGitSpawn,
  scanDirectoriesForGitSpawn,
} from "../lib/git_spawn_chokepoint_check.ts";

Deno.test("scanContentForGitSpawn - flags a direct git spawn", () => {
  const violations = scanContentForGitSpawn(
    [
      "async function run(args: string[]) {",
      '  const command = new Deno.Command("git", { args });',
      "  return await command.output();",
      "}",
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 2);
  assertEquals(violations[0]?.file, "worker/deno/lib/example.ts");
});

Deno.test("scanContentForGitSpawn - flags an inline spawn with no intermediate variable", () => {
  const violations = scanContentForGitSpawn(
    [
      'const out = await new Deno.Command("git", {',
      '  args: ["-C", repoDir, "push", "origin", branch],',
      "}).output();",
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 1);
});

Deno.test("scanContentForGitSpawn - ignores other binaries and the chokepoint helper", () => {
  const violations = scanContentForGitSpawn(
    [
      'const gh = new Deno.Command("gh", { args });',
      "const out = await runGitCommand(args, { cwd });",
      "const checked = await runGitCommandChecked(args);",
      'const other = new Deno.Command("gitleaks", { args });',
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForGitSpawn - ignores comments mentioning the pattern", () => {
  const violations = scanContentForGitSpawn(
    [
      "/**",
      ' * Never write `new Deno.Command("git", …)` here.',
      " */",
      '// legacy: new Deno.Command("git", { args })',
      "export const x = 1;",
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForGitSpawn - flags a variable binary handed a git argv literal", () => {
  const violations = scanContentForGitSpawn(
    [
      "async function run(call: { bin: string; args: string[] }) {",
      "  const command = new Deno.Command(call.bin, { args: call.args });",
      "  return await command.output();",
      "}",
      'await run({ bin: "git", args: ["ls-files"] });',
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 2);
});

Deno.test("scanContentForGitSpawn - a variable binary that delegates git to the chokepoint is clean", () => {
  const violations = scanContentForGitSpawn(
    [
      'import { runGitCommand } from "./git_timeout.ts";',
      "async function run(call: { bin: string; args: string[] }) {",
      '  if (call.bin === "git") return await runGitCommand(call.args);',
      "  const command = new Deno.Command(call.bin, { args: call.args });",
      "  return await command.output();",
      "}",
      'await run({ bin: "git", args: ["ls-files"] });',
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForGitSpawn - an allowlisted module naming git as tool data is clean", () => {
  // `secrets_history_scan.ts` passes "git" as gitleaks' source-type argument,
  // not as a binary — a documented false positive (Issue #1227).
  const violations = scanContentForGitSpawn(
    [
      "async function run(cmd: { bin: string; args: string[] }) {",
      "  const command = new Deno.Command(cmd.bin, { args: cmd.args });",
      "  return await command.output();",
      "}",
      'await run({ bin: "gitleaks", args: ["git", "/repo"] });',
    ].join("\n"),
    "worker/deno/lib/secrets_history_scan.ts",
  );
  assertEquals(violations, []);
});

Deno.test("scanDirectoriesForGitSpawn - walks directories and honours the allowlist", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmpDir}/worker/deno/lib`, { recursive: true });
    await Deno.mkdir(`${tmpDir}/worker/deno/commands`, { recursive: true });

    // The chokepoint itself is allowed to spawn git.
    await Deno.writeTextFile(
      `${tmpDir}/worker/deno/lib/git_timeout.ts`,
      'const c = new Deno.Command("git", { args });\n',
    );
    // A compliant caller.
    await Deno.writeTextFile(
      `${tmpDir}/worker/deno/lib/good.ts`,
      "const out = await runGitCommand(args);\n",
    );
    // A bypassing caller.
    await Deno.writeTextFile(
      `${tmpDir}/worker/deno/commands/bad.ts`,
      'const c = new Deno.Command("git", { args: ["push", "origin"] });\n',
    );

    const result = await scanDirectoriesForGitSpawn(tmpDir, [
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

Deno.test("scanDirectoriesForGitSpawn - test fixtures may spawn git directly", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmpDir}/worker/deno/lib`, { recursive: true });
    // A co-located test builds throwaway repositories — not a production
    // surface, so it is not held to the chokepoint.
    await Deno.writeTextFile(
      `${tmpDir}/worker/deno/lib/thing_test.ts`,
      'const c = new Deno.Command("git", { args: ["init"] });\n',
    );

    const result = await scanDirectoriesForGitSpawn(tmpDir, [
      "worker/deno/lib",
    ]);

    assertEquals(result.filesScanned, 0);
    assertEquals(result.violations, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("scanDirectoriesForGitSpawn - missing directories yield no violations", async () => {
  const result = await scanDirectoriesForGitSpawn("/nonexistent-root-xyz", [
    "worker/deno/lib",
  ]);
  assertEquals(result.filesScanned, 0);
  assertEquals(result.violations, []);
});

// The production tree must satisfy the invariant this check enforces. Before
// Issue #1214 this listed seven bypass sites — `codebase_map.ts`,
// `prompt_manager.ts`, `security_sarif_upload.ts`, `semgrep_check.ts`,
// `bash_script_refs_scanner.ts`, `stale_workdir.ts` and `pr_manager.ts` — each
// spawning git with no timeout and outside the audit journal.
Deno.test("scanDirectoriesForGitSpawn - the worker tree has no direct git spawns", async () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const result = await scanDirectoriesForGitSpawn(repoRoot, [
    "worker/deno/lib",
    "worker/deno/commands",
  ]);
  assertEquals(
    result.violations.map((v) => `${v.file}:${v.line}`),
    [],
  );
});
