/**
 * Tests for git_branch_args.ts — safe `git branch` argument construction
 * (Issue #2798).
 *
 * A branch name is an untrusted positional (derived from `git branch` output,
 * the GitHub API, or a PR `headRefName`). The `--` end-of-options separator
 * must always precede it so a name beginning with `-` can never be parsed as a
 * git option (argument/option-injection defence-in-depth).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { buildBranchDeleteArgs } from "../lib/git_branch_args.ts";

Deno.test("buildBranchDeleteArgs - safe delete uses -d with -- before the name", () => {
  assertEquals(buildBranchDeleteArgs("issue-123"), [
    "branch",
    "-d",
    "--",
    "issue-123",
  ]);
});

Deno.test("buildBranchDeleteArgs - force delete uses -D with -- before the name", () => {
  assertEquals(buildBranchDeleteArgs("issue-123", true), [
    "branch",
    "-D",
    "--",
    "issue-123",
  ]);
});

Deno.test("buildBranchDeleteArgs - the -- separator immediately precedes the branch positional", () => {
  const args = buildBranchDeleteArgs("issue-456", true);
  const sepIndex = args.indexOf("--");
  // Separator must exist and the branch name must be the very next argument.
  assertEquals(sepIndex >= 0, true);
  assertEquals(args[sepIndex + 1], "issue-456");
  // Nothing after the branch name.
  assertEquals(args.length, sepIndex + 2);
});

Deno.test("buildBranchDeleteArgs - a -leading branch name lands after -- (cannot be parsed as an option)", () => {
  // git/GitHub block such names today, so this is defence-in-depth: even if a
  // value like "-D" or "--force" reached the builder, it is positioned after
  // the separator and is therefore treated as a ref, never an option.
  for (const hostile of ["-D", "--force", "-rf"]) {
    const args = buildBranchDeleteArgs(hostile, true);
    const sepIndex = args.indexOf("--");
    // The hostile value is the branch positional: it sits after the separator
    // (where git treats it as a ref) and is the final argument.
    assertEquals(args[sepIndex + 1], hostile);
    assertEquals(args.length, sepIndex + 2);
  }
});
