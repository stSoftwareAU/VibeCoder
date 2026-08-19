/**
 * Workflow label classification (Issue #1711).
 *
 * Workflow labels signal worker pickup, processing state, or human
 * escalation on an issue. They have no meaning on a PR — copying them
 * across is at best noise and at worst counter-productive (a PR labelled
 * `work-on` muddles dashboards and search). This module is the single
 * source of truth for "which labels must NOT be copied from an issue to
 * a PR".
 *
 * The list is derived from the `workflow` and `ui` categories of
 * `LABEL_DEFINITIONS` (defined in `setup/label_definitions.ts`), plus
 * the deprecated discovery/watch labels `help wanted` and `claude`
 * (Issue #2022) so older repos that still carry them never leak the
 * label to a freshly opened PR.
 *
 * Uses Australian English throughout.
 */
import { LABEL_DEFINITIONS } from "../setup/label_definitions.ts";

/**
 * Deprecated workflow labels retained in the workflow-label set so any
 * issue that still carries a legacy label is stripped before its labels
 * are copied onto a PR.
 *
 * - `claude`, `help wanted` — Issue #2022 (discovery/watch labels)
 * - `skip-clarification`, `needs-clarification` — Issue #2031
 *   (clarification handoff consolidated onto `needs-human`)
 * - `answered` — Issue #2030 (question workflow signals handoff with
 *   `needs-human`; the "done" half of the question pair is retired)
 * - `idle-task-pending` — Issue #2077 (approval gate retired — `idle-task`
 *   is already the lowest priority in the queue)
 */
const DEPRECATED_WORKFLOW_LABELS: readonly string[] = [
  "claude",
  "help wanted",
  "skip-clarification",
  "needs-clarification",
  "answered",
  "idle-task-pending",
];

/**
 * Names of every workflow-related label that must NOT be copied from
 * an issue onto its PR. Frozen so callers cannot mutate the set.
 */
export const WORKFLOW_LABEL_NAMES: ReadonlySet<string> = new Set([
  ...LABEL_DEFINITIONS.map((l) => l.name),
  ...DEPRECATED_WORKFLOW_LABELS,
]);

/**
 * Return the labels with all workflow labels removed.
 *
 * Stable: preserves the original order of the kept labels.
 */
export function filterOutWorkflowLabels(labels: string[]): string[] {
  return labels.filter((name) => !WORKFLOW_LABEL_NAMES.has(name));
}

/** True if the label name is a workflow label. */
export function isWorkflowLabel(name: string): boolean {
  return WORKFLOW_LABEL_NAMES.has(name);
}

/**
 * Workflow labels that the worker is explicitly permitted to self-apply
 * (Issue #1961). All other workflow labels remain reserved for trusted
 * humans (see AGENTS.md → "Worker Label Policy").
 *
 * One narrow exception:
 *   - `idle-task` — applied by the worker when filing an idle-task
 *     wrapper issue. Strict lowest-priority placement in
 *     `issue_priority.ts` guarantees these issues never starve real
 *     work. Issue #2077 retired the `idle-task-pending` approval gate.
 */
export const WORKER_SELF_APPLIABLE_LABELS: ReadonlySet<string> = new Set([
  "idle-task",
]);

/**
 * True if the label is on the worker self-apply allowlist
 * (Issue #1961). Returns false for every other label — including all
 * other workflow labels.
 */
export function isWorkerSelfAppliable(name: string): boolean {
  return WORKER_SELF_APPLIABLE_LABELS.has(name);
}
