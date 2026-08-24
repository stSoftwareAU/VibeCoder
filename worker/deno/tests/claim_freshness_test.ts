/**
 * Claim-freshness re-check (Issue #344).
 *
 * A claim that was legitimate when it was taken can be worthless by the time
 * the PR goes up. On VibeCoder#333 it was: the issue closed at 07:57:54Z when
 * PR #339 merged, and the worker opened PR #341 against it at 08:15:06Z —
 * seventeen minutes later, a `CONFLICTING`/`DIRTY` duplicate of work already
 * on `main` that a human had to salvage by hand.
 *
 * These tests pin the decision rules, the fail-safe behaviour of the lookups,
 * and the fact that a stale claim is a *clean* outcome — not a failure.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkClaimFreshness,
  decideClaimFreshness,
  formatStaleClaimComment,
  formatStaleClaimReason,
  type StaleClaim,
} from "../lib/claim_freshness.ts";
import {
  claimStaleOutcome,
  describeRunOutcome,
  type RunOutcome,
} from "../lib/run_outcome.ts";
import {
  describeAttemptOutcome,
  renderRunOutcomeClause,
} from "../lib/heartbeat_storage.ts";
import type { Result } from "../types.ts";

const REPO = "stSoftwareAU/VibeCoder";
const BRANCH = "issue-333-parse-the-weekly-usage-limit-reset";
const OTHER_BRANCH = "issue-333-human-side-fix";
const PR_URL = "https://github.com/stSoftwareAU/VibeCoder/pull/339";

// ---------------------------------------------------------------------------
// decideClaimFreshness — the pure rules
// ---------------------------------------------------------------------------

Deno.test("claim freshness #344 - an issue closed mid-cycle makes the claim stale", () => {
  const verdict = decideClaimFreshness({
    issueState: "CLOSED",
    existingPr: { kind: "none" },
    runBranch: BRANCH,
  });

  assertEquals(verdict.kind, "stale");
  assert(verdict.kind === "stale");
  assertEquals(verdict.reason, "issue_closed");
  assertStringIncludes(verdict.detail, "closed");
});

Deno.test("claim freshness #344 - a closed issue names the PR that referenced it", () => {
  const verdict = decideClaimFreshness({
    issueState: "CLOSED",
    existingPr: {
      kind: "superseded",
      prState: "MERGED",
      prUrl: PR_URL,
      prNumber: 339,
      headRefName: OTHER_BRANCH,
    },
    runBranch: BRANCH,
  });

  assert(verdict.kind === "stale");
  assertEquals(verdict.reason, "issue_closed");
  assertEquals(verdict.prNumber, 339);
  assertEquals(verdict.prUrl, PR_URL);
});

Deno.test("claim freshness #344 - an open issue with no PR is fresh", () => {
  const verdict = decideClaimFreshness({
    issueState: "OPEN",
    existingPr: { kind: "none" },
    runBranch: BRANCH,
  });

  assertEquals(verdict.kind, "fresh");
});

Deno.test("claim freshness #344 - a merged PR carrying this run's branch is stale", () => {
  const verdict = decideClaimFreshness({
    issueState: "OPEN",
    existingPr: {
      kind: "superseded",
      prState: "MERGED",
      prUrl: PR_URL,
      prNumber: 339,
      headRefName: BRANCH,
    },
    runBranch: BRANCH,
  });

  assert(verdict.kind === "stale");
  assertEquals(verdict.reason, "work_already_merged");
  assertEquals(verdict.prNumber, 339);
});

Deno.test("claim freshness #344 - someone else's merged PR does NOT discard this run's commits (#174)", () => {
  const verdict = decideClaimFreshness({
    issueState: "OPEN",
    existingPr: {
      kind: "superseded",
      prState: "MERGED",
      prUrl: PR_URL,
      prNumber: 339,
      headRefName: OTHER_BRANCH,
    },
    runBranch: BRANCH,
  });

  // #174's rule: a merged PR on a different branch does not complete this
  // run, and the unpublished commits on this branch still want their PR.
  assertEquals(verdict.kind, "fresh");
});

Deno.test("claim freshness #344 - a merged PR with an unknown head is not treated as ours", () => {
  const verdict = decideClaimFreshness({
    issueState: "OPEN",
    existingPr: {
      kind: "superseded",
      prState: "MERGED",
      prUrl: PR_URL,
      prNumber: 339,
    },
    runBranch: BRANCH,
  });

  assertEquals(verdict.kind, "fresh");
});

Deno.test("claim freshness #344 - an open PR from another branch stops a competing PR", () => {
  const verdict = decideClaimFreshness({
    issueState: "OPEN",
    existingPr: {
      kind: "open",
      prUrl: PR_URL,
      prNumber: 341,
      headRefName: OTHER_BRANCH,
    },
    runBranch: BRANCH,
  });

  assert(verdict.kind === "stale");
  assertEquals(verdict.reason, "competing_open_pr");
  assertEquals(verdict.prNumber, 341);
});

Deno.test("claim freshness #344 - an open PR on our OWN branch is not a competitor", () => {
  const verdict = decideClaimFreshness({
    issueState: "OPEN",
    existingPr: {
      kind: "open",
      prUrl: PR_URL,
      prNumber: 341,
      headRefName: BRANCH,
    },
    runBranch: BRANCH,
  });

  assertEquals(verdict.kind, "fresh");
});

Deno.test("claim freshness #344 - an unreadable issue state fails safe to fresh", () => {
  const verdict = decideClaimFreshness({
    issueState: null,
    existingPr: { kind: "none" },
    runBranch: BRANCH,
  });

  // Withholding a finished, pushed, quality-gated PR because `gh` hiccupped
  // is the worse error of the two.
  assertEquals(verdict.kind, "fresh");
});

Deno.test("claim freshness #344 - a closed state is recognised whatever its case", () => {
  for (const state of ["CLOSED", "closed", " Closed "]) {
    const verdict = decideClaimFreshness({
      // checkClaimFreshness normalises; the rule itself sees the normalised
      // value, so assert on what normalisation produces.
      issueState: state.trim().toUpperCase(),
      existingPr: { kind: "none" },
      runBranch: BRANCH,
    });
    assertEquals(verdict.kind, "stale", `state '${state}' should be stale`);
  }
});

// ---------------------------------------------------------------------------
// checkClaimFreshness — the lookups
// ---------------------------------------------------------------------------

interface GhCall {
  args: string[];
}

function ghStub(
  handlers: {
    issueState?: string | (() => never);
    prState?: string;
    prHead?: string;
  },
  calls: GhCall[],
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    calls.push({ args });
    if (args[0] === "issue" && args[1] === "view") {
      if (typeof handlers.issueState === "function") handlers.issueState();
      return Promise.resolve(
        JSON.stringify({ state: handlers.issueState ?? "OPEN" }),
      );
    }
    if (args[0] === "pr" && args[1] === "view") {
      return Promise.resolve(
        JSON.stringify({
          state: handlers.prState ?? "OPEN",
          headRefName: handlers.prHead ?? BRANCH,
        }),
      );
    }
    return Promise.resolve("");
  };
}

function prLookup(url: string | null): () => Promise<Result<string, Error>> {
  return () =>
    Promise.resolve(
      url === null
        ? { ok: false, error: new Error("No PR found") }
        : { ok: true, value: url },
    );
}

Deno.test("claim freshness #344 - pre-write mode reads only the issue state", async () => {
  const calls: GhCall[] = [];
  const verdict = await checkClaimFreshness({
    repo: REPO,
    issueNumber: 333,
    runBranch: BRANCH,
    mode: "pre-write",
    deps: {
      findExistingPrForIssue: prLookup(PR_URL),
      runGhCommand: ghStub({ issueState: "CLOSED" }, calls),
    },
  });

  assert(verdict.kind === "stale");
  assertEquals(verdict.reason, "issue_closed");
  // One `gh` call — the cheap half of the guard, before an agent run is spent.
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.args.slice(0, 2), ["issue", "view"]);
});

Deno.test("claim freshness #344 - pre-write mode does not stop a run for an in-flight PR", async () => {
  const calls: GhCall[] = [];
  const verdict = await checkClaimFreshness({
    repo: REPO,
    issueNumber: 333,
    runBranch: BRANCH,
    mode: "pre-write",
    deps: {
      findExistingPrForIssue: prLookup(PR_URL),
      runGhCommand: ghStub({ issueState: "OPEN", prState: "MERGED" }, calls),
    },
  });

  // Only the decisive signal is consulted before the agent runs, so the
  // #174/#218 paths still get to make their own call later.
  assertEquals(verdict.kind, "fresh");
  assertEquals(calls.length, 1);
});

Deno.test("claim freshness #344 - pre-pr mode reproduces the VibeCoder#333 abort", async () => {
  const calls: GhCall[] = [];
  const verdict = await checkClaimFreshness({
    repo: REPO,
    issueNumber: 333,
    runBranch: BRANCH,
    mode: "pre-pr",
    deps: {
      findExistingPrForIssue: prLookup(PR_URL),
      runGhCommand: ghStub(
        { issueState: "CLOSED", prState: "MERGED", prHead: OTHER_BRANCH },
        calls,
      ),
    },
  });

  assert(verdict.kind === "stale");
  assertEquals(verdict.reason, "issue_closed");
  assertEquals(verdict.prNumber, 339);
  assert(
    calls.some((c) => c.args.slice(0, 2).join(" ") === "pr view"),
    "pre-pr mode also classifies the existing PR",
  );
});

Deno.test("claim freshness #344 - a `gh issue view` failure fails safe to fresh and is warned about", async () => {
  const warnings: string[] = [];
  const verdict = await checkClaimFreshness({
    repo: REPO,
    issueNumber: 333,
    runBranch: BRANCH,
    mode: "pre-pr",
    deps: {
      findExistingPrForIssue: prLookup(null),
      runGhCommand: (args: string[]) => {
        if (args[0] === "issue") {
          return Promise.reject(new Error("gh: API rate limit exceeded"));
        }
        return Promise.resolve("");
      },
      warn: (m) => warnings.push(m),
    },
  });

  assertEquals(verdict.kind, "fresh");
  // Never swallowed: the reason is on the record even though the guard
  // deliberately let the run continue.
  assert(
    warnings.some((w) => w.includes("rate limit")),
    `expected the failure to be logged, got ${JSON.stringify(warnings)}`,
  );
});

Deno.test("claim freshness #344 - an unparseable issue payload fails safe to fresh and is warned about", async () => {
  const warnings: string[] = [];
  const verdict = await checkClaimFreshness({
    repo: REPO,
    issueNumber: 333,
    runBranch: BRANCH,
    mode: "pre-write",
    deps: {
      findExistingPrForIssue: prLookup(null),
      runGhCommand: () => Promise.resolve("not json at all"),
      warn: (m) => warnings.push(m),
    },
  });

  assertEquals(verdict.kind, "fresh");
  assert(
    warnings.some((w) => w.includes("Unreadable")),
    `expected an unreadable-payload warning, got ${JSON.stringify(warnings)}`,
  );
});

Deno.test("claim freshness #344 - a lower-case gh state is still recognised as closed", async () => {
  const verdict = await checkClaimFreshness({
    repo: REPO,
    issueNumber: 333,
    runBranch: BRANCH,
    mode: "pre-write",
    deps: {
      findExistingPrForIssue: prLookup(null),
      runGhCommand: () => Promise.resolve(JSON.stringify({ state: "closed" })),
    },
  });

  assert(verdict.kind === "stale");
  assertEquals(verdict.reason, "issue_closed");
});

// ---------------------------------------------------------------------------
// The hand-off text and the outcome
// ---------------------------------------------------------------------------

const STALE: StaleClaim = {
  reason: "issue_closed",
  detail: "the issue closed while this run was working",
  prUrl: PR_URL,
  prNumber: 339,
};

Deno.test("claim freshness #344 - the reason starts with a greppable claim_stale token", () => {
  const reason = formatStaleClaimReason(STALE);
  assert(
    reason.startsWith("claim_stale:issue_closed"),
    `unexpected reason: ${reason}`,
  );
  assertStringIncludes(reason, STALE.detail);
});

Deno.test("claim freshness #344 - the hand-off comment links the branch so the work is not lost", () => {
  const body = formatStaleClaimComment({
    repo: REPO,
    branch: BRANCH,
    stale: STALE,
  });

  assertStringIncludes(body, BRANCH);
  assertStringIncludes(body, `https://github.com/${REPO}/tree/`);
  assertStringIncludes(body, PR_URL);
  assertStringIncludes(body, "did **not** open a PR");
});

Deno.test("claim freshness #344 - the hand-off comment still works when no PR overtook the run", () => {
  const body = formatStaleClaimComment({
    repo: REPO,
    branch: BRANCH,
    stale: { reason: "issue_closed", detail: "the issue closed" },
  });

  assertStringIncludes(body, BRANCH);
  assert(!body.includes("undefined"), `unexpected placeholder: ${body}`);
});

Deno.test("claim freshness #344 - the outcome is a distinct kind, never a failure", () => {
  const outcome: RunOutcome = claimStaleOutcome({
    phase: "completion",
    stale: STALE,
    branch: BRANCH,
  });

  assertEquals(outcome.kind, "claim_stale");
  assertEquals(describeRunOutcome(outcome), "claim_stale:issue_closed");
  // Not `no_pr`: `no_pr` is the kind that carries a failure category, files a
  // run-failure issue and labels the issue failed (Issue #342's lesson).
  assert(outcome.kind !== "no_pr");
});

Deno.test("claim freshness #344 - the release comment names the branch the work is on", () => {
  const clause = renderRunOutcomeClause(
    claimStaleOutcome({ phase: "completion", stale: STALE, branch: BRANCH }),
  );

  assertStringIncludes(clause, "claim went stale");
  assertStringIncludes(clause, BRANCH);
  assertStringIncludes(clause, PR_URL);
});

Deno.test("claim freshness #344 - the attempt tally reads as a stale claim, not a crash", () => {
  const text = describeAttemptOutcome(
    claimStaleOutcome({ phase: "execute", stale: STALE }),
  );

  assertStringIncludes(text, "claim went stale");
  assertStringIncludes(text, "issue_closed");
});
