/**
 * Registry of every PR-summary gate the completion phase applies (Issue #4234).
 *
 * `pr_summary_check.ts` takes each gate's report name and issue reference from
 * here, so the local check and the worker agree on what a gate is called. The
 * drift test (`tests/pr_summary_gate_registry_test.ts`) reads
 * `lib/phases/completion_phase.ts` and fails when the two sets of gate
 * functions part ways.
 *
 * Entries are listed in the order the completion phase applies them.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * How a gate runs outside the worker:
 * - `deterministic`: pure over the summary, the issue and git; the local check
 *   runs it.
 * - `model`: asks a model; the local check runs it only when asked to.
 * - `worker-only`: needs something only the worker has (a test runner); the
 *   local check reports it not checked.
 */
export type SummaryGateLocalCheck = "deterministic" | "model" | "worker-only";

/** One PR-summary gate. */
export interface SummaryGate {
  /** Stable key, used to look the gate up. */
  id: string;
  /** Report name, as printed by the local check. */
  name: string;
  /** Issue reference the gate was introduced under. */
  issueRef: string;
  /** Name of the function the completion phase calls for this gate. */
  validator: string;
  localCheck: SummaryGateLocalCheck;
}

/** Every PR-summary gate the completion phase applies, in its order. */
export const PR_SUMMARY_GATES: readonly SummaryGate[] = [
  {
    id: "prompt-scrub",
    name: "Prompt-scrubbed Markdown",
    issueRef: "#3710",
    validator: "summaryScrubProblem",
    localCheck: "deterministic",
  },
  {
    id: "acceptance-closure",
    name: "Acceptance-criteria closure",
    issueRef: "#518",
    validator: "validateAcceptanceClosure",
    localCheck: "deterministic",
  },
  {
    id: "independent-review",
    name: "Independent two-axis review",
    issueRef: "#663",
    validator: "validateIndependentReview",
    localCheck: "deterministic",
  },
  {
    id: "reproduction-status",
    name: "Reproduction status",
    issueRef: "#521",
    validator: "validateReproductionStatus",
    localCheck: "deterministic",
  },
  {
    id: "docs-sweep",
    name: "Docs sweep",
    issueRef: "#3073",
    validator: "validateDocsSweep",
    localCheck: "deterministic",
  },
  {
    id: "removed-assertions",
    name: "Removed test assertions",
    issueRef: "#3131",
    validator: "validateRemovedAssertions",
    localCheck: "deterministic",
  },
  {
    id: "result-placeholders",
    name: "Result placeholders",
    issueRef: "#3124",
    validator: "findResultPlaceholders",
    localCheck: "deterministic",
  },
  {
    id: "branch-outcomes",
    name: "Branch outcomes",
    issueRef: "#3147",
    validator: "validateBranchOutcomes",
    localCheck: "deterministic",
  },
  {
    id: "unmet-criteria",
    name: "Unmet acceptance criteria",
    issueRef: "#4146",
    validator: "assessUnmetCriteria",
    localCheck: "deterministic",
  },
  {
    id: "claim-check",
    name: "Summary claim check",
    issueRef: "#3257",
    validator: "runSummaryClaimCheck",
    localCheck: "model",
  },
  {
    id: "pre-pr-verifier",
    name: "Pre-PR verifier",
    issueRef: "#3395",
    validator: "runPrePrVerifier",
    localCheck: "model",
  },
  {
    id: "mutation-check",
    name: "Mutation check",
    issueRef: "#3393",
    validator: "evaluateMutationGate",
    localCheck: "worker-only",
  },
  {
    id: "coverage-carry-over",
    name: "Coverage carry-over",
    issueRef: "#3795",
    validator: "evaluateCoverageCarryOverGate",
    localCheck: "worker-only",
  },
];

/**
 * The report name and issue reference for one gate, by id.
 *
 * Throws on an unknown id: a caller naming a gate the registry does not hold is
 * a programming error, not a runtime condition.
 */
export function gateRef(id: string): { gate: string; issueRef: string } {
  const gate = PR_SUMMARY_GATES.find((g) => g.id === id);
  if (gate === undefined) {
    throw new Error(
      `summary_gate_registry: no PR-summary gate with id "${id}" — add it to PR_SUMMARY_GATES`,
    );
  }
  return { gate: gate.name, issueRef: gate.issueRef };
}
