/**
 * In-run recovery from a PR-summary rule block (Issue #2189).
 *
 * A summary-rule block with no PR used to end the run: the branch was pushed
 * and quality-gated, and the next whole agent session existed only to add a
 * documentation block to it. A quarter of this host's runs that reached
 * completion ended that way. These tests drive the LIVE completion phase and
 * assert on the observable outcome — how many agent invocations the block
 * caused, what their prompt carried, whether `gh pr create` ran, and what the
 * issue thread was told.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  detectFailureCategory,
  SUMMARY_RULE_GATE_MARKER,
} from "../lib/failure_diagnosis.ts";

import {
  BUG_SUMMARY_WITH_REPRODUCTION,
  BUG_SUMMARY_WITHOUT_REPRODUCTION,
  ISSUE,
  ISSUE_WITHOUT_CRITERIA,
  REPO,
  runCompletion,
  SUMMARY_WITH_BLOCK,
  SUMMARY_WITHOUT_BLOCK,
} from "./support/completion_summary_harness.ts";

Deno.test(
  "completion - a first summary-rule block re-invokes the agent once and the PR is raised",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_BLOCK,
      retryWrites: SUMMARY_WITH_BLOCK,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(outcome.qualityGateRuns, 1, "the quality gate re-runs");
    assertEquals(outcome.prCreateCalls, 1, "the recovered run raises its PR");
  },
);

Deno.test(
  "completion - the recovery prompt carries the gate's own remediation comment",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_BLOCK,
      retryWrites: SUMMARY_WITH_BLOCK,
    });

    assertEquals(outcome.claudePrompts.length, 1);
    const prompt = outcome.claudePrompts[0]!;
    assertStringIncludes(prompt, "PR-SUMMARY GATE RETRY NOTICE");
    assertStringIncludes(prompt, "Acceptance-criteria closure missing");
    assertStringIncludes(prompt, `${REPO}#${ISSUE}`);
    assertStringIncludes(
      prompt,
      `docs/archive/pr-summaries/pr-summary-${ISSUE}.md`,
    );
    // The comment is on the thread as well, so the shortfall is not only in
    // this host's log.
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "Acceptance-criteria closure");
  },
);

Deno.test(
  "completion - a second block in the same run ends the run with one comment",
  async () => {
    const outcome = await runCompletion({ summary: SUMMARY_WITHOUT_BLOCK });

    assertEquals(outcome.status, "failure");
    // One recovery invocation, then the two bounded closure-verdict questions
    // the worker asks when the recovery's own summary still fails the gate
    // (Issue #2242). The recovery itself is still entered exactly once.
    assertEquals(
      outcome.claudePrompts.filter((p) => p.includes("RETRY NOTICE")).length,
      1,
      "the recovery is not repeated",
    );
    assertEquals(outcome.claudeCalls, 3, "recovery plus two verdict questions");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "Acceptance criteria");
    assertEquals(
      outcome.comments.length,
      1,
      "the same verdict is not posted twice",
    );
  },
);

Deno.test(
  "completion - a recovery invocation that cannot be launched leaves the block standing",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_BLOCK,
      retryInvocationFails: true,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.claudeCalls, 1, "launched once, no second attempt");
    assertEquals(outcome.qualityGateRuns, 0, "nothing changed to re-gate");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(outcome.reason ?? "", "Acceptance criteria");
    assertEquals(outcome.comments.length, 1);
  },
);

Deno.test(
  "completion - the reproduction gate recovers on the same path",
  async () => {
    const outcome = await runCompletion({
      summary: BUG_SUMMARY_WITHOUT_REPRODUCTION,
      retryWrites: BUG_SUMMARY_WITH_REPRODUCTION,
      issueBody: "## Problem\n\nThe gate ends the run.\n",
      labels: ["bug", "work-on"],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1);
    assertEquals(outcome.prCreateCalls, 1);
    assertStringIncludes(
      outcome.claudePrompts[0]!,
      "Reproduction status missing",
    );
  },
);

Deno.test(
  "completion - a summary missing both the closure block and the Docs sweep line is asked for both in the one recovery turn (Issue #3085 review)",
  async () => {
    // SUMMARY_WITHOUT_BLOCK has no closure block AND no `Docs sweep` line.
    // The closure gate runs first and used to consume the run's only
    // recovery turn on its own notice, never mentioning the sweep — the
    // re-run then blocked at the docs-sweep gate as a second, unrecovered
    // block. The single retry prompt must now carry both notices.
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_BLOCK,
      retryWrites: SUMMARY_WITH_BLOCK,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(
      outcome.prCreateCalls,
      1,
      "the PR is raised once both are fixed",
    );
    assertStringIncludes(
      outcome.claudePrompts[0]!,
      "Acceptance-criteria closure",
    );
    assertStringIncludes(outcome.claudePrompts[0]!, "Docs sweep");
  },
);

/** Closure is valid; the Standards heading and the Docs sweep line are absent. */
const SUMMARY_CLOSURE_WITHOUT_STANDARDS = `## Summary

Recovered in-run. Closes #${ISSUE}.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — the first block launches one recovery invocation — evidence: \`worker/deno/lib/summary_rule_gate_retry.ts\` — reviewer: met
- **met** — a second block in the same run fails as today — evidence: \`worker/deno/tests/completion_phase_summary_rule_retry_test.ts\` — reviewer: met

## Test Plan

- \`worker/deno/tests/completion_phase_summary_rule_retry_test.ts\`
`;

Deno.test(
  "completion - a bug summary missing both the reproduction block and the Docs sweep line is asked for both in the one recovery turn (Issue #3085 review)",
  async () => {
    // No acceptance criteria, so the closure and independent-review gates
    // do not run. The reproduction gate is the one that blocks, and it must
    // fold the docs-sweep notice into that same turn.
    const outcome = await runCompletion({
      summary: BUG_SUMMARY_WITHOUT_REPRODUCTION,
      retryWrites: BUG_SUMMARY_WITH_REPRODUCTION,
      issueBody: "## Problem\n\nThe gate ends the run.\n",
      labels: ["bug", "work-on"],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(
      outcome.prCreateCalls,
      1,
      "the PR is raised once both are fixed",
    );
    assertStringIncludes(
      outcome.claudePrompts[0]!,
      "Reproduction status missing",
    );
    assertStringIncludes(outcome.claudePrompts[0]!, "Docs sweep");
  },
);

Deno.test(
  "completion - a summary with a valid closure but no Standards Review and no Docs sweep line is asked for both in the one recovery turn (Issue #3085 review)",
  async () => {
    // Closure passes, so the independent-review gate is the one that blocks.
    // Dropping the fold at that call site would leave "Docs sweep" out of
    // the only recovery prompt.
    const outcome = await runCompletion({
      summary: SUMMARY_CLOSURE_WITHOUT_STANDARDS,
      retryWrites: SUMMARY_WITH_BLOCK,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(
      outcome.prCreateCalls,
      1,
      "the PR is raised once both are fixed",
    );
    assertStringIncludes(
      outcome.claudePrompts[0]!,
      "Independent review missing",
    );
    assertStringIncludes(outcome.claudePrompts[0]!, "Docs sweep");
  },
);

Deno.test(
  "completion - a first block on a run whose agent already raised its PR gets the one recovery turn before the PR is finalised (Issue #3163)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_BLOCK,
      retryWrites: SUMMARY_WITH_BLOCK,
      prExistsForBranch: true,
    });

    // The run's first block gets the same in-run recovery turn a no-PR run
    // gets, instead of finalising the agent's own PR straight off that first
    // block with the gate's shortfall unrepaired.
    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(outcome.qualityGateRuns, 1, "the quality gate re-runs");
    assertEquals(
      outcome.prCreateCalls,
      0,
      "the existing PR is updated, not recreated",
    );
  },
);

Deno.test(
  "completion - an existing PR with no fix from the recovery is finalised as summary_incomplete",
  async () => {
    // An issue with no acceptance criteria (Issue #4146: unmet criteria
    // never take this path), blocked by the reproduction gate alone.
    const outcome = await runCompletion({
      summary: BUG_SUMMARY_WITHOUT_REPRODUCTION,
      labels: ["bug", "work-on"],
      issueBody: ISSUE_WITHOUT_CRITERIA,
      prExistsForBranch: true,
    });

    // The recovery turn ran once and the retried summary still fails the
    // gate, so the second block takes the existing-PR path: the PR is
    // finalised and the run reports the shortfall against it.
    assertEquals(outcome.status, "early_exit");
    assertEquals(
      outcome.claudePrompts.filter((p) => p.includes("RETRY NOTICE")).length,
      1,
      "the recovery is entered exactly once",
    );
    assertEquals(outcome.prCreateCalls, 0, "the existing PR is not recreated");
  },
);

Deno.test(
  "completion - a recovery invocation that cannot be launched over an existing PR still finalises it (Issue #1140)",
  async () => {
    const outcome = await runCompletion({
      summary: BUG_SUMMARY_WITHOUT_REPRODUCTION,
      labels: ["bug", "work-on"],
      issueBody: ISSUE_WITHOUT_CRITERIA,
      prExistsForBranch: true,
      retryInvocationFails: true,
    });

    // A bare failure here would release a PR the agent had already raised
    // back into the claimable pool — the regression Issue #1140 exists to
    // stop. The run instead re-runs completion, whose existing-PR path
    // finalises the PR as `summary_incomplete`.
    assertEquals(outcome.status, "early_exit");
    assertEquals(outcome.claudeCalls, 1, "launched once, no second attempt");
    assertEquals(outcome.qualityGateRuns, 0, "nothing changed to re-gate");
    assertEquals(outcome.comments.length, 1);
  },
);

/**
 * Issue #3431: the summary's Standards Review quotes a Rust `AppError::X`
 * path in a `violation` finding. The gate's refusal quotes it back.
 */
const SUMMARY_WITH_QUOTED_RUST_PATH = SUMMARY_WITH_BLOCK.replace(
  "- **clean** — Australian English, TDD, fail-loud error handling",
  "- **violation** — Tests: no test triggers AppError::EvaluationSummaryUnavailable in evaluate — evidence: `crates/app/src/handler.rs:602-626` — reason: not fixed.",
);

Deno.test(
  "completion - a no-PR summary-rule block carries the gate marker, so it is summary_incomplete not a crash (Issue #3431)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_QUOTED_RUST_PATH,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "no PR was raised");
    const reason = outcome.reason ?? "";
    assertStringIncludes(reason, SUMMARY_RULE_GATE_MARKER);
    assertStringIncludes(reason, "AppError::EvaluationSummaryUnavailable");
    assertEquals(detectFailureCategory(reason), "summary_incomplete");
  },
);

/** A Standards `violation` on a line this branch adds, with the given reason. */
function summaryWithViolation(reason: string): string {
  return SUMMARY_WITH_BLOCK.replace(
    "- **clean** — Australian English, TDD, fail-loud error handling",
    "- **violation** — American spelling in the new code — evidence: " +
      `\`worker/deno/lib/run_outcome.ts:12\` — reason: ${reason}`,
  );
}

/** A unified=0 diff whose added lines are 10-15 of run_outcome.ts. */
const DIFF_ADDS_LINES_10_TO_15 =
  `diff --git a/worker/deno/lib/run_outcome.ts b/worker/deno/lib/run_outcome.ts
--- a/worker/deno/lib/run_outcome.ts
+++ b/worker/deno/lib/run_outcome.ts
@@ -9,0 +10,6 @@
+a
+b
+c
+d
+e
+f
`;

Deno.test(
  "completion - an own-line standing violation reaches the recovery prompt as a CODE FIX item (Issue #3382)",
  async () => {
    const outcome = await runCompletion({
      summary: summaryWithViolation("not fixed"),
      diffUnified0: DIFF_ADDS_LINES_10_TO_15,
    });

    const prompt = outcome.claudePrompts[0] ?? "";
    assertStringIncludes(prompt, "CODE FIX 1 of 1");
    assertStringIncludes(prompt, "MAY change code");
    assertStringIncludes(prompt, "worker/deno/lib/run_outcome.ts:12");
  },
);

Deno.test(
  "completion - a violation marked fixed in this diff yields no CODE FIX item and no recovery (Issue #3382)",
  async () => {
    const outcome = await runCompletion({
      summary: summaryWithViolation("fixed in this diff"),
      diffUnified0: DIFF_ADDS_LINES_10_TO_15,
    });

    assertEquals(outcome.claudePrompts.length, 0);
    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
  },
);

Deno.test("completion skips summary recovery when the exact work merges during gate checks (Issue #3977)", async () => {
  const result = await runCompletion({
    summary: SUMMARY_WITHOUT_BLOCK,
    landedDuringGate: true,
  });
  assertEquals(result.status, "early_exit");
  assertEquals(result.claudeCalls, 0);
  assertEquals(result.qualityGateRuns, 0);
  assertEquals(result.prCreateCalls, 0);
});
