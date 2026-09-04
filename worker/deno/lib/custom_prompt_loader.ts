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

import type { Result } from "../types.ts";
import { validatePromptTemplate } from "./prompt_manager.ts";

/** Template type a custom prompt must satisfy — it replaces `prompts/issue/`. */
export const CUSTOM_PROMPT_TEMPLATE_TYPE = "issue";

/**
 * Read and validate an operator's custom prompt template.
 *
 * Rejects — never repairs — a file that is missing, unreadable, empty (or
 * whitespace only), or short of a required `issue` placeholder
 * (`{{ISSUE_NUMBER}}`, `{{QUALITY_INSTRUCTIONS}}`).
 *
 * @param promptPath - Absolute host path of the operator's template
 * @param label - Optional label the mapping dispatches, named in errors
 * @returns The template content, or an error naming the path and the fault
 */
export async function loadCustomPromptTemplate(
  promptPath: string,
  label?: string,
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

  const validation = validatePromptTemplate(
    CUSTOM_PROMPT_TEMPLATE_TYPE,
    content,
  );
  if (!validation.ok) {
    return {
      ok: false,
      error: new Error(`${subject} is invalid: ${validation.error.message}`),
    };
  }

  return { ok: true, value: content };
}
