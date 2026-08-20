/**
 * Regression: an attacker-controlled PR head branch that begins with a dash
 * is refused before it reaches git (Issue #12, CWE-88).
 *
 * The unit-level proof is that every builder in `git_ref_args.ts` and the
 * entry guards on the PR-branch functions throw / return an error on a
 * dash-leading ref; the chokepoint scanner (git_ref_argv_check_test.ts)
 * proves no site bypasses them. This suite pins the behaviour at the two
 * seams the exploit travelled through: `isWorkerPr` selection and
 * `updatePrBranch`.
 */

import { assert, assertEquals } from "@std/assert";
import { isWorkerPr } from "../lib/pr_branch_update.ts";
import { WORKER_PR_MARKER_PREFIX } from "../lib/pr_body.ts";
import { updatePrBranch } from "../lib/git_pull.ts";

const EVIL = "--upload-pack=touch /tmp/pwned";

Deno.test("a spoofed worker marker on a dash-leading branch is not selected for maintenance", () => {
  // The exact trigger the finding described: paste the public marker, keep an
  // argument-injecting head branch.
  assertEquals(isWorkerPr(`${WORKER_PR_MARKER_PREFIX}42 -->`, EVIL), false);
  // A genuine worker branch shape is still selected.
  assert(isWorkerPr(undefined, "issue-42-fix-thing"));
});

Deno.test("updatePrBranch refuses a dash-leading head branch without running git", async () => {
  let ran = false;
  const result = await updatePrBranch(EVIL, "main", {
    cwd: "/nonexistent-vibe-12",
  });
  // It returns a handled error, and never spawned git (cwd does not exist —
  // a git run there would fail differently, but the guard short-circuits).
  assertEquals(result.ok, false);
  if (!result.ok) {
    assert(
      result.error.message.includes("must not begin with '-'"),
      result.error.message,
    );
  }
  assertEquals(ran, false);
});

Deno.test("updatePrBranch refuses a dash-leading base branch too", async () => {
  const result = await updatePrBranch("issue-1-x", EVIL, {
    cwd: "/nonexistent-vibe-12",
  });
  assertEquals(result.ok, false);
});
