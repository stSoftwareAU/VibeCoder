/**
 * The one grammar for the labelled fields of a closure entry (Issue #4977).
 *
 * The worker renders each entry in this shape:
 *
 *   - **status** — criterion — evidence: `x` — reviewer: status — reason: text
 *
 * A field label is `evidence`, `reason` or `reviewer` followed by `:`. It counts
 * as a field when it is at the start of the entry text or directly preceded by
 * whitespace (`(?:^|\s)`). A keyword glued to a word or a path is plain data:
 * `src/evidence-store.ts`, `reviewer-guide.md`, `Xreviewer:` and
 * `a/reason-codes.ts` carry no field. A hyphen or an em dash is not accepted as
 * the label's own separator, so `reason - x` and `reason—x` are not labels.
 *
 * The boundary is deliberately the superset of the renderer's ` — ` separator,
 * not the separator alone. `collectListItems` joins a nested continuation line
 * to its entry with a single space, so a nested `  - evidence: x` bullet reads
 * as `… evidence: x`, and the tests pin that shape. The renderer's own ` — ` is
 * whitespace-led too, so it is covered without a special case. An en dash, a
 * hyphen or a bare colon before a label is covered for the same reason, and so
 * is a label after a leading em dash.
 *
 * The sanitiser (`closure_verdict.ts`) consumes every whitespace-led label in
 * model text, to a fixed point, so no model text can carry a field that the
 * validators would read. The renderer and the validators therefore agree on
 * every entry, and the boundary never needs a dash-specific rule.
 *
 * The patterns are hardcoded literals rather than built from a label argument:
 * a `new RegExp(label…)` is a ReDoS surface Semgrep blocks on, and only these
 * three labels exist.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * The capture of each labelled field, after the `(?:^|\s)` boundary. The value
 * is `([^\n]*)` with no `$`, so it runs to the end of the entry text; the
 * reviewer's verdict is a bounded token, since only a status word follows it.
 */
export const ENTRY_FIELD_PATTERNS = {
  evidence: /(?:^|\s)evidence\s*:\s*([^\n]*)/i,
  reason: /(?:^|\s)reason\s*:\s*([^\n]*)/i,
  reviewer: /(?:^|\s)reviewer\s*:\s*[`*_]*([a-z-]{1,16})/i,
} as const;

/**
 * Every `reviewer:` field in an entry, for counting them. Global, so it is used
 * with `matchAll`, which works on a copy and never shares `lastIndex` state.
 */
export const ENTRY_REVIEWER_ALL_RE =
  /(?:^|\s)reviewer\s*:\s*[`*_]*([a-z-]{1,16})/gi;

/**
 * The first labelled field of an entry, used with `.search`. The match starts
 * at the whitespace before the label, so a subject cut there keeps any dash that
 * stood before the label, and the matcher ignores that dash as punctuation.
 */
export const ENTRY_FIELD_LABEL_RE = /(?:^|\s)(?:evidence|reason|reviewer)\s*:/i;

/**
 * Every field label at a boundary, with its colon and trailing space. Each match
 * is replaced by one space.
 */
const FIELD_LABEL_SCRUB_RE = /(?:^|\s)(?:evidence|reason|reviewer)\s*:\s*/gi;

/**
 * Remove every field label at a field boundary, to a fixed point.
 *
 * One pass is not enough. A match consumes the whitespace after its colon, so
 * the label that follows it has no whitespace left in front of it for the same
 * pass: `a reviewer: reviewer: missing` loses its first label and leaves
 * `a reviewer: missing`, which only a second pass removes. Trimming can likewise
 * expose a label at the start of the text. The loop therefore repeats
 * replace-and-trim until the text stops changing. Each change strictly shortens
 * the text (a label and its colon are at least seven characters, replaced by
 * one space), so it ends.
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
