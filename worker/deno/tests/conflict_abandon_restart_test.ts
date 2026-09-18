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
  buildNoIssueAbandonPrComment,
  buildRestartIssueComment,
  CONFLICT_RESTART_MARKER,
  conflictRestartMarker,
  describeConcludedAttempts,
  describeExhaustedRoute,
  exhaustedEscalationDedupKey,
  exhaustedEscalationRoute,
  findOtherPrsForIssue,
  MAX_RESTARTS_PER_ISSUE,
  mergeFallbackRunsFromHistory,
  planRequeueLabel,
  requeueLabelName,
  restartMarkerPrNumbers,
  summariseFailedAttempts,
} from "../lib/conflict_abandon_restart.ts";
import type { ConflictIssueContext } from "../lib/conflict_issue_context.ts";
import type {
  MergeFallbackFiling,
  MergeFallbackOutcome,
} from "../lib/merge_fallback_issue.ts";
import { formatStageTimings } from "../lib/conflict_stage_timer.ts";
import type { Result } from "../types.ts";
import {
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_FAILED_MARKER,
  DEFAULT_MAX_CONFLICT_ATTEMPTS,
} from "../lib/pr_merge_conflict_scan.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = "org/repo";
const PR_NUMBER = 48;
const ISSUE_NUMBER = 16;

/** The fleet login every fixture comment is written by (Issue #1247). */
const FLEET = "vibe-bot";
/** The resolved fleet identity the rung attributes markers against. */
const FLEET_AUTHORS = [FLEET];
/** An account with no fleet privileges at all — the attacker. */
const OUTSIDER = "drive-by";

/** One comment as the REST API renders it: body plus its author. */
function comment(
  body: string,
  login: string = FLEET,
  createdAt = "2026-08-19T10:00:00Z",
): { body: string; created_at: string; user: { login: string } } {
  return { body, created_at: createdAt, user: { login } };
}

/** Two concluded failures, exactly as the processor writes them. */
function failedComments(
  login: string = FLEET,
): Array<{ body: string; created_at: string; user: { login: string } }> {
  return [1, 2].map((n) => ({
    user: { login },
    body: [
      `${CONFLICT_FAILED_MARKER} n="${n}" -->`,
      `❌ **Merge-conflict resolution — attempt ${n} of ` +
      `${DEFAULT_MAX_CONFLICT_ATTEMPTS} failed**`,
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
  /** Files `gh pr view --json files` reports for the PR (Issue #2310). */
  prFiles: Array<{ path: string; additions: number; deletions: number }>;
  /** Commits the compare API reports the head is behind (Issue #2310). */
  behindBy: number;
  /** Issue state as `gh issue view --json state,labels` reports it. */
  issueState: string;
  issueLabels: string[];
  /** Comments already on the originating issue. */
  issueComments: Array<{ body: string; user?: { login: string } }>;
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
    prFiles: [{
      path: "worker/deno/lib/limits.ts",
      additions: 12,
      deletions: 3,
    }],
    behindBy: 41,
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

    // How far behind the base the head is, for the flag issue (Issue #2310).
    if (args[0] === "api" && String(args[1]).includes("/compare/")) {
      return Promise.resolve(`${state.behindBy}\n`);
    }

    // The `merge-conflict` label's own `labeled` event (Issue #2310).
    if (args[0] === "api" && String(args[1]).includes("/timeline")) {
      return Promise.resolve(JSON.stringify([{
        event: "labeled",
        label: { name: "merge-conflict" },
        actor: { login: FLEET },
        created_at: "2026-08-18T09:30:00Z",
      }]));
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

    // The abandoned PR's diff summary — the re-do item's starting point.
    if (args[0] === "pr" && args[1] === "view") {
      const fields = String(args[args.indexOf("--json") + 1] ?? "");
      if (fields.includes("files")) {
        return Promise.resolve(JSON.stringify({ files: state.prFiles }));
      }
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
      // The worker's own comment, so it carries the worker's login — that is
      // what makes the cross-host restart claim readable back (Issue #1247).
      state.issueComments.push({
        body: String(args[args.indexOf("--body") + 1] ?? ""),
        user: { login: FLEET },
      });
      return Promise.resolve("");
    }

    if (args[0] === "issue" && args[1] === "reopen") {
      state.issueState = "OPEN";
      return Promise.resolve("");
    }

    // A closed PR leaves the open listing, which is what lets a second round
    // reach the restart bound rather than the other-open-PR precondition
    // (Issue #2312).
    if (args[0] === "pr" && args[1] === "close") {
      const number = Number(args[2]);
      state.prsByState.open = (state.prsByState.open ?? []).filter(
        (pr) => pr.number !== number,
      );
      (state.prsByState.closed ??= []).push({
        number,
        title: `Fix the limits (#${ISSUE_NUMBER})`,
      });
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

/**
 * No `gh` call this abandon made mentions `needs-human` at all (Issue #2277).
 *
 * Every stubbed call is captured, argument by argument — the label add, the
 * comment bodies and the label-creation calls alike — so an escalation
 * reaching *any* of them fails here rather than in production.
 */
function assertNoNeedsHuman(fake: FakeGh): void {
  const offending = fake.calls.find((args) =>
    args.some((arg) => arg.includes("needs-human"))
  );
  assertEquals(
    offending,
    undefined,
    `no abandon call may name needs-human: ${JSON.stringify(offending)}`,
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

Deno.test("mergeFallbackRunsFromHistory - each run's analysis, timings and host (Issue #2310)", () => {
  // The run that measured the timings is long gone by the time a fallback
  // runs, so the conclusion comment is the only surviving source for them.
  const comments = failedComments().map((raw, index) => ({
    ...raw,
    body: `${raw.body}\n\n${
      formatStageTimings(
        [
          { stage: "deepen", seconds: 3 },
          { stage: "agent", seconds: index === 1 ? null : 212 },
        ],
        `host-${index + 1}`,
      )
    }`,
  }));

  const runs = mergeFallbackRunsFromHistory(summariseFailedAttempts(comments));

  assertEquals(runs.length, 2);
  assertEquals(runs[0]?.run, 1);
  assertEquals(runs[0]?.host, "host-1");
  assertEquals(runs[0]?.timings, [
    { stage: "deepen", seconds: 3 },
    { stage: "agent", seconds: 212 },
  ]);
  assertStringIncludes(runs[0]?.analysis ?? "", "two different values");
  // An attempt that died inside the agent says so, rather than reporting a
  // duration it never measured.
  assertEquals(runs[1]?.timings?.[1], { stage: "agent", seconds: null });
  assertEquals(runs[1]?.host, "host-2");
});

Deno.test("mergeFallbackRunsFromHistory - a run with no timings line still records its analysis", () => {
  const runs = mergeFallbackRunsFromHistory(
    summariseFailedAttempts(failedComments()),
  );
  assertEquals(runs.length, 2);
  assertEquals(runs[0]?.timings, undefined);
  assertEquals(runs[0]?.host, undefined);
  assertStringIncludes(runs[0]?.analysis ?? "", "attempt 1");
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

  const outcome = await abandonAndRestart(makeRequest(), {
    gh: fake.gh,
    trustedAuthors: FLEET_AUTHORS,
  });

  assertEquals(outcome, {
    outcome: "abandoned",
    issueNumber: ISSUE_NUMBER,
    label: { kept: "work-on" },
  });

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
  // Reworded in Issue #2280: the sentence now states what GitHub reports and
  // counts the attempts the thread actually recorded, because the ladder's own
  // abandon rung reaches this comment with none opened at all.
  assertStringIncludes(issueBody, "will not merge that branch into `main`");
  assertStringIncludes(issueBody, "2 merge-conflict resolution attempts");

  // The issue already carried the human-applied work label, so it is not
  // re-applied — and it was open, so it is not reopened.
  assertEquals(callsMatching(fake, "issue", "reopen").length, 0);
  assertEquals(labelAddCalls(fake, ISSUE_NUMBER).length, 0);
  assertNoNeedsHuman(fake);
});

Deno.test("abandonAndRestart - claims the restart on the issue before closing the PR", async () => {
  // The marker is the claim two hosts race for: it must exist before anything
  // is destroyed, or the loser destroys the PR twice.
  const fake = makeFake();
  await abandonAndRestart(makeRequest(), {
    gh: fake.gh,
    trustedAuthors: FLEET_AUTHORS,
  });

  const claim = indexOfCall(fake, "issue", "comment");
  const close = indexOfCall(fake, "pr", "close");
  assert(claim >= 0 && close >= 0);
  assert(claim < close, "the issue claim must precede the close");
});

Deno.test("abandonAndRestart - reopens a closed issue and applies idle-task", async () => {
  const fake = makeFake({ issueState: "CLOSED", issueLabels: [] });

  const outcome = await abandonAndRestart(makeRequest(), {
    gh: fake.gh,
    trustedAuthors: FLEET_AUTHORS,
  });

  assertEquals(outcome, {
    outcome: "abandoned",
    issueNumber: ISSUE_NUMBER,
    // `idle-task` is the one pickup label the worker may self-apply.
    label: { applied: "idle-task" },
  });
  assertEquals(callsMatching(fake, "issue", "reopen").length, 1);
  const labelAdds = labelAddCalls(fake, ISSUE_NUMBER);
  assertEquals(labelAdds.length, 1);
  assert((labelAdds[0] ?? []).includes("labels[]=idle-task"));
  assertNoNeedsHuman(fake);
});

// ---------------------------------------------------------------------------
// The re-queue label — keep what is there, else `idle-task` (Issue #2277)
// ---------------------------------------------------------------------------

Deno.test("planRequeueLabel - keeps the highest-priority pickup label present", () => {
  // The fleet's own order: top-priority > work-on > low-priority > idle-task.
  // Keeping the lower of two would demote the issue as surely as replacing it.
  assertEquals(planRequeueLabel(["work-on", "top-priority"]), {
    kept: "top-priority",
  });
  assertEquals(planRequeueLabel(["idle-task", "low-priority"]), {
    kept: "low-priority",
  });
  assertEquals(planRequeueLabel(["bug", "idle-task"]), { kept: "idle-task" });
});

Deno.test("planRequeueLabel - an issue with no pickup label gains idle-task", () => {
  assertEquals(planRequeueLabel([]), { applied: "idle-task" });
  assertEquals(planRequeueLabel(["bug", "documentation"]), {
    applied: "idle-task",
  });
  // A label that merely contains a pickup name is not one of them.
  assertEquals(planRequeueLabel(["work-on-later"]), { applied: "idle-task" });
});

Deno.test("planRequeueLabel - a differently-cased label still counts, and is canonicalised", () => {
  // GitHub label names are case-insensitive to create, so `Top-Priority` is
  // the same pickup signal — and the canonical spelling is what the public
  // comments name, never the repository's own text.
  assertEquals(planRequeueLabel(["Top-Priority"]), { kept: "top-priority" });
  assertEquals(requeueLabelName(planRequeueLabel(["IDLE-TASK"])), "idle-task");
});

Deno.test("requeueLabelName - names either shape", () => {
  assertEquals(requeueLabelName({ kept: "work-on" }), "work-on");
  assertEquals(requeueLabelName({ applied: "idle-task" }), "idle-task");
});

Deno.test("abandonAndRestart - an issue carrying top-priority keeps it, and no label is added", async () => {
  // The live case: NEAT-AI-Lamarck#234 carries `top-priority`. Replacing it —
  // or handing the issue to `needs-human` because the worker may not apply
  // `work-on` — would demote work a human deliberately raised.
  const fake = makeFake({ issueLabels: ["bug", "top-priority"] });

  const outcome = await abandonAndRestart(makeRequest(), {
    gh: fake.gh,
    trustedAuthors: FLEET_AUTHORS,
  });

  assertEquals(outcome, {
    outcome: "abandoned",
    issueNumber: ISSUE_NUMBER,
    label: { kept: "top-priority" },
  });
  assertEquals(callsMatching(fake, "pr", "close").length, 1);
  assertEquals(labelAddCalls(fake, ISSUE_NUMBER).length, 0);
  assertNoNeedsHuman(fake);

  // The restart comment names the label the issue now carries.
  assertStringIncludes(bodyOfCall(fake, "issue", "comment"), "`top-priority`");
  assertStringIncludes(bodyOfCall(fake, "pr", "comment"), "`top-priority`");
});

Deno.test("abandonAndRestart - an issue with no pickup label gains idle-task, never needs-human", async () => {
  const fake = makeFake({ issueLabels: ["bug"] });

  const outcome = await abandonAndRestart(makeRequest(), {
    gh: fake.gh,
    trustedAuthors: FLEET_AUTHORS,
  });

  assertEquals(outcome, {
    outcome: "abandoned",
    issueNumber: ISSUE_NUMBER,
    label: { applied: "idle-task" },
  });
  const labelAdds = labelAddCalls(fake, ISSUE_NUMBER);
  assertEquals(labelAdds.length, 1);
  assert((labelAdds[0] ?? []).includes("labels[]=idle-task"));
  assertNoNeedsHuman(fake);
  assertStringIncludes(bodyOfCall(fake, "issue", "comment"), "`idle-task`");
});

Deno.test("abandonAndRestart - an issue already carrying idle-task has nothing added", async () => {
  const fake = makeFake({ issueLabels: ["idle-task"] });

  const outcome = await abandonAndRestart(makeRequest(), {
    gh: fake.gh,
    trustedAuthors: FLEET_AUTHORS,
  });

  assertEquals(outcome, {
    outcome: "abandoned",
    issueNumber: ISSUE_NUMBER,
    label: { kept: "idle-task" },
  });
  assertEquals(labelAddCalls(fake, ISSUE_NUMBER).length, 0);
  assertNoNeedsHuman(fake);
});

// ---------------------------------------------------------------------------
// Preconditions — the destructive cases, asserted before the close
// ---------------------------------------------------------------------------

/** A context whose PR side resolves to nothing at all (Issue #2310). */
function noIssueContext(): () => Promise<ConflictIssueContext> {
  return () =>
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
    });
}

/** A flag filer that records what it was asked to file. */
function recordingFiler(
  outcome: Result<MergeFallbackOutcome>,
  filings: MergeFallbackFiling[],
  order?: string[],
): (filing: MergeFallbackFiling) => Promise<Result<MergeFallbackOutcome>> {
  return (filing) => {
    filings.push(filing);
    order?.push("flag-filed");
    return Promise.resolve(outcome);
  };
}

Deno.test("abandonAndRestart - no originating issue: the PR is closed and the flag is the re-do item (Issue #2310)", async () => {
  // This used to decline: closing a PR the fleet cannot re-raise loses the
  // work. The reasoning holds — the flag issue is what the fleet re-raises
  // from, carrying `idle-task` and the PR's diff summary, so the work is
  // queued instead of parked on a human who never came.
  const fake = makeFake();
  const filings: MergeFallbackFiling[] = [];

  const outcome = await abandonAndRestart(
    makeRequest({ branchName: "hotfix/no-issue-here" }),
    {
      gh: fake.gh,
      trustedAuthors: FLEET_AUTHORS,
      resolveContext: noIssueContext(),
      fileFallbackFlag: recordingFiler({
        ok: true,
        value: {
          issueNumber: 900,
          url: `https://github.com/${REPO}/issues/900`,
          appended: false,
        },
      }, filings),
    },
  );

  assertEquals(outcome, {
    outcome: "abandoned",
    issueNumber: 900,
    label: { applied: "idle-task" },
    flagIssueNumber: 900,
  });

  // The flag carries `idle-task` and the diff summary — that is what makes it
  // a work item rather than a note.
  assertEquals(filings.length, 1);
  const filing = filings[0];
  assertEquals(filing?.requestIdleTask, true);
  assertEquals(filing?.diffSummary, [{
    path: "worker/deno/lib/limits.ts",
    additions: 12,
    deletions: 3,
  }]);
  assertEquals(filing?.diffSummaryOmitted, 0);
  assertEquals(filing?.target, {
    kind: "pr",
    repo: REPO,
    prNumber: PR_NUMBER,
    headBranch: "hotfix/no-issue-here",
    baseBranch: "main",
  });
  assertEquals(filing?.behindBy, 41);
  assertEquals(filing?.behindSince, "2026-08-18T09:30:00.000Z");
  assertEquals(filing?.conflictedFiles, ["worker/deno/lib/limits.ts"]);
  assertEquals(filing?.runs?.length, 2);

  // Closed, not merged, and the branch is left where it is.
  const closes = callsMatching(fake, "pr", "close");
  assertEquals(closes.length, 1);
  assert(!(closes[0] ?? []).includes("--delete-branch"));
  assertEquals(callsMatching(fake, "pr", "merge").length, 0);

  // The close comment names the issue the work comes back through.
  const prBody = bodyOfCall(fake, "pr", "comment");
  assertStringIncludes(prBody, "#900");
  assertStringIncludes(prBody, "no originating issue");
  // No issue exists to claim a restart on, so none is commented on.
  assertEquals(callsMatching(fake, "issue", "comment").length, 0);
  assertNoNeedsHuman(fake);
});

Deno.test("abandonAndRestart - no originating issue: a flag that cannot be filed leaves the PR open (Issue #2310)", async () => {
  // The one thing worse than a PR left open: a PR closed against a record
  // nobody can find. The flag is filed *before* anything is closed.
  const fake = makeFake();

  const outcome = await abandonAndRestart(
    makeRequest({ branchName: "hotfix/no-issue-here" }),
    {
      gh: fake.gh,
      trustedAuthors: FLEET_AUTHORS,
      resolveContext: noIssueContext(),
      fileFallbackFlag: () =>
        Promise.resolve({ ok: false, error: new Error("gh: 503") }),
    },
  );

  assert(outcome.outcome === "failed");
  assertEquals(outcome.step, "fallback-flag");
  assertStringIncludes(outcome.message, "503");
  assertEquals(callsMatching(fake, "pr", "close").length, 0);
  assertEquals(callsMatching(fake, "pr", "comment").length, 0);
  assertNoNeedsHuman(fake);
});

Deno.test("abandonAndRestart - no originating issue: an unreadable flag number leaves the PR open (Issue #2310)", async () => {
  // `gh` filed the issue but reported no number, so nothing can link to the
  // re-do item. Closing against it would be the same loss as closing with no
  // record at all.
  const fake = makeFake();

  const outcome = await abandonAndRestart(
    makeRequest({ branchName: "hotfix/no-issue-here" }),
    {
      gh: fake.gh,
      trustedAuthors: FLEET_AUTHORS,
      resolveContext: noIssueContext(),
      fileFallbackFlag: () =>
        Promise.resolve({
          ok: true,
          value: { issueNumber: 0, url: "", appended: false },
        }),
    },
  );

  assert(outcome.outcome === "failed");
  assertEquals(outcome.step, "fallback-flag");
  assertEquals(callsMatching(fake, "pr", "close").length, 0);
});

Deno.test("abandonAndRestart - no originating issue: an appended flag is labelled idle-task (Issue #2310)", async () => {
  // A second fallback on the same PR appends to the open flag, and the filer
  // labels only the issues it creates — so without this the PR would be closed
  // against a flag nobody picks up, and the work would be lost.
  const fake = makeFake();
  const labelled: Array<{ issueNumber: number; label: string }> = [];

  const outcome = await abandonAndRestart(
    makeRequest({ branchName: "hotfix/no-issue" }),
    {
      gh: fake.gh,
      trustedAuthors: FLEET_AUTHORS,
      resolveContext: noIssueContext(),
      addLabel: (_repo, issueNumber, label) => {
        labelled.push({ issueNumber, label });
        return Promise.resolve({ ok: true, value: undefined });
      },
      fileFallbackFlag: () =>
        Promise.resolve({
          ok: true,
          value: { issueNumber: 800, url: "", appended: true },
        }),
    },
  );

  assertEquals(outcome, {
    outcome: "abandoned",
    issueNumber: 800,
    label: { applied: "idle-task" },
    flagIssueNumber: 800,
  });
  assertEquals(labelled, [{ issueNumber: 800, label: "idle-task" }]);
  assertEquals(callsMatching(fake, "pr", "close").length, 1);
});

Deno.test("abandonAndRestart - no originating issue: an unlabelled appended flag leaves the PR open (Issue #2310)", async () => {
  const fake = makeFake();

  const outcome = await abandonAndRestart(
    makeRequest({ branchName: "hotfix/no-issue" }),
    {
      gh: fake.gh,
      trustedAuthors: FLEET_AUTHORS,
      resolveContext: noIssueContext(),
      addLabel: () =>
        Promise.resolve({ ok: false, error: new Error("label add refused") }),
      fileFallbackFlag: () =>
        Promise.resolve({
          ok: true,
          value: { issueNumber: 800, url: "", appended: true },
        }),
    },
  );

  assert(outcome.outcome === "failed");
  assertEquals(outcome.step, "fallback-flag");
  assertEquals(callsMatching(fake, "pr", "close").length, 0);
});

Deno.test("buildNoIssueAbandonPrComment - names the flag issue, the reason and the branch", () => {
  const body = buildNoIssueAbandonPrComment({
    request: makeRequest({ branchName: "hotfix/no-issue" }),
    history: summariseFailedAttempts(failedComments()),
    reason: "no-signal",
    flagIssueNumber: 900,
  });

  assertStringIncludes(body, "#900");
  assertStringIncludes(body, "no-signal");
  assertStringIncludes(body, "hotfix/no-issue");
  assertStringIncludes(body, "idle-task");
  assertStringIncludes(body, "worker/deno/lib/limits.ts");
  // Closed, not force-pushed: the abandoned commits stay readable.
  assertStringIncludes(body, "not** deleted");
});

Deno.test("buildNoIssueAbandonPrComment - a thread with no conclusion states the absence", () => {
  const body = buildNoIssueAbandonPrComment({
    request: makeRequest({ prComments: [] }),
    history: summariseFailedAttempts([]),
    reason: "no-signal",
    flagIssueNumber: 900,
  });

  assertStringIncludes(body, "No concluded merge-conflict resolution attempt");
  assertStringIncludes(body, "no conflicted path was recorded");
});

Deno.test("abandonAndRestart - no originating issue: the flag is filed before the close", async () => {
  // Ordering, not just outcome — the property the old decline protected.
  const fake = makeFake();
  const order: string[] = [];
  const filings: MergeFallbackFiling[] = [];
  const gh = (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "close") order.push("pr-close");
    return fake.gh(args);
  };

  await abandonAndRestart(makeRequest({ branchName: "hotfix/no-issue" }), {
    gh,
    trustedAuthors: FLEET_AUTHORS,
    resolveContext: noIssueContext(),
    fileFallbackFlag: recordingFiler(
      {
        ok: true,
        value: { issueNumber: 901, url: "", appended: false },
      },
      filings,
      order,
    ),
  });

  assertEquals(order, ["flag-filed", "pr-close"]);
});

Deno.test("abandonAndRestart - an issue with another open PR is left alone", async () => {
  const fake = makeFake({
    prsByState: {
      open: [{ number: 91, title: `Fix the limits (#${ISSUE_NUMBER})` }],
      merged: [],
      closed: [],
    },
  });

  const outcome = await abandonAndRestart(makeRequest(), {
    gh: fake.gh,
    trustedAuthors: FLEET_AUTHORS,
  });

  assertEquals(outcome.outcome, "declined");
  assert(outcome.outcome === "declined");
  assertEquals(outcome.reason.kind, "other-open-pr");
  assertEquals(callsMatching(fake, "pr", "close").length, 0);
});

// ---------------------------------------------------------------------------
// The bound — one restart per originating issue
// ---------------------------------------------------------------------------

Deno.test("abandonAndRestart - a restarted issue is restarted a second time", async () => {
  // Issue #2312 raised the bound from one restart to two. The fresh PR is a
  // different PR, so the first round's marker must not decline the second —
  // the regression this asserts against is the one-restart rule.
  const fake = makeFake();
  const first = await abandonAndRestart(makeRequest(), {
    gh: fake.gh,
    trustedAuthors: FLEET_AUTHORS,
  });
  assertEquals(first.outcome, "abandoned");

  const second = await abandonAndRestart(
    makeRequest({ prNumber: 77, branchName: `issue-${ISSUE_NUMBER}-limits-2` }),
    { gh: fake.gh, trustedAuthors: FLEET_AUTHORS },
  );

  assertEquals(second, {
    outcome: "abandoned",
    issueNumber: ISSUE_NUMBER,
    label: { kept: "work-on" },
  });
  // Both PRs were closed, and both events are recorded on the same issue.
  assertEquals(callsMatching(fake, "pr", "close").length, 2);
  assertEquals(
    restartMarkerPrNumbers(fake.state.issueComments),
    [PR_NUMBER, 77],
  );
});

Deno.test("abandonAndRestart - the third exhaustion is declined, not restarted", async () => {
  // The bound itself (Issue #2312). Two restarts, then the caller parks the
  // PR: a third close-and-re-raise of the same work is not a new experiment.
  const fake = makeFake();
  await abandonAndRestart(makeRequest(), {
    gh: fake.gh,
    trustedAuthors: FLEET_AUTHORS,
  });
  await abandonAndRestart(
    makeRequest({ prNumber: 77, branchName: `issue-${ISSUE_NUMBER}-limits-2` }),
    { gh: fake.gh, trustedAuthors: FLEET_AUTHORS },
  );

  const third = await abandonAndRestart(
    makeRequest({ prNumber: 88, branchName: `issue-${ISSUE_NUMBER}-limits-3` }),
    { gh: fake.gh, trustedAuthors: FLEET_AUTHORS },
  );

  assertEquals(third, {
    outcome: "declined",
    reason: {
      kind: "already-restarted",
      issueNumber: ISSUE_NUMBER,
      samePr: false,
      restartCount: MAX_RESTARTS_PER_ISSUE,
    },
  });
  // Two closes across the three rounds — the third PR is left open.
  assertEquals(callsMatching(fake, "pr", "close").length, 2);
});

Deno.test("buildRestartIssueComment - the last restart says what follows it", () => {
  // The comment is permanent, so "this is your last restart" has to be true
  // when it says so, and the first one must not promise a park (Issue #2312).
  const first = buildRestartIssueComment({
    request: makeRequest(),
    history: summariseFailedAttempts(failedComments()),
    label: { kept: "work-on" },
    restartNumber: 1,
  });
  assertStringIncludes(first, `restart **1 of ${MAX_RESTARTS_PER_ISSUE}**`);
  assertStringIncludes(first, "redone once more");

  const last = buildRestartIssueComment({
    request: makeRequest(),
    history: summariseFailedAttempts(failedComments()),
    label: { kept: "work-on" },
    restartNumber: MAX_RESTARTS_PER_ISSUE,
  });
  assertStringIncludes(
    last,
    `restart **${MAX_RESTARTS_PER_ISSUE} of ${MAX_RESTARTS_PER_ISSUE}**`,
  );
  assertStringIncludes(last, "re-attempted only when its base branch moves");
});

// ---------------------------------------------------------------------------
// Who wrote the marker (Issue #1247, SEC-1216-06)
// ---------------------------------------------------------------------------

Deno.test("abandonAndRestart - an outsider's restart claim does not stall the rung", async () => {
  // The suppression half of the exploit: one planted marker on the issue made
  // the rung decline `already-restarted` for ever, so every conflicted PR for
  // that issue stalled unowned. An outsider's claim is not the fleet's claim.
  const fake = makeFake({
    issueComments: [
      comment(conflictRestartMarker(REPO, 999), OUTSIDER),
      comment("plausible chatter", OUTSIDER),
    ],
  });

  const outcome = await abandonAndRestart(makeRequest(), {
    gh: fake.gh,
    trustedAuthors: FLEET_AUTHORS,
  });

  assertEquals(outcome, {
    outcome: "abandoned",
    issueNumber: ISSUE_NUMBER,
    label: { kept: "work-on" },
  });
  assertEquals(callsMatching(fake, "pr", "close").length, 1);
});

Deno.test("abandonAndRestart - the fleet's own restart claim still bounds the rung", async () => {
  // The other direction of the same check: filtering must not weaken the
  // one-abandon-per-issue bound the fleet's own marker carries.
  const fake = makeFake({
    issueComments: [comment(conflictRestartMarker(REPO, PR_NUMBER), FLEET)],
  });

  const outcome = await abandonAndRestart(makeRequest(), {
    gh: fake.gh,
    trustedAuthors: FLEET_AUTHORS,
  });

  assertEquals(outcome, {
    outcome: "declined",
    reason: {
      kind: "already-restarted",
      issueNumber: ISSUE_NUMBER,
      samePr: true,
      restartCount: 1,
    },
  });
  assertEquals(callsMatching(fake, "pr", "close").length, 0);
});

Deno.test("abandonAndRestart - a claim that cannot be attributed refuses the close", async () => {
  // The restart marker *suppresses* a destructive step, so an unattributable
  // claim must not be discarded: with no fleet identity resolved, a genuine
  // fleet claim is indistinguishable from an outsider's, and proceeding would
  // relax the only bound on closing and re-raising this work.
  const fake = makeFake({
    issueComments: [comment(conflictRestartMarker(REPO, PR_NUMBER), FLEET)],
  });

  const outcome = await abandonAndRestart(makeRequest(), {
    gh: fake.gh,
    trustedAuthors: [],
  });

  assertEquals(outcome, {
    outcome: "declined",
    reason: {
      kind: "restart-claim-unverifiable",
      issueNumber: ISSUE_NUMBER,
      claimCount: 1,
    },
  });
  assertEquals(callsMatching(fake, "pr", "close").length, 0);
});

Deno.test("abandonAndRestart - an outsider's failure text is never quoted back", async () => {
  // `summariseFailedAttempts` reads the PR thread the abandon comment quotes,
  // so an unfiltered thread publishes an outsider's invented "attempt" and
  // its invented issue numbers as the fleet's own permanent record.
  const fake = makeFake();

  await abandonAndRestart(
    makeRequest({
      prComments: [
        ...failedComments(FLEET),
        comment(
          [
            `${CONFLICT_FAILED_MARKER} n="9" -->`,
            "attempt 9 tripped on a file nobody touched",
            "",
            "Conflicted files:",
            "- `planted/never-conflicted.ts`",
          ].join("\n"),
          OUTSIDER,
        ),
        comment(
          `${CONFLICT_ATTEMPT_MARKER} n="9" -->\n### Issues consulted\n\n- #4242`,
          OUTSIDER,
        ),
      ],
    }),
    { gh: fake.gh, trustedAuthors: FLEET_AUTHORS },
  );

  const prBody = bodyOfCall(fake, "pr", "comment");
  assert(
    !prBody.includes("planted/never-conflicted.ts"),
    "an outsider's conflicted path was quoted as the fleet's record",
  );
  assert(
    !prBody.includes("#4242"),
    "an outsider's consulted-issue number was quoted as the fleet's record",
  );
  // The fleet's own two attempts are still there.
  assertStringIncludes(prBody, "two different values");
});

Deno.test("abandonAndRestart - two hosts on the same PR produce one abandon", async () => {
  // Cross-host dedupe: both hosts see the same issue thread, so the marker
  // the first one posts is what the second one reads.
  const shared = makeFake();
  const hostA = await abandonAndRestart(makeRequest(), {
    gh: shared.gh,
    trustedAuthors: FLEET_AUTHORS,
  });
  const hostB = await abandonAndRestart(makeRequest(), {
    gh: shared.gh,
    trustedAuthors: FLEET_AUTHORS,
  });

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
    const outcome = await abandonAndRestart(makeRequest(), {
      gh: fake.gh,
      trustedAuthors: FLEET_AUTHORS,
    });

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
    trustedAuthors: FLEET_AUTHORS,
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
    trustedAuthors: FLEET_AUTHORS,
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
    label: { applied: "idle-task" },
  });

  assertStringIncludes(body, "no failure comment survives");
  assertStringIncludes(body, "no conflicted path was recorded");
  assertStringIncludes(body, "not** deleted");
  // The count is read off the thread, never assumed: the stale-verdict ladder
  // reaches this rung with no attempt opened at all (Issue #2280), and
  // "two attempts failed" would be a fabricated fact on a permanent comment.
  assertStringIncludes(body, "No concluded merge-conflict resolution attempt");
});

Deno.test("describeConcludedAttempts - counts what the thread records (Issue #2280)", () => {
  const history = (count: number) => ({
    attempts: Array.from({ length: count }, (_, index) => ({
      attempt: index + 1,
      detail: "conflicted",
    })),
    conflictedPaths: [],
    consultedIssues: [],
  });

  assertStringIncludes(
    describeConcludedAttempts(history(0)),
    "No concluded merge-conflict resolution attempt",
  );
  assertStringIncludes(
    describeConcludedAttempts(history(1)),
    "1 merge-conflict resolution attempt on this PR concluded and failed",
  );
  assertStringIncludes(
    describeConcludedAttempts(history(3)),
    "3 merge-conflict resolution attempts on this PR concluded and failed",
  );
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
    trustedAuthors: FLEET_AUTHORS,
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
  // Issue #2312: `restart-exhausted` is gone — no caller escalates a spent
  // restart budget any more, so it maps to the ordinary declined route and the
  // scan parks the PR off the decline reason itself.
  const spent = exhaustedEscalationRoute({
    outcome: "declined",
    reason: {
      kind: "already-restarted",
      issueNumber: ISSUE_NUMBER,
      samePr: false,
      restartCount: MAX_RESTARTS_PER_ISSUE,
    },
  });
  assertEquals(spent.kind, "abandon-declined");
  assertStringIncludes(
    spent.kind === "abandon-declined" ? spent.detail : "",
    `spent its ${MAX_RESTARTS_PER_ISSUE} restarts`,
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

Deno.test("exhaustedEscalationRoute - a burnt claim on this PR is not a failed replacement", () => {
  // The marker is posted before the close, so a mid-abandon failure leaves a
  // claim with nothing abandoned. Saying "the replacement PR spent its budget
  // too" would be false, so the two declines read differently (Issue #2312
  // kept the distinction when it removed the escalation route).
  const samePr = exhaustedEscalationRoute({
    outcome: "declined",
    reason: {
      kind: "already-restarted",
      issueNumber: ISSUE_NUMBER,
      samePr: true,
      restartCount: 1,
    },
  });
  assertStringIncludes(
    samePr.kind === "abandon-declined" ? samePr.detail : "",
    "did not finish",
  );

  const replaced = exhaustedEscalationRoute({
    outcome: "declined",
    reason: {
      kind: "already-restarted",
      issueNumber: ISSUE_NUMBER,
      samePr: false,
      restartCount: MAX_RESTARTS_PER_ISSUE,
    },
  });
  assertStringIncludes(
    replaced.kind === "abandon-declined" ? replaced.detail : "",
    "left open on `merge-conflict`",
  );
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
    { gh: fake.gh, trustedAuthors: FLEET_AUTHORS },
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

  const outcome = await abandonAndRestart(request, {
    gh: fake.gh,
    trustedAuthors: FLEET_AUTHORS,
  });

  assert(outcome.outcome === "failed");
  assertEquals(outcome.step, "pr-thread");
  assertEquals(callsMatching(fake, "pr", "close").length, 0);
});

Deno.test("abandonAndRestart - an unreadable issue view is not an open, unlabelled issue", async () => {
  const fake = makeFake();
  const outcome = await abandonAndRestart(makeRequest(), {
    trustedAuthors: FLEET_AUTHORS,
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

Deno.test("exhaustedEscalationRoute - the other-PR decline says what blocked it", () => {
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
});
