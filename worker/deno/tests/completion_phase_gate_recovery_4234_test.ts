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
  PRE_PR_VERIFIER_COMMENT_HEADING,
  type PrePrVerifierResult,
  type ReviewFinding,
} from "../lib/pre_pr_verifier.ts";
import { PRE_PR_VERIFIER_ADVISORY_HEADING } from "../lib/verifier_convergence.ts";
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
