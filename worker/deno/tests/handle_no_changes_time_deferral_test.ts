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
import type { GitHubClient, GitHubIssue } from "../types.ts";
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

function makeClient(calls: StubCalls, body = "Original body."): GitHubClient {
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
    getIssueComments: () => Promise.resolve([]),
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
      github: { createClient: () => makeClient(calls) },
    });

    const priorComments = buildPriorDeferralComments(MAX_TIME_DEFERRALS);
    const result = await workOnIssueHandleNoChanges(
      makeContext({ issueComments: priorComments }),
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
