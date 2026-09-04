/**
 * Issue #853: a repo-level milestone-branch rejection is reported once, not
 * once per sub-issue.
 *
 * On GRQ-23 on 2026-09-03, ruleset "Milestone" applied
 * `required_status_checks` to `refs/heads/milestone/**`. A branch being
 * created has no checks, so every push was refused, and the fleet claimed
 * nine sub-issues in turn, failed each in `setup`, and parked each with
 * `needs-human` — nine human chores for one configuration fact, none of
 * which clear themselves once it is fixed (Issue #854).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  claimRepoLevelRejectionReport,
  describeRepoLevelRejection,
  hasReportedRepoLevelRejection,
  isRepoLevelBranchRejection,
  resetRepoLevelRejectionsForTest,
} from "../lib/milestone_branch_rejection.ts";

/** The exact error the fleet hit, abridged only in the ref name. */
const GH013 =
  "Failed to push milestone branch milestone/794-prompt-terminology: " +
  "git push -u origin milestone/794-prompt-terminology failed (exit code 1): " +
  "remote: error: GH013: Repository rule violations found for " +
  "refs/heads/milestone/794-prompt-terminology. " +
  "! [remote rejected] (push declined due to repository rule violations)";

const BRANCH = "milestone/794-prompt-terminology";
const REPO = "stSoftwareAU/VibeCoder";

Deno.test("branch rejection - the observed GH013 failure is recognised as repo-level (Issue #853)", () => {
  assertEquals(isRepoLevelBranchRejection(GH013), true);
});

Deno.test("branch rejection - protection and permission failures are repo-level (Issue #853)", () => {
  for (
    const message of [
      "remote: error: GH006: Protected branch update failed",
      "remote: Required status check 'validate' is expected",
      "remote: Permission to stSoftwareAU/VibeCoder.git denied to VibeCoderST",
    ]
  ) {
    assertEquals(
      isRepoLevelBranchRejection(message),
      true,
      `should be repo-level: ${message}`,
    );
  }
});

Deno.test("branch rejection - an ordinary git failure stays per-issue (Issue #853)", () => {
  // Under-matching costs a repeated escalation; over-matching loses one. A
  // transient or issue-specific fault must keep its own escalation.
  for (
    const message of [
      "fatal: couldn't find remote ref milestone/794-prompt-terminology",
      "error: failed to push some refs (non-fast-forward)",
      "fatal: unable to access 'https://github.com/...': Could not resolve host",
      "merge conflict in worker/deno/lib/run_core.ts",
    ]
  ) {
    assertEquals(
      isRepoLevelBranchRejection(message),
      false,
      `should stay per-issue: ${message}`,
    );
  }
});

Deno.test("branch rejection - the first sighting escalates and later ones do not (Issue #853)", () => {
  resetRepoLevelRejectionsForTest();
  assertEquals(hasReportedRepoLevelRejection(REPO, BRANCH), false);

  // #834 — the first sub-issue to hit it.
  assertEquals(claimRepoLevelRejectionReport(REPO, BRANCH), true);
  // #835, #836, #838, #839, #841, #842 — the seven that followed.
  for (let i = 0; i < 6; i++) {
    assertEquals(
      claimRepoLevelRejectionReport(REPO, BRANCH),
      false,
      "only the first sighting escalates",
    );
  }
  assertEquals(hasReportedRepoLevelRejection(REPO, BRANCH), true);
});

Deno.test("branch rejection - a different branch or repo reports separately (Issue #853)", () => {
  resetRepoLevelRejectionsForTest();
  assertEquals(claimRepoLevelRejectionReport(REPO, BRANCH), true);
  assertEquals(
    claimRepoLevelRejectionReport(REPO, "milestone/843-other"),
    true,
    "a different milestone is a different fault",
  );
  assertEquals(
    claimRepoLevelRejectionReport("stSoftwareAU/GRQ", BRANCH),
    true,
    "a different repo is a different fault",
  );
});

Deno.test("branch rejection - the ruleset explanation names the cause and the remedy (Issue #853)", () => {
  const note = describeRepoLevelRejection(GH013, BRANCH);
  assert(note !== null, "a GH013 rejection must be explained");
  assert(
    note.includes("required_status_checks"),
    "must name why creation is refused",
  );
  assert(note.includes("bypass"), "must name the remedy");
  assert(note.includes(BRANCH), "must name the branch");
  assert(
    note.includes("claimable"),
    "must say the other issues are left claimable, not parked",
  );
});

Deno.test("branch rejection - an ordinary failure gets no repo-level explanation (Issue #853)", () => {
  assertEquals(
    describeRepoLevelRejection("merge conflict in a file", BRANCH),
    null,
  );
});
