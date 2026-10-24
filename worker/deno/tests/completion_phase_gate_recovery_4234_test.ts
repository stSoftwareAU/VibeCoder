/**
 * The bounded summary-gate recovery loop (Issue #4234).
 *
 * Every PR-summary gate's block now earns a recovery turn, up to
 * `OPERATIONAL_DEFAULTS.summaryGateRecoveryTurns` turns, for as long as the
 * blocking-finding count keeps strictly falling. These tests drive the LIVE
 * `workOnIssueCompletion` through the shared harness and assert on what the
 * run did: how many turns it spent, what the turn's prompt carried, whether
 * the PR was raised or finalised, what the fleet telemetry counted, and how
 * the pre-PR verifier's findings converged on a retry.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildPrePrVerifierGateComment,
  PRE_PR_VERIFIER_COMMENT_HEADING,
  type PrePrVerifierResult,
  type ReviewFinding,
} from "../lib/pre_pr_verifier.ts";
import {
  findingToEarlierText,
  PRE_PR_VERIFIER_ADVISORY_HEADING,
} from "../lib/verifier_convergence.ts";
import {
  getFleetTelemetry,
  resetFleetTelemetry,
} from "../lib/fleet_telemetry.ts";
import {
  runCompletion,
  SUMMARY_WITH_BLOCK,
} from "./support/completion_summary_harness.ts";

/** The words of the pre-PR verifier's comment heading, as the prompt quotes them. */
const VERIFIER_WORDS = "The pre-PR verifier found blocking problems";

/** A summary that clears every gate (the harness's fixed summary). */
const SUMMARY_CLEAN = SUMMARY_WITH_BLOCK;

/** The clean summary with a fill-in-later token left where a result belongs. */
const SUMMARY_PLACEHOLDER = `${SUMMARY_CLEAN}\nQUALITY_RESULT_PLACEHOLDER\n`;

/** The clean summary without its Docs sweep line, so the docs-sweep gate blocks. */
const SUMMARY_NO_DOCS_SWEEP = SUMMARY_CLEAN.replace(
  /\*\*Docs sweep\*\*[^\n]*\n/,
  "",
);

/** A verifier finding on a file the change does not touch. */
function finding(
  tag: string,
  extra: Partial<ReviewFinding> = {},
): ReviewFinding {
  return {
    file: "worker/deno/lib/unchanged_module.ts",
    line: 7,
    problem: `problem ${tag}`,
    fix: `fix ${tag}`,
    ...extra,
  };
}

/** `n` distinct findings, tagged `<prefix>1` … `<prefix>n`. */
function findings(prefix: string, n: number): ReviewFinding[] {
  return Array.from({ length: n }, (_, i) => finding(`${prefix}${i + 1}`));
}

/** A checked verifier result carrying `findingList`. */
function checked(findingList: ReviewFinding[]): PrePrVerifierResult {
  return {
    status: "checked",
    review: {
      summary: findingList.length ? "problems found" : "nothing found",
      findings: findingList,
      testChanges: "none",
      testChangeNotes: [],
      unrelatedIssues: [],
      checklist: [],
      closure: [],
    },
  };
}

const F1 = finding("A");
const F2 = finding("B");
const F3 = finding("C");

// (a) Two gates block in the same pass, so the one recovery prompt carries both.
Deno.test(
  "gate recovery - findings from every blocked gate go to one recovery prompt (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_PLACEHOLDER,
      retryWrites: SUMMARY_CLEAN,
      verifier: [checked([F1]), checked([])],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudePrompts.length, 1, "one recovery prompt");
    const prompt = outcome.claudePrompts[0]!;
    assertStringIncludes(prompt, "REQUIRED ITEM 1 of 2");
    assertStringIncludes(prompt, "REQUIRED ITEM 2 of 2");
    assertStringIncludes(prompt, "QUALITY_RESULT_PLACEHOLDER");
    assertStringIncludes(prompt, VERIFIER_WORDS);
    assertStringIncludes(prompt, F1.problem);
  },
);

// (b) Blocks, blocks less, then passes: the PR is raised in the same run.
Deno.test(
  "gate recovery - a count that falls each turn keeps the run going to a PR (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [checked([F1, F2, F3]), checked([F1, F2]), checked([])],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.verifierInputs.length, 3, "three gate passes");
    assertEquals(outcome.claudePrompts.length, 2, "two recovery turns");
    assertEquals(outcome.reason, undefined);
  },
);

// (c) The count stops falling: the run ends after that turn, quoting the findings.
Deno.test(
  "gate recovery - a count that stops falling ends the run and says why (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [checked([F1, F2, F3]), checked([F1, F2]), checked([F1, F2])],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(outcome.claudePrompts.length, 2);
    assertEquals(outcome.verifierInputs.length, 3);
    const reason = outcome.reason ?? "";
    assertStringIncludes(reason, F1.problem);
    assertStringIncludes(
      reason,
      "recovery stopped after 2 turns: blocking findings did not decrease (3 → 2 → 2)",
    );
  },
);

// (d) The turn limit: counts 6, 5, 4, 3 stop after three turns.
Deno.test(
  "gate recovery - the turn limit stops a count that is still falling (Issue #4234)",
  async () => {
    const six = findings("G", 6);
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [
        checked(six),
        checked(six.slice(0, 5)),
        checked(six.slice(0, 4)),
        checked(six.slice(0, 3)),
      ],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.claudePrompts.length, 3, "three recovery turns");
    assertEquals(outcome.verifierInputs.length, 4);
    assertStringIncludes(
      outcome.reason ?? "",
      "recovery stopped at the 3-turn limit with 3 blocking findings left (6 → 5 → 4 → 3)",
    );
  },
);

// (e) Over an existing PR the PR is left alone while the count falls, and is
// finalised as summary_incomplete once the count stops falling.
Deno.test(
  "gate recovery - an existing PR is not finalised while the count falls (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [checked([F1, F2, F3]), checked([F1, F2]), checked([F1, F2])],
      prExistsForBranch: true,
    });

    assertEquals(outcome.claudePrompts.length, 2);
    assertEquals(
      outcome.finalisedBeforeTurn,
      [0, 0],
      "no finalise before either turn",
    );
    assertEquals(outcome.status, "early_exit");
    assertEquals(outcome.outcomeKind, "summary_incomplete");
    assertEquals(outcome.finalisePrCalls, 1, "finalised once, when stuck");
  },
);

Deno.test(
  "gate recovery - an existing PR that clears after falling counts is finalised by the pass (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [checked([F1, F2, F3]), checked([F1, F2]), checked([])],
      prExistsForBranch: true,
    });

    // The baseline is a clean run over the same existing PR with no turn: the
    // final pass must finalise it exactly as that run does.
    const clean = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [checked([])],
      prExistsForBranch: true,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.finalisedBeforeTurn, [0, 0]);
    assertEquals(outcome.finalisePrCalls, clean.finalisePrCalls);
  },
);

// (f) A recovery invocation that never launches does not spin the loop.
Deno.test(
  "gate recovery - a turn that is not launched stops the loop (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [checked([F1])],
      retryInvocationFails: true,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.claudePrompts.length, 1, "one attempted turn");
    assertEquals(outcome.verifierInputs.length, 1, "no second gate pass");
  },
);

// (g) Verifier convergence: a retry's fresh finding on an unchanged line is
// advisory unless it is high or critical; a repeated finding keeps blocking.
Deno.test(
  "gate recovery - a fresh medium finding on an unchanged line is advisory on the retry (Issue #4234)",
  async () => {
    const fresh = finding("N", {
      file: "worker/deno/lib/other_module.ts",
      line: 9,
      severity: "medium",
    });
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [checked([F1]), checked([fresh])],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.verifierInputs.length, 2);
    assertStringIncludes(
      outcome.verifierInputs[1]!.previousFindings?.join("\n") ?? "",
      F1.problem,
    );
    const advisory = outcome.comments.filter((c) =>
      c.includes(PRE_PR_VERIFIER_ADVISORY_HEADING)
    );
    assertEquals(advisory.length, 1, "advisory comment posted once");
    assertStringIncludes(advisory[0]!, fresh.problem);
  },
);

Deno.test(
  "gate recovery - the same fresh finding at high severity still blocks the retry (Issue #4234)",
  async () => {
    const fresh = finding("N", {
      file: "worker/deno/lib/other_module.ts",
      line: 9,
      severity: "high",
    });
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [checked([F1]), checked([fresh])],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(
      outcome.comments.filter((c) =>
        c.includes(PRE_PR_VERIFIER_ADVISORY_HEADING)
      )
        .length,
      0,
    );
    assertEquals(
      outcome.comments.filter((c) =>
        c.includes(PRE_PR_VERIFIER_COMMENT_HEADING)
      )
        .length,
      2,
      "the verifier comment reports both passes' findings",
    );
  },
);

// -----------------------------------------------------------------------------
// What makes a pass a retry (Issue #4234 review). A retry is a pass after a
// recovery turn in this run, a pass on a `failed-once` or `failed` issue, or a
// pass with earlier verifier findings. Each test below isolates one of them.
// -----------------------------------------------------------------------------

/** A fresh finding on a line this change does not touch, at `severity`. */
function freshOnUnchangedLine(
  severity: "medium" | "high",
): ReviewFinding {
  return finding("N", {
    file: "worker/deno/lib/other_module.ts",
    line: 9,
    severity,
  });
}

// (a) Not a retry: the first pass of a first attempt blocks on a fresh finding.
Deno.test(
  "retry - a fresh medium finding blocks the first pass of a first attempt (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [checked([freshOnUnchangedLine("medium")])],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(
      outcome.comments.filter((c) =>
        c.includes(PRE_PR_VERIFIER_ADVISORY_HEADING)
      )
        .length,
      0,
      "nothing is advisory on a first pass",
    );
  },
);

// (b) Retry by a recovery turn in this run (no earlier verifier finding, no label).
Deno.test(
  "retry - a medium finding first raised after a recovery turn is advisory (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_NO_DOCS_SWEEP,
      retryWrites: SUMMARY_CLEAN,
      verifier: [checked([]), checked([freshOnUnchangedLine("medium")])],
    });

    assertEquals(outcome.claudePrompts.length, 1, "one recovery turn");
    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
  },
);

Deno.test(
  "retry - a high finding first raised after a recovery turn still blocks (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_NO_DOCS_SWEEP,
      retryWrites: SUMMARY_CLEAN,
      verifier: [checked([]), checked([freshOnUnchangedLine("high")])],
    });

    assertEquals(outcome.claudePrompts.length, 1, "one recovery turn");
    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
  },
);

// (c) Retry by label: the first pass of a `failed-once` issue.
Deno.test(
  "retry - a medium finding is advisory on the first pass of a failed-once issue (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      labels: ["enhancement", "work-on", "failed-once"],
      verifier: [checked([freshOnUnchangedLine("medium")])],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
  },
);

Deno.test(
  "retry - a high finding on the first pass of a failed-once issue still blocks (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      labels: ["enhancement", "work-on", "failed-once"],
      verifier: [checked([freshOnUnchangedLine("high")])],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
  },
);

// (e) Retry by earlier verifier findings: a prior run's verifier section on the
// issue, with no recovery turn in this run and no label.
Deno.test(
  "retry - earlier verifier findings on the issue make the first pass a retry (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      issueComments: [{ author: "testbot", body: verifierSectionFor([F2]) }],
      verifier: [checked([freshOnUnchangedLine("medium")])],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudePrompts.length, 0, "no recovery turn ran");
  },
);

// (h) The pre-filled draft reaches the recovery prompt when the docs sweep blocks.
Deno.test(
  "gate recovery - the pre-filled draft is in the recovery prompt when a gate blocks (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_NO_DOCS_SWEEP,
      retryWrites: SUMMARY_CLEAN,
      diffUnified0: [
        "diff --git a/worker/deno/lib/new_module.ts b/worker/deno/lib/new_module.ts",
        "--- a/worker/deno/lib/new_module.ts",
        "+++ b/worker/deno/lib/new_module.ts",
        "@@ -0,0 +1 @@",
        "+export function newModuleEntry(): number {",
        "",
      ].join("\n"),
      verifier: [checked([])],
    });

    assertEquals(outcome.claudePrompts.length, 1);
    assertStringIncludes(
      outcome.claudePrompts[0]!,
      "PRE-FILLED DRAFT — confirm or correct each line against the diff",
    );
  },
);

// (i) Telemetry: a recovered run counts as recovered, a failed run's final
// gates count as failures.
Deno.test(
  "gate recovery - a recovered run is counted with its first-pass gates (Issue #4234)",
  async () => {
    resetFleetTelemetry();
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      retryWrites: SUMMARY_CLEAN,
      verifier: [checked([F1]), checked([])],
    });

    assertEquals(outcome.status, "continue");
    const telemetry = getFleetTelemetry();
    assertEquals(telemetry.gateRecoveredRuns, 1);
    assertEquals(telemetry.gateFirstPassBlocks["pre-pr-verifier"], 1);
    assertEquals(telemetry.gateRunFailures, {});
  },
);

Deno.test(
  "gate recovery - a failed run is counted with its final gates (Issue #4234)",
  async () => {
    resetFleetTelemetry();
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [checked([F1, F2]), checked([F1, F2])],
    });

    assertEquals(outcome.status, "failure");
    const telemetry = getFleetTelemetry();
    assertEquals(telemetry.gateRecoveredRuns, 0);
    assertEquals(telemetry.gateRunFailures["pre-pr-verifier"], 1);
  },
);

// (j) Regression guard: a second block with the same count ends the run, as the
// old "second block ends the run" behaviour did.
Deno.test(
  "gate recovery - a block whose count did not fall after the first turn fails the run (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [checked([F1]), checked([F1])],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.claudePrompts.length, 1, "the first block's one turn");
    assertEquals(outcome.verifierInputs.length, 2);
    assertStringIncludes(
      outcome.reason ?? "",
      "recovery stopped after 1 turn: blocking findings did not decrease (1 → 1)",
    );
  },
);

// -----------------------------------------------------------------------------
// One pass for real (Issue #4234 review): the three opening gates fold together.
// -----------------------------------------------------------------------------

/** The docs-sweep line the clean summary carries, reused in the fixtures below. */
const DOCS_SWEEP_LINE = SUMMARY_CLEAN.match(/\*\*Docs sweep\*\*[^\n]*/)![0];

/**
 * A summary with no closure, independent-review or reproduction block, but a
 * docs sweep and branch outcomes that pass: only the three opening gates block.
 */
const SUMMARY_WITHOUT_THREE_GATES = [
  "## Summary",
  "",
  "Fixed the fault. Closes #4234.",
  "",
  DOCS_SWEEP_LINE,
  "",
  "**Branch outcomes:** none added",
  "",
  "## Test Plan",
  "",
  "- `worker/deno/tests/completion_phase_gate_recovery_4234_test.ts`",
  "",
].join("\n");

Deno.test(
  "gate recovery - closure, independent review and reproduction blocked together go to one recovery prompt (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_THREE_GATES,
      labels: ["bug", "work-on"],
      verifier: [checked([])],
    });

    // The first pass reports all three gates, so its one recovery prompt
    // carries all three items. The unmet criteria (Issue #4146) fold in as a
    // fourth item, since these criteria are unmet. Later turns are a separate
    // question (the closure render and the loop's count decide them), so they
    // are not pinned.
    const prompt = outcome.claudePrompts[0]!;
    assertStringIncludes(prompt, "REQUIRED ITEM 1 of 4");
    assertStringIncludes(prompt, "REQUIRED ITEM 2 of 4");
    assertStringIncludes(prompt, "REQUIRED ITEM 3 of 4");
    assertStringIncludes(prompt, "Acceptance-criteria closure missing");
    assertStringIncludes(prompt, "Independent review missing");
    assertStringIncludes(prompt, "Reproduction status missing");
    assertStringIncludes(
      outcome.comments[0]!,
      "Acceptance-criteria closure missing",
    );
    assertStringIncludes(outcome.comments[0]!, "Reproduction status missing");
  },
);

// -----------------------------------------------------------------------------
// Per-finding counts (Issue #4234 review): a count of problems, not of sections.
// -----------------------------------------------------------------------------

/** Three claims the model reports as describing named code wrongly. */
const CLAIM_SENTENCES = [
  "The first claim names a helper that does not exist.",
  "The second claim names a regex that matches nothing.",
  "The third claim names a test that covers nothing.",
];

/**
 * The docs-sweep-only summary, with the claim sentences in it. The docs sweep
 * blocks every pass (the recovery writes nothing), so the claim check folds
 * into that block, where its per-problem count reaches the loop.
 */
const SUMMARY_WITH_CLAIMS = [
  SUMMARY_NO_DOCS_SWEEP.trimEnd(),
  "",
  ...CLAIM_SENTENCES,
  "",
].join("\n");

Deno.test(
  "gate recovery - a claim-check count that falls from three problems to two keeps the loop going (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_CLAIMS,
      claimSentences: [
        CLAIM_SENTENCES,
        CLAIM_SENTENCES.slice(0, 2),
        CLAIM_SENTENCES.slice(0, 2),
      ],
      verifier: [checked([])],
    });

    // docs sweep (1) + three claim problems = 4; then 1 + two = 3, which falls.
    // The third pass holds at 3, so the loop stops after the second turn.
    assertEquals(outcome.verifierInputs.length, 3, "three gate passes");
    assertEquals(outcome.claudePrompts.length, 2, "two recovery turns");
    assertEquals(outcome.status, "failure");
    assertStringIncludes(
      outcome.reason ?? "",
      "blocking findings did not decrease (4 → 3 → 3)",
    );
  },
);

Deno.test(
  "gate recovery - a claim-check count that holds at three problems stops the loop after one turn (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_CLAIMS,
      claimSentences: [CLAIM_SENTENCES, CLAIM_SENTENCES],
      verifier: [checked([])],
    });

    assertEquals(outcome.claudePrompts.length, 1, "one recovery turn");
    assertEquals(outcome.verifierInputs.length, 2, "two gate passes");
    assertStringIncludes(
      outcome.reason ?? "",
      "blocking findings did not decrease (4 → 4)",
    );
  },
);

// -----------------------------------------------------------------------------
// The agent's reply reaches the verifier (Issue #4234 review).
// -----------------------------------------------------------------------------

Deno.test(
  "gate recovery - the agent's reply to the verifier's findings reaches the next verifier pass (Issue #4234)",
  async () => {
    const reply =
      "Fixed F1 by removing the claim. Disputed F2: the test covers it at line 9.";
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      retryWrites: SUMMARY_CLEAN,
      retryOutput: reply,
      verifier: [checked([F1, F2]), checked([])],
    });

    assertEquals(outcome.verifierInputs.length, 2, "two verifier passes");
    assertEquals(
      outcome.verifierInputs[0]!.agentResponse,
      undefined,
      "the first pass has no recovery turn behind it",
    );
    assertEquals(outcome.verifierInputs[1]!.agentResponse, reply);
    assertEquals(outcome.verifierInputs[1]!.previousFindings?.length, 2);
  },
);

// -----------------------------------------------------------------------------
// Anchored verifier-comment parsing (Issue #4234 review).
// -----------------------------------------------------------------------------

/** One folded gate comment's separator, as `foldInLateSummaryVerdicts` writes it. */
const FOLD = "\n\n---\n\n";

/** The verifier's own gate comment for `list`, as the worker posts it. */
function verifierSectionFor(list: ReviewFinding[]): string {
  const result = checked(list);
  if (result.status !== "checked") {
    throw new Error("a checked verifier result is expected");
  }
  return buildPrePrVerifierGateComment(result.review);
}

/**
 * A folded section that QUOTES the verifier heading mid-text, with a bullet
 * under it the old `indexOf` slice would have parsed as a finding.
 */
const QUOTED_VERIFIER_SECTION = [
  "The agent quoted the verifier's comment back:",
  "",
  PRE_PR_VERIFIER_COMMENT_HEADING,
  "",
  "A quoted intro line.",
  "",
  "A quoted summary line.",
  "",
  "- `worker/deno/lib/quoted.ts:1` — QUOTED PROBLEM — fix: QUOTED FIX",
].join("\n");

Deno.test(
  "gate recovery - a verifier heading quoted mid-section is not taken as the verifier's findings (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      issueComments: [{
        author: "testbot",
        body: [QUOTED_VERIFIER_SECTION, verifierSectionFor([F2])].join(FOLD),
      }],
      verifier: [checked([])],
    });

    assertEquals(
      outcome.verifierInputs[0]!.previousFindings,
      [findingToEarlierText(F2)],
      "only the verifier's own section is read back",
    );
  },
);

Deno.test(
  "gate recovery - the verifier's own folded section is read back as its findings (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      issueComments: [{
        author: "testbot",
        body: [
          "Closure block missing: the gate's own text.",
          verifierSectionFor([F2]),
        ].join(FOLD),
      }],
      verifier: [checked([])],
    });

    assertEquals(
      outcome.verifierInputs[0]!.previousFindings,
      [findingToEarlierText(F2)],
    );
  },
);

// -----------------------------------------------------------------------------
// The run's hard-cap ceiling reaches the recovery turn through the seam
// (Issue #4234 review). No test mutates the process environment.
// -----------------------------------------------------------------------------

Deno.test(
  "gate recovery - a near-expired run hard cap skips the recovery turn, and an uncapped run invokes it (Issue #4234)",
  async () => {
    const nearlyExpired = await runCompletion({
      summary: SUMMARY_NO_DOCS_SWEEP,
      retryWrites: SUMMARY_CLEAN,
      verifier: [checked([])],
      runCeilingMs: Date.now() + 1000,
    });

    assertEquals(
      nearlyExpired.claudePrompts.length,
      0,
      "one second of runway is below the minimum, so the agent is not invoked",
    );
    assertEquals(
      nearlyExpired.status,
      "failure",
      "the skipped turn leaves the block standing",
    );

    // The pair: the same scenario with no injected ceiling is uncapped, so the
    // recovery turn runs and the PR is raised.
    const uncapped = await runCompletion({
      summary: SUMMARY_NO_DOCS_SWEEP,
      retryWrites: SUMMARY_CLEAN,
      verifier: [checked([])],
    });

    assertEquals(uncapped.claudePrompts.length, 1, "the recovery turn ran");
    assertEquals(uncapped.status, "continue");
  },
);

// -----------------------------------------------------------------------------
// Gate-failure telemetry line (Issue #4234 review).
// -----------------------------------------------------------------------------

const GATE_FAILURE_RATE_PREFIX = "[gate-failure-rate]";

Deno.test(
  "gate recovery - the gate-failure-rate line is logged once for a run that recorded a summary-rule block (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_NO_DOCS_SWEEP,
      retryWrites: SUMMARY_CLEAN,
      verifier: [checked([])],
    });

    const lines = outcome.logs.filter((l) =>
      l.message.startsWith(GATE_FAILURE_RATE_PREFIX)
    );
    assertEquals(lines.length, 1, "logged exactly once");
  },
);

Deno.test(
  "gate recovery - the gate-failure-rate line is not logged for a run with no block (Issue #4234)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      verifier: [checked([])],
    });

    const lines = outcome.logs.filter((l) =>
      l.message.startsWith(GATE_FAILURE_RATE_PREFIX)
    );
    assertEquals(lines.length, 0, "no summary gate blocked, so no line");
  },
);

// -----------------------------------------------------------------------------
// The advisory verifier comment is non-fatal (Issue #4234 review).
// -----------------------------------------------------------------------------

Deno.test(
  "gate recovery - a refused advisory verifier comment is logged and the run continues (Issue #4234)",
  async () => {
    const fresh = finding("N", {
      file: "worker/deno/lib/other_module.ts",
      line: 9,
      severity: "medium",
    });
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      failCommentContaining: PRE_PR_VERIFIER_ADVISORY_HEADING,
      verifier: [checked([F1]), checked([fresh])],
    });

    assertEquals(outcome.status, "continue", "the advisory post is not fatal");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(
      outcome.logs.filter((l) =>
        l.level === "warn" &&
        l.message.includes(
          "Could not post the pre-PR verifier advisory comment",
        )
      ).length,
      1,
      "the refused post is logged once",
    );
  },
);
