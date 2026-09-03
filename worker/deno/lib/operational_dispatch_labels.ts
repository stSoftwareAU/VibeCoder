/**
 * Operational dispatch labels (Issue #3083).
 *
 * The label-based discovery path (`findIssuesByLabel`) drives several
 * privileged automation phases: refinement, grill-me, quorum (Issue #4112),
 * planning, question, and revision. Each phase performs state-changing, LLM-backed work (creating
 * sub-issues, posting answers, applying labels) and consumes a top-tier model
 * invocation, so steering the worker into one of these phases is a privileged
 * action.
 *
 * Broken-access-control fix (A01:2025): for these operational dispatch labels
 * the label *adder* must always be on the allowlist, regardless of who authored
 * the issue. A trusted issue author is not sufficient — otherwise a
 * non-allowlisted actor with triage (label-applying) permission could apply an
 * operational label to a trusted-authored issue and force the worker into a
 * privileged phase. This mirrors the existing operational-label trust model in
 * `label_security.ts` (`verifyOperationalLabels` / `filterTrustedLabels`).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { WorkerConfig } from "../types.ts";
import { customLabelPromptLabels } from "./custom_label_prompts_config.ts";

/**
 * Resolve the configured operational dispatch labels.
 *
 * These are the labels that, when present on an issue, cause the worker to run
 * a privileged automation phase via `findIssuesByLabel`. The values are
 * operator-configurable, so they are read from the config rather than
 * hard-coded.
 *
 * @param config - Worker configuration
 * @returns The operational dispatch label names
 */
export function operationalDispatchLabels(config: WorkerConfig): string[] {
  return [
    config.refineIssueLabel,
    config.grillMeLabel,
    // Issue #4112: `quorum` runs three top-tier agents and decides the plan
    // every downstream sub-issue is cut from — as privileged as planning.
    config.quorumLabel,
    config.planningLabel,
    config.questionLabel,
    config.needsRevisionLabel,
    // Issue #847 (part of #843): a `custom_label_prompts` label dispatches a
    // privileged automation phase with an operator-supplied prompt, so it is as
    // privileged as planning and belongs in the same AND-gated set. With no
    // mappings configured this contributes nothing and the six labels above are
    // returned unchanged.
    ...customLabelPromptLabels(config),
  ];
}

/**
 * Whether the given label requires the label *adder* to be on the allowlist.
 *
 * Returns true for operational dispatch labels (AND gate — label adder must be
 * trusted regardless of issue authorship); false for any other label (OR gate
 * — trusted issue author or trusted label adder is sufficient).
 *
 * Comparison is case-insensitive to match GitHub's case-insensitive label
 * handling and the allowed-author comparisons used elsewhere.
 *
 * @param config - Worker configuration
 * @param label - The label being searched for
 * @returns True if strict label-adder trust is required
 */
export function requiresLabelAdderTrust(
  config: WorkerConfig,
  label: string,
): boolean {
  const target = label.toLowerCase();
  return operationalDispatchLabels(config).some(
    (l) => l.toLowerCase() === target,
  );
}
