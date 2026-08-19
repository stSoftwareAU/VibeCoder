/**
 * Tests for `lib/analysis_only_handoff.ts` (Issue #2849).
 *
 * Covers marker detection and the clean hand-off through the
 * `escalateToHuman` chokepoint plus claim release.
 *
 * Uses Australian English throughout.
 */

import { captureReleaseOutcomes } from "./fixtures/release_outcome_capture.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  ANALYSIS_ONLY_MARKER,
  buildAnalysisOnlyDedupKey,
  buildAnalysisOnlyNextStep,
  buildAnalysisOnlyReason,
  handOffAnalysisOnly,
  hasAnalysisOnlyMarker,
} from "../lib/analysis_only_handoff.ts";
import type {
  EscalateToHumanOptions,
  EscalateToHumanOutcome,
} from "../lib/needs_human_escalation.ts";
import type { GitHubClient, Logger, Result } from "../types.ts";

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  skipReason: () => {},
  timing: () => {},
  scanSummary: () => {},
  workerSummary: () => {},
};

/** Minimal GitHubClient stub — only the methods the hand-off touches. */
function makeStubClient(
  unassignCalls: Array<
    { repo: string; issueNumber: number; assignees: string[] }
  >,
): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub: getIssue not implemented");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: (repo, issueNumber, assignees) => {
      unassignCalls.push({ repo, issueNumber, assignees });
      return Promise.resolve();
    },
    closeIssue: () => Promise.resolve(),
  };
}

// -------------------------------------------------------------------------
// Marker detection
// -------------------------------------------------------------------------

Deno.test("hasAnalysisOnlyMarker - detects the canonical marker", () => {
  assert(
    hasAnalysisOnlyMarker(`Some intro.\n\n${ANALYSIS_ONLY_MARKER}\n\nMore.`),
  );
});

Deno.test("hasAnalysisOnlyMarker - tolerant of whitespace and case", () => {
  assert(hasAnalysisOnlyMarker("<!--analysis-only-->"));
  assert(hasAnalysisOnlyMarker("<!--   Analysis-Only   -->"));
});

Deno.test("hasAnalysisOnlyMarker - false when absent", () => {
  assertEquals(hasAnalysisOnlyMarker("A normal issue body."), false);
  assertEquals(hasAnalysisOnlyMarker(""), false);
  assertEquals(hasAnalysisOnlyMarker(undefined), false);
  assertEquals(hasAnalysisOnlyMarker(null), false);
  // A prose mention of the words must NOT trigger it.
  assertEquals(
    hasAnalysisOnlyMarker("This is an analysis-only task, no code needed."),
    false,
  );
});

// -------------------------------------------------------------------------
// Reason / next-step copy
// -------------------------------------------------------------------------

Deno.test("buildAnalysisOnlyReason - distinct per trigger, both mention no PR", () => {
  const marker = buildAnalysisOnlyReason("marker");
  const noChanges = buildAnalysisOnlyReason("no_changes");
  assert(marker !== noChanges);
  assertStringIncludes(marker, "analysis-only");
  assertStringIncludes(noChanges, "no code changes");
});

Deno.test("buildAnalysisOnlyNextStep - guides to planning and warns about label stripping", () => {
  const step = buildAnalysisOnlyNextStep();
  assertStringIncludes(step, "planning");
  assertStringIncludes(step, "needs-human");
});

Deno.test("buildAnalysisOnlyDedupKey - stable per issue", () => {
  assertEquals(buildAnalysisOnlyDedupKey(2834), "work-on-analysis-only-2834");
});

// -------------------------------------------------------------------------
// handOffAnalysisOnly — escalation + claim release
// -------------------------------------------------------------------------

Deno.test("handOffAnalysisOnly - escalates to needs-human and releases the claim", async () => {
  const unassignCalls: Array<
    { repo: string; issueNumber: number; assignees: string[] }
  > = [];
  const ghClient = makeStubClient(unassignCalls);
  const escalateCalls: EscalateToHumanOptions[] = [];

  const escalate = (
    options: EscalateToHumanOptions,
  ): Promise<Result<EscalateToHumanOutcome>> => {
    escalateCalls.push(options);
    return Promise.resolve({
      ok: true,
      value: { commentPosted: true, labelAdded: true, dedupSkipped: false },
    });
  };

  const capture = captureReleaseOutcomes();
  const handedOff = await handOffAnalysisOnly({
    ghClient,
    repo: "org/repo",
    issueNumber: 2834,
    needsHumanLabel: "needs-human",
    githubUser: "testbot",
    trigger: "no_changes",
    logger: silentLogger,
    deps: { escalate },
  });
  capture.restore();
  // The hand-off releases with a deliberate no-PR outcome (Issue #4330).
  const handOffOutcome = capture.hooked.at(-1)?.outcome;
  assertEquals(handOffOutcome?.kind, "no_pr_expected");
  if (handOffOutcome?.kind === "no_pr_expected") {
    assertEquals(
      handOffOutcome.summary.includes("handed off to a human"),
      true,
    );
  }

  assertEquals(handedOff, true);
  // Escalation called with the needs-human label and a stable dedup key.
  assertEquals(escalateCalls.length, 1);
  assertEquals(escalateCalls[0]!.needsHumanLabel, "needs-human");
  assertEquals(escalateCalls[0]!.target, { kind: "issue", number: 2834 });
  assertEquals(escalateCalls[0]!.dedupKey, "work-on-analysis-only-2834");
  // Claim released exactly once.
  assertEquals(unassignCalls.length, 1);
  assertEquals(unassignCalls[0]!.assignees, ["testbot"]);
});

Deno.test("handOffAnalysisOnly - still releases the claim when escalation fails", async () => {
  const unassignCalls: Array<
    { repo: string; issueNumber: number; assignees: string[] }
  > = [];
  const ghClient = makeStubClient(unassignCalls);

  const escalate = (): Promise<Result<EscalateToHumanOutcome>> =>
    Promise.resolve({ ok: false, error: new Error("boom") });

  const handedOff = await handOffAnalysisOnly({
    ghClient,
    repo: "org/repo",
    issueNumber: 7,
    needsHumanLabel: "needs-human",
    githubUser: "testbot",
    trigger: "marker",
    logger: silentLogger,
    deps: { escalate },
  });

  // Hand-off reports failure, but the claim is still released (Issue #2731).
  assertEquals(handedOff, false);
  assertEquals(unassignCalls.length, 1);
});

Deno.test("handOffAnalysisOnly - dedup-skipped counts as handed off", async () => {
  const unassignCalls: Array<
    { repo: string; issueNumber: number; assignees: string[] }
  > = [];
  const ghClient = makeStubClient(unassignCalls);

  const escalate = (): Promise<Result<EscalateToHumanOutcome>> =>
    Promise.resolve({
      ok: true,
      value: { commentPosted: false, labelAdded: true, dedupSkipped: true },
    });

  const handedOff = await handOffAnalysisOnly({
    ghClient,
    repo: "org/repo",
    issueNumber: 9,
    needsHumanLabel: "needs-human",
    githubUser: "testbot",
    trigger: "no_changes",
    logger: silentLogger,
    deps: { escalate },
  });

  assertEquals(handedOff, true);
  assertEquals(unassignCalls.length, 1);
});

Deno.test("handOffAnalysisOnly - escalation throw is swallowed, claim still released", async () => {
  const unassignCalls: Array<
    { repo: string; issueNumber: number; assignees: string[] }
  > = [];
  const ghClient = makeStubClient(unassignCalls);

  const escalate = (): Promise<Result<EscalateToHumanOutcome>> => {
    throw new Error("network down");
  };

  const handedOff = await handOffAnalysisOnly({
    ghClient,
    repo: "org/repo",
    issueNumber: 11,
    needsHumanLabel: "needs-human",
    githubUser: "testbot",
    trigger: "no_changes",
    logger: silentLogger,
    deps: { escalate },
  });

  assertEquals(handedOff, false);
  assertEquals(unassignCalls.length, 1);
});
