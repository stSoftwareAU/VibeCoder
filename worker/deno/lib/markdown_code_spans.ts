/**
 * Shared, paragraph-aware Markdown code-span splitter (Issue #3313).
 *
 * A gate that must ignore Markdown code cannot pair backticks one line at a
 * time: CommonMark lets an inline span (`` `like this` ``) wrap across a line
 * break, and only resets at a *blank* line — a lone, unmatched backtick on
 * one line can legitimately pair with one on the very next line of the same
 * paragraph. A per-line regex such as `` /`[^`\n]*`/g `` never crosses a line
 * at all, so it fails the other way: a span's closing backtick, alone on its
 * own line, instead pairs with the *next* opening backtick that line
 * happens to contain — masking real prose as code, and reading a wrapped
 * span's contents as prose a reference can hide in.
 *
 * A paragraph also ends — without a blank line — at any line that starts a
 * new block: an ATX heading, a list-item marker, a table row, or a setext
 * underline / thematic break (Issue #3351 review, two rounds). CommonMark
 * never lets a span cross into one of these, so a literal unmatched
 * backtick in one list item or heading must not pair with a backtick in a
 * later block and hide the prose between them. These markers are matched at
 * any indentation (`^[ \t]*`, not CommonMark's 0-3-space limit): a Markdown
 * renderer still treats a deeply-nested list item or a tab-indented one as a
 * list item, and archived summaries indent list content well past three
 * spaces (see {@link parseFenceLine}). An ATX heading is additionally a
 * one-line block on its own: nothing after it continues the same paragraph,
 * even without a blank line.
 *
 * A block quote marker (`>`) is different: CommonMark lets consecutive `>`
 * lines form one quoted *paragraph*, so a span may still wrap across them.
 * The paragraph only ends where the quote starts or ends — a quoted line
 * following an unquoted one, or the reverse — not on every `>` line. But a
 * quoted line can still open one of the blocks above *inside* the quote: a
 * quoted blank line (`>` with nothing after), list item, heading, table row
 * or break must end the paragraph the same way the unquoted form does, so
 * the blank-line and block-start checks run on the line with its quote
 * marker(s) stripped, not on the raw `>`-prefixed line (Issue #3351 review,
 * round 3). The quote is tracked by *depth* (how many `>` levels), not just
 * whether a line is quoted: a nested quote opening inside a quote (`> > ...`
 * after `> ...`) starts a new block quote that interrupts the outer quote's
 * paragraph, so any change of depth ends the paragraph too, while lines at
 * the same depth still join (Issue #3351 review, round 4).
 *
 * An HTML comment (`<!-- ... -->`) also interrupts a paragraph in
 * CommonMark: a line whose content, after optional indentation (and any
 * quote prefix), starts with `<!--` opens an HTML block that the paragraph
 * never continues into, and the block runs to the line containing `-->`
 * (which may be the same line). A stray backtick before such a line must
 * not pair with one on or after it (Issue #3351 review, round 3).
 *
 * A fenced block opens on a line whose first non-space characters are three
 * or more backticks or tildes (an optional info string may follow on the
 * opening line). It closes only on a later line that starts with the *same*
 * character, run at least as long as the opener's, and nothing but
 * whitespace after the run — a shorter run, a different character, or a run
 * with an info string does not close it. An opener with no matching closer
 * runs fail-safe to the end of the text: everything after it is treated as
 * code, so a broken fence can never leak a reference out of a documentation
 * block.
 *
 * Its callers today are the result-placeholder gate, `stripCodeSpans` /
 * `maskCodeSpans` in `issue_dependencies.ts` (and through them the
 * blocked-outcome detector and the marker probes in `planning_handoff.ts`
 * and `time_deferral.ts`), and the blocked-outcome detector's fence scan. A
 * new gate that must ignore Markdown code calls into this module rather
 * than pairing backticks with a per-line regex.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** One segment of text, tagged with whether it sits inside Markdown code. */
export interface MarkdownSegment {
  value: string;
  inCode: boolean;
}

/** A fence line: the marker character, how long the run is, and the rest of the line. */
export interface FenceLine {
  char: string;
  length: number;
  rest: string;
}

/**
 * A line whose first non-space characters are a fence. Indent is ignored, so
 * a fence under a list item counts. CommonMark's three-space limit does not:
 * archived summaries indent list fences further than that.
 */
export function parseFenceLine(line: string): FenceLine | null {
  // `split` keeps the line break, and `.` does not match it, so trim first.
  // The rest is read with `([^\n]*)` and no `$`, not `(.*)$`: `.` stops at a
  // lone `\r` or a Unicode line/paragraph separator, so a run-length
  // backtrack through `(.*)$` rescanned to the end on every length — O(run
  // length × line length) on a line where one of those follows a long fence
  // run (Issue #3351 review; same shape as Issue #3186).
  const match = line.trim().match(/^(`{3,}|~{3,})([^\n]*)/);
  if (!match) return null;
  return {
    char: match[1]![0]!,
    length: match[1]!.length,
    rest: match[2] ?? "",
  };
}

/** A closer uses the opener's character, is at least as long, and has no info string. */
export function isClosingFence(line: string, opener: FenceLine): boolean {
  const parsed = parseFenceLine(line);
  if (!parsed) return false;
  return parsed.char === opener.char && parsed.length >= opener.length &&
    parsed.rest.trim() === "";
}

/**
 * Pair inline code spans inside one paragraph. A run of N backticks closes
 * at the next run of exactly N, and that span may contain a line break.
 * A run with no closer is literal text. CommonMark does not let a span
 * cross a blank line, so the caller passes one paragraph at a time.
 *
 * Linear in the number of backtick runs: for each opener, the index of the
 * next run of the same length is looked up in a map built with a single
 * backwards pass, rather than re-scanning forward from every opener (which
 * is quadratic when many distinct-length unmatched runs precede many runs of
 * their own). This helper runs on untrusted issue bodies on the claim path.
 */
function splitInlineSpans(block: string): MarkdownSegment[] {
  const runs: Array<{ index: number; length: number }> = [];
  const runRe = /`+/g;
  let found: RegExpExecArray | null;
  while ((found = runRe.exec(block)) !== null) {
    runs.push({ index: found.index, length: found[0].length });
  }

  // For each run, the index of the next run with the same length, found with
  // a single backwards pass instead of a forward re-scan per opener.
  const nextSameLength: number[] = new Array(runs.length).fill(-1);
  const lastSeenAt = new Map<number, number>();
  for (let k = runs.length - 1; k >= 0; k--) {
    const seen = lastSeenAt.get(runs[k]!.length);
    nextSameLength[k] = seen ?? -1;
    lastSeenAt.set(runs[k]!.length, k);
  }

  const segments: MarkdownSegment[] = [];
  let cursor = 0;
  let r = 0;
  while (r < runs.length) {
    const open = runs[r]!;
    if (open.index > cursor) {
      segments.push({ value: block.slice(cursor, open.index), inCode: false });
    }
    const closeAt = nextSameLength[r]!;
    if (closeAt === -1) {
      const end = open.index + open.length;
      segments.push({ value: block.slice(open.index, end), inCode: false });
      cursor = end;
      r++;
      continue;
    }
    const close = runs[closeAt]!;
    const end = close.index + close.length;
    segments.push({ value: block.slice(open.index, end), inCode: true });
    cursor = end;
    r = closeAt + 1;
  }
  if (cursor < block.length) {
    segments.push({ value: block.slice(cursor), inCode: false });
  }
  return segments;
}

/**
 * An ATX heading: leading whitespace, 1-6 `#`, then whitespace or end of
 * line. CommonMark gives it no continuation line — the heading is the whole
 * block, so `splitMarkdownCode` flushes the paragraph buffer both before
 * *and* immediately after one. Indentation is unbounded (`^[ \t]*`), like
 * {@link parseFenceLine} — `#{1,6}` is capped, so widening the leading
 * whitespace adds no backtracking risk.
 */
const ATX_HEADING_RE = /^[ \t]*#{1,6}(?:[ \t]|$)/;

/**
 * A list-item marker: leading whitespace, a bullet (`-`, `*`, `+`) or an
 * ordered marker (`1.` / `1)`), then whitespace or end of line. Indentation
 * is unbounded, so a nested or tab-indented item still counts — see
 * {@link ATX_HEADING_RE}.
 */
const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/**
 * One or more quote-marker levels at the start of a line, plus at most one
 * space/tab right after the last `>` (CommonMark strips at most one). Every
 * repetition of the outer `+` must itself consume a literal `>`, so the
 * match length is bounded by the number of `>` characters present — no
 * quantifier here can backtrack over the same characters as another one
 * (Issue #3351 review, round 3; same class of risk as Issue #3186).
 */
const QUOTE_PREFIX_RE = /^(?:[ \t]*>)+[ \t]?/;

/**
 * Strip the leading quote marker(s) from `line`, so the blank-line and
 * block-start checks below see the quoted *content*, not the `>` prefix —
 * a quoted blank line, list item, heading, table row or break must end the
 * paragraph the same way the unquoted form does. A line with no `>` prefix
 * is returned unchanged.
 */
function stripQuotePrefix(line: string): string {
  return line.replace(QUOTE_PREFIX_RE, "");
}

/**
 * How many block-quote levels open `line`: the number of `>` characters in
 * its {@link QUOTE_PREFIX_RE} match, or 0 for an unquoted line. Counted with
 * a single linear pass over the matched prefix, so it adds no backtracking
 * risk (Issue #3351 review, round 4).
 */
function quoteDepth(line: string): number {
  const prefix = QUOTE_PREFIX_RE.exec(line)?.[0] ?? "";
  let depth = 0;
  for (const ch of prefix) if (ch === ">") depth++;
  return depth;
}

/**
 * An HTML comment opener: leading whitespace, then `<!--`. In CommonMark
 * this starts an HTML block that interrupts a paragraph; the block runs to
 * the line containing `-->` (Issue #3351 review, round 3).
 */
const HTML_COMMENT_START_RE = /^[ \t]*<!--/;

/**
 * A GFM table row: leading whitespace, then `|`. A table row ends a
 * paragraph the same way a heading does, even without one of GFM's
 * delimiter rows present — a stray backtick in one cell must not pair with
 * one in a later row.
 */
const TABLE_ROW_RE = /^[ \t]*\|/;

/**
 * A setext heading underline (`===` / `---`) or a thematic break (`---`,
 * `***`, `___`): leading whitespace, then one of `=*_-` repeated with no
 * other character, then trailing whitespace and an optional line
 * terminator — `splitMarkdownCode`'s lines keep their own `\n`, so `$`
 * alone would never match a line that still carries one. The three
 * quantifiers never match the same characters: the backreference `\1*`
 * matches only the fixed marker character, the leading/trailing `[ \t]*`
 * only space/tab, so there is no catastrophic backtracking on a long run
 * (Issue #3351 review; same class of risk as Issue #3186).
 */
const SETEXT_OR_THEMATIC_BREAK_RE = /^[ \t]*([=*_-])\1*[ \t]*(?:\r?\n)?$/;

/**
 * Does `line` start a new CommonMark block that a paragraph never continues
 * into (Issue #3351 review)? A literal backtick in one list item, heading,
 * table row or setext/thematic-break line must not pair with a backtick in
 * a later block. The caller passes the line with any quote prefix already
 * stripped, so a quoted list item, heading, table row or break is detected
 * too (round 3) — a block-quote marker itself is handled separately by the
 * caller, since consecutive `>` lines form one quoted paragraph rather than
 * each ending it.
 */
function startsNewBlock(line: string): boolean {
  return ATX_HEADING_RE.test(line) || LIST_ITEM_RE.test(line) ||
    TABLE_ROW_RE.test(line) || SETEXT_OR_THEMATIC_BREAK_RE.test(line);
}

/**
 * Split text into alternating "outside code" / "inside code" segments, so
 * callers can scan or rewrite only the prose a reader actually sees.
 * Fenced blocks (``` or ~~~, to the matching close or end of text) and
 * inline backtick spans are both "inside code" — a token named for
 * discussion (`` `REDACTION_PLACEHOLDER` ``) is not an unfilled result.
 *
 * The returned segments concatenate back to `text` exactly.
 */
export function splitMarkdownCode(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const lines = (text ?? "").split(/(?<=\n)/); // keep line terminators attached
  let i = 0;
  let fenceCursor = "";
  let paragraph = "";
  let inFence = false;
  let opener: FenceLine | null = null;
  // How many block-quote levels the open paragraph sits in (0 = unquoted) —
  // tracked separately from `startsNewBlock` because consecutive `>` lines
  // at the same depth form one quoted paragraph (Issue #3351 review): the
  // paragraph flushes only where the depth changes — a quote starting,
  // ending, or nesting deeper / shallower (round 4) — not on every `>` line.
  let currentQuoteDepth = 0;
  // Whether the current line is inside an HTML comment opened on an earlier
  // line that has not yet closed with `-->` (round 3).
  let inComment = false;

  function pushSegment(value: string, inCode: boolean) {
    if (value.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.inCode === inCode) last.value += value;
    else segments.push({ value, inCode });
  }

  function flushParagraph() {
    if (paragraph.length === 0) return;
    for (const segment of splitInlineSpans(paragraph)) {
      pushSegment(segment.value, segment.inCode);
    }
    paragraph = "";
  }

  while (i < lines.length) {
    const line = lines[i]!;
    const fenceMatch = parseFenceLine(line);
    if (fenceMatch && !inFence) {
      flushParagraph();
      currentQuoteDepth = 0;
      inFence = true;
      opener = fenceMatch;
      fenceCursor += line;
      i++;
      continue;
    }
    if (inFence && opener && isClosingFence(line, opener)) {
      fenceCursor += line;
      pushSegment(fenceCursor, true);
      fenceCursor = "";
      inFence = false;
      opener = null;
      i++;
      continue;
    }
    if (inFence) {
      fenceCursor += line;
      i++;
      continue;
    }
    // A line inside an already-open HTML comment stays part of it until the
    // line that closes it with `-->` — blank lines, list markers, etc. do
    // not end an HTML block the way they end a paragraph (round 3).
    if (inComment) {
      paragraph += line;
      if (line.includes("-->")) {
        flushParagraph();
        inComment = false;
      }
      i++;
      continue;
    }
    // The blank-line and block-start checks below see the quoted *content*,
    // with any `>` prefix stripped — a quoted blank line, list item,
    // heading, table row or break must end the paragraph the same way the
    // unquoted form does (Issue #3351 review, round 3).
    const content = stripQuotePrefix(line);
    // A blank line ends the paragraph, so a code span cannot cross it.
    if (content.trim() === "") {
      flushParagraph();
      pushSegment(line, false);
      currentQuoteDepth = 0;
      i++;
      continue;
    }
    // Entering, leaving or changing the depth of a block quote ends the
    // paragraph; staying at the same depth does not, so consecutive quoted
    // lines stay one paragraph and a span may still wrap across them (Issue
    // #3351 review). A deeper `> > ...` line opens a nested quote that
    // interrupts the outer paragraph (round 4). A shallower line could be a
    // CommonMark lazy continuation, but flushing there too is the safe
    // direction: it can only stop a span pairing, never hide prose.
    const lineQuoteDepth = quoteDepth(line);
    if (lineQuoteDepth !== currentQuoteDepth) {
      flushParagraph();
      currentQuoteDepth = lineQuoteDepth;
    }
    // A line starting an HTML comment ends the paragraph; the comment runs
    // to the line holding `-->`, which may be this same line (round 3).
    if (HTML_COMMENT_START_RE.test(content)) {
      flushParagraph();
      paragraph += line;
      if (line.includes("-->")) {
        flushParagraph();
      } else {
        inComment = true;
      }
      i++;
      continue;
    }
    // A heading, list item, table row or setext/thematic-break line also
    // ends the paragraph, the same way a blank line does (Issue #3351
    // review).
    if (startsNewBlock(content)) {
      flushParagraph();
      paragraph += line;
      // An ATX heading has no continuation line, so it never merges with
      // whatever follows it.
      if (ATX_HEADING_RE.test(content)) flushParagraph();
      i++;
      continue;
    }
    paragraph += line;
    i++;
  }
  if (inFence) pushSegment(fenceCursor, true);
  else flushParagraph();
  return segments;
}

/**
 * Replace every in-code character (everything but `\n`) with a space, so the
 * result is the same length — and every offset lines up — as `text`, but
 * carries only the prose a reader actually sees.
 */
export function maskMarkdownCode(text: string): string {
  return splitMarkdownCode(text)
    .map((segment) =>
      segment.inCode ? segment.value.replace(/[^\n]/g, " ") : segment.value
    )
    .join("");
}

/**
 * Remove all Markdown code (fenced blocks and inline spans, including the
 * fence lines and their line breaks, and any line break inside an inline
 * span) from `text`, leaving only the non-code prose joined back together.
 */
export function stripMarkdownCode(text: string): string {
  return splitMarkdownCode(text)
    .filter((segment) => !segment.inCode)
    .map((segment) => segment.value)
    .join("");
}
