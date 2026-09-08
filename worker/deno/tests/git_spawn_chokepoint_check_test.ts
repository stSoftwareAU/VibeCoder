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
  GIT_SPAWN_SCAN_DIRS,
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

Deno.test("scanContentForGitSpawn - flags the generic wrapper called with git (Issue #1378)", () => {
  const violations = scanContentForGitSpawn(
    [
      "const origin = await runWithTimeout(",
      '  "git",',
      '  ["remote", "get-url", "origin"],',
      "  { cwd: repoDir, timeoutMs },",
      ");",
    ].join("\n"),
    "worker/deno/lib/release_check.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 1);
});

Deno.test("scanContentForGitSpawn - flags a git spawn routed through a variable (Issue #1378)", () => {
  const violations = scanContentForGitSpawn(
    [
      "async function runner(cmd: string[]) {",
      "  const command = new Deno.Command(cmd[0]!, { args: cmd.slice(1) });",
      "  return await command.output();",
      "}",
      'export const head = () => runner(["git", "rev-parse", "HEAD"]);',
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 2);
});

Deno.test("scanContentForGitSpawn - a runner that delegates to the chokepoint is compliant", () => {
  const violations = scanContentForGitSpawn(
    [
      'import { runGitCommand } from "./git_timeout.ts";',
      "async function runner(cmd: string[]) {",
      '  if (cmd[0] === "git") return await runGitCommand(cmd.slice(1));',
      "  const command = new Deno.Command(cmd[0]!, { args: cmd.slice(1) });",
      "  return await command.output();",
      "}",
      'export const head = () => runner(["git", "rev-parse", "HEAD"]);',
    ].join("\n"),
    "worker/deno/lib/example.ts",
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
// Issue #1259: `worker/deno/setup` was never in the scanned set, so the setup
// prerequisite probe ran `git config --global …` untimed and unjournalled
// while the gate reported clean. This fails against the unfixed scan set.
Deno.test("GIT_SPAWN_SCAN_DIRS - a direct git spawn under setup/ is caught", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmpDir}/worker/deno/setup`, { recursive: true });
    await Deno.writeTextFile(
      `${tmpDir}/worker/deno/setup/prerequisites.ts`,
      'const c = new Deno.Command("git", { args: ["config", "--global"] });\n',
    );

    const result = await scanDirectoriesForGitSpawn(
      tmpDir,
      GIT_SPAWN_SCAN_DIRS,
    );

    assertEquals(
      result.violations.map((v) => v.file),
      ["worker/deno/setup/prerequisites.ts"],
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// Issue #1214 this listed seven bypass sites — `codebase_map.ts`,
// `prompt_manager.ts`, `security_sarif_upload.ts`, `semgrep_check.ts`,
// `bash_script_refs_scanner.ts`, `stale_workdir.ts` and `pr_manager.ts` — each
// spawning git with no timeout and outside the audit journal.
Deno.test("scanDirectoriesForGitSpawn - the worker tree has no direct git spawns", async () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const result = await scanDirectoriesForGitSpawn(
    repoRoot,
    GIT_SPAWN_SCAN_DIRS,
  );
  assertEquals(
    result.violations.map((v) => `${v.file}:${v.line}`),
    [],
  );
});

// ---------------------------------------------------------------------------
// Cross-module pass-through runners (Issue #1553)
// ---------------------------------------------------------------------------

Deno.test("scanContentForGitSpawn - flags an argv-head pass-through runner whose callers live elsewhere (Issue #1553)", () => {
  // The argv is built in another module, so the file never names `git` — the
  // blind spot `resolve_cross_repo_dep.ts` sat in.
  const violations = scanContentForGitSpawn(
    [
      "export const run: RunCommand = async (cmd: string[]) => {",
      "  const command = new Deno.Command(cmd[0]!, {",
      "    args: cmd.slice(1),",
      "  });",
      "  return await command.output();",
      "};",
    ].join("\n"),
    "worker/deno/commands/example.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 2);
});

Deno.test("scanContentForGitSpawn - a pass-through runner that delegates git is compliant (Issue #1553)", () => {
  const violations = scanContentForGitSpawn(
    [
      'import { runGitArgv } from "../lib/git_timeout.ts";',
      "export const run: RunCommand = async (cmd: string[]) => {",
      '  if (cmd[0] === "git") return await runGitArgv(cmd);',
      "  const command = new Deno.Command(cmd[0]!, { args: cmd.slice(1) });",
      "  return await command.output();",
      "};",
    ].join("\n"),
    "worker/deno/commands/example.ts",
  );
  assertEquals(violations, []);
});

Deno.test("scanContentForGitSpawn - a spawn of a resolved binary is not a pass-through (Issue #1553)", () => {
  // `binary` is chosen inside the module, not taken from a caller's argv
  // head, so the widened rule leaves it alone.
  const violations = scanContentForGitSpawn(
    [
      "const binary = await resolveSemgrep();",
      "const command = new Deno.Command(binary, { args: probeArgs });",
      "return await command.output();",
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations, []);
});

Deno.test("scanDirectoriesForGitSpawn - a pass-through runner in the scanned tree is caught (Issue #1553)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmpDir}/worker/deno/commands`, { recursive: true });
    await Deno.writeTextFile(
      `${tmpDir}/worker/deno/commands/passthrough.ts`,
      [
        "export async function run(cmd: string[]) {",
        "  const command = new Deno.Command(cmd[0]!, { args: cmd.slice(1) });",
        "  return await command.output();",
        "}",
      ].join("\n"),
    );

    const result = await scanDirectoriesForGitSpawn(tmpDir, [
      "worker/deno/commands",
    ]);
    assertEquals(
      result.violations.map((v) => `${v.file}:${v.line}`),
      ["worker/deno/commands/passthrough.ts:2"],
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
