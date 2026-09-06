/**
 * Redact-before-truncate, made unforgeable by the type system (Issue #1217).
 *
 * `SECURITY.md` states the rule plainly: **a sink that trims output to a size
 * limit must run `redactSecrets()` first.** Cutting first splits a credential
 * across the boundary, and the surviving fragment has lost the anchor every
 * signature rule keys on — `ghp_`, `sk-ant-`, the `AKIA…` id that precedes an
 * AWS secret — so the later redaction pass at the sink matches nothing and the
 * fragment is published verbatim.
 *
 * The rule was documented and applied per call site, which is exactly the shape
 * that drifts: `handle_no_changes_phase.ts` redacted its no-changes comment
 * before slicing (Issue #3636) while ten sibling call sites in the same phase
 * modules sliced the agent's stdout to 500 characters raw and relied on the
 * redaction that `label_failure.ts` runs later — after the cut.
 *
 * This module makes the ordering a **type**, not a convention. {@link
 * RedactedText} is a branded string that only the constructors below can
 * produce, and they redact the whole input before they trim it. A field typed
 * `RedactedText` therefore cannot be fed `output.slice(-500)`: the build fails
 * at `deno check`, which is a stage of the quality gate.
 *
 * ```mermaid
 * flowchart LR
 *     O["agent stdout / ps table<br/>(may carry a token)"] --> R["redactSecrets<br/>(whole text)"]
 *     R --> T["trim to budget"]
 *     T --> S["public sink<br/>(issue comment, log)"]
 *     X["output.slice(-500)"] -. "compile error" .-> S
 * ```
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { redactSecrets } from "./secret_redaction.ts";

declare const redactedTextBrand: unique symbol;

/**
 * Text that has been through {@link redactSecrets} over its **whole** length
 * before any trimming.
 *
 * The brand is nominal and unforgeable outside this module, so a field typed
 * `RedactedText` cannot be handed raw, pre-truncated text by mistake.
 */
export type RedactedText = string & { readonly [redactedTextBrand]: true };

/** A budget of zero or fewer keeps nothing; guard the callers' arithmetic. */
function clampBudget(maxChars: number): number {
  return Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0;
}

/**
 * Redact `text` in full, then keep its last `maxChars` characters.
 *
 * The tail is what a failure message wants — the agent's final words before it
 * died — and it is also the cut that loses a credential's leading anchor, so
 * this is the constructor most call sites need.
 *
 * @param text - The full, untruncated text. Pass it whole; trimming it first is
 *   the bug this module exists to prevent.
 * @param maxChars - Characters to keep. Zero or less keeps nothing.
 * @returns The redacted tail, branded as {@link RedactedText}.
 */
export function redactedTail(text: string, maxChars: number): RedactedText {
  const budget = clampBudget(maxChars);
  const masked = redactSecrets(text);
  return (budget === 0 ? "" : masked.slice(-budget)) as RedactedText;
}

/**
 * Redact `text` in full, then keep its first `maxChars` characters.
 *
 * @param text - The full, untruncated text.
 * @param maxChars - Characters to keep. Zero or less keeps nothing.
 * @returns The redacted head, branded as {@link RedactedText}.
 */
export function redactedHead(text: string, maxChars: number): RedactedText {
  const budget = clampBudget(maxChars);
  return redactSecrets(text).slice(0, budget) as RedactedText;
}

/**
 * Join already-redacted parts, dropping the empty ones.
 *
 * Concatenating two `RedactedText` values yields a plain `string` in
 * TypeScript, so a call site that stitches a stdout tail to a stderr tail needs
 * this to keep the brand. Both inputs are already masked, so no rescan is
 * needed and none is performed.
 *
 * @param parts - Redacted fragments, in order.
 * @param separator - Text placed between the non-empty parts.
 * @returns The joined text, branded as {@link RedactedText}.
 */
export function joinRedacted(
  parts: readonly RedactedText[],
  separator: string,
): RedactedText {
  return parts.filter((part) => part.length > 0).join(
    separator,
  ) as RedactedText;
}
