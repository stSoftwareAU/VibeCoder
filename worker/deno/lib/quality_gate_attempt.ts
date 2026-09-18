/**
 * What the implementation run's quality gate did, carried out of the phase
 * (Issue #2345, part of #2320).
 *
 * The gate is bounded to two attempts — the initial `./quality.sh` run plus one
 * `quality_fix` remediation and re-run — and which of them passed used to be
 * written to the host's private worker log only. The advisor/executor pilot is
 * judged partly on the **first-attempt quality-gate pass rate**, so the outcome
 * has to leave the phase: `workOnIssueQualityGate` records it on the phase
 * state and the completion path renders it on the run-stats comment.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * The gate's outcome for one run.
 *
 * `attempt` is the gate's own bounded loop counter — `1` for a gate that passed
 * on the initial run, `2` for one that passed after the single remediation
 * cycle. A gate that never passed carries no attempt: `failed` is the whole
 * report — including the bump-audit case, where the gate only went green once
 * the dependency bump was reverted, so the gate on the tree this run built did
 * not pass.
 */
export type QualityGateAttemptOutcome =
  | { readonly status: "passed"; readonly attempt: number }
  | { readonly status: "failed" };
