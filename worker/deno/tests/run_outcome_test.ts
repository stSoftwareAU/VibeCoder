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
