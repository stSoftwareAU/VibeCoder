/**
 * Tests for `lib/phases/handle_no_changes_phase.ts` — focused on the
 * structured-output suppression added in Issue #2098.
 *
 * The standard pipeline must NOT post a "Partial Answer" comment when
 * the issue being worked is a wrapper filed by an idle-task template
 * that declares `requiresStructuredOutput`. The wrapper's outcome is
 * filed issues, not narrative text, so a partial answer would be
 * meaningless to the user.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueHandleNoChanges } from "../lib/phases/handle_no_changes_phase.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { GitHubClient, WorkerConfig } from "../types.ts";
import { ISSUE_RUN_STATS_MARKER } from "../lib/issue_run_stats_comment.ts";

// Side-effect import: register the security-scan template so its
// title and body fingerprint are visible to the suppression check.
import {
  SECURITY_SCAN_ISSUE_TITLE,
} from "../lib/idle_task_templates/security_scan_template.ts";

interface StubGhCalls {
  addLabel: Array<{ repo: string; issueNumber: number; label: string }>;
  removeLabel: Array<{ repo: string; issueNumber: number; label: string }>;
  unassignIssue: Array<
    { repo: string; issueNumber: number; assignees: string[] }
  >;
  postComment: Array<{ repo: string; issueNumber: number; body: string }>;
  closeIssue: Array<{ repo: string; issueNumber: number; comment?: string }>;
}

function makeStubGhCalls(): StubGhCalls {
  return {
    addLabel: [],
    removeLabel: [],
    unassignIssue: [],
    postComment: [],
    closeIssue: [],
  };
}

function makeStubGhClient(calls: StubGhCalls): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub: getIssue not implemented");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: (repo, issueNumber, label) => {
      calls.addLabel.push({ repo, issueNumber, label });
      return Promise.resolve();
    },
    removeLabel: (repo, issueNumber, label) => {
      calls.removeLabel.push({ repo, issueNumber, label });
      return Promise.resolve();
    },
    postComment: (repo, issueNumber, body) => {
      calls.postComment.push({ repo, issueNumber, body });
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: (repo, issueNumber, assignees) => {
      calls.unassignIssue.push({ repo, issueNumber, assignees });
      return Promise.resolve();
    },
    closeIssue: (repo, issueNumber, comment?) => {
      calls.closeIssue.push({ repo, issueNumber, comment });
      return Promise.resolve();
    },
  };
}

function makeConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), ...overrides };
}

function makeContext(overrides?: Partial<IssueContext>): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 42,
    issueTitle: "Fix login bug",
    issueBody: "The login button on `src/auth/login.ts:45` does not work.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: makeConfig(),
    ...overrides,
  };
}

function makeState(overrides?: Partial<PhaseState>): PhaseState {
  return {
    branchName: "issue-42-fix-login-bug",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    ...overrides,
  };
}

// Long narrative output (> 100 chars after trim) — would normally
// trigger the Partial Answer branch.
const NARRATIVE = "A".repeat(200) + " Here is my analysis of the issue...";

// -------------------------------------------------------------------------
// Happy path — existing behaviour preserved
// -------------------------------------------------------------------------

Deno.test(
  "handle_no_changes_phase - regular issue posts Partial Answer and hands off to needs-human (Issue #2849)",
  async () => {
    // Behaviour change (Issue #2849): a no-code-change run on a regular
    // `work-on` issue is the analysis-only / no-PR signal. The phase now
    // posts the partial answer AND hands the issue off to `needs-human`
    // (clean hand-off via the escalation chokepoint) so it stops looping,
    // rather than just unassigning and leaving it for re-pickup. The
    // previous test asserted reason `partial_answer_posted` with a single
    // comment; it now asserts the hand-off.
    const calls = makeStubGhCalls();
    const ctx = makeContext();
    const state = makeState({ claudeOutput: NARRATIVE });
    const deps = createMockDeps({
      github: {
        createClient: () => makeStubGhClient(calls),
      },
    });

    const result = await workOnIssueHandleNoChanges(ctx, state, deps);

    assertEquals(result.status, "early_exit");
    assertEquals(
      (result as { reason: string }).reason,
      "analysis_only_handed_off",
    );
    // Two comments: the partial answer, then the needs-human explanation.
    assertEquals(calls.postComment.length, 2);
    assert(calls.postComment[0]!.body.includes("Partial Answer"));
    assert(
      calls.postComment[1]!.body.includes("Analysis-only issue"),
      "second comment is the needs-human hand-off explanation",
    );
    // needs-human label applied via the escalation chokepoint.
    assert(
      calls.addLabel.some((c) => c.label === ctx.config.needsHumanLabel),
      "needs-human label applied",
    );
    // Worker claim released exactly once.
    assertEquals(calls.unassignIssue.length, 1);
    assertEquals(calls.unassignIssue[0]!.assignees, ["testbot"]);
  },
);

// -------------------------------------------------------------------------
// Title-match skip path
// -------------------------------------------------------------------------

Deno.test(
  "handle_no_changes_phase - skips Partial Answer for security-scan wrapper by title (Issue #2098)",
  async () => {
    const calls = makeStubGhCalls();
    const ctx = makeContext({ issueTitle: SECURITY_SCAN_ISSUE_TITLE });
    const state = makeState({ claudeOutput: NARRATIVE });
    const deps = createMockDeps({
      github: {
        createClient: () => makeStubGhClient(calls),
      },
    });

    const result = await workOnIssueHandleNoChanges(ctx, state, deps);

    assertEquals(result.status, "early_exit");
    assertEquals(
      (result as { reason: string }).reason,
      "structured_output_wrapper_skipped",
    );
    // No Partial Answer comment posted
    assertEquals(calls.postComment.length, 0);
    // Worker still unassigns itself
    assertEquals(calls.unassignIssue.length, 1);
    assertEquals(calls.unassignIssue[0]!.assignees, ["testbot"]);
  },
);

// -------------------------------------------------------------------------
// Body-fingerprint skip path
// -------------------------------------------------------------------------

Deno.test(
  "handle_no_changes_phase - skips Partial Answer for security-scan wrapper by body fingerprint (Issue #2098)",
  async () => {
    const calls = makeStubGhCalls();
    const ctx = makeContext({
      // Title has been edited away from the canonical wrapper title,
      // but the body still carries the MythOS-style heading fingerprint.
      issueTitle: "An edited title that no longer matches the wrapper",
      issueBody: [
        "# MythOS-style Security Audit",
        "",
        "Please run the four-phase audit against org/repo.",
      ].join("\n"),
    });
    const state = makeState({ claudeOutput: NARRATIVE });
    const deps = createMockDeps({
      github: {
        createClient: () => makeStubGhClient(calls),
      },
    });

    const result = await workOnIssueHandleNoChanges(ctx, state, deps);

    assertEquals(result.status, "early_exit");
    assertEquals(
      (result as { reason: string }).reason,
      "structured_output_wrapper_skipped",
    );
    assertEquals(calls.postComment.length, 0);
    assertEquals(calls.unassignIssue.length, 1);
  },
);

// -------------------------------------------------------------------------
// Edge case — no structured-output template matches
// -------------------------------------------------------------------------

Deno.test(
  "handle_no_changes_phase - issue mentioning the fingerprint in prose still gets Partial Answer + hand-off (Issue #2098, #2849)",
  async () => {
    // The fingerprint is anchored to a Markdown heading at the start
    // of a line (Issue #2118). A prose mention must NOT trigger the
    // skip path — the issue still gets the partial answer, and (Issue
    // #2849) the analysis-only hand-off to needs-human.
    const calls = makeStubGhCalls();
    const ctx = makeContext({
      issueTitle: "Document the security scan workflow",
      issueBody:
        "We should explain that the prompt is the MythOS-style Security Audit doc.",
    });
    const state = makeState({ claudeOutput: NARRATIVE });
    const deps = createMockDeps({
      github: {
        createClient: () => makeStubGhClient(calls),
      },
    });

    const result = await workOnIssueHandleNoChanges(ctx, state, deps);

    assertEquals(result.status, "early_exit");
    assertEquals(
      (result as { reason: string }).reason,
      "analysis_only_handed_off",
    );
    assertEquals(calls.postComment.length, 2);
    assert(calls.postComment[0]!.body.includes("Partial Answer"));
    assert(
      calls.addLabel.some((c) => c.label === ctx.config.needsHumanLabel),
      "needs-human label applied",
    );
  },
);

// -------------------------------------------------------------------------
// Already-complete path is unchanged
// -------------------------------------------------------------------------

Deno.test(
  "handle_no_changes_phase - structured-output suppression does NOT pre-empt the already-complete close (Issue #2098)",
  async () => {
    // Even when the title matches a structured-output wrapper, an
    // explicit "already complete" signal in Claude's output should
    // still produce a close-comment — that branch precedes the
    // partial-answer suppression.
    const calls = makeStubGhCalls();
    const ctx = makeContext({ issueTitle: SECURITY_SCAN_ISSUE_TITLE });
    const state = makeState({
      claudeOutput:
        "This wrapper is already complete — nothing to scan, no findings to file.",
    });
    const deps = createMockDeps({
      github: {
        createClient: () => makeStubGhClient(calls),
      },
    });

    const result = await workOnIssueHandleNoChanges(ctx, state, deps);

    assertEquals(result.status, "early_exit");
    assertEquals((result as { reason: string }).reason, "already_complete");
    assertEquals(calls.closeIssue.length, 1);
  },
);

// -------------------------------------------------------------------------
// Secret redaction (Issue #3636)
// -------------------------------------------------------------------------

// Credentials the child process can reach and that a prompt-injected run can
// emit into its final summary — the tail of which both branches publish.
const LEAKY_TAIL = [
  "Here is the environment I was given:",
  "GH_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz",
  "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
  "remote: https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123456789@github.com/org/repo.git",
].join("\n");

/** Assert no raw credential from LEAKY_TAIL survived into `body`. */
function assertRedacted(body: string, label: string): void {
  for (
    const secret of [
      "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
      "ghs_abcdefghijklmnopqrstuvwxyz0123456789",
    ]
  ) {
    assert(
      !body.includes(secret),
      `${label} must not contain the raw credential ${secret.slice(0, 8)}…`,
    );
  }
  assert(
    body.includes(REDACTION_PLACEHOLDER),
    `${label} must contain the redaction placeholder`,
  );
}

Deno.test(
  "handle_no_changes_phase - already-complete close comment redacts secrets (Issue #3636)",
  async () => {
    const calls = makeStubGhCalls();
    const ctx = makeContext();
    const state = makeState({
      claudeOutput: `The implementation is already complete.\n\n${LEAKY_TAIL}`,
    });
    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
    });

    const result = await workOnIssueHandleNoChanges(ctx, state, deps);

    assertEquals((result as { reason: string }).reason, "already_complete");
    assertEquals(calls.closeIssue.length, 1);
    const body = calls.closeIssue[0]!.comment ?? "";
    assert(body.includes("Already Complete"));
    assertRedacted(body, "close comment");
  },
);

Deno.test(
  "handle_no_changes_phase - Partial Answer comment redacts secrets (Issue #3636)",
  async () => {
    const calls = makeStubGhCalls();
    const ctx = makeContext();
    const state = makeState({ claudeOutput: `${NARRATIVE}\n\n${LEAKY_TAIL}` });
    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
    });

    const result = await workOnIssueHandleNoChanges(ctx, state, deps);

    assertEquals(
      (result as { reason: string }).reason,
      "analysis_only_handed_off",
    );
    const body = calls.postComment[0]!.body;
    assert(body.includes("Partial Answer"));
    assertRedacted(body, "partial answer comment");
  },
);

// -------------------------------------------------------------------------
// Already-complete close posts the issue's run-stats comment (Issue #3756)
// -------------------------------------------------------------------------

Deno.test(
  "handle_no_changes_phase - already-complete close posts the run stats comment",
  async () => {
    const calls = makeStubGhCalls();
    const ctx = makeContext();
    const state = makeState({
      claudeOutput:
        "The implementation is already complete — no changes needed.",
      claudeRunStats: [{
        runStats: {
          servedModels: ["claude-opus-4-8"],
          requestedModel: "opus",
          wallClockMs: 3_000,
          tokenUsage: {
            inputTokens: 1_500,
            outputTokens: 2_500,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        },
      }],
    });
    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
    });

    const result = await workOnIssueHandleNoChanges(ctx, state, deps);

    assertEquals((result as { reason: string }).reason, "already_complete");
    assertEquals(calls.closeIssue.length, 1);
    const stats = calls.postComment.find((c) =>
      c.body.includes(ISSUE_RUN_STATS_MARKER)
    );
    assert(stats, "expected a run-stats comment on the closed issue");
    assert(stats.body.includes("## Issue run model stats"));
    assert(stats.body.includes("Estimate only"));
  },
);

Deno.test(
  "handle_no_changes_phase - already-complete close posts no stats when Claude produced none",
  async () => {
    const calls = makeStubGhCalls();
    const ctx = makeContext();
    const state = makeState({
      claudeOutput: "No changes needed — this was already fixed.",
    });
    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
    });

    await workOnIssueHandleNoChanges(ctx, state, deps);

    assertEquals(calls.closeIssue.length, 1);
    assertEquals(
      calls.postComment.filter((c) => c.body.includes(ISSUE_RUN_STATS_MARKER))
        .length,
      0,
    );
  },
);

Deno.test(
  "handle_no_changes_phase - a mid-run usage limit is named as such, not 'no useful output' (Issue #4315)",
  async () => {
    const calls = makeStubGhCalls();
    const ctx = makeContext();
    const state = makeState({
      claudeOutput: "You've hit your weekly limit · resets 1am (UTC)",
    });
    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
    });

    const result = await workOnIssueHandleNoChanges(ctx, state, deps);

    assertEquals(result.status, "failure");
    assert(result.status === "failure");
    assertStringIncludes(result.reason, "usage limit");
    assert(!result.reason.includes("no useful output"), result.reason);
    // The issue is not closed or handed off — it is not the issue's fault.
    assertEquals(calls.closeIssue.length, 0);
  },
);

// -------------------------------------------------------------------------
// Issue #108 — a truncated/interrupted run is retried, not handed off
// -------------------------------------------------------------------------

// The exact shape seen on GRQ#4138: the run's only output is a "still
// working / I'll pick up" status line because it was blocked on a slow first
// quality-gate pass. Over 100 chars, so under the old ordering it reached the
// analysis-only branch and was escalated to needs-human.
const INTERRUPTED_OUTPUT =
  "Quality gate is still running (it re-clones sibling repos on a >24h " +
  "cache miss, so the first run is slow). I'll pick up as soon as it finishes.";

Deno.test(
  "handle_no_changes_phase - an interrupted run is a retryable failure, not analysis-only (Issue #108)",
  async () => {
    const calls = makeStubGhCalls();
    const ctx = makeContext();
    const state = makeState({ claudeOutput: INTERRUPTED_OUTPUT });
    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
    });

    const result = await workOnIssueHandleNoChanges(ctx, state, deps);

    // Retryable failure — NOT the analysis-only early_exit.
    assertEquals(result.status, "failure");
    assertStringIncludes(
      (result as { reason: string }).reason,
      "interrupted before completing",
    );
    // No Partial Answer, no needs-human hand-off, no claim release.
    assertEquals(calls.postComment.length, 0);
    assert(
      !calls.addLabel.some((c) => c.label === ctx.config.needsHumanLabel),
      "must NOT apply needs-human for an interrupted run",
    );
    assertEquals(calls.unassignIssue.length, 0);
  },
);

Deno.test(
  "handle_no_changes_phase - a usage limit that left >100 chars is infrastructure, not analysis-only (Issue #108)",
  async () => {
    // Regression for the ordering bug: a mid-run usage limit whose message is
    // over 100 chars previously reached the analysis-only branch below.
    const calls = makeStubGhCalls();
    const ctx = makeContext();
    const state = makeState({
      claudeOutput: "A".repeat(150) +
        "\nClaude AI usage limit reached. Your limit will reset at 3pm.",
    });
    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
    });

    const result = await workOnIssueHandleNoChanges(ctx, state, deps);

    assertEquals(result.status, "failure");
    assertStringIncludes(
      (result as { reason: string }).reason,
      "usage limit",
    );
    assert(
      !calls.addLabel.some((c) => c.label === ctx.config.needsHumanLabel),
      "must NOT apply needs-human for a usage-limit run",
    );
  },
);
