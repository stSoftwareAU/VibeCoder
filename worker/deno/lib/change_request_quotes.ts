/**
 * Change-request quote extraction and staleness checking (Issue #3244).
 *
 * `pr_feedback_drift_check.ts` (Issue #3143) asks a model to compare this
 * push against the files it touched, but it never sees the change request
 * (review or comment) the push is answering. A reviewer's finding often
 * quotes the exact sentence in the PR summary it says is wrong — and a
 * review-fix push has been seen to leave that sentence standing, appending
 * a "PR-feedback round N" correction below it rather than rewriting or
 * removing it (VibeCoder#3236's round 2). This module is the deterministic,
 * no-I/O half of the fix: it parses the change request's findings, pulls out
 * every sentence-length quoted span in each finding's problem text, and
 * checks whether that span is still present (whitespace/markup-normalised)
 * in the named PR summary.
 *
 * The producer contract this module's parser matches is `reviewBody` in
 * `.claude/skills/review-fleet-prs/scripts/review_log.ts`: a `changes_requested`
 * review body is a run of findings, each shaped
 * ```
 * **`<file>[:<line>]`**: <problem>
 *
 * **Fix:** <fix>
 *
 * ```
 * (the blank line and `**Fix:**` block are both optional) followed by a
 * closing summary paragraph. `parseChangeRequestFindings` must read only the
 * `<problem>` text of each finding — never the `**Fix:**` text or the
 * trailing summary paragraph, both of which routinely include quoted prose
 * that is not the finding itself.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** One finding parsed out of a change request body. */
export interface ChangeRequestFinding {
  /** Repo-relative path the finding names (any trailing `:line` stripped). */
  file: string;
  /** The finding's problem text — never the `**Fix:**` text or summary. */
  problem: string;
}

/** A PR summary file's repo-relative path (Issue #3143, #3244). */
const PR_SUMMARY_PATH_PATTERN =
  /^docs\/archive\/pr-summaries\/pr-summary-\d+\.md$/;

/** Whether `path` is a PR summary (`docs/archive/pr-summaries/pr-summary-N.md`). */
export function isPrSummaryPath(path: string): boolean {
  return PR_SUMMARY_PATH_PATTERN.test(path);
}

/** A finding header, `**\`<file>[:<line>]\`**:` at the start of a line. */
const FINDING_HEADER_PATTERN = /^\*\*`([^`\n]+)`\*\*:/;

/**
 * Parse a change request body into its findings (Issue #3244).
 *
 * See the module doc comment for the producer contract this matches
 * (`reviewBody` in `.claude/skills/review-fleet-prs/scripts/review_log.ts`). Each
 * finding's `problem` runs from the header line's remainder through
 * following lines until the first blank line, a line starting
 * `**Fix:**`, or the next finding header — so the `**Fix:**` text and the
 * review's closing summary paragraph are never read as part of a problem.
 */
export function parseChangeRequestFindings(
  body: string,
): ChangeRequestFinding[] {
  const lines = body.split(/\r?\n/);
  const findings: ChangeRequestFinding[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const match = FINDING_HEADER_PATTERN.exec(line);
    if (!match) {
      i++;
      continue;
    }
    const captured = match[1]!;
    const colonIdx = captured.indexOf(":");
    const file = (colonIdx >= 0 ? captured.slice(0, colonIdx) : captured)
      .trim();
    const restOfLine = line.slice(match[0].length).trim();
    const problemLines: string[] = [restOfLine];
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (next.trim() === "") {
        i++;
        break;
      }
      if (/^\*\*Fix:\*\*/.test(next.trim())) break;
      if (FINDING_HEADER_PATTERN.test(next)) break;
      problemLines.push(next.trim());
      i++;
    }
    findings.push({ file, problem: problemLines.join(" ").trim() });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// extractQuotedSpans — hand-written linear scanners, no backtracking regex.
// ---------------------------------------------------------------------------

/** Whether `ch` is a Unicode letter or digit. */
function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

/** Number of whitespace-separated tokens in `text` that contain a letter or digit. */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((token) => token !== "" && isWordChar(token))
    .length;
}

/**
 * Straight double-quote pass. Outside a span, `"` or `\"` opens; inside,
 * `\"` is a literal `"` kept in the span, and a bare `"` closes. A span
 * still open at a line break is dropped (Issue #3244).
 */
function scanStraightDouble(text: string): string[] {
  const spans: string[] = [];
  let inSpan = false;
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") {
      inSpan = false;
      buf = "";
      continue;
    }
    if (ch === "\\" && text[i + 1] === '"') {
      if (inSpan) {
        buf += '"';
      } else {
        inSpan = true;
        buf = "";
      }
      i++; // consume the escaped quote too
      continue;
    }
    if (ch === '"') {
      if (inSpan) {
        spans.push(buf);
        inSpan = false;
        buf = "";
      } else {
        inSpan = true;
        buf = "";
      }
      continue;
    }
    if (inSpan) buf += ch;
  }
  return spans;
}

/** Curly double-quote pass (`“` opens, `”` closes). No escape handling — the two characters are unambiguous already. */
function scanCurlyDouble(text: string): string[] {
  const spans: string[] = [];
  let inSpan = false;
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") {
      inSpan = false;
      buf = "";
      continue;
    }
    if (ch === "“" /* “ */) {
      if (!inSpan) {
        inSpan = true;
        buf = "";
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === "”" /* ” */) {
      if (inSpan) {
        spans.push(buf);
        inSpan = false;
        buf = "";
      }
      continue;
    }
    if (inSpan) buf += ch;
  }
  return spans;
}

/** Whether `text[i]` is a well-positioned single-quote opener. */
function isSingleOpenerPosition(
  text: string,
  i: number,
  openChar: string,
): boolean {
  if (text[i] !== openChar) return false;
  if (i === 0) return true;
  const prev = text[i - 1]!;
  return prev === "\n" || prev === "(" || prev === "[" || /\s/.test(prev);
}

/**
 * Single-quote pass, parameterised over the open/close characters so the
 * same logic drives both the straight-single pass (`'`/`'`) and the
 * curly-single pass (`‘`/`’`). An opener is `openChar` at text/line start or
 * preceded by whitespace, `(` or `[`; inside a span, `closeChar` followed by
 * a letter or digit is an apostrophe (kept literally); otherwise it closes.
 */
function scanSingle(
  text: string,
  openChar: string,
  closeChar: string,
): string[] {
  const spans: string[] = [];
  let inSpan = false;
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") {
      inSpan = false;
      buf = "";
      continue;
    }
    if (!inSpan) {
      if (isSingleOpenerPosition(text, i, openChar)) {
        inSpan = true;
        buf = "";
      }
      continue;
    }
    if (ch === closeChar) {
      const next = text[i + 1];
      if (next !== undefined && isWordChar(next)) {
        buf += ch; // apostrophe, kept literally
      } else {
        spans.push(buf);
        inSpan = false;
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  return spans;
}

/** Ellipsis, straight (`...`) or Unicode (`…`). */
const ELLIPSIS_PATTERN = /…|\.\.\./g;

/**
 * Extract every quoted span of 4 or more words from `text` (Issue #3244).
 *
 * Runs four independent linear scanners — no backtracking regex — over
 * straight double quotes, curly double quotes (`“ ”`), straight single
 * quotes, and curly single quotes (`‘ ’`); see {@link scanStraightDouble},
 * {@link scanCurlyDouble} and {@link scanSingle}. Each raw span is split at
 * an ellipsis (`…` or `...`), each fragment trimmed, and only fragments with
 * 4 or more words (a word being a whitespace-separated token containing a
 * Unicode letter or digit) are kept. Results are de-duplicated, keeping
 * first-seen order.
 */
export function extractQuotedSpans(text: string): string[] {
  const raw = [
    ...scanStraightDouble(text),
    ...scanCurlyDouble(text),
    ...scanSingle(text, "'", "'"),
    ...scanSingle(text, "‘", "’"),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const span of raw) {
    for (const fragment of span.split(ELLIPSIS_PATTERN)) {
      const trimmed = fragment.trim();
      if (trimmed === "" || wordCount(trimmed) < 4) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Normalise text for a quote-match comparison (Issue #3244).
 *
 * Lowercases, folds curly quotes to straight and unescapes `\"`, drops
 * markdown emphasis markers (`*`, `` ` ``, `_`), collapses whitespace runs to
 * a single space, and trims. Apply to both sides of every comparison.
 */
export function normaliseForQuoteMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/\\"/g, '"')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[*`_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A quoted sentence from a change request that is still present in a summary. */
export interface StaleQuote {
  /** The PR summary path the quote is still found in. */
  file: string;
  /** The quote, verbatim as it appeared in the change request. */
  quote: string;
}

/**
 * Find quotes the change request says are wrong that are still present in
 * the named PR summaries (Issue #3244).
 *
 * Only findings whose `file` is a PR summary path ({@link isPrSummaryPath})
 * are checked; findings on other files are ignored. When `summaries` maps a
 * named summary to `undefined`, the file could not be read inside the
 * checkout — it is reported once in `unchecked` rather than silently
 * skipped. Otherwise, every 4+-word quoted span in the finding's `problem`
 * ({@link extractQuotedSpans}) whose normalised form
 * ({@link normaliseForQuoteMatch}) is a substring of the normalised summary
 * is a stale quote. Results are de-duplicated by file + normalised quote.
 */
export function findStaleQuotes(
  findings: readonly ChangeRequestFinding[],
  summaries: ReadonlyMap<string, string | undefined>,
): { stale: StaleQuote[]; unchecked: string[] } {
  const stale: StaleQuote[] = [];
  const uncheckedSeen = new Set<string>();
  const unchecked: string[] = [];
  const staleSeen = new Set<string>();

  for (const finding of findings) {
    if (!isPrSummaryPath(finding.file)) continue;
    const content = summaries.get(finding.file);
    if (content === undefined) {
      if (!uncheckedSeen.has(finding.file)) {
        uncheckedSeen.add(finding.file);
        unchecked.push(finding.file);
      }
      continue;
    }
    const normalisedContent = normaliseForQuoteMatch(content);
    for (const quote of extractQuotedSpans(finding.problem)) {
      const normalisedQuote = normaliseForQuoteMatch(quote);
      if (!normalisedContent.includes(normalisedQuote)) continue;
      const key = `${finding.file}\u0000${normalisedQuote}`;
      if (staleSeen.has(key)) continue;
      staleSeen.add(key);
      stale.push({ file: finding.file, quote });
    }
  }

  return { stale, unchecked };
}

/** The unique PR summary paths named by `findings`, first-seen order. */
export function summaryFilesNamedBy(
  findings: readonly ChangeRequestFinding[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const finding of findings) {
    if (!isPrSummaryPath(finding.file)) continue;
    if (seen.has(finding.file)) continue;
    seen.add(finding.file);
    out.push(finding.file);
  }
  return out;
}
