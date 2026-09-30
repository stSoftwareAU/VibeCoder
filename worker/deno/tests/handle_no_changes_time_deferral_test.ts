/**
 * Regression tests for the time-gated deferral in the no-changes phase
 * (Issue #2873).
 *
 * A run that reports the data it needs to analyse does not exist *yet*
 * (rather than being blocked on another issue, or genuinely needing a
 * human decision) asks to be parked until a future time via a
 * `vibe-defer-until` marker. This must not be escalated to `needs-human`
 * — the issue stays open, keeps its discovery label, and is skipped until
 * the requested time.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueHandleNoChanges } from "../lib/phases/handle_no_changes_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { GitHubClient, GitHubComment, GitHubIssue } from "../types.ts";
import { MAX_TIME_DEFERRALS } from "../lib/time_deferral.ts";

const REPO = "stSoftwareAU/NEAT-AI-Backpropagation";
const ISSUE = 94;

const FUTURE_UNTIL = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
  .toISOString().replace(/\.\d{3}Z$/, "Z");
const PAST_UNTIL = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  .toISOString().replace(/\.\d{3}Z$/, "Z");

/** Analysis output (>100 chars) with a valid future defer-until marker. */
const DEFER_OUTPUT = "A".repeat(150) +
  ` Here is my analysis: the 7-day window is empty right now.\n\n` +
  `<!-- vibe-defer-until until="${FUTURE_UNTIL}" reason="7-day window is empty" -->`;

/** Same analysis output, but with no marker at all. */
const NO_MARKER_OUTPUT = "A".repeat(150) +
  " Here is my analysis: nothing to report yet.";

/** Same analysis output, but the marker's `until` is already past. */
const PAST_MARKER_OUTPUT = "A".repeat(150) +
  ` Here is my analysis: the window is empty.\n\n` +
  `<!-- vibe-defer-until until="${PAST_UNTIL}" reason="7-day window is empty" -->`;

/** Blocked-shaped output that also carries a defer-until marker. */
const BLOCKED_AND_DEFER_OUTPUT = `## Blocked: upstream data is not produced yet

No code change is possible here yet.

Depends on stSoftwareAU/NEAT-AI-core#560

<!-- vibe-defer-until until="${FUTURE_UNTIL}" reason="waiting on upstream" -->
`;

interface StubCalls {
  addLabel: string[];
  postComment: string[];
  editIssue: Array<{ title?: string; body?: string }>;
  unassignIssue: number;
}

function makeCalls(): StubCalls {
  return { addLabel: [], postComment: [], editIssue: [], unassignIssue: 0 };
}

function makeClient(
  calls: StubCalls,
  body = "Original body.",
  thread: GitHubComment[] = [],
): GitHubClient {
  const issue: GitHubIssue = {
    number: ISSUE,
    title: "Report on the rolling 7-day window",
    body,
    labels: ["work-on"],
    author: "human",
    assignees: ["testbot"],
    createdAt: "",
    updatedAt: "",
  };
  return {
    getIssue: () => Promise.resolve(issue),
    getIssueComments: () => Promise.resolve(thread),
    addLabel: (_r, _i, label) => {
      calls.addLabel.push(label);
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: (_r, _i, b) => {
      calls.postComment.push(b);
      return Promise.resolve(undefined);
    },
    editIssue: (_r, _i, updates) => {
      calls.editIssue.push(updates);
      return Promise.resolve();
    },
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => {
      calls.unassignIssue++;
      return Promise.resolve();
    },
    closeIssue: () => Promise.resolve(),
  };
}

function makeContext(overrides?: Partial<IssueContext>): IssueContext {
  return {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Report on the rolling 7-day window",
    issueBody: "Analyse the last 7 days of data and report on it.",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
    ...overrides,
  };
}

function makeState(claudeOutput: string): PhaseState {
  return {
    branchName: "issue-94-report",
    baseBranch: "Develop",
    defaultBranch: "Develop",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput,
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

/** A full-thread comment, as `getIssueComments` returns it. */
function comment(id: number, author: string, body: string): GitHubComment {
  return {
    id,
    body,
    author,
    createdAt: "",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  } as GitHubComment;
}

/**
 * The full thread behind a busy issue: 25 human comments (more than the
 * prompt blob's 20-comment budget admits) followed by `parks` of the
 * worker's own park comments.
 */
function busyThread(parks: number, parkAuthor = "testbot"): GitHubComment[] {
  const thread: GitHubComment[] = [];
  for (let i = 0; i < 25; i++) {
    thread.push(
      comment(i + 1, "human", `Human note ${i + 1}: ${"x".repeat(600)}`),
    );
  }
  buildPriorDeferralComments(parks).split("\n\n").filter(Boolean).forEach(
    (marker, i) =>
      thread.push(
        comment(100 + i, parkAuthor, `## Deferred until …\n\n${marker}`),
      ),
  );
  return thread;
}

/** Build `count` prior `vibe-time-deferral` markers, as prior park comments carry. */
function buildPriorDeferralComments(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const until = new Date(Date.now() + (i + 1) * 24 * 60 * 60 * 1000)
      .toISOString().replace(/\.\d{3}Z$/, "Z");
    lines.push(`<!-- vibe-time-deferral until="${until}" -->`);
  }
  return lines.join("\n\n");
}

Deno.test(
  "handle_no_changes_phase - valid time-deferral marker parks the issue, no needs-human",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });

    const result = await workOnIssueHandleNoChanges(
      makeContext(),
      makeState(DEFER_OUTPUT),
      deps,
    );

    assertEquals(result.status, "early_exit");
    const reason = (result as { reason: string }).reason;
    assert(
      reason.startsWith("deferred: until"),
      `expected reason to start with "deferred: until", got: ${reason}`,
    );
    assertEquals((result as { expectedSkip?: boolean }).expectedSkip, true);

    // One park comment, carrying the loop-guard marker.
    assertEquals(calls.postComment.length, 1);
    assertStringIncludes(calls.postComment[0]!, "## Deferred until");
    assertStringIncludes(calls.postComment[0]!, "vibe-time-deferral");

    // The body records the machine-owned `Deferred until` line.
    assertEquals(calls.editIssue.length, 1);
    assertStringIncludes(calls.editIssue[0]?.body ?? "", "Deferred until ");

    // No needs-human hand-off.
    assertEquals(calls.addLabel, []);

    // Claim released.
    assertEquals(calls.unassignIssue, 1);
  },
);

Deno.test(
  "handle_no_changes_phase - analysis output with no marker still hands off (#2834)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });

    const result = await workOnIssueHandleNoChanges(
      makeContext(),
      makeState(NO_MARKER_OUTPUT),
      deps,
    );

    assertEquals(
      (result as { reason: string }).reason,
      "analysis_only_handed_off",
    );
    assertEquals(calls.addLabel, ["needs-human"]);
  },
);

Deno.test(
  "handle_no_changes_phase - deferral limit reached hands off to a human",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: {
        createClient: () =>
          makeClient(calls, undefined, busyThread(MAX_TIME_DEFERRALS)),
      },
    });

    const result = await workOnIssueHandleNoChanges(
      makeContext(),
      makeState(DEFER_OUTPUT),
      deps,
    );

    assertEquals(
      (result as { reason: string }).reason,
      "analysis_only_handed_off",
    );
    assertEquals(calls.addLabel, ["needs-human"]);
    assertStringIncludes(
      calls.postComment.find((c) => c.includes("## Deferral limit reached")) ??
        "",
      "## Deferral limit reached",
    );
  },
);

Deno.test(
  "handle_no_changes_phase - a past 'until' is not deferred, falls through to hand-off",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });

    const result = await workOnIssueHandleNoChanges(
      makeContext(),
      makeState(PAST_MARKER_OUTPUT),
      deps,
    );

    assertEquals(
      (result as { reason: string }).reason,
      "analysis_only_handed_off",
    );
    assertEquals(calls.addLabel, ["needs-human"]);
    assertEquals(calls.editIssue, []);
  },
);

Deno.test(
  "handle_no_changes_phase - blocked output wins over a defer-until marker",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });

    const result = await workOnIssueHandleNoChanges(
      makeContext(),
      makeState(BLOCKED_AND_DEFER_OUTPUT),
      deps,
    );

    assertEquals(
      (result as { reason: string }).reason,
      "deferred: depends on stSoftwareAU/NEAT-AI-core#560",
    );
    assertEquals(calls.addLabel, []);
  },
);

Deno.test(
  "handle_no_changes_phase - the limit fires on a busy thread the prompt blob truncates (#2873 review)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: {
        createClient: () =>
          makeClient(calls, undefined, busyThread(MAX_TIME_DEFERRALS)),
      },
    });

    // The prompt blob admits worker comments last, after 20+ human ones have
    // used the budget: it carries none of the park comments.
    const result = await workOnIssueHandleNoChanges(
      makeContext({ issueComments: "Human note 1 … Human note 20" }),
      makeState(DEFER_OUTPUT),
      deps,
    );

    assertEquals(
      (result as { reason: string }).reason,
      "analysis_only_handed_off",
      "a fourth park must not happen",
    );
    assertEquals(calls.addLabel, ["needs-human"]);
    assertEquals(calls.editIssue, []);
  },
);

Deno.test(
  "handle_no_changes_phase - the park comment numbers the deferral from the full thread (#2873 review)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: {
        createClient: () => makeClient(calls, undefined, busyThread(1)),
      },
    });

    await workOnIssueHandleNoChanges(
      makeContext({ issueComments: "" }),
      makeState(DEFER_OUTPUT),
      deps,
    );

    assertStringIncludes(
      calls.postComment[0] ?? "",
      `Deferral 2 of ${MAX_TIME_DEFERRALS}`,
    );
  },
);

Deno.test(
  "handle_no_changes_phase - park markers from another author are not counted (#2873 review)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: {
        createClient: () =>
          makeClient(calls, undefined, busyThread(MAX_TIME_DEFERRALS, "human")),
      },
    });

    const result = await workOnIssueHandleNoChanges(
      makeContext(),
      makeState(DEFER_OUTPUT),
      deps,
    );

    assert(
      (result as { reason: string }).reason.startsWith("deferred: until"),
      "only the worker's own park comments count toward the limit",
    );
    assertStringIncludes(calls.postComment[0] ?? "", "Deferral 1 of");
  },
);

Deno.test(
  "handle_no_changes_phase - a failed thread fetch counts from the prompt blob (#2873 review)",
  async () => {
    const calls = makeCalls();
    const client = makeClient(calls);
    client.getIssueComments = () => Promise.reject(new Error("gh: 502"));
    const deps = createMockDeps({ github: { createClient: () => client } });

    const result = await workOnIssueHandleNoChanges(
      makeContext({
        issueComments: buildPriorDeferralComments(MAX_TIME_DEFERRALS),
      }),
      makeState(DEFER_OUTPUT),
      deps,
    );

    assertEquals(
      (result as { reason: string }).reason,
      "analysis_only_handed_off",
    );
  },
);
