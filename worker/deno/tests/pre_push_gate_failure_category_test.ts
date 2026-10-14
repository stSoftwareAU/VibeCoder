/**
 * A completion-phase pre-push gate block quotes raw formatter, linter and test
 * output (PR #3716 review of Issue #3689). The worker-written
 * `PRE_PUSH_GATE_MARKER` prefix must decide the category, so a quoted
 * "rate limit", "timed out" or "SIGKILL" cannot reclassify the run as
 * infrastructure and re-claim it forever.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { classifyCodingFailure } from "../lib/coding_failure_ladder.ts";
import {
  detectFailureCategory,
  getFailureCategoryDisplay,
  getFailureDiagnosis,
  getFailureDiagnosisOneliner,
  isInfrastructureFailure,
  normaliseFailureCategory,
  PRE_PUSH_GATE_MARKER,
} from "../lib/failure_diagnosis.ts";
import { detectHostFault } from "../lib/host_fault.ts";
import { shouldRetryInfrastructureFailure } from "../lib/infra_retry.ts";
import { classifyRunFailure } from "../lib/run_outcome_classifier.ts";
import type { PhaseState } from "../lib/issue_worker_types.ts";
import type { Logger } from "../types.ts";

/** What `cargo fmt --check` prints: a diff hunk quoting source comments. */
const QUOTED_OUTPUT = "[PRE_PUSH_BLOCKED] Pre-flight gate BLOCK\n" +
  "Diff in src/exchange.rs:12:\n" +
  "-    // back off when the exchange rate limit is hit\n" +
  "+    // retry: the command timed out, then SIGKILL; command not found\n" +
  "ENOSPC: no space left on device";

const gateReason = `${PRE_PUSH_GATE_MARKER}: ${QUOTED_OUTPUT}`;

Deno.test("detectFailureCategory - a marked pre-push gate block quoting rate limit, timed out and SIGKILL is pre_push_gate (PR #3716 review)", () => {
  assertEquals(detectFailureCategory(gateReason), "pre_push_gate");
  // Positive control: the same quotation without the marker is misread, which
  // is the defect this marker exists to end.
  assertEquals(detectFailureCategory(QUOTED_OUTPUT), "killed");
});

Deno.test("detectFailureCategory - the pre-push gate marker must be a prefix, not merely included (PR #3716 review)", () => {
  assertEquals(
    detectFailureCategory(
      `Claude timed out after 3600s: ${PRE_PUSH_GATE_MARKER}`,
    ),
    "timeout",
  );
});

Deno.test("classifyCodingFailure - a marked pre-push gate block earns a normal ladder attempt, never transient (PR #3716 review)", () => {
  for (
    const quoted of [
      "// back off when the exchange rate limit is hit",
      "the check timed out",
      "terminated by SIGKILL",
      "deno: command not found",
    ]
  ) {
    const decision = classifyCodingFailure(
      `${PRE_PUSH_GATE_MARKER}: [PRE_PUSH_BLOCKED] ${quoted}`,
    );
    assertEquals(decision.disposition, "ladder", quoted);
    assertEquals(decision.category, "pre_push_gate", quoted);
    assertEquals(decision.cooldownKind, "non_transient", quoted);
    assertEquals(decision.failureClass, "agent-outcome", quoted);
  }
  // Positive control: unmarked, the rate-limit quotation is transient.
  assertEquals(
    classifyCodingFailure("[PRE_PUSH_BLOCKED] exchange rate limit is hit")
      .disposition,
    "transient",
  );
});

Deno.test("classifyRunFailure - a pre-push gate block is an agent-outcome (PR #3716 review)", () => {
  assertEquals(
    classifyRunFailure("pre_push_gate", gateReason).failureClass,
    "agent-outcome",
  );
});

Deno.test("detectHostFault - a marked pre-push gate block quoting ENOSPC is never a host fault (PR #3716 review)", () => {
  assertEquals(detectHostFault(QUOTED_OUTPUT), "disk-full");
  assertEquals(detectHostFault(gateReason), null);
});

Deno.test("pre_push_gate category - display, diagnosis, oneliner and validation handle it (PR #3716 review)", () => {
  assertEquals(getFailureCategoryDisplay("pre_push_gate"), "pre-push-gate");
  for (
    const text of [
      getFailureDiagnosis("pre_push_gate"),
      getFailureDiagnosisOneliner("pre_push_gate"),
    ]
  ) {
    assertStringIncludes(text.toLowerCase(), "pre-push gate");
  }
  assertEquals(normaliseFailureCategory("pre_push_gate"), "pre_push_gate");
  assertEquals(isInfrastructureFailure("pre_push_gate"), false);
});

Deno.test("shouldRetryInfrastructureFailure - a marked pre-push gate block quoting a rate limit is not re-run (PR #3716 review)", async () => {
  const noop = () => {};
  const logger: Logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
  const state = (): PhaseState => ({
    branchName: "issue-42-test",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  });
  const sleepFn = (_ms: number) => Promise.resolve();
  assert(
    !await shouldRetryInfrastructureFailure(
      "completion",
      gateReason,
      state(),
      logger,
      { sleepFn },
    ),
  );
  // Positive control: the unmarked quotation is retried as a rate limit.
  assert(
    await shouldRetryInfrastructureFailure(
      "completion",
      "[PRE_PUSH_BLOCKED] the exchange rate limit is hit",
      state(),
      logger,
      { sleepFn },
    ),
  );
});
