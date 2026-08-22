/**
 * The git-ref argument-injection chokepoint (Issue #12).
 *
 * Unit cases drive the scanner over synthetic content; the last case runs it
 * over the real `worker/deno/{lib,commands}` tree, so the gate fails the day a
 * new call site passes a ref to `fetch`/`pull`/`checkout`/`rebase` inline
 * instead of through the `git_ref_args.ts` builders.
 */

import { assert, assertEquals } from "@std/assert";
import {
  GIT_REF_ARGV_ALLOWLIST,
  scanContentForGitRefArgv,
  scanDirectoriesForGitRefArgv,
} from "../lib/git_ref_argv_check.ts";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;

Deno.test("scanner - flags an inline fetch/checkout/pull/rebase ref", () => {
  for (
    const line of [
      'await runGitCommand(["fetch", "origin", branchName], opts);',
      'await runGitCommand(["checkout", branchName], opts);',
      'await runGitCommand(["pull", "origin", branchName], opts);',
      'await runGitCommand(["checkout", "-b", branchName, base], opts);',
      'await gitCommandFn(["checkout", pr.headRefName]);',
      'await runGitCommand(["fetch", "origin", candidate.headBranch], opts);',
    ]
  ) {
    const v = scanContentForGitRefArgv(line, "worker/deno/lib/x.ts");
    assertEquals(v.length, 1, line);
  }
});

Deno.test("scanner - the builder-shaped array is not a violation", () => {
  // `--end-of-options` immediately after the verb is the sanctioned shape.
  for (
    const line of [
      'return ["fetch", "--end-of-options", remote, ref];',
      'return ["checkout", "--end-of-options", ref];',
      // safe internal refs are out of scope for this CWE-88 gate:
      'runGitCommand(["checkout", defaultBranch], opts);',
      'runGitCommand(["fetch", "origin", baseBranch], opts);',
      'runGitCommand(["rebase", baseBranch], opts);',
      'runGitCommand(["fetch", "origin", milestoneBranch], opts);',
    ]
  ) {
    assertEquals(scanContentForGitRefArgv(line, "x.ts"), []);
  }
});

Deno.test("scanner - non-ref git verbs are ignored", () => {
  for (
    const line of [
      'runGitCommand(["rev-list", "--count", `HEAD..${base}`], opts);',
      'runGitCommand(["status", "--porcelain"], opts);',
      'runGitCommand(["remote", "set-url", "origin", url], opts);',
    ]
  ) {
    assertEquals(scanContentForGitRefArgv(line, "x.ts"), []);
  }
});

// ===========================================================================
// Issue #275 — push and rebase join the guarded verbs
// ===========================================================================

Deno.test("scanner - flags an unguarded push of a PR head branch (Issues #267, #275)", () => {
  // The #267 shape: pr_ci_nudge pushed a GitHub-controlled PR head branch as
  // a bare positional. The gate called it clean because `push` was excluded
  // outright, which is how it reached main.
  const violations = scanContentForGitRefArgv(
    'await runGitCommand(["push", "origin", headRefName], opts);',
    "worker/deno/lib/pr_ci_nudge.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 1);
});

Deno.test("scanner - flags a multi-line push argv (Issues #267, #268, #275)", () => {
  // The #268 evasion applied to a push: no single line holds both the verb
  // and the attacker-controlled identifier, so a line-local scan sees nothing.
  const violations = scanContentForGitRefArgv(
    `await runGitCommand([
      "push",
      "origin",
      branchName,
    ], options);`,
    "worker/deno/lib/x.ts",
  );
  assertEquals(violations.length, 1);
});

Deno.test("scanner - flags an unguarded rebase onto a PR head branch (Issue #275)", () => {
  // `rebase` was named in the module contract and in buildRebaseArgs but was
  // missing from the pattern, so the documentation promised a gate that was
  // not there.
  assertEquals(
    scanContentForGitRefArgv(
      'runGitCommand(["rebase", headBranch], opts);',
      "x.ts",
    ).length,
    1,
  );
});

Deno.test("scanner - a builder-shaped push with a flag before the separator is clean (Issue #275)", () => {
  // buildPushArgs emits `["push", "-u", "--end-of-options", remote, branch]`
  // and the lease form puts `--force-with-lease=…` in the same position. A
  // lookahead for the separator in the very next slot would have called both
  // of those safe arrays a violation.
  for (
    const line of [
      'return ["push", "--end-of-options", remote, branchName];',
      'return ["push", "-u", "--end-of-options", remote, branchName];',
      'return ["push", `--force-with-lease=${branchName}:${sha}`, "--end-of-options", remote, branchName];',
      'return ["rebase", "--end-of-options", branchName];',
    ]
  ) {
    assertEquals(scanContentForGitRefArgv(line, "x.ts"), [], line);
  }
});

Deno.test("scanner - safe internal refs stay out of scope for push and rebase (Issue #275)", () => {
  for (
    const line of [
      'runGitCommand(["push", "origin", defaultBranch], opts);',
      'runGitCommand(["rebase", baseBranch], opts);',
      'runGitCommand(["push", "origin", milestoneBranch], opts);',
    ]
  ) {
    assertEquals(scanContentForGitRefArgv(line, "x.ts"), [], line);
  }
});

Deno.test("scanner - a comment naming the pattern is not a violation", () => {
  assertEquals(
    scanContentForGitRefArgv(
      '// ["fetch", "origin", branchName] is unsafe',
      "x.ts",
    ),
    [],
  );
});

Deno.test("scanner - flags a multi-line fetch argv (Issue #268)", () => {
  const content = `const fetchResult = await deps.runGitCommand([
      "fetch",
      "origin",
      branchName,
    ]);`;
  const violations = scanContentForGitRefArgv(content, "worker/deno/lib/x.ts");
  assertEquals(violations.length, 1, JSON.stringify(violations));
  assertEquals(violations[0]?.file, "worker/deno/lib/x.ts");
});

Deno.test("the real lib/commands tree routes every ref through the builders (Issue #12)", async () => {
  const { violations, filesScanned } = await scanDirectoriesForGitRefArgv(
    REPO_ROOT,
  );
  assert(filesScanned > 100, `expected a real scan, got ${filesScanned} files`);
  assertEquals(
    violations,
    [],
    "inline git ref argv found — route through git_ref_args.ts builders:\n" +
      violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join("\n"),
  );
});

Deno.test("only the builders file is allowlisted", () => {
  assertEquals([...GIT_REF_ARGV_ALLOWLIST], [
    "worker/deno/lib/git_ref_args.ts",
  ]);
});
