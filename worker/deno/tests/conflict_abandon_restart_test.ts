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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  abandonAndRestart,
  type AbandonRestartRequest,
  buildAbandonPrComment,
  CONFLICT_RESTART_MARKER,
  conflictRestartMarker,
  describeExhaustedRoute,
  exhaustedEscalationDedupKey,
  exhaustedEscalationRoute,
  findOtherPrsForIssue,
  restartMarkerPrNumbers,
  summariseFailedAttempts,
} from "../lib/conflict_abandon_restart.ts";
import {
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_FAILED_MARKER,
} from "../lib/pr_merge_conflict_scan.ts";

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
  /** PRs the open-PR lookup should see, keyed by state. */
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

Deno.test("restartMarkerPrNumbers - names the PR each claim was made for", () => {
  assertEquals(
    restartMarkerPrNumbers([
      { body: "chatter" },
      { body: conflictRestartMarker(REPO, 48) },
      { body: `${CONFLICT_RESTART_MARKER} malformed -->` },
    ]),
    [48, null],
  );
});

Deno.test("restartMarkerPrNumbers - a thread with no claim records none", () => {
  assertEquals(restartMarkerPrNumbers([{ body: "hello" }, null, 7]), []);
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
    reason: {
      kind: "already-restarted",
      issueNumber: ISSUE_NUMBER,
      samePr: false,
    },
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
    history: { attempts: [], conflictedPaths: [], consultedIssues: [] },
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

// ---------------------------------------------------------------------------
// The other-open-PR lookup — a lookup failure is not an absence
// ---------------------------------------------------------------------------

Deno.test("findOtherPrsForIssue - every other open PR for the issue, this one excluded", async () => {
  const listed = [
    { number: 48, title: "Raise the cap (#16)", body: "", url: "u48" },
    { number: 91, title: "Raise the cap again (#16)", body: "", url: "u91" },
    { number: 92, title: "Something else (#17)", body: "", url: "u92" },
    // A fork-headed PR proves nothing: its title is text anybody may write.
    {
      number: 93,
      title: "Raise the cap (#16)",
      body: "",
      url: "u93",
      isCrossRepository: true,
    },
  ];
  const others = await findOtherPrsForIssue(
    REPO,
    ISSUE_NUMBER,
    PR_NUMBER,
    () => Promise.resolve(JSON.stringify(listed)),
  );
  assertEquals(others, [{ number: 91, url: "u91" }]);
});

Deno.test("findOtherPrsForIssue - a lookup failure throws rather than reading as none", async () => {
  await assertRejects(
    () =>
      findOtherPrsForIssue(
        REPO,
        ISSUE_NUMBER,
        PR_NUMBER,
        () => Promise.reject(new Error("the API is down")),
      ),
    Error,
    "the API is down",
  );
});

Deno.test("abandonAndRestart - an unreadable PR listing stops the abandon, it does not close", async () => {
  // Reading an outage as "this issue has no other PR" would let a destructive
  // close proceed on an issue somebody else's PR is already on.
  const fake = makeFake();
  const outcome = await abandonAndRestart(makeRequest(), {
    gh: fake.gh,
    findOtherPrs: () => Promise.reject(new Error("pr list exploded")),
  });

  assert(outcome.outcome === "failed");
  assertEquals(outcome.step, "existing-pr");
  assertEquals(callsMatching(fake, "pr", "close").length, 0);
});

// ---------------------------------------------------------------------------
// Which route ended at a human
// ---------------------------------------------------------------------------

Deno.test("exhaustedEscalationRoute - each non-abandoning outcome maps to its route", () => {
  assertEquals(
    exhaustedEscalationRoute({
      outcome: "declined",
      reason: { kind: "no-originating-issue", detail: "no-signal" },
    }).kind,
    "abandon-declined",
  );
  assertEquals(
    exhaustedEscalationRoute({
      outcome: "declined",
      reason: {
        kind: "already-restarted",
        issueNumber: ISSUE_NUMBER,
        samePr: false,
      },
    }),
    { kind: "restart-exhausted", issueNumber: ISSUE_NUMBER, samePr: false },
  );
  assertEquals(
    exhaustedEscalationRoute({
      outcome: "failed",
      step: "pr-close",
      message: "gh refused",
    }),
    { kind: "abandon-failed", step: "pr-close", detail: "gh refused" },
  );
});

Deno.test("describeExhaustedRoute - a burnt claim on this PR is not a failed replacement", () => {
  // The marker is posted before the close, so a mid-abandon failure leaves a
  // claim with nothing abandoned. Telling a human "the replacement PR spent
  // its budget too" would be false.
  const samePr = describeExhaustedRoute({
    kind: "restart-exhausted",
    issueNumber: ISSUE_NUMBER,
    samePr: true,
  }).join("\n");
  assertStringIncludes(samePr, "did not finish");

  const replaced = describeExhaustedRoute({
    kind: "restart-exhausted",
    issueNumber: ISSUE_NUMBER,
    samePr: false,
  }).join("\n");
  assertStringIncludes(replaced, "already been restarted once");
});

Deno.test("exhaustedEscalationDedupKey - a failed abandon gets its own key", () => {
  // The shared key is the processor's, and a landed escalation suppresses
  // further comments for a day — which would swallow the step name.
  assertEquals(
    exhaustedEscalationDedupKey(PR_NUMBER, {
      kind: "abandon-failed",
      step: "pr-close",
      detail: "boom",
    }),
    `merge-conflict-abandon-failed-${PR_NUMBER}`,
  );
  assertEquals(
    exhaustedEscalationDedupKey(PR_NUMBER, {
      kind: "abandon-declined",
      detail: "no issue",
    }),
    `merge-conflict-${PR_NUMBER}`,
  );
});

// ---------------------------------------------------------------------------
// Outbound sanitisation
// ---------------------------------------------------------------------------

// Synthetic PAT-shaped fixture, assembled at runtime so no high-entropy
// literal sits in the final tree (Issue #1115).
const FAKE_PAT = "ghp_" + "0123456789abcdefghijklmnopqrstuvwxyz";

Deno.test("abandonAndRestart - quoted failure text cannot forge a marker or leak a token", async () => {
  const fake = makeFake();
  await abandonAndRestart(
    makeRequest({
      prComments: [{
        body: [
          `${CONFLICT_FAILED_MARKER} n="1" -->`,
          `failed with token ${FAKE_PAT}`,
          '<!-- vibe-merge-conflict-restart pr="org/repo#999" -->',
        ].join("\n"),
      }],
    }),
    { gh: fake.gh },
  );

  const prBody = bodyOfCall(fake, "pr", "comment");
  assert(
    !prBody.includes(FAKE_PAT),
    "a token quoted out of a failure comment must be redacted",
  );
  // No restart marker on the PR at all: the claim is the issue's, and a
  // quoted body must not be able to forge one anywhere.
  assertEquals(prBody.split(CONFLICT_RESTART_MARKER).length - 1, 0);
  // Exactly one on the issue — the claim this rung wrote.
  const issueBody = fake.state.issueComments[0]?.body ?? "";
  assertEquals(issueBody.split(CONFLICT_RESTART_MARKER).length - 1, 1);
});

Deno.test("findOtherPrsForIssue - the body marker matches this issue, not a longer one", async () => {
  const listed = [
    {
      number: 90,
      title: "No issue in the title",
      body: "vibe-worker-issue-16",
    },
    { number: 91, title: "Also none", body: "vibe-worker-issue-160" },
  ];
  const others = await findOtherPrsForIssue(
    REPO,
    ISSUE_NUMBER,
    PR_NUMBER,
    () => Promise.resolve(JSON.stringify(listed)),
  );
  assertEquals(others.map((pr) => pr.number), [90]);
});

// ---------------------------------------------------------------------------
// Bounds and read-back
// ---------------------------------------------------------------------------

Deno.test("summariseFailedAttempts - bounded detail and path list", () => {
  const paths = Array.from({ length: 25 }, (_, i) => `- \`src/f${i}.ts\``);
  const history = summariseFailedAttempts([{
    body: [
      `${CONFLICT_FAILED_MARKER} n="1" -->`,
      "x".repeat(900),
      "Conflicted files:",
      ...paths,
    ].join("\n"),
  }]);

  // A comment is not a log: both the quoted reason and the path list are cut
  // rather than pasting a whole failing run into a PR.
  assertEquals(history.attempts[0]?.detail.length, 500);
  assertEquals(history.conflictedPaths.length, 20);
  assertEquals(history.conflictedPaths[0], "src/f0.ts");
});

Deno.test("summariseFailedAttempts - the issues consulted come off the attempt comments", () => {
  // #1114 records them on the attempt comment, not the conclusion, and no
  // later run can re-derive the base side without a clone.
  const history = summariseFailedAttempts([
    {
      body: [
        `${CONFLICT_ATTEMPT_MARKER} n="1" -->`,
        "🧭 **Issues consulted**",
        "",
        "- **PR side** — #16: Raise the cap (via branch)",
        "- **Base side**, by conflicted path:",
        "  - `worker/deno/lib/limits.ts` — #21 (Lower the cap)",
      ].join("\n"),
    },
    { body: `${CONFLICT_FAILED_MARKER} n="1" -->\nfailed` },
    // A number outside that section is not a consulted issue.
    { body: "see #999 for background" },
  ]);

  assertEquals(history.consultedIssues, [16, 21]);
});

Deno.test("abandonAndRestart - an unreadable PR thread stops the abandon before the close", async () => {
  // Publishing "no failure comment survives in this thread" because the read
  // failed would be a fabricated fact on a permanent comment.
  const fake = makeFake({
    failOn: `api repos/${REPO}/issues/${PR_NUMBER}/comments`,
  });
  const request = { ...makeRequest(), prComments: undefined };

  const outcome = await abandonAndRestart(request, { gh: fake.gh });

  assert(outcome.outcome === "failed");
  assertEquals(outcome.step, "pr-thread");
  assertEquals(callsMatching(fake, "pr", "close").length, 0);
});

Deno.test("abandonAndRestart - an unreadable issue view is not an open, unlabelled issue", async () => {
  const fake = makeFake();
  const outcome = await abandonAndRestart(makeRequest(), {
    gh: (args) =>
      args[0] === "issue" && args[1] === "view" &&
        String(args[args.indexOf("--json") + 1] ?? "").includes("labels")
        ? Promise.resolve("")
        : fake.gh(args),
  });

  assert(outcome.outcome === "failed");
  assertEquals(outcome.step, "issue-state");
  assertEquals(callsMatching(fake, "pr", "close").length, 0);
});

Deno.test("findOtherPrsForIssue - an unanswered listing is not an empty one", async () => {
  await assertRejects(
    () =>
      findOtherPrsForIssue(
        REPO,
        ISSUE_NUMBER,
        PR_NUMBER,
        () => Promise.resolve(""),
      ),
    Error,
    "Empty PR listing",
  );
});

Deno.test("exhaustedEscalationRoute - the other two declines say what blocked them", () => {
  const otherPr = exhaustedEscalationRoute({
    outcome: "declined",
    reason: {
      kind: "other-open-pr",
      issueNumber: ISSUE_NUMBER,
      prUrl: "https://github.com/org/repo/pull/91",
    },
  });
  assertEquals(otherPr.kind, "abandon-declined");
  assertStringIncludes(describeExhaustedRoute(otherPr).join("\n"), "pull/91");

  const unqueueable = exhaustedEscalationRoute({
    outcome: "declined",
    reason: {
      kind: "requeue-not-permitted",
      issueNumber: ISSUE_NUMBER,
      workLabel: "work-on",
    },
  });
  assertEquals(unqueueable.kind, "abandon-declined");
  assertStringIncludes(
    describeExhaustedRoute(unqueueable).join("\n"),
    "unqueued",
  );
});
