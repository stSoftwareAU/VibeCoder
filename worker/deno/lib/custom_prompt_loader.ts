/**
 * Loader for an operator's custom prompt template (Issue #848, part of #843).
 *
 * `custom_label_prompts` (Issue #846) maps a GitHub label to a prompt template
 * that lives outside the public repository — an absolute host path. This module
 * reads that file for dispatch. It is deliberately *not* `loadPrompt`: there is
 * no `prompts/<name>/prompt.md` directory convention to resolve, just the plain
 * path the operator configured.
 *
 * ## Fail loud, never fall back
 *
 * The file was readable at config load, but it can be deleted, truncated or
 * edited between then and dispatch. Every such fault is returned as an error
 * naming the path (and the label, where the caller supplies one). Falling back
 * to the built-in `issue` template would run an operator's label through a
 * prompt they did not write, and silently skipping the issue would leave them
 * believing their extension was live — both are exactly what #843 rules out.
 *
 * The operator's file is *configuration*, not untrusted content: it is theirs
 * to edit, so `validatePromptImmutability` does not apply. What it renders
 * around — the issue title, labels, body and comments — is untrusted, and the
 * builder fences that with the same nonce delimiters as the built-in template.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { CustomPromptTargetPhase, Result } from "../types.ts";
import { validatePromptTemplate } from "./prompt_manager.ts";

/**
 * Target phase → the registered template type whose placeholder contract that
 * phase's prompt must satisfy (Issue #1008, part of #938).
 *
 * An `issue`-phase template replaces `prompts/issue/` and needs
 * `{{ISSUE_NUMBER}}` + `{{QUALITY_INSTRUCTIONS}}`; a `pr`-phase one replaces
 * `prompts/pr_feedback/` and needs `{{PR_NUMBER}}` + `{{QUALITY_INSTRUCTIONS}}`.
 * Before this map the type was hardwired to `issue`, so a PR-phase template
 * was rejected for missing a placeholder it has no business carrying.
 */
const TEMPLATE_TYPE_BY_PHASE: Readonly<
  Record<CustomPromptTargetPhase, string>
> = {
  issue: "issue",
  pr: "pr_feedback",
};

/** Template type a custom prompt must satisfy — it replaces `prompts/issue/`. */
export const CUSTOM_PROMPT_TEMPLATE_TYPE = TEMPLATE_TYPE_BY_PHASE.issue;

/**
 * The template type a mapping's target phase is held to (Issue #1008).
 *
 * @param phase - The mapping's validated target phase
 * @returns The registered template type whose placeholders must be present
 */
export function customPromptTemplateType(
  phase: CustomPromptTargetPhase,
): string {
  return TEMPLATE_TYPE_BY_PHASE[phase];
}

/** The target phase a template type belongs to, for error messages. */
function targetPhaseOf(
  templateType: string,
): CustomPromptTargetPhase | undefined {
  return (Object.keys(TEMPLATE_TYPE_BY_PHASE) as CustomPromptTargetPhase[])
    .find((phase) => TEMPLATE_TYPE_BY_PHASE[phase] === templateType);
}

/**
 * Read and validate an operator's custom prompt template.
 *
 * Rejects — never repairs — a file that is missing, unreadable, empty (or
 * whitespace only), or short of a placeholder the phase it serves requires.
 * The phase defaults to `issue` (a new custom label runs the implementation
 * phase, Issue #848); an override of a built-in phase passes its own phase, so
 * a `planning` override is held to the `planning` contract (Issue #849).
 *
 * @param promptPath - Absolute host path of the operator's template
 * @param label - Optional label the mapping dispatches, named in errors
 * @param templateType - Template type to validate against (default `issue`).
 *   A mapping-driven caller passes {@link customPromptTemplateType} of its
 *   target phase; a built-in override passes the phase it replaces.
 * @returns The template content, or an error naming the path and the fault
 */
export async function loadCustomPromptTemplate(
  promptPath: string,
  label?: string,
  templateType: string = CUSTOM_PROMPT_TEMPLATE_TYPE,
): Promise<Result<string>> {
  const subject = label
    ? `Custom prompt for label '${label}' at ${promptPath}`
    : `Custom prompt at ${promptPath}`;

  let content: string;
  try {
    content = await Deno.readTextFile(promptPath);
  } catch (error: unknown) {
    return {
      ok: false,
      error: new Error(
        `${subject} is missing or unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }

  if (content.trim().length === 0) {
    return { ok: false, error: new Error(`${subject} is empty`) };
  }

  const validation = validatePromptTemplate(templateType, content);
  if (!validation.ok) {
    // Name the target phase as well as the template type, so an operator who
    // wrote an `{{ISSUE_NUMBER}}` template against a `pr` mapping is told
    // exactly that rather than being left to infer it (Issue #1008).
    const phase = targetPhaseOf(templateType);
    const forPhase = phase === undefined
      ? ""
      : ` for the '${phase}' target phase`;
    return {
      ok: false,
      error: new Error(
        `${subject} is invalid${forPhase}: ${validation.error.message}`,
      ),
    };
  }

  return { ok: true, value: content };
}
