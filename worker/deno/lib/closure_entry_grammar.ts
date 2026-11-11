/**
 * The one grammar for the labelled fields of a closure entry (Issue #4977).
 *
 * The worker renders each entry in this shape:
 *
 *   - **status** — criterion — evidence: `x` — reviewer: status — reason: text
 *
 * A field label is `evidence`, `reason` or `reviewer` followed by `:`. It
 * counts as a field only at the start of the entry text or straight after the
 * separator ` — ` (whitespace, em dash U+2014, whitespace). A keyword anywhere
 * else is plain data: `src/evidence-store.ts`, `reviewer-guide.md` and
 * `Xreviewer:` carry no field. A hyphen or an em dash is not accepted as the
 * label's own separator.
 *
 * The renderer (`closure_verdict.ts`) scrubs model text with this grammar, and
 * the validators (`independent_review_gate.ts`, `acceptance_criteria_gate.ts`)
 * and the routing code (`closure_criterion_match.ts`,
 * `standing_violation_routing.ts`) read fields with it, so none of them can
 * disagree about what a field is.
 *
 * The patterns are hardcoded literals rather than built from a label argument:
 * a `new RegExp(label…)` is a ReDoS surface Semgrep blocks on, and only these
 * three labels exist.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * The capture of each labelled field. The value is `([^\n]*)` with no `$`, so
 * it runs to the end of the entry text; the reviewer's verdict is a bounded
 * token, since only a status word follows it.
 */
export const ENTRY_FIELD_PATTERNS = {
  evidence: /(?:^|\s—\s)evidence\s*:\s*([^\n]*)/i,
  reason: /(?:^|\s—\s)reason\s*:\s*([^\n]*)/i,
  reviewer: /(?:^|\s—\s)reviewer\s*:\s*[`*_]*([a-z-]{1,16})/i,
} as const;

/**
 * Every `reviewer:` field in an entry, for counting them. Global, so it is used
 * with `matchAll`, which works on a copy and never shares `lastIndex` state.
 */
export const ENTRY_REVIEWER_ALL_RE =
  /(?:^|\s—\s)reviewer\s*:\s*[`*_]*([a-z-]{1,16})/gi;

/** The first labelled field of an entry, used with `.search`. */
export const ENTRY_FIELD_LABEL_RE =
  /(?:^|\s—\s)(?:evidence|reason|reviewer)\s*:/i;

/** Every field label at a boundary, with the separator and trailing space. */
const FIELD_LABEL_SCRUB_RE = /(?:^|\s—\s)(?:evidence|reason|reviewer)\s*:\s*/gi;

/**
 * Remove every field label at a field boundary, to a fixed point.
 *
 * One pass is not enough. A removed label becomes a single space, so
 * `a — reviewer: — reviewer: missing` loses its first label and leaves
 * `a — reviewer: missing`: a new ` — reviewer:` now sits beside its neighbour,
 * and only a second pass removes it. Trimming can likewise expose a label at
 * the start of the text. The loop therefore repeats replace-and-trim until the
 * text stops changing. Each change strictly shortens the text (a label and its
 * colon are at least seven characters, replaced by one space), so it ends.
 *
 * The result is stable under replace-and-trim, so no sanitiser step that runs
 * after this one can create a field. Callers truncate to their cap BEFORE
 * calling, because the cost is quadratic in the worst case in the length.
 *
 * @param text - The text to scrub.
 * @returns The text with no field label left at a boundary, trimmed.
 */
export function neutraliseFieldLabels(text: string): string {
  let current = text.trim();
  for (;;) {
    const next = current.replace(FIELD_LABEL_SCRUB_RE, " ").trim();
    if (next === current) return current;
    current = next;
  }
}

/**
 * The trimmed value of a labelled field, or `null` when the field is absent or
 * carries nothing but markup, dashes and whitespace.
 *
 * @param entry - The entry text.
 * @param label - Which field to read.
 * @returns The field's value, or `null`.
 */
export function fieldValue(
  entry: string,
  label: keyof typeof ENTRY_FIELD_PATTERNS,
): string | null {
  const match = entry.match(ENTRY_FIELD_PATTERNS[label]);
  if (!match) return null;
  if (match[1]!.replace(/[`*_\s—-]/g, "") === "") return null;
  return match[1]!.trim();
}
