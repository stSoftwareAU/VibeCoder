/**
 * Clarifying-question validation for the Vibe Coder worker (Issue #190).
 *
 * The clarification hand-off that used to post these questions with
 * `needs-human` is gone (Issue #4298): an approved issue is never handed back
 * to a human, so a vague one proceeds with stated assumptions. What remains is
 * the sanity check the clarity assessment still applies to its own output.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";

/**
 * Validate that clarifying questions contain actual questions.
 *
 * Returns ok:true if valid, ok:false with reason if invalid.
 *
 * Issue #190 — Prevent empty "Questions" sections in comments.
 */
export function validateClarifyingQuestions(
  questions: string,
): Result<void> {
  const trimmed = questions.replace(/\s/g, "");
  if (!trimmed) {
    return {
      ok: false,
      error: new Error("Clarifying questions are empty or whitespace-only"),
    };
  }
  if (!questions.includes("?")) {
    return {
      ok: false,
      error: new Error(
        "Clarifying questions contain no question marks — likely not actual questions",
      ),
    };
  }
  return { ok: true, value: undefined };
}
