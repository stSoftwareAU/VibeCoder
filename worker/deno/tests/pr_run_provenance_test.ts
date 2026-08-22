/**
 * Tests for run-provenance in PR linking (Issue #174).
 *
 * The failure these encode, from `worker-20260820-231159.log`: the worker
 * pushed three commits to
 * `issue-42-primary-graphql-quota-exhaustion-is-swallowed-by-t`, completion
 * matched PR #173 — a human's partial PR on
 * `issue-42-relabel-reopens-merged-pr-gate`, merged mid-run — logged
 * `IDEMPOTENT: PR already exists`, closed #42 and released `pr:#173`. No PR
 * was raised for the worker's branch.
 *
 * Both PRs had an `issue-42-*` head and the same author, so the tests below
 * use those real branch names: any rule that keys on the branch *shape*
 * rather than the exact name passes the wrong way here.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  decideCompletionPr,
  foreignMergedPrComment,
  mergedPrCompletesThisRun,
} from "../lib/pr_run_provenance.ts";

/** The worker's branch on VibeCoder#42. */
const OURS = "issue-42-primary-graphql-quota-exhaustion-is-swallowed-by-t";
/** The human's branch, PR #173 — same `issue-42-*` shape, different work. */
const THEIRS = "issue-42-relabel-reopens-merged-pr-gate";

const PR_173 = {
  url: "https://github.com/o/r/pull/173",
  state: "MERGED" as const,
};

// ===========================================================================
// decideCompletionPr
// ===========================================================================

Deno.test("decideCompletionPr #174 - a merged sibling PR does not stop us raising ours", () => {
  // The exact #42 situation: three commits pushed, #173 merged mid-run.
  const d = decideCompletionPr({
    openPrForBranch: null,
    branchCommitsAhead: 3,
    prForIssue: PR_173,
  });
  assertEquals(d.kind, "create");
  assertStringIncludes(d.why, "3 commit(s) ahead");
  assertStringIncludes(d.why, "not the PR for this branch");
});

Deno.test("decideCompletionPr #174 - a closed sibling PR does not stop us either", () => {
  const d = decideCompletionPr({
    openPrForBranch: null,
    branchCommitsAhead: 1,
    prForIssue: { url: "https://github.com/o/r/pull/9", state: "CLOSED" },
  });
  assertEquals(d.kind, "create");
});

Deno.test("decideCompletionPr - an open PR on our exact branch is recovered", () => {
  const d = decideCompletionPr({
    openPrForBranch: "https://github.com/o/r/pull/176",
    branchCommitsAhead: 3,
    prForIssue: PR_173,
  });
  assertEquals(d.kind, "recover");
  if (d.kind !== "recover") return;
  assertEquals(d.prUrl, "https://github.com/o/r/pull/176");
});

Deno.test("decideCompletionPr - an open PR for the issue is still recovered (pre-#174 behaviour)", () => {
  const d = decideCompletionPr({
    openPrForBranch: null,
    branchCommitsAhead: 2,
    prForIssue: { url: "https://github.com/o/r/pull/50", state: "OPEN" },
  });
  assertEquals(d.kind, "recover");
});

Deno.test("decideCompletionPr - a level branch with a merged PR still recovers (Issue #1559 stays fixed)", () => {
  // Nothing to raise, so the merged PR genuinely does represent the work.
  // Over-correcting here would reintroduce the #1557 re-pickup loop.
  const d = decideCompletionPr({
    openPrForBranch: null,
    branchCommitsAhead: 0,
    prForIssue: PR_173,
  });
  assertEquals(d.kind, "recover");
  if (d.kind !== "recover") return;
  assertStringIncludes(d.why, "level with base");
});

Deno.test("decideCompletionPr - an unknown commit count does not force creation", () => {
  // Deliberate: without the count we do not know work exists, and the close
  // is guarded separately by provenance.
  const d = decideCompletionPr({
    openPrForBranch: null,
    branchCommitsAhead: null,
    prForIssue: PR_173,
  });
  assertEquals(d.kind, "recover");
  if (d.kind !== "recover") return;
  assertStringIncludes(d.why, "could not be taken");
});

Deno.test("decideCompletionPr - nothing found means create", () => {
  const d = decideCompletionPr({
    openPrForBranch: null,
    branchCommitsAhead: 0,
    prForIssue: null,
  });
  assertEquals(d.kind, "create");
});

// ===========================================================================
// mergedPrCompletesThisRun
// ===========================================================================

Deno.test("mergedPrCompletesThisRun #174 - the human's PR on the same issue is NOT ours", () => {
  assert(!mergedPrCompletesThisRun(THEIRS, OURS));
});

Deno.test("mergedPrCompletesThisRun - our own branch is ours", () => {
  assert(mergedPrCompletesThisRun(OURS, OURS));
});

Deno.test("mergedPrCompletesThisRun - the branch shape alone proves nothing", () => {
  // Both of these are `issue-42-*`; only one is the run's branch. A prefix
  // rule would accept both and reintroduce the bug.
  assert(!mergedPrCompletesThisRun("issue-42-something-else", OURS));
  assert(!mergedPrCompletesThisRun("issue-42", OURS));
});

Deno.test("mergedPrCompletesThisRun - an unknown head never authorises a close", () => {
  assert(!mergedPrCompletesThisRun(null, OURS));
  assert(!mergedPrCompletesThisRun(undefined, OURS));
  assert(!mergedPrCompletesThisRun("", OURS));
});

Deno.test("mergedPrCompletesThisRun - an unknown run branch never authorises a close", () => {
  assert(!mergedPrCompletesThisRun(OURS, ""));
  assert(!mergedPrCompletesThisRun(OURS, null));
});

Deno.test("mergedPrCompletesThisRun - surrounding whitespace is not a difference", () => {
  assert(mergedPrCompletesThisRun(` ${OURS} `, OURS));
});

Deno.test("mergedPrCompletesThisRun - comparison is case-sensitive, as git refs are", () => {
  assert(!mergedPrCompletesThisRun(OURS.toUpperCase(), OURS));
});

// ===========================================================================
// The comment left behind
// ===========================================================================

Deno.test("foreignMergedPrComment - names the PR, the branch, and whose call it is", () => {
  const body = foreignMergedPrComment(173, OURS);
  assertStringIncludes(body, "#173");
  assertStringIncludes(body, OURS);
  assertStringIncludes(body, "your call");
  // The branch is the thing a human needs to find the work.
  assert(
    body.split(OURS).length - 1 >= 2,
    "the branch is named more than once",
  );
});
