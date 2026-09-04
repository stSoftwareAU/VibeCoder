/**
 * Which built-in phase a `custom_label_prompts` entry overrides (Issue #849,
 * part of #843).
 *
 * Issue #848 gave a **new** label the generic implementation phase. This module
 * is the other half: an entry whose label matches a **built-in** label replaces
 * that phase's own template, so an operator can run a non-public `planning`,
 * `grill-me`, `question`, `quorum` or `work-on` prompt.
 *
 * ## Two things this module refuses to guess
 *
 * 1. **The label names are operator-configurable.** `planning` may be
 *    `plan-it` on a fleet that renamed it, so the mapping is resolved against
 *    the configured names on `WorkerConfig` — never against hard-coded
 *    literals.
 * 2. **A two-turn phase is two templates.** Overriding `planning` does not
 *    touch `planning_critique`, and overriding `quorum` does not touch
 *    `quorum_judge`: each is a separate template with its own required
 *    placeholders, so each needs its own entry naming its phase explicitly.
 *    Inferring the second turn from the first would hand an agent a prompt the
 *    operator never wrote.
 *
 * `refine-issue` has no template file at all — `lib/refinement_processor.ts`
 * builds its prompt inline — so a mapping naming it is rejected by name with
 * that reason rather than failing later with a confusing "prompt not found".
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";
import { LABEL_DEFAULTS } from "./config_defaults.ts";
import { getRequiredPlaceholders } from "./prompt_manager.ts";

/**
 * The operator-configurable label names an override may name.
 *
 * A structural subset of `WorkerConfig`, so config load can pass the resolved
 * config and tests can pass a literal.
 */
export interface BuiltInLabelNames {
  workOnLabel: string;
  planningLabel: string;
  questionLabel: string;
  grillMeLabel: string;
  quorumLabel: string;
  refineIssueLabel: string;
}

/** The stock label names, used when a caller supplies none. */
export const DEFAULT_BUILTIN_LABEL_NAMES: BuiltInLabelNames = {
  workOnLabel: LABEL_DEFAULTS.workOnLabel,
  planningLabel: LABEL_DEFAULTS.planningLabel,
  questionLabel: LABEL_DEFAULTS.questionLabel,
  grillMeLabel: LABEL_DEFAULTS.grillMeLabel,
  quorumLabel: LABEL_DEFAULTS.quorumLabel,
  refineIssueLabel: LABEL_DEFAULTS.refineIssueLabel,
};

/**
 * The phases each built-in label owns, first entry first.
 *
 * The first phase is what an entry overrides when it names no `phase`; the
 * rest are the later turns, which must be named explicitly. `refineIssueLabel`
 * owns nothing — see {@link REFINE_ISSUE_REASON}.
 */
const LABEL_PHASES: Record<keyof BuiltInLabelNames, readonly string[]> = {
  workOnLabel: ["issue"],
  planningLabel: ["planning", "planning_critique"],
  questionLabel: ["question"],
  grillMeLabel: ["grill-me"],
  quorumLabel: ["quorum", "quorum_judge"],
  refineIssueLabel: [],
};

/** Why a `refine-issue` mapping is refused. */
export const REFINE_ISSUE_REASON =
  "the refinement phase builds its prompt inline in " +
  "lib/refinement_processor.ts and has no template file to override";

/** Read the six configurable label names off a worker configuration. */
export function builtInLabelNames(
  config: BuiltInLabelNames,
): BuiltInLabelNames {
  return {
    workOnLabel: config.workOnLabel,
    planningLabel: config.planningLabel,
    questionLabel: config.questionLabel,
    grillMeLabel: config.grillMeLabel,
    quorumLabel: config.quorumLabel,
    refineIssueLabel: config.refineIssueLabel,
  };
}

/** The label name each built-in field carries, in match order. */
function labelFields(
  names: BuiltInLabelNames,
): [keyof BuiltInLabelNames, string][] {
  return (Object.keys(LABEL_PHASES) as (keyof BuiltInLabelNames)[])
    .map((field) => [field, names[field]]);
}

/**
 * Every phase that can be overridden, given the configured label names.
 *
 * Exported for the documentation-facing error messages and for tests, which
 * assert the list rather than restating it.
 */
export function overridablePhases(
  names: BuiltInLabelNames = DEFAULT_BUILTIN_LABEL_NAMES,
): string[] {
  return labelFields(names).flatMap(([field]) => [...LABEL_PHASES[field]]);
}

/**
 * Resolve which built-in phase a mapping overrides.
 *
 * @param label - The mapping's GitHub label
 * @param requestedPhase - The mapping's explicit `phase`, when it named one
 * @param names - The configured built-in label names
 * @returns `ok` with the phase, or `ok` with `undefined` when the label is not
 *   a built-in one (a new custom label — Issue #848 behaviour); `error` with a
 *   message naming the label and why it cannot be overridden
 */
export function resolveOverridePhase(
  label: string,
  requestedPhase: string | undefined,
  names: BuiltInLabelNames = DEFAULT_BUILTIN_LABEL_NAMES,
): Result<string | undefined, string> {
  const target = label.toLowerCase();
  const match = labelFields(names).find(
    ([, name]) => name.toLowerCase() === target,
  );

  if (!match) {
    if (requestedPhase !== undefined) {
      return {
        ok: false,
        error:
          `"phase" may only be set on a mapping that overrides a built-in ` +
          `label; "${label}" is not one, and a new custom label always runs ` +
          `the implementation phase`,
      };
    }
    return { ok: true, value: undefined };
  }

  const [field] = match;
  const phases = LABEL_PHASES[field];
  if (phases.length === 0) {
    return {
      ok: false,
      error: `"${label}" cannot be overridden: ${REFINE_ISSUE_REASON}`,
    };
  }

  if (requestedPhase === undefined) return { ok: true, value: phases[0]! };
  if (!phases.includes(requestedPhase)) {
    return {
      ok: false,
      error: `"${label}" overrides ${phases.join(" or ")}, not ` +
        `"${requestedPhase}"`,
    };
  }
  return { ok: true, value: requestedPhase };
}

/**
 * Validate an override template against the placeholders **its own phase**
 * requires.
 *
 * This is the contract that separates an override from a new custom label: a
 * new label runs the implementation phase and so validates against `issue`,
 * whereas an override must satisfy whatever its target phase needs — `planning`
 * wants `{{PLANNING_LABEL}}`, `quorum` additionally wants
 * `{{BOUNDARY_INTEGRITY_INSTRUCTION}}`. Getting that wrong renders a prompt
 * with unfilled markers, or silently drops the fencing instruction from a
 * Quorum template.
 *
 * @param phase - The phase the template replaces
 * @param content - The operator's template text
 * @returns `ok`, or `error` naming the phase and the missing placeholders
 */
export function validateOverrideTemplate(
  phase: string,
  content: string,
): Result<void, string> {
  if (content.trim().length === 0) {
    return { ok: false, error: `overrides phase "${phase}" but is empty` };
  }
  const required = getRequiredPlaceholders(phase);
  if (!required.ok) {
    return {
      ok: false,
      error: `overrides phase "${phase}", which has no registered ` +
        `placeholder contract: ${required.error.message}`,
    };
  }
  const missing = required.value.filter(
    (placeholder) => !content.includes(`{{${placeholder}}}`),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      error: `overrides phase "${phase}" but is missing the placeholders ` +
        `that phase requires: ${
          missing.map((name) => `{{${name}}}`).join(", ")
        }`,
    };
  }
  return { ok: true, value: undefined };
}
