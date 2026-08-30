/**
 * Tests for branch_history_rewrite.ts (Issue #630).
 *
 * The behaviour under test is the one that bit a real PR: a secret finding
 * lives in the commit range, so a further commit cannot clear it. These cover
 * the rebuild that can, and — more importantly — every case where it must
 * refuse, because a wrong force-push destroys work that is not ours.
 *
 * Australian English spelling throughout (behaviour, recognise).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildRewriteCommitMessage,
  isOwnedBranch,
  rebuildBranchHistory,
} from "../lib/branch_history_rewrite.ts";
import type { Result } from "../types.ts";

type GitOut = { code: number; stdout: string; stderr: string };

/** A fake git that answers by subcommand and records the argv it was given. */
function fakeGit(
  answers: Record<string, GitOut>,
  calls: string[][] = [],
): {
  run: (
    args: string[],
    options?: { cwd?: string },
  ) => Promise<Result<GitOut>>;
  calls: string[][];
} {
  return {
    run: (args: string[]) => {
      calls.push(args);
      const key = args[0] === "rev-list" ? "rev-list" : args[0] ?? "";
      const answer = answers[key] ?? { code: 0, stdout: "", stderr: "" };
      return Promise.resolve({ ok: true as const, value: answer });
    },
    calls,
  };
}

const BASE_SHA = "a".repeat(40);

function happyAnswers(): Record<string, GitOut> {
  return {
    "merge-base": { code: 0, stdout: `${BASE_SHA}\n`, stderr: "" },
    log: { code: 0, stdout: "worker@example.com\n", stderr: "" },
    "rev-list": { code: 0, stdout: "3\n", stderr: "" },
    reset: { code: 0, stdout: "", stderr: "" },
    commit: { code: 0, stdout: "", stderr: "" },
    push: { code: 0, stdout: "", stderr: "" },
  };
}

// ---------------------------------------------------------------------------
// isOwnedBranch — the guard that decides whether a rewrite is even considered
// ---------------------------------------------------------------------------

Deno.test("isOwnedBranch - recognises the branch shapes a run creates", () => {
  assert(isOwnedBranch("fix/secret-scan", "main"));
  assert(isOwnedBranch("issue/630-rewrite", "main"));
  assert(isOwnedBranch("milestone/509", "main"));
});

Deno.test("isOwnedBranch - never the default branch, by name or by base", () => {
  // Both paths matter: `main` as the base it was cut from, and `main` in the
  // protected list for a repo whose default branch is called something else.
  assertEquals(isOwnedBranch("main", "main"), false);
  assertEquals(isOwnedBranch("main", "develop"), false);
  assertEquals(isOwnedBranch("master", "main"), false);
  assertEquals(isOwnedBranch("trunk", "main"), false);
});

Deno.test("isOwnedBranch - refuses a branch this automation did not create", () => {
  // Somebody's own working branch. The cost of refusing is one escalation;
  // the cost of allowing is their lost commits.
  assertEquals(isOwnedBranch("nigel/experiment", "main"), false);
  assertEquals(isOwnedBranch("release-2.1", "main"), false);
});

// ---------------------------------------------------------------------------
// rebuildBranchHistory — the rebuild itself
// ---------------------------------------------------------------------------

Deno.test("rebuildBranchHistory - collapses to one commit and force-pushes with a lease", async () => {
  const git = fakeGit(happyAnswers());
  const result = await rebuildBranchHistory({
    branchName: "fix/secret-scan",
    baseBranch: "main",
    commitMessage: "rebuilt",
  }, { runGitCommand: git.run });

  assert(result.ok);
  assertEquals(result.value.collapsedCommits, 3);
  assertEquals(result.value.baseSha, BASE_SHA);

  // --soft keeps the corrected tree the caller staged; a hard reset would
  // throw away the very fix this exists to preserve.
  const reset = git.calls.find((c) => c[0] === "reset");
  assertEquals(reset, ["reset", "--soft", BASE_SHA]);

  // --force-with-lease, never a bare --force: Issue #534 was a force-push
  // that dropped another writer's commit.
  const push = git.calls.find((c) => c[0] === "push");
  assert(push?.includes("--force-with-lease"));
  assertEquals(push?.includes("--force"), false);
  // Issue #12: built by git_ref_args.ts, so `--end-of-options` separates the
  // flags from the positionals. A dash-leading branch name must never reach
  // git as a flag — least of all on the one call that force-pushes.
  assert(push?.includes("--end-of-options"));
  assertEquals(
    push?.indexOf("--end-of-options")! < push?.indexOf("fix/secret-scan")!,
    true,
  );
});

Deno.test("rebuildBranchHistory - rebuilds onto the merge base, not the base tip", async () => {
  // Rebuilding onto origin/main's tip would drag in everything merged since
  // the branch was cut, turning a history rewrite into an unreviewed rebase.
  const git = fakeGit(happyAnswers());
  await rebuildBranchHistory({
    branchName: "fix/secret-scan",
    baseBranch: "main",
    commitMessage: "rebuilt",
  }, { runGitCommand: git.run });

  const mergeBase = git.calls.find((c) => c[0] === "merge-base");
  assertEquals(mergeBase, ["merge-base", "origin/main", "HEAD"]);
});

Deno.test("rebuildBranchHistory - refuses a branch it does not own, touching nothing", async () => {
  const git = fakeGit(happyAnswers());
  const result = await rebuildBranchHistory({
    branchName: "main",
    baseBranch: "main",
    commitMessage: "rebuilt",
  }, { runGitCommand: git.run });

  assert(!result.ok);
  assertStringIncludes(result.error.message, "not a branch this run owns");
  // The refusal must come before any git call that changes state.
  assertEquals(git.calls.length, 0);
});

Deno.test("rebuildBranchHistory - refuses a branch carrying someone else's commits", async () => {
  const answers = happyAnswers();
  answers["log"] = {
    code: 0,
    stdout: "worker@example.com\nnigel@stsoftware.com.au\n",
    stderr: "",
  };
  const git = fakeGit(answers);
  const result = await rebuildBranchHistory({
    branchName: "fix/shared-branch",
    baseBranch: "main",
    commitMessage: "rebuilt",
    ownedAuthorEmails: ["worker@example.com"],
  }, { runGitCommand: git.run });

  assert(!result.ok);
  assertStringIncludes(result.error.message, "nigel@stsoftware.com.au");
  // Nothing was reset, committed or pushed.
  assertEquals(
    git.calls.some((c) => ["reset", "commit", "push"].includes(c[0] ?? "")),
    false,
  );
});

Deno.test("rebuildBranchHistory - a branch with no commits of its own means the finding is in the base", async () => {
  const answers = happyAnswers();
  answers["rev-list"] = { code: 0, stdout: "0\n", stderr: "" };
  const git = fakeGit(answers);
  const result = await rebuildBranchHistory({
    branchName: "fix/nothing-here",
    baseBranch: "main",
    commitMessage: "rebuilt",
  }, { runGitCommand: git.run });

  assert(!result.ok);
  // The message has to point at the base branch, or a reviewer looks in the
  // wrong place for a credential that is already exposed.
  assertStringIncludes(result.error.message, "in 'main' itself");
});

Deno.test("rebuildBranchHistory - a refused lease is reported as another writer, not a git error", async () => {
  const answers = happyAnswers();
  answers["push"] = {
    code: 1,
    stdout: "",
    stderr: "! [rejected] fix/x -> fix/x (stale info)",
  };
  const git = fakeGit(answers);
  const result = await rebuildBranchHistory({
    branchName: "fix/secret-scan",
    baseBranch: "main",
    commitMessage: "rebuilt",
  }, { runGitCommand: git.run });

  assert(!result.ok);
  assertStringIncludes(result.error.message, "another writer has moved");
  assertStringIncludes(result.error.message, "stale info");
});

Deno.test("rebuildBranchHistory - a merge base that is not a sha is refused", async () => {
  const answers = happyAnswers();
  answers["merge-base"] = { code: 0, stdout: "\n", stderr: "" };
  const git = fakeGit(answers);
  const result = await rebuildBranchHistory({
    branchName: "fix/secret-scan",
    baseBranch: "main",
    commitMessage: "rebuilt",
  }, { runGitCommand: git.run });

  assert(!result.ok);
  assertStringIncludes(result.error.message, "no usable sha");
  assertEquals(git.calls.some((c) => c[0] === "reset"), false);
});

// ---------------------------------------------------------------------------
// The commit message
// ---------------------------------------------------------------------------

Deno.test("buildRewriteCommitMessage - explains the squash and names no secret", () => {
  const message = buildRewriteCommitMessage("gitleaks", 629);
  assertStringIncludes(message, "gitleaks");
  assertStringIncludes(message, "Issue #630");
  assertStringIncludes(message, "PR #629");
  // A reader finding a squashed branch with no explanation assumes a mistake.
  assertStringIncludes(message, "scans every commit");
});
