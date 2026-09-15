/**
 * Tests for the run outcome carried to the claim-release site (Issue #4325,
 * part of #4291).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  deriveRunOutcome,
  describeRunOutcome,
  prBlockedAfterRaiseOutcome,
  prDeferredOutcome,
  prNumberFromUrl,
  summaryIncompleteOutcome,
} from "../lib/run_outcome.ts";
import { detectFailureCategory } from "../lib/failure_diagnosis.ts";
import {
  _setRenderReleasedBody,
  describeAttemptOutcome,
  type HeartbeatBodyFields,
  releaseClaim,
  renderHeartbeatBody,
  renderRunOutcomeClause,
  seedMarkerState,
} from "../lib/heartbeat_storage.ts";
import { resumeStateSurvivesRelease } from "../lib/resume_state_store.ts";

Deno.test("run outcome - a success that raised a PR → kind pr with the real URL and number (Issue #4325)", () => {
  const outcome = deriveRunOutcome({
    success: true,
    phase: "completion",
    reason: "Issue processed successfully",
    timings: { setup: 3, execute: 120, completion: 4 },
    prUrl: "https://github.com/stSoftwareAU/VibeCoder/pull/4277",
    prNumber: 4277,
  });
  assertEquals(outcome, {
    kind: "pr",
    prUrl: "https://github.com/stSoftwareAU/VibeCoder/pull/4277",
    prNumber: 4277,
  });
  // Number derived from the URL when the caller did not supply it.
  const derived = deriveRunOutcome({
    success: true,
    phase: "completion",
    reason: "ok",
    prUrl: "https://github.com/o/r/pull/12",
  });
  assert(derived.kind === "pr" && derived.prNumber === 12);
  assertEquals(prNumberFromUrl("https://github.com/o/r/pull/99"), 99);
  assertEquals(prNumberFromUrl("nope"), 0);
});

Deno.test("run outcome - a timeout failure → kind no_pr with category timeout, the dying phase and non-zero elapsed; category comes from detectFailureCategory (Issue #4325)", () => {
  const reason =
    "Claude timed out after 3600s (execute phase) — no PR was raised";
  const outcome = deriveRunOutcome({
    success: false,
    phase: "execute",
    reason,
    timings: { setup: 2.4, execute: 3600.2 },
  });
  assert(outcome.kind === "no_pr");
  assertEquals(outcome.category, "timeout");
  assertEquals(outcome.category, detectFailureCategory(reason));
  assertEquals(outcome.phase, "execute");
  assertEquals(outcome.elapsedSeconds, 3603);
  assert(outcome.elapsedSeconds > 0);
  assertEquals(outcome.message, reason);
});

Deno.test("run outcome - explicit elapsedSeconds wins over the timings sum; a killed run classifies killed (Issue #4325)", () => {
  const reason =
    "Claude was killed (SIGKILL) after 539s — no watchdog fired, possible VM OOM";
  const outcome = deriveRunOutcome({
    success: false,
    phase: "execute",
    reason,
    timings: { execute: 539 },
    elapsedSeconds: 545.6,
  });
  assert(outcome.kind === "no_pr");
  assertEquals(outcome.elapsedSeconds, 546);
  assertEquals(outcome.category, detectFailureCategory(reason));
});

Deno.test("run outcome - a success with no PR (no-changes hand-off, merged-PR pre-check) → no_pr_expected, never a failure (Issue #4325)", () => {
  const handled = deriveRunOutcome({
    success: true,
    phase: "handle_no_changes",
    reason: "no_changes_handled",
    timings: {},
  });
  assertEquals(handled, {
    kind: "no_pr_expected",
    phase: "handle_no_changes",
    summary: "no_changes_handled",
  });
  const precheck = deriveRunOutcome({
    success: true,
    phase: "merged_pr_precheck",
    reason: "merged PR #12 already resolves this issue",
  });
  assertEquals(precheck.kind, "no_pr_expected");
});

Deno.test("run outcome - describeRunOutcome names the kind for the release log line (Issue #4325)", () => {
  assertEquals(describeRunOutcome(undefined), "none");
  assertEquals(
    describeRunOutcome({ kind: "pr", prUrl: "u", prNumber: 5 }),
    "pr:#5",
  );
  assertEquals(
    describeRunOutcome({
      kind: "no_pr",
      category: "timeout",
      phase: "execute",
      elapsedSeconds: 1,
      message: "m",
    }),
    "no_pr:timeout:execute",
  );
  assertEquals(
    describeRunOutcome({ kind: "no_pr_expected", phase: "p", summary: "s" }),
    "no_pr_expected:p",
  );
});

// ---------------------------------------------------------------------------
// The outcome reaches the render site
// ---------------------------------------------------------------------------

async function seededDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "run-outcome-release-" });
  await seedMarkerState(dir, "org/repo", 42, {
    commentId: 9001,
    lastRefresh: 1_700_000_000,
  });
  return dir;
}

Deno.test("run outcome - releaseClaim({ outcome }) delivers the outcome object to the release render (Issue #4325)", async () => {
  const dir = await seededDir();
  const seen: HeartbeatBodyFields[] = [];
  const restore = _setRenderReleasedBody((fields, nowFn) => {
    seen.push(fields);
    return renderHeartbeatBody(fields, nowFn);
  });
  try {
    const patched: string[] = [];
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "api" && args.includes("-X")) {
        patched.push(args.join(" "));
      }
      return Promise.resolve("");
    };
    const outcome = {
      kind: "pr" as const,
      prUrl: "https://github.com/org/repo/pull/7",
      prNumber: 7,
    };
    const result = await releaseClaim(dir, "org/repo", 42, {
      githubUser: "vibe-bot",
      ghFn,
      markerOptions: { machineId: "host-A:1", ghFn },
      outcome,
    });
    assert(result.ok && result.value.heartbeatCleared);
    assertEquals(seen.length, 1, "exactly one release render");
    assertEquals(seen[0]!.released, true);
    assertEquals(seen[0]!.outcome, outcome);
    assert(patched.length >= 1, "the marker comment was PATCHed");
  } finally {
    restore();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run outcome - releaseClaim without an outcome renders with no outcome field and a byte-identical body to today (Issue #4325)", async () => {
  const dir = await seededDir();
  const seen: HeartbeatBodyFields[] = [];
  const bodies: string[] = [];
  const nowFn = () => 1_700_000_100;
  const restore = _setRenderReleasedBody((fields, _now) => {
    seen.push(fields);
    const body = renderHeartbeatBody(fields, nowFn);
    bodies.push(body);
    return body;
  });
  try {
    const ghFn = (_args: string[]): Promise<string> => Promise.resolve("");
    await releaseClaim(dir, "org/repo", 42, {
      githubUser: "vibe-bot",
      ghFn,
      markerOptions: { machineId: "host-A:1", ghFn },
    });
    assertEquals(seen.length, 1);
    assertEquals(seen[0]!.outcome, undefined, "skip/omitted → no outcome");
    // Today's exact released text.
    assertEquals(
      bodies[0],
      renderHeartbeatBody({
        machineId: "host-A:1",
        epoch: 0,
        released: true,
        milestones: [],
      }, nowFn),
    );
    assert(
      /^<!-- VIBE_CODER_HEARTBEAT:host-A:1:0 --> <!-- cleared: claim released by machine host-A:1 -->\n\n✅ \*\*Vibe Coder released this claim\*\* — host `host-A:1`, finished \d\d:\d\d UTC\.$/
        .test(bodies[0]!),
      bodies[0],
    );
  } finally {
    restore();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run outcome - summaryIncompleteOutcome names the PR and the rule, and is not a failure (Issue #1140)", () => {
  const outcome = summaryIncompleteOutcome({
    phase: "completion",
    prUrl: "https://github.com/stSoftwareAU/VibeCoder/pull/1107",
    prNumber: 1107,
    problem:
      "Independent Spec/Standards review not reported in the PR summary: " +
      "`unrequested` entry names no `reviewer:` verdict",
  });
  assertEquals(outcome.kind, "summary_incomplete");
  assertEquals(describeRunOutcome(outcome), "summary_incomplete:pr#1107");
  // Not a failure shape: nothing here feeds the failure streak or the
  // auto-filed run-failure issue, both of which key off `kind: "no_pr"`.
  assert(!("category" in outcome), "carries no failure category");
  assertEquals(resumeStateSurvivesRelease(outcome), false);
});

Deno.test("run outcome - the release comment states the PR and the shortfall (Issue #1140)", () => {
  const clause = renderRunOutcomeClause({
    kind: "summary_incomplete",
    phase: "completion",
    prUrl: "https://github.com/stSoftwareAU/VibeCoder/pull/1126",
    prNumber: 1126,
    problem: "the PR summary carries no `## Acceptance Criteria` heading",
  });
  assertStringIncludes(clause, "Raised #1126");
  assertStringIncludes(clause, "pull/1126");
  assertStringIncludes(clause, "The PR summary is incomplete");
  assertStringIncludes(clause, "## Acceptance Criteria");
});

Deno.test("run outcome - the attempt tally distinguishes a delivered run from a failed one (Issue #1140)", () => {
  assertEquals(
    describeAttemptOutcome({
      kind: "summary_incomplete",
      phase: "completion",
      prUrl: "https://github.com/stSoftwareAU/VibeCoder/pull/1133",
      prNumber: 1133,
      problem: "reproduction status not recorded",
    }),
    "raised #1133, summary incomplete",
  );
  assertEquals(
    describeAttemptOutcome({
      kind: "no_pr",
      category: detectFailureCategory("Git push failed"),
      phase: "completion",
      elapsedSeconds: 12,
      message: "Git push failed",
    }),
    "no PR (`infrastructure-error`, phase `completion`)",
  );
});

Deno.test("run outcome - a deferred PR is its own kind, never a failure (Issue #1951)", () => {
  const outcome = prDeferredOutcome({
    phase: "completion",
    branch: "issue-1951-secondary-limit",
    base: "main",
    reason: "secondary rate limit",
  });
  assertEquals(outcome.kind, "pr_deferred");
  assertEquals(
    describeRunOutcome(outcome),
    "pr_deferred:issue-1951-secondary-limit",
  );
});

Deno.test("run outcome - a deferred PR keeps its resume state for the next claim (Issue #1951)", () => {
  assertEquals(
    resumeStateSurvivesRelease(prDeferredOutcome({
      phase: "completion",
      branch: "issue-1951-secondary-limit",
      base: "main",
      reason: "secondary rate limit",
    })),
    true,
  );
});

// ---------------------------------------------------------------------------
// A PR-then-later-step failure (Issue #2044)
// ---------------------------------------------------------------------------

const BLOCK_REASON =
  "Workflow files changed by this run did not pass the GitHub Actions file " +
  "checks, so PR #2100 cannot merge until the finding below is fixed on it.";

Deno.test("run outcome - a failed run that already had a PR keeps the PR and names the block (Issue #2044)", () => {
  const outcome = deriveRunOutcome({
    success: false,
    phase: "completion",
    reason: BLOCK_REASON,
    prUrl: "https://github.com/stSoftwareAU/VibeCoder/pull/2100",
    prNumber: 2100,
    elapsedSeconds: 900,
  });

  assertEquals(outcome.kind, "pr");
  assert(outcome.kind === "pr", "narrowing");
  assertEquals(outcome.prNumber, 2100);
  // The category is diagnosed by the single diagnosis path, never `unknown`
  // for a gate the worker itself applied.
  assertEquals(outcome.blocked?.category, "workflow_gate");
  assertEquals(outcome.blocked?.phase, "completion");
  assertEquals(describeRunOutcome(outcome), "pr:#2100:blocked:workflow_gate");
});

Deno.test("run outcome - a delivered run carries no block and reads exactly as before (Issue #2044)", () => {
  const outcome = deriveRunOutcome({
    success: true,
    phase: "completion",
    reason: "Issue processed successfully",
    prUrl: "https://github.com/stSoftwareAU/VibeCoder/pull/2101",
    prNumber: 2101,
  });

  assert(outcome.kind === "pr", "narrowing");
  assertEquals(outcome.blocked, undefined);
  assertEquals(describeRunOutcome(outcome), "pr:#2101");
});

Deno.test("run outcome - the release comment states both the PR and the block (Issue #2044)", () => {
  const outcome = prBlockedAfterRaiseOutcome({
    phase: "completion",
    prUrl: "https://github.com/stSoftwareAU/VibeCoder/pull/2100",
    prNumber: 2100,
    reason: BLOCK_REASON,
  });

  const clause = renderRunOutcomeClause(outcome);
  assertStringIncludes(clause, "Raised #2100");
  assertStringIncludes(clause, "pull/2100");
  assertStringIncludes(clause, "then blocked in phase `completion`");
  assertStringIncludes(clause, "workflow-gate");
  assertStringIncludes(clause, "the work is not lost");

  // And the tally says the same in one line.
  assertEquals(
    describeAttemptOutcome(outcome),
    "raised #2100, blocked (`workflow-gate`)",
  );
});
