/**
 * Which workflow a terminal run served, for the callback context's `mode`
 * (Issue #2100, part of #2060).
 *
 * A fleet archive that counts runs cannot tell an implementation run from an
 * idle-task sweep without being told: `result`, `outcome` and the telemetry
 * look the same either way. `mode` names the workflow the dispatch served, so
 * a trial can compare implementation runs only.
 *
 * ## Scope — deliberately the claim scan's own routes, and no more
 *
 * Post-run callbacks fire for exactly one family of runs: those the claim
 * scan hands to `processIssue` (see `dispatchIssueCallbacks` in
 * `run_core.ts`). That scan serves the implementation workflow — `work-on`,
 * `top-priority`, `low-priority` — plus the idle-task wrapper route inside
 * `processIssue` itself. The label routes at priorities 1.75–1.86 (grill-me,
 * quorum, planning, question, refine-issue, the custom-label prompts) run
 * through `findAndProcessByLabel`, which returns a bare `{ processed }` and
 * fires no run callback at all.
 *
 * So this resolver reads **only** the labels that can name the workflow a
 * `processIssue` run actually served. Reading the label routes' names here
 * would be worse than useless: `grill-me` is not one of the labels the claim
 * scan filters out, so a `work-on` issue that also carries `grill-me` — the
 * grill-me route having declined it — is claimed and implemented by the
 * scan, and would then be archived as a grill-me run. That is precisely the
 * mis-count `mode` exists to prevent.
 *
 * `TerminalIssueRun.mode` itself is an open string: a route that later gains
 * its own run callbacks reports its own label without touching this module.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";

/**
 * The configured label names this resolver reads.
 *
 * A subset of `WorkerConfig` deliberately: the resolver is pure, so the
 * dispatch site passes only the `*Label` value it already holds.
 */
export interface CallbackRunModeLabels {
  /**
   * The implementation label (`work-on` by default). Also the answer for a
   * claim taken on a priority label — `top-priority` and `low-priority` order
   * the implementation queue, they are not workflows of their own.
   */
  workOnLabel: string;
}

/** Non-blank trimmed value, or undefined. */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The workflow a claim-scan run served, or `undefined` when the fleet
 * configured no implementation label to name it by.
 *
 * Matching is case-insensitive, as GitHub's own label handling is, and the
 * value returned is always one the **host** configured (or the fixed
 * {@link IDLE_TASK_LABEL}) — never a string taken from the issue, so a label
 * an untrusted party added cannot put its own text into the callback context.
 */
export function resolveCallbackRunMode(
  issueLabels: readonly string[],
  labels: CallbackRunModeLabels,
): string | undefined {
  const applied = issueLabels.map((label) => label.trim().toLowerCase());
  // The wrapper route inside `processIssue` claims these before the standard
  // implementation pipeline, so the wrapper label wins where both are on.
  if (applied.includes(IDLE_TASK_LABEL)) return IDLE_TASK_LABEL;
  return present(labels.workOnLabel);
}
