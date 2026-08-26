/**
 * Tests for clone_contention.ts — clone contention is not a PR fault
 * (Issue #394).
 *
 * The messages exercised here are the ones the worker actually logged in the
 * cycle that produced the issue, plus the git wordings the same class of
 * collision produces.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyCloneContention,
  describeCloneContention,
} from "../lib/clone_contention.ts";
import { LOCAL_AHEAD_OF_REMOTE_ERROR } from "../lib/git_branch_sync.ts";

Deno.test("classifyCloneContention - the observed 'pathspec did not match' is a vanished branch", () => {
  const contention = classifyCloneContention(
    new Error(
      "Failed to checkout branch 'issue-373-prompts-coding-guidelines': " +
        "error: pathspec 'issue-373-prompts-coding-guidelines' did not match " +
        "any file(s) known to git",
    ),
  );
  assertEquals(contention?.kind, "branch-vanished");
});

Deno.test("classifyCloneContention - a corrupt ref reaches the same misleading message and is still contention", () => {
  const contention = classifyCloneContention(
    "Failed to fetch PR branch error=fatal: bad object refs/heads/milestone/357-audit",
  );
  assertEquals(contention?.kind, "branch-vanished");
});

Deno.test("classifyCloneContention - a branch another worktree holds is contention, not a fault", () => {
  assertEquals(
    classifyCloneContention(
      new Error(
        "fatal: 'issue-366-fix' is already checked out at '/work/VibeCoder'",
      ),
    )?.kind,
    "branch-held",
  );
  assertEquals(
    classifyCloneContention(
      "fatal: cannot force update the branch 'main' checked out at '/work/demo'",
    )?.kind,
    "branch-held",
  );
});

Deno.test("classifyCloneContention - a git lock held by another lane is contention", () => {
  assertEquals(
    classifyCloneContention(
      "fatal: Unable to create '/work/demo/.git/index.lock': File exists.",
    )?.kind,
    "clone-locked",
  );
});

Deno.test("classifyCloneContention - the Issue #211 refusal is contention, by name and by wording", () => {
  const named = new Error("something the future rewords");
  named.name = LOCAL_AHEAD_OF_REMOTE_ERROR;
  assertEquals(classifyCloneContention(named)?.kind, "unpushed-local-work");

  assertEquals(
    classifyCloneContention(
      "Local branch 'issue-366-fix' is ahead of the remote head by 2 " +
        "commit(s) — refusing to judge it against its base (Issue #211)",
    )?.kind,
    "unpushed-local-work",
  );
  assertEquals(
    classifyCloneContention(
      "Local branch 'issue-366-fix' holds 2 commit(s) that " +
        "origin/issue-366-fix does not",
    )?.kind,
    "unpushed-local-work",
  );
});

Deno.test("classifyCloneContention - a real PR failure is NOT reclassified as contention", () => {
  assertEquals(
    classifyCloneContention(
      new Error(
        "Failed to push updated branch 'issue-9-x': ! [remote rejected] " +
          "issue-9-x -> issue-9-x (protected branch hook declined)",
      ),
    ),
    null,
  );
  assertEquals(
    classifyCloneContention(
      new Error("PR branch 'issue-9-x' conflicts with 'main' during rebase"),
    ),
    null,
  );
  assertEquals(classifyCloneContention(new Error("")), null);
});

Deno.test("describeCloneContention - says the PR is not at fault and keeps git's words", () => {
  const contention = classifyCloneContention(
    "error: pathspec 'issue-373-x' did not match any file(s) known to git",
  );
  assertEquals(contention !== null, true);
  const line = describeCloneContention(contention!);
  assertStringIncludes(line, "not at fault");
  assertStringIncludes(line, "retried next cycle");
  assertStringIncludes(line, "did not match any file(s) known to git");
});
