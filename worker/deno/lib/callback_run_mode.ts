/**
 * Which workflow a terminal run served, for the callback context's `mode`
 * (Issue #2100, part of #2060).
 *
 * A fleet archive that counts runs cannot tell an implementation run from a
 * grill-me or question run without being told: `result`, `outcome` and the
 * telemetry look the same either way. `mode` names the **workflow label the
 * dispatch matched**, so a trial can compare implementation runs only.
 *
 * The order below is the dispatcher's own: the label routes (priorities
 * 1.75–1.86) are tried before the issue scan, so a doubly-labelled issue is
 * attributed to the route that would actually have served it. An issue
 * carrying no workflow label at all was claimed by the implementation scan on
 * a priority label (`top-priority`, `low-priority`) — a queue position, not a
 * workflow — so it reports the configured `work-on` label.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";

/**
 * The configured label names this resolver reads.
 *
 * A subset of `WorkerConfig` deliberately: the resolver is pure, so the
 * dispatch site passes only the `*Label` values it already holds.
 */
export interface CallbackRunModeLabels {
  /** Implementation label, and the fallback for a priority-only claim. */
  workOnLabel: string;
  refineIssueLabel?: string;
  grillMeLabel?: string;
  quorumLabel?: string;
  planningLabel?: string;
  questionLabel?: string;
  /**
   * Operator-configured custom dispatch labels, in configuration order
   * (Issue #846). Each is a workflow of its own, so its name is the mode.
   */
  customLabels?: readonly string[];
}

/** Non-blank trimmed value, or undefined. */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The workflow label the dispatch matched, or `undefined` when the fleet
 * configured no implementation label to fall back on.
 *
 * Matching is case-insensitive, as GitHub's own label handling is, and the
 * **configured** name is returned — an operator who renamed a label sees
 * their own name in the callback, not the built-in default.
 */
export function resolveCallbackRunMode(
  issueLabels: readonly string[],
  labels: CallbackRunModeLabels,
): string | undefined {
  // Dispatch order, most specific route first.
  const ordered: (string | undefined)[] = [
    labels.refineIssueLabel,
    labels.grillMeLabel,
    labels.quorumLabel,
    labels.planningLabel,
    labels.questionLabel,
    ...(labels.customLabels ?? []),
    IDLE_TASK_LABEL,
  ];
  const applied = new Set(
    issueLabels.map((label) => label.trim().toLowerCase()),
  );
  for (const candidate of ordered) {
    const name = present(candidate);
    if (name && applied.has(name.toLowerCase())) return name;
  }
  return present(labels.workOnLabel);
}
