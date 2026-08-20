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
      'runGitCommand(["push", "origin", branchName], opts);',
    ]
  ) {
    assertEquals(scanContentForGitRefArgv(line, "x.ts"), []);
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
