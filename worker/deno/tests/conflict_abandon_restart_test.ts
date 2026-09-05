/**
 * Tests for abandon-and-restart (Issue #1115, parent #1076).
 *
 * The rung is destructive — it closes a PR — so the tests are ordered by what
 * that destruction can cost:
 *
 * 1. **No originating issue.** Closing a PR the fleet cannot re-raise loses
 *    the work permanently, with no undo and no human in the loop. The
 *    precondition is asserted as an *ordering* property, not just an outcome:
 *    no `pr close` may be issued at all.
 * 2. **One restart per issue.** Without the bound this closes a PR, raises
 *    another, closes that one, forever. The marker lives on the **issue**
 *    because the PR identity changes each time round — a PR-keyed marker
 *    passes a single-cycle test and loops in production.
 * 3. **Partial abandon.** Every step is failed in turn and the resting state
 *    must name the step that stopped it. "PR closed, issue not re-queued" is
 *    the state this exists to keep out of production.
 * 4. **Cross-host dedupe.** Two hosts abandoning the same PR would close it
 *    twice and re-queue twice.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  abandonAndRestart,
  type AbandonRestartRequest,
  buildAbandonPrComment,
  CONFLICT_RESTART_MARKER,
  conflictRestartMarker,
  hasConflictRestartMarker,
  prNumberFromUrl,
  summariseFailedAttempts,
} from "../lib/conflict_abandon_restart.ts";
import { CONFLICT_FAILED_MARKER } from "../lib/pr_merge_conflict_scan.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = "org/repo";
const PR_NUMBER = 48;
const ISSUE_NUMBER = 16;

/** Two concluded failures, exactly as the processor writes them. */
function failedComments(): Array<{ body: string; created_at: string }> {
  return [1, 2].map((n) => ({
    body: [
      `${CONFLICT_FAILED_MARKER} n="${n}" -->`,
      `❌ **Merge-conflict resolution — attempt ${n} of 2 failed**`,
      "",
      "Merging `main` in did not produce a mergeable branch: the same " +
      `constant is set to two different values (attempt ${n}).`,
      "",
      "Conflicted files:",
      "- `worker/deno/lib/limits.ts`",
      "",
      "The branch was left exactly as its author pushed it.",
    ].join("\n"),
    created_at: `2026-08-19T1${n}:00:00Z`,
  }));
}

function makeRequest(
  overrides: Partial<AbandonRestartRequest> = {},
): AbandonRestartRequest {
  return {
    repo: REPO,
    prNumber: PR_NUMBER,
    branchName: `issue-${ISSUE_NUMBER}-limits`,
    baseBranch: "main",
    prComments: failedComments(),
    ...overrides,
  };
}

interface FakeState {
  /** Issue state as `gh issue view --json state,labels` reports it. */
  issueState: string;
  issueLabels: string[];
  /** Comments already on the originating issue. */
  issueComments: Array<{ body: string }>;
  /** PRs `findExistingPrForIssue` should see, keyed by state. */
  prsByState: Record<string, Array<{ number: number; title: string }>>;
  /** Issue numbers `gh issue view --json number,title,state,body` knows. */
  issues: Record<number, { title: string; state: string; body: string }>;
  /** Args prefix (joined with a space) whose call must throw. */
  failOn?: string;
}

interface FakeGh {
  gh: (args: string[]) => Promise<string>;
  calls: string[][];
  state: FakeState;
}

function makeFake(overrides: Partial<FakeState> = {}): FakeGh {
  const state: FakeState = {
    issueState: "OPEN",
    issueLabels: ["work-on"],
    issueComments: [],
    prsByState: {
      open: [{ number: PR_NUMBER, title: `Fix the limits (#${ISSUE_NUMBER})` }],
      merged: [],
      closed: [],
    },
    issues: {
      [ISSUE_NUMBER]: {
        title: "Raise the per-path commit cap",
        state: "OPEN",
        body: "The cap is too low.",
      },
    },
    ...overrides,
  };
  const calls: string[][] = [];

  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    if (state.failOn && joined.startsWith(state.failOn)) {
      return Promise.reject(new Error(`gh refused: ${state.failOn}`));
    }

    // Issue comment pages.
    if (args[0] === "api" && String(args[1]).includes("/comments")) {
      const page = /[?&]page=(\d+)/.exec(String(args[1]))?.[1] ?? "1";
      return Promise.resolve(
        page === "1" ? JSON.stringify(state.issueComments) : "[]",
      );
    }

    // Label add (REST primary of `addLabelToIssue`).
    if (args[0] === "api" && args.includes("POST")) return Promise.resolve("");

    if (args[0] === "issue" && args[1] === "view") {
      const number = Number(args[2]);
      const fields = String(args[args.indexOf("--json") + 1] ?? "");
      if (fields.includes("labels")) {
        return Promise.resolve(JSON.stringify({
          state: state.issueState,
          labels: state.issueLabels.map((name) => ({ name })),
        }));
      }
      const issue = state.issues[number];
      if (!issue) return Promise.reject(new Error(`no issue #${number}`));
      return Promise.resolve(JSON.stringify({ number, ...issue }));
    }

    if (args[0] === "pr" && args[1] === "list") {
      const prState = String(args[args.indexOf("--state") + 1] ?? "open");
      const prs = (state.prsByState[prState] ?? []).map((pr) => ({
        ...pr,
        url: `https://github.com/${REPO}/pull/${pr.number}`,
        body: "",
      }));
      return Promise.resolve(JSON.stringify(prs));
    }

    if (args[0] === "issue" && args[1] === "comment") {
      state.issueComments.push({
        body: String(args[args.indexOf("--body") + 1] ?? ""),
      });
      return Promise.resolve("");
    }

    if (args[0] === "issue" && args[1] === "reopen") {
      state.issueState = "OPEN";
      return Promise.resolve("");
    }

    return Promise.resolve("");
  };

  return { gh, calls, state };
}

/** Every call matching `gh <a> <b>`, in the order they were made. */
function callsMatching(fake: FakeGh, a: string, b: string): string[][] {
  return fake.calls.filter((args) => args[0] === a && args[1] === b);
}

/** Index of the first `gh <a> <b>` call, or -1. */
function indexOfCall(fake: FakeGh, a: string, b: string): number {
  return fake.calls.findIndex((args) => args[0] === a && args[1] === b);
}

/** The `--body` of the first `gh <a> <b>` call. */
function bodyOfCall(fake: FakeGh, a: string, b: string): string {
  const call = callsMatching(fake, a, b)[0] ?? [];
  return call[call.indexOf("--body") + 1] ?? "";
}

/** Label-add calls (`addLabelToIssue`'s REST primary) against an issue. */
function labelAddCalls(fake: FakeGh, issueNumber: number): string[][] {
  return fake.calls.filter((args) =>
    args[0] === "api" && args.includes("POST") &&
    args.some((arg) => arg.includes(`/issues/${issueNumber}/labels`))
  );
}

// ---------------------------------------------------------------------------
// Reading the PR's own record
// ---------------------------------------------------------------------------

Deno.test("summariseFailedAttempts - quotes each recorded failure and its paths", () => {
  const history = summariseFailedAttempts(failedComments());

  assertEquals(history.attempts.length, 2);
  const [first, second] = history.attempts;
  assertEquals(first?.attempt, 1);
  assertEquals(second?.attempt, 2);
  assertStringIncludes(first?.detail ?? "", "two different values");
  // The marker line is machinery, not a reason — it must not be quoted back.
  assert(!(first?.detail ?? "").includes("<!--"));
  assertEquals(history.conflictedPaths, ["worker/deno/lib/limits.ts"]);
});

Deno.test("summariseFailedAttempts - a thread with no conclusions yields nothing", () => {
  const history = summariseFailedAttempts([
    { body: "just chatter" },
    { body: '<!-- vibe-coder:merge-conflict-attempt n="1" -->' },
    null,
    42,
  ]);
  assertEquals(history.attempts, []);
  assertEquals(history.conflictedPaths, []);
});

Deno.test("prNumberFromUrl - reads the PR number a GitHub URL names", () => {
  assertEquals(prNumberFromUrl("https://github.com/org/repo/pull/48"), 48);
  assertEquals(
    prNumberFromUrl("https://github.com/org/repo/pull/48/files"),
    48,
  );
  assertEquals(prNumberFromUrl("https://github.com/org/repo/issues/48"), null);
  assertEquals(prNumberFromUrl("nonsense"), null);
});

Deno.test("hasConflictRestartMarker - finds the marker whichever PR wrote it", () => {
  assertEquals(hasConflictRestartMarker([{ body: "hello" }]), false);
  assertEquals(
    hasConflictRestartMarker([{ body: conflictRestartMarker(REPO, 99) }]),
    true,
  );
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

Deno.test("abandonAndRestart - closes the PR, re-queues the issue, keeps the branch", async () => {
  const fake = makeFake();

  const outcome = await abandonAndRestart(makeRequest(), { gh: fake.gh });

  assertEquals(outcome, { outcome: "abandoned", issueNumber: ISSUE_NUMBER });

  // Closed, not merged — and the branch is neither deleted nor force-pushed.
  const closes = callsMatching(fake, "pr", "close");
  assertEquals(closes.length, 1);
  assertEquals(closes[0], ["pr", "close", String(PR_NUMBER), "--repo", REPO]);
  assert(!(closes[0] ?? []).includes("--delete-branch"));
  assertEquals(callsMatching(fake, "pr", "merge").length, 0);

  // The PR carries the explanation, and the issue carries the restart claim.
  const prBody = bodyOfCall(fake, "pr", "comment");
  assertStringIncludes(prBody, "two different values (attempt 1)");
  assertStringIncludes(prBody, "two different values (attempt 2)");
  assertStringIncludes(prBody, "worker/deno/lib/limits.ts");
  assertStringIncludes(prBody, `#${ISSUE_NUMBER} — Raise the per-path`);
  assertStringIncludes(prBody, "issue-16-limits");
  assertStringIncludes(prBody, "**closed**");

  const issueBody = fake.state.issueComments[0]?.body ?? "";
  assertStringIncludes(issueBody, CONFLICT_RESTART_MARKER);
  assertStringIncludes(issueBody, `${REPO}#${PR_NUMBER}`);
  assertStringIncludes(issueBody, "conflicts with `main`");

  // The issue already carried the human-applied work label, so it is not
  // re-applied — and it was open, so it is not reopened.
  assertEquals(callsMatching(fake, "issue", "reopen").length, 0);
  assertEquals(labelAddCalls(fake, ISSUE_NUMBER).length, 0);
});

Deno.test("abandonAndRestart - claims the restart on the issue before closing the PR", async () => {
  // The marker is the claim two hosts race for: it must exist before anything
  // is destroyed, or the loser destroys the PR twice.
  const fake = makeFake();
  await abandonAndRestart(makeRequest(), { gh: fake.gh });

  const claim = indexOfCall(fake, "issue", "comment");
  const close = indexOfCall(fake, "pr", "close");
  assert(claim >= 0 && close >= 0);
  assert(claim < close, "the issue claim must precede the close");
});

Deno.test("abandonAndRestart - reopens a closed issue and applies an appliable work label", async () => {
  const fake = makeFake({ issueState: "CLOSED", issueLabels: [] });

  const outcome = await abandonAndRestart(makeRequest(), {
    gh: fake.gh,
    // `idle-task` is the operational label the worker may self-apply.
    workLabel: "idle-task",
  });

  assertEquals(outcome, { outcome: "abandoned", issueNumber: ISSUE_NUMBER });
  assertEquals(callsMatching(fake, "issue", "reopen").length, 1);
  const labelAdds = labelAddCalls(fake, ISSUE_NUMBER);
  assertEquals(labelAdds.length, 1);
  assert((labelAdds[0] ?? []).includes("labels[]=idle-task"));
});

// ---------------------------------------------------------------------------
// Preconditions — the destructive cases, asserted before the close
// ---------------------------------------------------------------------------

Deno.test("abandonAndRestart - no originating issue: nothing is closed at all", async () => {
  // The earliest failure point. A PR whose branch, body and linkage name no
  // issue cannot be re-raised, so closing it would lose the work outright.
  const fake = makeFake();
  const outcome = await abandonAndRestart(
    makeRequest({ branchName: "hotfix/no-issue-here", prComments: [] }),
    {
      gh: fake.gh,
      resolveContext: () =>
        Promise.resolve({
          repo: REPO,
          prNumber: PR_NUMBER,
          prSide: { resolved: false, reason: "no-signal" },
          baseSide: [],
          truncation: {
            commitCapPaths: [],
            issueCapHit: false,
            textTruncatedIssues: [],
            ghCallCapHit: false,
          },
          ghCallsUsed: 0,
          warnings: [],
        }),
    },
  );

  assertEquals(outcome, {
    outcome: "declined",
    reason: { kind: "no-originating-issue", detail: "no-signal" },
  });
  // Ordering, not just outcome: the close call is never reached.
  assertEquals(callsMatching(fake, "pr", "close").length, 0);
  assertEquals(callsMatching(fake, "pr", "comment").length, 0);
  assertEquals(callsMatching(fake, "issue", "comment").length, 0);
});

Deno.test("abandonAndRestart - an issue with another open PR is left alone", async () => {
  const fake = makeFake({
    prsByState: {
      open: [{ number: 91, title: `Fix the limits (#${ISSUE_NUMBER})` }],
      merged: [],
      closed: [],
    },
  });

  const outcome = await abandonAndRestart(makeRequest(), { gh: fake.gh });

  assertEquals(outcome.outcome, "declined");
  assert(outcome.outcome === "declined");
  assertEquals(outcome.reason.kind, "other-open-pr");
  assertEquals(callsMatching(fake, "pr", "close").length, 0);
});

Deno.test("abandonAndRestart - an unqueueable issue is refused before the close", async () => {
  // `work-on` on an existing issue is refused by the worker label guard and
  // stripped by the discovery collectors, so closing here would leave the
  // issue open, unqueued and invisible — worse than the stall.
  const fake = makeFake({ issueLabels: [] });

  const outcome = await abandonAndRestart(makeRequest(), { gh: fake.gh });

  assertEquals(outcome, {
    outcome: "declined",
    reason: {
      kind: "requeue-not-permitted",
      issueNumber: ISSUE_NUMBER,
      workLabel: "work-on",
    },
  });
  assertEquals(callsMatching(fake, "pr", "close").length, 0);
});

// ---------------------------------------------------------------------------
// The bound — one restart per originating issue
// ---------------------------------------------------------------------------

Deno.test("abandonAndRestart - a restarted issue is never abandoned twice", async () => {
  // The fresh PR is a different PR, so the marker has to be keyed to the
  // issue: a PR-keyed marker would let this loop forever.
  const fake = makeFake();
  const first = await abandonAndRestart(makeRequest(), { gh: fake.gh });
  assertEquals(first.outcome, "abandoned");

  const second = await abandonAndRestart(
    makeRequest({ prNumber: 77, branchName: `issue-${ISSUE_NUMBER}-limits-2` }),
    { gh: fake.gh },
  );

  assertEquals(second, {
    outcome: "declined",
    reason: { kind: "already-restarted", issueNumber: ISSUE_NUMBER },
  });
  // One close across both rounds — the second PR is left open for a human.
  assertEquals(callsMatching(fake, "pr", "close").length, 1);
});

Deno.test("abandonAndRestart - two hosts on the same PR produce one abandon", async () => {
  // Cross-host dedupe: both hosts see the same issue thread, so the marker
  // the first one posts is what the second one reads.
  const shared = makeFake();
  const hostA = await abandonAndRestart(makeRequest(), { gh: shared.gh });
  const hostB = await abandonAndRestart(makeRequest(), { gh: shared.gh });

  assertEquals(hostA.outcome, "abandoned");
  assertEquals(hostB.outcome, "declined");
  assertEquals(callsMatching(shared, "pr", "close").length, 1);
  assertEquals(callsMatching(shared, "issue", "comment").length, 1);
});

// ---------------------------------------------------------------------------
// Partial abandon — every step failed in turn
// ---------------------------------------------------------------------------

Deno.test("abandonAndRestart - a failure at any step names that step and stops", async () => {
  const cases: Array<{ failOn: string; step: string }> = [
    { failOn: "issue comment", step: "issue-comment" },
    { failOn: "pr comment", step: "pr-comment" },
    { failOn: "pr close", step: "pr-close" },
    {
      failOn: `api repos/${REPO}/issues/${ISSUE_NUMBER}/comments`,
      step: "restart-marker",
    },
  ];

  for (const testCase of cases) {
    const fake = makeFake({ failOn: testCase.failOn });
    const outcome = await abandonAndRestart(makeRequest(), { gh: fake.gh });

    assertEquals(outcome.outcome, "failed", `${testCase.failOn} should fail`);
    assert(outcome.outcome === "failed");
    assertEquals(outcome.step, testCase.step);
    assertStringIncludes(outcome.message, "gh refused");

    // Nothing after the failing step ran.
    if (testCase.step !== "pr-close") {
      assertEquals(
        callsMatching(fake, "pr", "close").length,
        0,
        `${testCase.step} must not reach the close`,
      );
    }
  }
});

Deno.test("abandonAndRestart - a failed reopen leaves the step named, not a silent half-state", async () => {
  const fake = makeFake({
    issueState: "CLOSED",
    issueLabels: ["idle-task"],
    failOn: "issue reopen",
  });

  const outcome = await abandonAndRestart(makeRequest(), {
    gh: fake.gh,
    workLabel: "idle-task",
  });

  assert(outcome.outcome === "failed");
  assertEquals(outcome.step, "issue-reopen");
  assertEquals(outcome.issueNumber, ISSUE_NUMBER);
  // The PR is already closed by this point — which is exactly why the caller
  // must escalate naming the step rather than resting here.
  assertEquals(callsMatching(fake, "pr", "close").length, 1);
});

Deno.test("abandonAndRestart - a failed label add names the label step", async () => {
  const fake = makeFake({ issueLabels: [] });

  const outcome = await abandonAndRestart(makeRequest(), {
    gh: fake.gh,
    workLabel: "idle-task",
    addLabel: () =>
      Promise.resolve({ ok: false, error: new Error("labels are down") }),
  });

  assert(outcome.outcome === "failed");
  assertEquals(outcome.step, "issue-label");
  assertStringIncludes(outcome.message, "labels are down");
});

// ---------------------------------------------------------------------------
// The comment body
// ---------------------------------------------------------------------------

Deno.test("buildAbandonPrComment - states the absence when nothing was recorded", () => {
  const body = buildAbandonPrComment({
    request: makeRequest({ prComments: [] }),
    history: { attempts: [], conflictedPaths: [] },
    context: {
      repo: REPO,
      prNumber: PR_NUMBER,
      prSide: { resolved: false, reason: "no-signal" },
      baseSide: [],
      truncation: {
        commitCapPaths: [],
        issueCapHit: false,
        textTruncatedIssues: [],
        ghCallCapHit: false,
      },
      ghCallsUsed: 0,
      warnings: [],
    },
    issueNumber: ISSUE_NUMBER,
    workLabel: "work-on",
  });

  assertStringIncludes(body, "no failure comment survives");
  assertStringIncludes(body, "no conflicted path was recorded");
  assertStringIncludes(body, "not** deleted");
});
