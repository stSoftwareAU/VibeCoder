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
 * new block: an ATX heading, a list-item marker, or a block quote marker
 * (Issue #3351 review). CommonMark never lets a span cross into one of
 * these, so a literal unmatched backtick in one list item or heading must
 * not pair with a backtick in a later block and hide the prose between them.
 * An ATX heading is additionally a one-line block on its own: nothing after
 * it continues the same paragraph, even without a blank line.
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
 * An ATX heading: up to three leading spaces, 1-6 `#`, then whitespace or
 * end of line. CommonMark gives it no continuation line — the heading is the
 * whole block, so `splitMarkdownCode` flushes the paragraph buffer both
 * before *and* immediately after one.
 */
const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/**
 * A list-item marker: up to three leading spaces, a bullet (`-`, `*`, `+`)
 * or an ordered marker (`1.` / `1)`), then whitespace or end of line.
 */
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/** A block-quote marker: up to three leading spaces, then `>`. */
const BLOCK_QUOTE_RE = /^ {0,3}>/;

/**
 * Does `line` start a new CommonMark block that a paragraph never continues
 * into (Issue #3351 review)? A literal backtick in one list item or heading
 * must not pair with a backtick in a later block.
 */
function startsNewBlock(line: string): boolean {
  return ATX_HEADING_RE.test(line) || LIST_ITEM_RE.test(line) ||
    BLOCK_QUOTE_RE.test(line);
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
    // A blank line ends the paragraph, so a code span cannot cross it.
    if (line.trim() === "") {
      flushParagraph();
      pushSegment(line, false);
      i++;
      continue;
    }
    // A heading, list item or block quote also ends the paragraph, the same
    // way a blank line does (Issue #3351 review).
    if (startsNewBlock(line)) {
      flushParagraph();
      paragraph += line;
      // An ATX heading has no continuation line, so it never merges with
      // whatever follows it.
      if (ATX_HEADING_RE.test(line)) flushParagraph();
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
