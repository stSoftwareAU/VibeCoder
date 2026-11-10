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
 * The module now also answers "which lines form one statement?" via
 * {@link markdownLogicalUnits} (Issue #3356): a gate over Markdown prose
 * matches per logical unit rather than per physical line, because the prose is
 * hard-wrapped. Its callers are a removed summary gate in a removed summary gate,
 * `logicalBlocks` in `test_plan_recount.ts` (and through it
 * a removed summary gate), and the uncaptured-line grouping of the
 * unreached-admission check in a removed summary gate. A new gate over
 * Markdown prose calls it rather than splitting on "\n".
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ /** One segment of text, tagged with whether it sits inside Markdown code. */ function tick(meter) {
  if (meter) meter.steps++;
}
/** `$` in these patterns: end of the line, or the final newline itself. */ function atLineEnd(line, index) {
  if (index >= line.length) return true;
  return line.endsWith("\n") && index === line.length - 1;
}
/**
 * A line whose first non-space characters are a fence. Indent is ignored, so
 * a fence under a list item counts. CommonMark's three-space limit does not:
 * archived summaries indent list fences further than that.
 */ export function parseFenceLine(line, meter) {
  // `split` keeps the line break, so trim first. The rest is every character
  // up to a newline, read once: a `(.*)$` tail stops at a lone `\r` and
  // backtracked the run length over the line (Issue #3351 review; same shape
  // as Issue #3186). One pass records a step per character it examines.
  const trimmed = line.trim();
  const fenceChar = trimmed[0];
  if (fenceChar !== "`" && fenceChar !== "~") {
    if (trimmed.length > 0) tick(meter);
    return null;
  }
  let length = 0;
  while(length < trimmed.length && trimmed[length] === fenceChar){
    tick(meter);
    length++;
  }
  if (length < 3) return null;
  let end = length;
  while(end < trimmed.length && trimmed[end] !== "\n"){
    tick(meter);
    end++;
  }
  return {
    char: fenceChar,
    length,
    rest: trimmed.slice(length, end)
  };
}
/** A closer uses the opener's character, is at least as long, and has no info string. */ export function isClosingFence(line, opener, meter) {
  const parsed = parseFenceLine(line, meter);
  if (!parsed) return false;
  return parsed.char === opener.char && parsed.length >= opener.length && parsed.rest.trim() === "";
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
 */ function splitInlineSpans(block, meter) {
  const runs = [];
  let i = 0;
  while(i < block.length){
    if (block[i] !== "`") {
      tick(meter);
      i++;
      continue;
    }
    const start = i;
    while(i < block.length && block[i] === "`"){
      tick(meter);
      i++;
    }
    runs.push({
      index: start,
      length: i - start
    });
  }
  // For each run, the index of the next run with the same length, found with
  // a single backwards pass instead of a forward re-scan per opener. Each
  // run examined is one step, so a nested rescan shows up as super-linear.
  const nextSameLength = new Array(runs.length).fill(-1);
  const lastSeenAt = new Map();
  for(let k = runs.length - 1; k >= 0; k--){
    tick(meter);
    const seen = lastSeenAt.get(runs[k].length);
    nextSameLength[k] = seen ?? -1;
    lastSeenAt.set(runs[k].length, k);
  }
  const segments = [];
  let cursor = 0;
  let r = 0;
  while(r < runs.length){
    tick(meter);
    const open = runs[r];
    if (open.index > cursor) {
      segments.push({
        value: block.slice(cursor, open.index),
        inCode: false
      });
    }
    const closeAt = nextSameLength[r];
    if (closeAt === -1) {
      const end = open.index + open.length;
      segments.push({
        value: block.slice(open.index, end),
        inCode: false
      });
      cursor = end;
      r++;
      continue;
    }
    const close = runs[closeAt];
    const end = close.index + close.length;
    segments.push({
      value: block.slice(open.index, end),
      inCode: true
    });
    cursor = end;
    r = closeAt + 1;
  }
  if (cursor < block.length) {
    segments.push({
      value: block.slice(cursor),
      inCode: false
    });
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
 */ function isAtxHeading(line, meter) {
  let i = 0;
  while(i < line.length && (line[i] === " " || line[i] === "\t")){
    tick(meter);
    i++;
  }
  let hashes = 0;
  while(hashes < 6 && i < line.length && line[i] === "#"){
    tick(meter);
    hashes++;
    i++;
  }
  if (hashes === 0) return false;
  // A seventh hash is not an ATX heading. Stop; do not walk the run again.
  if (i < line.length && line[i] === "#") return false;
  if (i < line.length && (line[i] === " " || line[i] === "\t")) return true;
  return atLineEnd(line, i);
}
/**
 * A list-item marker: leading whitespace, a bullet (`-`, `*`, `+`) or an
 * ordered marker (`1.` / `1)`), then whitespace or end of line. Indentation
 * is unbounded, so a nested or tab-indented item still counts — see
 * {@link isAtxHeading}.
 */ function isListItem(line, meter) {
  let i = 0;
  while(i < line.length && (line[i] === " " || line[i] === "\t")){
    tick(meter);
    i++;
  }
  if (i >= line.length) return false;
  const marker = line[i];
  if (marker === "-" || marker === "*" || marker === "+") {
    tick(meter);
    i++;
  } else if (marker >= "0" && marker <= "9") {
    let digits = 0;
    while(digits < 9 && i < line.length && line[i] >= "0" && line[i] <= "9"){
      tick(meter);
      digits++;
      i++;
    }
    if (i < line.length && line[i] >= "0" && line[i] <= "9") return false;
    if (i >= line.length || line[i] !== "." && line[i] !== ")") return false;
    tick(meter);
    i++;
  } else {
    return false;
  }
  if (i < line.length && (line[i] === " " || line[i] === "\t")) return true;
  return atLineEnd(line, i);
}
/**
 * One or more quote-marker levels at the start of a line, plus at most one
 * space/tab right after the last `>` (CommonMark strips at most one). Every
 * repetition of the outer `+` must itself consume a literal `>`, so the
 * match length is bounded by the number of `>` characters present — no
 * quantifier here can backtrack over the same characters as another one
 * (Issue #3351 review, round 3; same class of risk as Issue #3186).
 */ /**
 * Leading quote markers, read once. Each repetition consumes a `>`, so a
 * run of markers is one linear pass (Issue #3351 review, round 3). At most
 * one space or tab after the last `>` is part of the prefix.
 */ function quotePrefix(line, meter) {
  let i = 0;
  let depth = 0;
  while(i < line.length){
    let j = i;
    while(j < line.length && (line[j] === " " || line[j] === "\t")){
      tick(meter);
      j++;
    }
    if (j >= line.length || line[j] !== ">") break;
    tick(meter);
    depth++;
    i = j + 1;
  }
  if (depth === 0) return {
    end: 0,
    depth: 0
  };
  if (i < line.length && (line[i] === " " || line[i] === "\t")) {
    tick(meter);
    i++;
  }
  return {
    end: i,
    depth
  };
}
/**
 * Strip the leading quote marker(s) from `line`, so the blank-line and
 * block-start checks below see the quoted *content*, not the `>` prefix —
 * a quoted blank line, list item, heading, table row or break must end the
 * paragraph the same way the unquoted form does. A line with no `>` prefix
 * is returned unchanged.
 */ function stripQuotePrefix(line, meter) {
  const prefix = quotePrefix(line, meter);
  if (prefix.depth === 0) return line;
  return line.slice(prefix.end);
}
/**
 * How many block-quote levels open `line`: the number of `>` characters in
 * its quote prefix, or 0 for an unquoted line. One linear pass (Issue #3351
 * review, round 4).
 */ function quoteDepth(line, meter) {
  return quotePrefix(line, meter).depth;
}
/**
 * An HTML comment opener: leading whitespace, then `<!--`. In CommonMark
 * this starts an HTML block that interrupts a paragraph; the block runs to
 * the line containing `-->` (Issue #3351 review, round 3).
 */ function isHtmlCommentStart(line, meter) {
  let i = 0;
  while(i < line.length && (line[i] === " " || line[i] === "\t")){
    tick(meter);
    i++;
  }
  const marker = "<!--";
  for(let k = 0; k < marker.length; k++){
    if (line[i + k] !== marker[k]) return false;
    tick(meter);
  }
  return true;
}
/**
 * A GFM table row: leading whitespace, then `|`. A table row ends a
 * paragraph the same way a heading does, even without one of GFM's
 * delimiter rows present — a stray backtick in one cell must not pair with
 * one in a later row.
 */ function isTableRow(line, meter) {
  let i = 0;
  while(i < line.length && (line[i] === " " || line[i] === "\t")){
    tick(meter);
    i++;
  }
  if (i < line.length && line[i] === "|") {
    tick(meter);
    return true;
  }
  return false;
}
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
 */ function isMarkerChar(char) {
  return char === "=" || char === "*" || char === "_" || char === "-";
}
function isSetextOrThematicBreak(line, meter) {
  let i = 0;
  while(i < line.length && (line[i] === " " || line[i] === "\t")){
    tick(meter);
    i++;
  }
  const marker = line[i];
  if (!isMarkerChar(marker)) return false;
  while(i < line.length && line[i] === marker){
    tick(meter);
    i++;
  }
  while(i < line.length && (line[i] === " " || line[i] === "\t")){
    tick(meter);
    i++;
  }
  if (line[i] === "\r" && line[i + 1] === "\n") {
    tick(meter);
    tick(meter);
    i += 2;
  } else if (line[i] === "\n") {
    tick(meter);
    i++;
  }
  return i === line.length;
}
/**
 * Does `line` start a new CommonMark block that a paragraph never continues
 * into (Issue #3351 review)? A literal backtick in one list item, heading,
 * table row or setext/thematic-break line must not pair with a backtick in
 * a later block. The caller passes the line with any quote prefix already
 * stripped, so a quoted list item, heading, table row or break is detected
 * too (round 3) — a block-quote marker itself is handled separately by the
 * caller, since consecutive `>` lines form one quoted paragraph rather than
 * each ending it.
 */ function startsNewBlock(line, meter) {
  return isAtxHeading(line, meter) || isListItem(line, meter) || isTableRow(line, meter) || isSetextOrThematicBreak(line, meter);
}
/**
 * Split text into alternating "outside code" / "inside code" segments, so
 * callers can scan or rewrite only the prose a reader actually sees.
 * Fenced blocks (``` or ~~~, to the matching close or end of text) and
 * inline backtick spans are both "inside code" — a token named for
 * discussion (`` `REDACTION_PLACEHOLDER` ``) is not an unfilled result.
 *
 * The returned segments concatenate back to `text` exactly.
 */ export function splitMarkdownCode(text, meter) {
  const segments = [];
  const lines = (text ?? "").split(/(?<=\n)/); // keep line terminators attached
  let i = 0;
  let fenceCursor = "";
  let paragraph = "";
  let inFence = false;
  let opener = null;
  // How many block-quote levels the open paragraph sits in (0 = unquoted) —
  // tracked separately from `startsNewBlock` because consecutive `>` lines
  // at the same depth form one quoted paragraph (Issue #3351 review): the
  // paragraph flushes only where the depth changes — a quote starting,
  // ending, or nesting deeper / shallower (round 4) — not on every `>` line.
  let currentQuoteDepth = 0;
  // Whether the current line is inside an HTML comment opened on an earlier
  // line that has not yet closed with `-->` (round 3).
  let inComment = false;
  function pushSegment(value, inCode) {
    if (value.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.inCode === inCode) last.value += value;
    else segments.push({
      value,
      inCode
    });
  }
  function flushParagraph() {
    if (paragraph.length === 0) return;
    for (const segment of splitInlineSpans(paragraph, meter)){
      pushSegment(segment.value, segment.inCode);
    }
    paragraph = "";
  }
  while(i < lines.length){
    const line = lines[i];
    const fenceMatch = parseFenceLine(line, meter);
    if (fenceMatch && !inFence) {
      flushParagraph();
      currentQuoteDepth = 0;
      inFence = true;
      opener = fenceMatch;
      fenceCursor += line;
      i++;
      continue;
    }
    if (inFence && opener && isClosingFence(line, opener, meter)) {
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
    const content = stripQuotePrefix(line, meter);
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
    const lineQuoteDepth = quoteDepth(line, meter);
    if (lineQuoteDepth !== currentQuoteDepth) {
      flushParagraph();
      currentQuoteDepth = lineQuoteDepth;
    }
    // A line starting an HTML comment ends the paragraph; the comment runs
    // to the line holding `-->`, which may be this same line (round 3).
    if (isHtmlCommentStart(content, meter)) {
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
    if (startsNewBlock(content, meter)) {
      flushParagraph();
      paragraph += line;
      // An ATX heading has no continuation line, so it never merges with
      // whatever follows it.
      if (isAtxHeading(content, meter)) flushParagraph();
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
 */ export function maskMarkdownCode(text) {
  return splitMarkdownCode(text).map((segment)=>segment.inCode ? segment.value.replace(/[^\n]/g, " ") : segment.value).join("");
}
/**
 * Remove all Markdown code (fenced blocks and inline spans, including the
 * fence lines and their line breaks, and any line break inside an inline
 * span) from `text`, leaving only the non-code prose joined back together.
 */ export function stripMarkdownCode(text) {
  return splitMarkdownCode(text).filter((segment)=>!segment.inCode).map((segment)=>segment.value).join("");
}
/** Split text into physical lines on every line terminator (terminators dropped). */ export function splitMarkdownLines(text) {
  return (text ?? "").split(/\r\n|[\n\r\u2028\u2029]/);
}
/**
 * Group physical Markdown lines into logical units (Issue #3356).
 *
 * PR summaries are hard-wrapped at about 78 columns, so `text.split("\n")`
 * reads half a claim per line: a gate that matches one physical line misses a
 * phrase wrapped across two. Matching per unit fixes that, and the unit
 * boundaries stop one unit's evidence excusing another unit's admission.
 *
 * One linear pass, one open unit at a time:
 * - A blank line (after the quote prefix) closes the open unit and belongs to
 *   none.
 * - A fence opener closes the open unit; every non-blank line from it to its
 *   matching closer (or the end of input) is its own one-line `code` unit, so
 *   a caller ignoring code filters `kind === "code"` and one that must check
 *   every line still sees each one.
 * - A change of quote depth closes the open unit.
 * - An HTML comment is one `html` unit through the first line holding `-->`.
 * - An ATX heading, a setext underline / thematic break (checked before list
 *   items) and a table row are each their own one-line unit.
 * - A list item opens a new `list-item` unit, at any indent.
 * - Any other line extends an open `paragraph` or `list-item` (indented or
 *   lazy alike), otherwise opens a new `paragraph`.
 */ export function markdownLogicalUnits(lines) {
  const units = [];
  let open = null;
  let openDepth = 0;
  const make = (kind, idx)=>({
      kind,
      lines: idx,
      text: idx.map((n)=>lines[n].trim()).filter((t)=>t !== "").join(" ")
    });
  const flush = ()=>{
    if (open) units.push(make(open.kind, open.lines));
    open = null;
  };
  const single = (kind, n)=>{
    flush();
    units.push(make(kind, [
      n
    ]));
  };
  let i = 0;
  while(i < lines.length){
    const line = lines[i];
    const fence = parseFenceLine(line);
    if (fence) {
      flush();
      openDepth = 0;
      if (line.trim() !== "") units.push(make("code", [
        i
      ]));
      i++;
      while(i < lines.length){
        const inner = lines[i];
        if (inner.trim() !== "") units.push(make("code", [
          i
        ]));
        i++;
        if (isClosingFence(inner, fence)) break;
      }
      continue;
    }
    const content = stripQuotePrefix(line);
    if (content.trim() === "") {
      flush();
      openDepth = 0;
      i++;
      continue;
    }
    const depth = quoteDepth(line);
    if (depth !== openDepth) {
      flush();
      openDepth = depth;
    }
    if (isHtmlCommentStart(content)) {
      flush();
      const idx = [
        i
      ];
      let closed = line.includes("-->");
      i++;
      while(!closed && i < lines.length){
        idx.push(i);
        closed = lines[i].includes("-->");
        i++;
      }
      units.push(make("html", idx));
      continue;
    }
    if (isAtxHeading(content)) {
      single("heading", i);
    } else if (isSetextOrThematicBreak(content)) {
      single("break", i);
    } else if (isListItem(content)) {
      flush();
      open = {
        kind: "list-item",
        lines: [
          i
        ]
      };
    } else if (isTableRow(content)) {
      single("table-row", i);
    } else if (open && (open.kind === "paragraph" || open.kind === "list-item")) {
      open.lines.push(i);
    } else {
      flush();
      open = {
        kind: "paragraph",
        lines: [
          i
        ]
      };
    }
    i++;
  }
  flush();
  return units;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9tYXJrZG93bl9jb2RlX3NwYW5zLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU2hhcmVkLCBwYXJhZ3JhcGgtYXdhcmUgTWFya2Rvd24gY29kZS1zcGFuIHNwbGl0dGVyIChJc3N1ZSAjMzMxMykuXG4gKlxuICogQSBnYXRlIHRoYXQgbXVzdCBpZ25vcmUgTWFya2Rvd24gY29kZSBjYW5ub3QgcGFpciBiYWNrdGlja3Mgb25lIGxpbmUgYXQgYVxuICogdGltZTogQ29tbW9uTWFyayBsZXRzIGFuIGlubGluZSBzcGFuIChgYCBgbGlrZSB0aGlzYCBgYCkgd3JhcCBhY3Jvc3MgYSBsaW5lXG4gKiBicmVhaywgYW5kIG9ubHkgcmVzZXRzIGF0IGEgKmJsYW5rKiBsaW5lIOKAlCBhIGxvbmUsIHVubWF0Y2hlZCBiYWNrdGljayBvblxuICogb25lIGxpbmUgY2FuIGxlZ2l0aW1hdGVseSBwYWlyIHdpdGggb25lIG9uIHRoZSB2ZXJ5IG5leHQgbGluZSBvZiB0aGUgc2FtZVxuICogcGFyYWdyYXBoLiBBIHBlci1saW5lIHJlZ2V4IHN1Y2ggYXMgYGAgL2BbXmBcXG5dKmAvZyBgYCBuZXZlciBjcm9zc2VzIGEgbGluZVxuICogYXQgYWxsLCBzbyBpdCBmYWlscyB0aGUgb3RoZXIgd2F5OiBhIHNwYW4ncyBjbG9zaW5nIGJhY2t0aWNrLCBhbG9uZSBvbiBpdHNcbiAqIG93biBsaW5lLCBpbnN0ZWFkIHBhaXJzIHdpdGggdGhlICpuZXh0KiBvcGVuaW5nIGJhY2t0aWNrIHRoYXQgbGluZVxuICogaGFwcGVucyB0byBjb250YWluIOKAlCBtYXNraW5nIHJlYWwgcHJvc2UgYXMgY29kZSwgYW5kIHJlYWRpbmcgYSB3cmFwcGVkXG4gKiBzcGFuJ3MgY29udGVudHMgYXMgcHJvc2UgYSByZWZlcmVuY2UgY2FuIGhpZGUgaW4uXG4gKlxuICogQSBwYXJhZ3JhcGggYWxzbyBlbmRzIOKAlCB3aXRob3V0IGEgYmxhbmsgbGluZSDigJQgYXQgYW55IGxpbmUgdGhhdCBzdGFydHMgYVxuICogbmV3IGJsb2NrOiBhbiBBVFggaGVhZGluZywgYSBsaXN0LWl0ZW0gbWFya2VyLCBhIHRhYmxlIHJvdywgb3IgYSBzZXRleHRcbiAqIHVuZGVybGluZSAvIHRoZW1hdGljIGJyZWFrIChJc3N1ZSAjMzM1MSByZXZpZXcsIHR3byByb3VuZHMpLiBDb21tb25NYXJrXG4gKiBuZXZlciBsZXRzIGEgc3BhbiBjcm9zcyBpbnRvIG9uZSBvZiB0aGVzZSwgc28gYSBsaXRlcmFsIHVubWF0Y2hlZFxuICogYmFja3RpY2sgaW4gb25lIGxpc3QgaXRlbSBvciBoZWFkaW5nIG11c3Qgbm90IHBhaXIgd2l0aCBhIGJhY2t0aWNrIGluIGFcbiAqIGxhdGVyIGJsb2NrIGFuZCBoaWRlIHRoZSBwcm9zZSBiZXR3ZWVuIHRoZW0uIFRoZXNlIG1hcmtlcnMgYXJlIG1hdGNoZWQgYXRcbiAqIGFueSBpbmRlbnRhdGlvbiAoYF5bIFxcdF0qYCwgbm90IENvbW1vbk1hcmsncyAwLTMtc3BhY2UgbGltaXQpOiBhIE1hcmtkb3duXG4gKiByZW5kZXJlciBzdGlsbCB0cmVhdHMgYSBkZWVwbHktbmVzdGVkIGxpc3QgaXRlbSBvciBhIHRhYi1pbmRlbnRlZCBvbmUgYXMgYVxuICogbGlzdCBpdGVtLCBhbmQgYXJjaGl2ZWQgc3VtbWFyaWVzIGluZGVudCBsaXN0IGNvbnRlbnQgd2VsbCBwYXN0IHRocmVlXG4gKiBzcGFjZXMgKHNlZSB7QGxpbmsgcGFyc2VGZW5jZUxpbmV9KS4gQW4gQVRYIGhlYWRpbmcgaXMgYWRkaXRpb25hbGx5IGFcbiAqIG9uZS1saW5lIGJsb2NrIG9uIGl0cyBvd246IG5vdGhpbmcgYWZ0ZXIgaXQgY29udGludWVzIHRoZSBzYW1lIHBhcmFncmFwaCxcbiAqIGV2ZW4gd2l0aG91dCBhIGJsYW5rIGxpbmUuXG4gKlxuICogQSBibG9jayBxdW90ZSBtYXJrZXIgKGA+YCkgaXMgZGlmZmVyZW50OiBDb21tb25NYXJrIGxldHMgY29uc2VjdXRpdmUgYD5gXG4gKiBsaW5lcyBmb3JtIG9uZSBxdW90ZWQgKnBhcmFncmFwaCosIHNvIGEgc3BhbiBtYXkgc3RpbGwgd3JhcCBhY3Jvc3MgdGhlbS5cbiAqIFRoZSBwYXJhZ3JhcGggb25seSBlbmRzIHdoZXJlIHRoZSBxdW90ZSBzdGFydHMgb3IgZW5kcyDigJQgYSBxdW90ZWQgbGluZVxuICogZm9sbG93aW5nIGFuIHVucXVvdGVkIG9uZSwgb3IgdGhlIHJldmVyc2Ug4oCUIG5vdCBvbiBldmVyeSBgPmAgbGluZS4gQnV0IGFcbiAqIHF1b3RlZCBsaW5lIGNhbiBzdGlsbCBvcGVuIG9uZSBvZiB0aGUgYmxvY2tzIGFib3ZlICppbnNpZGUqIHRoZSBxdW90ZTogYVxuICogcXVvdGVkIGJsYW5rIGxpbmUgKGA+YCB3aXRoIG5vdGhpbmcgYWZ0ZXIpLCBsaXN0IGl0ZW0sIGhlYWRpbmcsIHRhYmxlIHJvd1xuICogb3IgYnJlYWsgbXVzdCBlbmQgdGhlIHBhcmFncmFwaCB0aGUgc2FtZSB3YXkgdGhlIHVucXVvdGVkIGZvcm0gZG9lcywgc29cbiAqIHRoZSBibGFuay1saW5lIGFuZCBibG9jay1zdGFydCBjaGVja3MgcnVuIG9uIHRoZSBsaW5lIHdpdGggaXRzIHF1b3RlXG4gKiBtYXJrZXIocykgc3RyaXBwZWQsIG5vdCBvbiB0aGUgcmF3IGA+YC1wcmVmaXhlZCBsaW5lIChJc3N1ZSAjMzM1MSByZXZpZXcsXG4gKiByb3VuZCAzKS4gVGhlIHF1b3RlIGlzIHRyYWNrZWQgYnkgKmRlcHRoKiAoaG93IG1hbnkgYD5gIGxldmVscyksIG5vdCBqdXN0XG4gKiB3aGV0aGVyIGEgbGluZSBpcyBxdW90ZWQ6IGEgbmVzdGVkIHF1b3RlIG9wZW5pbmcgaW5zaWRlIGEgcXVvdGUgKGA+ID4gLi4uYFxuICogYWZ0ZXIgYD4gLi4uYCkgc3RhcnRzIGEgbmV3IGJsb2NrIHF1b3RlIHRoYXQgaW50ZXJydXB0cyB0aGUgb3V0ZXIgcXVvdGUnc1xuICogcGFyYWdyYXBoLCBzbyBhbnkgY2hhbmdlIG9mIGRlcHRoIGVuZHMgdGhlIHBhcmFncmFwaCB0b28sIHdoaWxlIGxpbmVzIGF0XG4gKiB0aGUgc2FtZSBkZXB0aCBzdGlsbCBqb2luIChJc3N1ZSAjMzM1MSByZXZpZXcsIHJvdW5kIDQpLlxuICpcbiAqIEFuIEhUTUwgY29tbWVudCAoYDwhLS0gLi4uIC0tPmApIGFsc28gaW50ZXJydXB0cyBhIHBhcmFncmFwaCBpblxuICogQ29tbW9uTWFyazogYSBsaW5lIHdob3NlIGNvbnRlbnQsIGFmdGVyIG9wdGlvbmFsIGluZGVudGF0aW9uIChhbmQgYW55XG4gKiBxdW90ZSBwcmVmaXgpLCBzdGFydHMgd2l0aCBgPCEtLWAgb3BlbnMgYW4gSFRNTCBibG9jayB0aGF0IHRoZSBwYXJhZ3JhcGhcbiAqIG5ldmVyIGNvbnRpbnVlcyBpbnRvLCBhbmQgdGhlIGJsb2NrIHJ1bnMgdG8gdGhlIGxpbmUgY29udGFpbmluZyBgLS0+YFxuICogKHdoaWNoIG1heSBiZSB0aGUgc2FtZSBsaW5lKS4gQSBzdHJheSBiYWNrdGljayBiZWZvcmUgc3VjaCBhIGxpbmUgbXVzdFxuICogbm90IHBhaXIgd2l0aCBvbmUgb24gb3IgYWZ0ZXIgaXQgKElzc3VlICMzMzUxIHJldmlldywgcm91bmQgMykuXG4gKlxuICogQSBmZW5jZWQgYmxvY2sgb3BlbnMgb24gYSBsaW5lIHdob3NlIGZpcnN0IG5vbi1zcGFjZSBjaGFyYWN0ZXJzIGFyZSB0aHJlZVxuICogb3IgbW9yZSBiYWNrdGlja3Mgb3IgdGlsZGVzIChhbiBvcHRpb25hbCBpbmZvIHN0cmluZyBtYXkgZm9sbG93IG9uIHRoZVxuICogb3BlbmluZyBsaW5lKS4gSXQgY2xvc2VzIG9ubHkgb24gYSBsYXRlciBsaW5lIHRoYXQgc3RhcnRzIHdpdGggdGhlICpzYW1lKlxuICogY2hhcmFjdGVyLCBydW4gYXQgbGVhc3QgYXMgbG9uZyBhcyB0aGUgb3BlbmVyJ3MsIGFuZCBub3RoaW5nIGJ1dFxuICogd2hpdGVzcGFjZSBhZnRlciB0aGUgcnVuIOKAlCBhIHNob3J0ZXIgcnVuLCBhIGRpZmZlcmVudCBjaGFyYWN0ZXIsIG9yIGEgcnVuXG4gKiB3aXRoIGFuIGluZm8gc3RyaW5nIGRvZXMgbm90IGNsb3NlIGl0LiBBbiBvcGVuZXIgd2l0aCBubyBtYXRjaGluZyBjbG9zZXJcbiAqIHJ1bnMgZmFpbC1zYWZlIHRvIHRoZSBlbmQgb2YgdGhlIHRleHQ6IGV2ZXJ5dGhpbmcgYWZ0ZXIgaXQgaXMgdHJlYXRlZCBhc1xuICogY29kZSwgc28gYSBicm9rZW4gZmVuY2UgY2FuIG5ldmVyIGxlYWsgYSByZWZlcmVuY2Ugb3V0IG9mIGEgZG9jdW1lbnRhdGlvblxuICogYmxvY2suXG4gKlxuICogSXRzIGNhbGxlcnMgdG9kYXkgYXJlIHRoZSByZXN1bHQtcGxhY2Vob2xkZXIgZ2F0ZSwgYHN0cmlwQ29kZVNwYW5zYCAvXG4gKiBgbWFza0NvZGVTcGFuc2AgaW4gYGlzc3VlX2RlcGVuZGVuY2llcy50c2AgKGFuZCB0aHJvdWdoIHRoZW0gdGhlXG4gKiBibG9ja2VkLW91dGNvbWUgZGV0ZWN0b3IgYW5kIHRoZSBtYXJrZXIgcHJvYmVzIGluIGBwbGFubmluZ19oYW5kb2ZmLnRzYFxuICogYW5kIGB0aW1lX2RlZmVycmFsLnRzYCksIGFuZCB0aGUgYmxvY2tlZC1vdXRjb21lIGRldGVjdG9yJ3MgZmVuY2Ugc2Nhbi4gQVxuICogbmV3IGdhdGUgdGhhdCBtdXN0IGlnbm9yZSBNYXJrZG93biBjb2RlIGNhbGxzIGludG8gdGhpcyBtb2R1bGUgcmF0aGVyXG4gKiB0aGFuIHBhaXJpbmcgYmFja3RpY2tzIHdpdGggYSBwZXItbGluZSByZWdleC5cbiAqXG4gKiBUaGUgbW9kdWxlIG5vdyBhbHNvIGFuc3dlcnMgXCJ3aGljaCBsaW5lcyBmb3JtIG9uZSBzdGF0ZW1lbnQ/XCIgdmlhXG4gKiB7QGxpbmsgbWFya2Rvd25Mb2dpY2FsVW5pdHN9IChJc3N1ZSAjMzM1Nik6IGEgZ2F0ZSBvdmVyIE1hcmtkb3duIHByb3NlXG4gKiBtYXRjaGVzIHBlciBsb2dpY2FsIHVuaXQgcmF0aGVyIHRoYW4gcGVyIHBoeXNpY2FsIGxpbmUsIGJlY2F1c2UgdGhlIHByb3NlIGlzXG4gKiBoYXJkLXdyYXBwZWQuIEl0cyBjYWxsZXJzIGFyZSBhIHJlbW92ZWQgc3VtbWFyeSBnYXRlIGluIGEgcmVtb3ZlZCBzdW1tYXJ5IGdhdGUsXG4gKiBgbG9naWNhbEJsb2Nrc2AgaW4gYHRlc3RfcGxhbl9yZWNvdW50LnRzYCAoYW5kIHRocm91Z2ggaXRcbiAqIGEgcmVtb3ZlZCBzdW1tYXJ5IGdhdGUpLCBhbmQgdGhlIHVuY2FwdHVyZWQtbGluZSBncm91cGluZyBvZiB0aGVcbiAqIHVucmVhY2hlZC1hZG1pc3Npb24gY2hlY2sgaW4gYSByZW1vdmVkIHN1bW1hcnkgZ2F0ZS4gQSBuZXcgZ2F0ZSBvdmVyXG4gKiBNYXJrZG93biBwcm9zZSBjYWxscyBpdCByYXRoZXIgdGhhbiBzcGxpdHRpbmcgb24gXCJcXG5cIi5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG4vKiogT25lIHNlZ21lbnQgb2YgdGV4dCwgdGFnZ2VkIHdpdGggd2hldGhlciBpdCBzaXRzIGluc2lkZSBNYXJrZG93biBjb2RlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBNYXJrZG93blNlZ21lbnQge1xuICB2YWx1ZTogc3RyaW5nO1xuICBpbkNvZGU6IGJvb2xlYW47XG59XG5cbi8qKiBBIGZlbmNlIGxpbmU6IHRoZSBtYXJrZXIgY2hhcmFjdGVyLCBob3cgbG9uZyB0aGUgcnVuIGlzLCBhbmQgdGhlIHJlc3Qgb2YgdGhlIGxpbmUuICovXG5leHBvcnQgaW50ZXJmYWNlIEZlbmNlTGluZSB7XG4gIGNoYXI6IHN0cmluZztcbiAgbGVuZ3RoOiBudW1iZXI7XG4gIHJlc3Q6IHN0cmluZztcbn1cblxuLyoqXG4gKiBDb3VudHMgY2hhcmFjdGVycyBhIHNjYW4gZXhhbWluZXMuXG4gKlxuICogVGVzdHMgcGFzcyBvbmUgc28gYSBsaW5lYXItZ3Jvd3RoIGNoZWNrIGNvbXBhcmVzIHN0ZXAgY291bnRzLiBUaGUgY291bnRcbiAqIGRvZXMgbm90IG1vdmUgd2hlbiB0aGUgbWFjaGluZSBpcyBidXN5LCB3aGljaCBhIHdhbGwtY2xvY2sgcmF0aW8gZG9lc1xuICogKElzc3VlICM0MzEyKS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBTY2FuTWV0ZXIge1xuICBzdGVwczogbnVtYmVyO1xufVxuXG5mdW5jdGlvbiB0aWNrKG1ldGVyOiBTY2FuTWV0ZXIgfCB1bmRlZmluZWQpOiB2b2lkIHtcbiAgaWYgKG1ldGVyKSBtZXRlci5zdGVwcysrO1xufVxuXG4vKiogYCRgIGluIHRoZXNlIHBhdHRlcm5zOiBlbmQgb2YgdGhlIGxpbmUsIG9yIHRoZSBmaW5hbCBuZXdsaW5lIGl0c2VsZi4gKi9cbmZ1bmN0aW9uIGF0TGluZUVuZChsaW5lOiBzdHJpbmcsIGluZGV4OiBudW1iZXIpOiBib29sZWFuIHtcbiAgaWYgKGluZGV4ID49IGxpbmUubGVuZ3RoKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIGxpbmUuZW5kc1dpdGgoXCJcXG5cIikgJiYgaW5kZXggPT09IGxpbmUubGVuZ3RoIC0gMTtcbn1cblxuLyoqXG4gKiBBIGxpbmUgd2hvc2UgZmlyc3Qgbm9uLXNwYWNlIGNoYXJhY3RlcnMgYXJlIGEgZmVuY2UuIEluZGVudCBpcyBpZ25vcmVkLCBzb1xuICogYSBmZW5jZSB1bmRlciBhIGxpc3QgaXRlbSBjb3VudHMuIENvbW1vbk1hcmsncyB0aHJlZS1zcGFjZSBsaW1pdCBkb2VzIG5vdDpcbiAqIGFyY2hpdmVkIHN1bW1hcmllcyBpbmRlbnQgbGlzdCBmZW5jZXMgZnVydGhlciB0aGFuIHRoYXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUZlbmNlTGluZShcbiAgbGluZTogc3RyaW5nLFxuICBtZXRlcj86IFNjYW5NZXRlcixcbik6IEZlbmNlTGluZSB8IG51bGwge1xuICAvLyBgc3BsaXRgIGtlZXBzIHRoZSBsaW5lIGJyZWFrLCBzbyB0cmltIGZpcnN0LiBUaGUgcmVzdCBpcyBldmVyeSBjaGFyYWN0ZXJcbiAgLy8gdXAgdG8gYSBuZXdsaW5lLCByZWFkIG9uY2U6IGEgYCguKikkYCB0YWlsIHN0b3BzIGF0IGEgbG9uZSBgXFxyYCBhbmRcbiAgLy8gYmFja3RyYWNrZWQgdGhlIHJ1biBsZW5ndGggb3ZlciB0aGUgbGluZSAoSXNzdWUgIzMzNTEgcmV2aWV3OyBzYW1lIHNoYXBlXG4gIC8vIGFzIElzc3VlICMzMTg2KS4gT25lIHBhc3MgcmVjb3JkcyBhIHN0ZXAgcGVyIGNoYXJhY3RlciBpdCBleGFtaW5lcy5cbiAgY29uc3QgdHJpbW1lZCA9IGxpbmUudHJpbSgpO1xuICBjb25zdCBmZW5jZUNoYXIgPSB0cmltbWVkWzBdO1xuICBpZiAoZmVuY2VDaGFyICE9PSBcImBcIiAmJiBmZW5jZUNoYXIgIT09IFwiflwiKSB7XG4gICAgaWYgKHRyaW1tZWQubGVuZ3RoID4gMCkgdGljayhtZXRlcik7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgbGV0IGxlbmd0aCA9IDA7XG4gIHdoaWxlIChsZW5ndGggPCB0cmltbWVkLmxlbmd0aCAmJiB0cmltbWVkW2xlbmd0aF0gPT09IGZlbmNlQ2hhcikge1xuICAgIHRpY2sobWV0ZXIpO1xuICAgIGxlbmd0aCsrO1xuICB9XG4gIGlmIChsZW5ndGggPCAzKSByZXR1cm4gbnVsbDtcbiAgbGV0IGVuZCA9IGxlbmd0aDtcbiAgd2hpbGUgKGVuZCA8IHRyaW1tZWQubGVuZ3RoICYmIHRyaW1tZWRbZW5kXSAhPT0gXCJcXG5cIikge1xuICAgIHRpY2sobWV0ZXIpO1xuICAgIGVuZCsrO1xuICB9XG4gIHJldHVybiB7XG4gICAgY2hhcjogZmVuY2VDaGFyLFxuICAgIGxlbmd0aCxcbiAgICByZXN0OiB0cmltbWVkLnNsaWNlKGxlbmd0aCwgZW5kKSxcbiAgfTtcbn1cblxuLyoqIEEgY2xvc2VyIHVzZXMgdGhlIG9wZW5lcidzIGNoYXJhY3RlciwgaXMgYXQgbGVhc3QgYXMgbG9uZywgYW5kIGhhcyBubyBpbmZvIHN0cmluZy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0Nsb3NpbmdGZW5jZShcbiAgbGluZTogc3RyaW5nLFxuICBvcGVuZXI6IEZlbmNlTGluZSxcbiAgbWV0ZXI/OiBTY2FuTWV0ZXIsXG4pOiBib29sZWFuIHtcbiAgY29uc3QgcGFyc2VkID0gcGFyc2VGZW5jZUxpbmUobGluZSwgbWV0ZXIpO1xuICBpZiAoIXBhcnNlZCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gcGFyc2VkLmNoYXIgPT09IG9wZW5lci5jaGFyICYmIHBhcnNlZC5sZW5ndGggPj0gb3BlbmVyLmxlbmd0aCAmJlxuICAgIHBhcnNlZC5yZXN0LnRyaW0oKSA9PT0gXCJcIjtcbn1cblxuLyoqXG4gKiBQYWlyIGlubGluZSBjb2RlIHNwYW5zIGluc2lkZSBvbmUgcGFyYWdyYXBoLiBBIHJ1biBvZiBOIGJhY2t0aWNrcyBjbG9zZXNcbiAqIGF0IHRoZSBuZXh0IHJ1biBvZiBleGFjdGx5IE4sIGFuZCB0aGF0IHNwYW4gbWF5IGNvbnRhaW4gYSBsaW5lIGJyZWFrLlxuICogQSBydW4gd2l0aCBubyBjbG9zZXIgaXMgbGl0ZXJhbCB0ZXh0LiBDb21tb25NYXJrIGRvZXMgbm90IGxldCBhIHNwYW5cbiAqIGNyb3NzIGEgYmxhbmsgbGluZSwgc28gdGhlIGNhbGxlciBwYXNzZXMgb25lIHBhcmFncmFwaCBhdCBhIHRpbWUuXG4gKlxuICogTGluZWFyIGluIHRoZSBudW1iZXIgb2YgYmFja3RpY2sgcnVuczogZm9yIGVhY2ggb3BlbmVyLCB0aGUgaW5kZXggb2YgdGhlXG4gKiBuZXh0IHJ1biBvZiB0aGUgc2FtZSBsZW5ndGggaXMgbG9va2VkIHVwIGluIGEgbWFwIGJ1aWx0IHdpdGggYSBzaW5nbGVcbiAqIGJhY2t3YXJkcyBwYXNzLCByYXRoZXIgdGhhbiByZS1zY2FubmluZyBmb3J3YXJkIGZyb20gZXZlcnkgb3BlbmVyICh3aGljaFxuICogaXMgcXVhZHJhdGljIHdoZW4gbWFueSBkaXN0aW5jdC1sZW5ndGggdW5tYXRjaGVkIHJ1bnMgcHJlY2VkZSBtYW55IHJ1bnMgb2ZcbiAqIHRoZWlyIG93bikuIFRoaXMgaGVscGVyIHJ1bnMgb24gdW50cnVzdGVkIGlzc3VlIGJvZGllcyBvbiB0aGUgY2xhaW0gcGF0aC5cbiAqL1xuZnVuY3Rpb24gc3BsaXRJbmxpbmVTcGFucyhibG9jazogc3RyaW5nLCBtZXRlcj86IFNjYW5NZXRlcik6IE1hcmtkb3duU2VnbWVudFtdIHtcbiAgY29uc3QgcnVuczogQXJyYXk8eyBpbmRleDogbnVtYmVyOyBsZW5ndGg6IG51bWJlciB9PiA9IFtdO1xuICBsZXQgaSA9IDA7XG4gIHdoaWxlIChpIDwgYmxvY2subGVuZ3RoKSB7XG4gICAgaWYgKGJsb2NrW2ldICE9PSBcImBcIikge1xuICAgICAgdGljayhtZXRlcik7XG4gICAgICBpKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3Qgc3RhcnQgPSBpO1xuICAgIHdoaWxlIChpIDwgYmxvY2subGVuZ3RoICYmIGJsb2NrW2ldID09PSBcImBcIikge1xuICAgICAgdGljayhtZXRlcik7XG4gICAgICBpKys7XG4gICAgfVxuICAgIHJ1bnMucHVzaCh7IGluZGV4OiBzdGFydCwgbGVuZ3RoOiBpIC0gc3RhcnQgfSk7XG4gIH1cblxuICAvLyBGb3IgZWFjaCBydW4sIHRoZSBpbmRleCBvZiB0aGUgbmV4dCBydW4gd2l0aCB0aGUgc2FtZSBsZW5ndGgsIGZvdW5kIHdpdGhcbiAgLy8gYSBzaW5nbGUgYmFja3dhcmRzIHBhc3MgaW5zdGVhZCBvZiBhIGZvcndhcmQgcmUtc2NhbiBwZXIgb3BlbmVyLiBFYWNoXG4gIC8vIHJ1biBleGFtaW5lZCBpcyBvbmUgc3RlcCwgc28gYSBuZXN0ZWQgcmVzY2FuIHNob3dzIHVwIGFzIHN1cGVyLWxpbmVhci5cbiAgY29uc3QgbmV4dFNhbWVMZW5ndGg6IG51bWJlcltdID0gbmV3IEFycmF5KHJ1bnMubGVuZ3RoKS5maWxsKC0xKTtcbiAgY29uc3QgbGFzdFNlZW5BdCA9IG5ldyBNYXA8bnVtYmVyLCBudW1iZXI+KCk7XG4gIGZvciAobGV0IGsgPSBydW5zLmxlbmd0aCAtIDE7IGsgPj0gMDsgay0tKSB7XG4gICAgdGljayhtZXRlcik7XG4gICAgY29uc3Qgc2VlbiA9IGxhc3RTZWVuQXQuZ2V0KHJ1bnNba10hLmxlbmd0aCk7XG4gICAgbmV4dFNhbWVMZW5ndGhba10gPSBzZWVuID8/IC0xO1xuICAgIGxhc3RTZWVuQXQuc2V0KHJ1bnNba10hLmxlbmd0aCwgayk7XG4gIH1cblxuICBjb25zdCBzZWdtZW50czogTWFya2Rvd25TZWdtZW50W10gPSBbXTtcbiAgbGV0IGN1cnNvciA9IDA7XG4gIGxldCByID0gMDtcbiAgd2hpbGUgKHIgPCBydW5zLmxlbmd0aCkge1xuICAgIHRpY2sobWV0ZXIpO1xuICAgIGNvbnN0IG9wZW4gPSBydW5zW3JdITtcbiAgICBpZiAob3Blbi5pbmRleCA+IGN1cnNvcikge1xuICAgICAgc2VnbWVudHMucHVzaCh7IHZhbHVlOiBibG9jay5zbGljZShjdXJzb3IsIG9wZW4uaW5kZXgpLCBpbkNvZGU6IGZhbHNlIH0pO1xuICAgIH1cbiAgICBjb25zdCBjbG9zZUF0ID0gbmV4dFNhbWVMZW5ndGhbcl0hO1xuICAgIGlmIChjbG9zZUF0ID09PSAtMSkge1xuICAgICAgY29uc3QgZW5kID0gb3Blbi5pbmRleCArIG9wZW4ubGVuZ3RoO1xuICAgICAgc2VnbWVudHMucHVzaCh7IHZhbHVlOiBibG9jay5zbGljZShvcGVuLmluZGV4LCBlbmQpLCBpbkNvZGU6IGZhbHNlIH0pO1xuICAgICAgY3Vyc29yID0gZW5kO1xuICAgICAgcisrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGNsb3NlID0gcnVuc1tjbG9zZUF0XSE7XG4gICAgY29uc3QgZW5kID0gY2xvc2UuaW5kZXggKyBjbG9zZS5sZW5ndGg7XG4gICAgc2VnbWVudHMucHVzaCh7IHZhbHVlOiBibG9jay5zbGljZShvcGVuLmluZGV4LCBlbmQpLCBpbkNvZGU6IHRydWUgfSk7XG4gICAgY3Vyc29yID0gZW5kO1xuICAgIHIgPSBjbG9zZUF0ICsgMTtcbiAgfVxuICBpZiAoY3Vyc29yIDwgYmxvY2subGVuZ3RoKSB7XG4gICAgc2VnbWVudHMucHVzaCh7IHZhbHVlOiBibG9jay5zbGljZShjdXJzb3IpLCBpbkNvZGU6IGZhbHNlIH0pO1xuICB9XG4gIHJldHVybiBzZWdtZW50cztcbn1cblxuLyoqXG4gKiBBbiBBVFggaGVhZGluZzogbGVhZGluZyB3aGl0ZXNwYWNlLCAxLTYgYCNgLCB0aGVuIHdoaXRlc3BhY2Ugb3IgZW5kIG9mXG4gKiBsaW5lLiBDb21tb25NYXJrIGdpdmVzIGl0IG5vIGNvbnRpbnVhdGlvbiBsaW5lIOKAlCB0aGUgaGVhZGluZyBpcyB0aGUgd2hvbGVcbiAqIGJsb2NrLCBzbyBgc3BsaXRNYXJrZG93bkNvZGVgIGZsdXNoZXMgdGhlIHBhcmFncmFwaCBidWZmZXIgYm90aCBiZWZvcmVcbiAqICphbmQqIGltbWVkaWF0ZWx5IGFmdGVyIG9uZS4gSW5kZW50YXRpb24gaXMgdW5ib3VuZGVkIChgXlsgXFx0XSpgKSwgbGlrZVxuICoge0BsaW5rIHBhcnNlRmVuY2VMaW5lfSDigJQgYCN7MSw2fWAgaXMgY2FwcGVkLCBzbyB3aWRlbmluZyB0aGUgbGVhZGluZ1xuICogd2hpdGVzcGFjZSBhZGRzIG5vIGJhY2t0cmFja2luZyByaXNrLlxuICovXG5mdW5jdGlvbiBpc0F0eEhlYWRpbmcobGluZTogc3RyaW5nLCBtZXRlcj86IFNjYW5NZXRlcik6IGJvb2xlYW4ge1xuICBsZXQgaSA9IDA7XG4gIHdoaWxlIChpIDwgbGluZS5sZW5ndGggJiYgKGxpbmVbaV0gPT09IFwiIFwiIHx8IGxpbmVbaV0gPT09IFwiXFx0XCIpKSB7XG4gICAgdGljayhtZXRlcik7XG4gICAgaSsrO1xuICB9XG4gIGxldCBoYXNoZXMgPSAwO1xuICB3aGlsZSAoaGFzaGVzIDwgNiAmJiBpIDwgbGluZS5sZW5ndGggJiYgbGluZVtpXSA9PT0gXCIjXCIpIHtcbiAgICB0aWNrKG1ldGVyKTtcbiAgICBoYXNoZXMrKztcbiAgICBpKys7XG4gIH1cbiAgaWYgKGhhc2hlcyA9PT0gMCkgcmV0dXJuIGZhbHNlO1xuICAvLyBBIHNldmVudGggaGFzaCBpcyBub3QgYW4gQVRYIGhlYWRpbmcuIFN0b3A7IGRvIG5vdCB3YWxrIHRoZSBydW4gYWdhaW4uXG4gIGlmIChpIDwgbGluZS5sZW5ndGggJiYgbGluZVtpXSA9PT0gXCIjXCIpIHJldHVybiBmYWxzZTtcbiAgaWYgKGkgPCBsaW5lLmxlbmd0aCAmJiAobGluZVtpXSA9PT0gXCIgXCIgfHwgbGluZVtpXSA9PT0gXCJcXHRcIikpIHJldHVybiB0cnVlO1xuICByZXR1cm4gYXRMaW5lRW5kKGxpbmUsIGkpO1xufVxuXG4vKipcbiAqIEEgbGlzdC1pdGVtIG1hcmtlcjogbGVhZGluZyB3aGl0ZXNwYWNlLCBhIGJ1bGxldCAoYC1gLCBgKmAsIGArYCkgb3IgYW5cbiAqIG9yZGVyZWQgbWFya2VyIChgMS5gIC8gYDEpYCksIHRoZW4gd2hpdGVzcGFjZSBvciBlbmQgb2YgbGluZS4gSW5kZW50YXRpb25cbiAqIGlzIHVuYm91bmRlZCwgc28gYSBuZXN0ZWQgb3IgdGFiLWluZGVudGVkIGl0ZW0gc3RpbGwgY291bnRzIOKAlCBzZWVcbiAqIHtAbGluayBpc0F0eEhlYWRpbmd9LlxuICovXG5mdW5jdGlvbiBpc0xpc3RJdGVtKGxpbmU6IHN0cmluZywgbWV0ZXI/OiBTY2FuTWV0ZXIpOiBib29sZWFuIHtcbiAgbGV0IGkgPSAwO1xuICB3aGlsZSAoaSA8IGxpbmUubGVuZ3RoICYmIChsaW5lW2ldID09PSBcIiBcIiB8fCBsaW5lW2ldID09PSBcIlxcdFwiKSkge1xuICAgIHRpY2sobWV0ZXIpO1xuICAgIGkrKztcbiAgfVxuICBpZiAoaSA+PSBsaW5lLmxlbmd0aCkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBtYXJrZXIgPSBsaW5lW2ldITtcbiAgaWYgKG1hcmtlciA9PT0gXCItXCIgfHwgbWFya2VyID09PSBcIipcIiB8fCBtYXJrZXIgPT09IFwiK1wiKSB7XG4gICAgdGljayhtZXRlcik7XG4gICAgaSsrO1xuICB9IGVsc2UgaWYgKG1hcmtlciA+PSBcIjBcIiAmJiBtYXJrZXIgPD0gXCI5XCIpIHtcbiAgICBsZXQgZGlnaXRzID0gMDtcbiAgICB3aGlsZSAoXG4gICAgICBkaWdpdHMgPCA5ICYmIGkgPCBsaW5lLmxlbmd0aCAmJiBsaW5lW2ldISA+PSBcIjBcIiAmJiBsaW5lW2ldISA8PSBcIjlcIlxuICAgICkge1xuICAgICAgdGljayhtZXRlcik7XG4gICAgICBkaWdpdHMrKztcbiAgICAgIGkrKztcbiAgICB9XG4gICAgaWYgKGkgPCBsaW5lLmxlbmd0aCAmJiBsaW5lW2ldISA+PSBcIjBcIiAmJiBsaW5lW2ldISA8PSBcIjlcIikgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChpID49IGxpbmUubGVuZ3RoIHx8IChsaW5lW2ldICE9PSBcIi5cIiAmJiBsaW5lW2ldICE9PSBcIilcIikpIHJldHVybiBmYWxzZTtcbiAgICB0aWNrKG1ldGVyKTtcbiAgICBpKys7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGlmIChpIDwgbGluZS5sZW5ndGggJiYgKGxpbmVbaV0gPT09IFwiIFwiIHx8IGxpbmVbaV0gPT09IFwiXFx0XCIpKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIGF0TGluZUVuZChsaW5lLCBpKTtcbn1cblxuLyoqXG4gKiBPbmUgb3IgbW9yZSBxdW90ZS1tYXJrZXIgbGV2ZWxzIGF0IHRoZSBzdGFydCBvZiBhIGxpbmUsIHBsdXMgYXQgbW9zdCBvbmVcbiAqIHNwYWNlL3RhYiByaWdodCBhZnRlciB0aGUgbGFzdCBgPmAgKENvbW1vbk1hcmsgc3RyaXBzIGF0IG1vc3Qgb25lKS4gRXZlcnlcbiAqIHJlcGV0aXRpb24gb2YgdGhlIG91dGVyIGArYCBtdXN0IGl0c2VsZiBjb25zdW1lIGEgbGl0ZXJhbCBgPmAsIHNvIHRoZVxuICogbWF0Y2ggbGVuZ3RoIGlzIGJvdW5kZWQgYnkgdGhlIG51bWJlciBvZiBgPmAgY2hhcmFjdGVycyBwcmVzZW50IOKAlCBub1xuICogcXVhbnRpZmllciBoZXJlIGNhbiBiYWNrdHJhY2sgb3ZlciB0aGUgc2FtZSBjaGFyYWN0ZXJzIGFzIGFub3RoZXIgb25lXG4gKiAoSXNzdWUgIzMzNTEgcmV2aWV3LCByb3VuZCAzOyBzYW1lIGNsYXNzIG9mIHJpc2sgYXMgSXNzdWUgIzMxODYpLlxuICovXG4vKipcbiAqIExlYWRpbmcgcXVvdGUgbWFya2VycywgcmVhZCBvbmNlLiBFYWNoIHJlcGV0aXRpb24gY29uc3VtZXMgYSBgPmAsIHNvIGFcbiAqIHJ1biBvZiBtYXJrZXJzIGlzIG9uZSBsaW5lYXIgcGFzcyAoSXNzdWUgIzMzNTEgcmV2aWV3LCByb3VuZCAzKS4gQXQgbW9zdFxuICogb25lIHNwYWNlIG9yIHRhYiBhZnRlciB0aGUgbGFzdCBgPmAgaXMgcGFydCBvZiB0aGUgcHJlZml4LlxuICovXG5mdW5jdGlvbiBxdW90ZVByZWZpeChcbiAgbGluZTogc3RyaW5nLFxuICBtZXRlcj86IFNjYW5NZXRlcixcbik6IHsgZW5kOiBudW1iZXI7IGRlcHRoOiBudW1iZXIgfSB7XG4gIGxldCBpID0gMDtcbiAgbGV0IGRlcHRoID0gMDtcbiAgd2hpbGUgKGkgPCBsaW5lLmxlbmd0aCkge1xuICAgIGxldCBqID0gaTtcbiAgICB3aGlsZSAoaiA8IGxpbmUubGVuZ3RoICYmIChsaW5lW2pdID09PSBcIiBcIiB8fCBsaW5lW2pdID09PSBcIlxcdFwiKSkge1xuICAgICAgdGljayhtZXRlcik7XG4gICAgICBqKys7XG4gICAgfVxuICAgIGlmIChqID49IGxpbmUubGVuZ3RoIHx8IGxpbmVbal0gIT09IFwiPlwiKSBicmVhaztcbiAgICB0aWNrKG1ldGVyKTtcbiAgICBkZXB0aCsrO1xuICAgIGkgPSBqICsgMTtcbiAgfVxuICBpZiAoZGVwdGggPT09IDApIHJldHVybiB7IGVuZDogMCwgZGVwdGg6IDAgfTtcbiAgaWYgKGkgPCBsaW5lLmxlbmd0aCAmJiAobGluZVtpXSA9PT0gXCIgXCIgfHwgbGluZVtpXSA9PT0gXCJcXHRcIikpIHtcbiAgICB0aWNrKG1ldGVyKTtcbiAgICBpKys7XG4gIH1cbiAgcmV0dXJuIHsgZW5kOiBpLCBkZXB0aCB9O1xufVxuXG4vKipcbiAqIFN0cmlwIHRoZSBsZWFkaW5nIHF1b3RlIG1hcmtlcihzKSBmcm9tIGBsaW5lYCwgc28gdGhlIGJsYW5rLWxpbmUgYW5kXG4gKiBibG9jay1zdGFydCBjaGVja3MgYmVsb3cgc2VlIHRoZSBxdW90ZWQgKmNvbnRlbnQqLCBub3QgdGhlIGA+YCBwcmVmaXgg4oCUXG4gKiBhIHF1b3RlZCBibGFuayBsaW5lLCBsaXN0IGl0ZW0sIGhlYWRpbmcsIHRhYmxlIHJvdyBvciBicmVhayBtdXN0IGVuZCB0aGVcbiAqIHBhcmFncmFwaCB0aGUgc2FtZSB3YXkgdGhlIHVucXVvdGVkIGZvcm0gZG9lcy4gQSBsaW5lIHdpdGggbm8gYD5gIHByZWZpeFxuICogaXMgcmV0dXJuZWQgdW5jaGFuZ2VkLlxuICovXG5mdW5jdGlvbiBzdHJpcFF1b3RlUHJlZml4KGxpbmU6IHN0cmluZywgbWV0ZXI/OiBTY2FuTWV0ZXIpOiBzdHJpbmcge1xuICBjb25zdCBwcmVmaXggPSBxdW90ZVByZWZpeChsaW5lLCBtZXRlcik7XG4gIGlmIChwcmVmaXguZGVwdGggPT09IDApIHJldHVybiBsaW5lO1xuICByZXR1cm4gbGluZS5zbGljZShwcmVmaXguZW5kKTtcbn1cblxuLyoqXG4gKiBIb3cgbWFueSBibG9jay1xdW90ZSBsZXZlbHMgb3BlbiBgbGluZWA6IHRoZSBudW1iZXIgb2YgYD5gIGNoYXJhY3RlcnMgaW5cbiAqIGl0cyBxdW90ZSBwcmVmaXgsIG9yIDAgZm9yIGFuIHVucXVvdGVkIGxpbmUuIE9uZSBsaW5lYXIgcGFzcyAoSXNzdWUgIzMzNTFcbiAqIHJldmlldywgcm91bmQgNCkuXG4gKi9cbmZ1bmN0aW9uIHF1b3RlRGVwdGgobGluZTogc3RyaW5nLCBtZXRlcj86IFNjYW5NZXRlcik6IG51bWJlciB7XG4gIHJldHVybiBxdW90ZVByZWZpeChsaW5lLCBtZXRlcikuZGVwdGg7XG59XG5cbi8qKlxuICogQW4gSFRNTCBjb21tZW50IG9wZW5lcjogbGVhZGluZyB3aGl0ZXNwYWNlLCB0aGVuIGA8IS0tYC4gSW4gQ29tbW9uTWFya1xuICogdGhpcyBzdGFydHMgYW4gSFRNTCBibG9jayB0aGF0IGludGVycnVwdHMgYSBwYXJhZ3JhcGg7IHRoZSBibG9jayBydW5zIHRvXG4gKiB0aGUgbGluZSBjb250YWluaW5nIGAtLT5gIChJc3N1ZSAjMzM1MSByZXZpZXcsIHJvdW5kIDMpLlxuICovXG5mdW5jdGlvbiBpc0h0bWxDb21tZW50U3RhcnQobGluZTogc3RyaW5nLCBtZXRlcj86IFNjYW5NZXRlcik6IGJvb2xlYW4ge1xuICBsZXQgaSA9IDA7XG4gIHdoaWxlIChpIDwgbGluZS5sZW5ndGggJiYgKGxpbmVbaV0gPT09IFwiIFwiIHx8IGxpbmVbaV0gPT09IFwiXFx0XCIpKSB7XG4gICAgdGljayhtZXRlcik7XG4gICAgaSsrO1xuICB9XG4gIGNvbnN0IG1hcmtlciA9IFwiPCEtLVwiO1xuICBmb3IgKGxldCBrID0gMDsgayA8IG1hcmtlci5sZW5ndGg7IGsrKykge1xuICAgIGlmIChsaW5lW2kgKyBrXSAhPT0gbWFya2VyW2tdKSByZXR1cm4gZmFsc2U7XG4gICAgdGljayhtZXRlcik7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKlxuICogQSBHRk0gdGFibGUgcm93OiBsZWFkaW5nIHdoaXRlc3BhY2UsIHRoZW4gYHxgLiBBIHRhYmxlIHJvdyBlbmRzIGFcbiAqIHBhcmFncmFwaCB0aGUgc2FtZSB3YXkgYSBoZWFkaW5nIGRvZXMsIGV2ZW4gd2l0aG91dCBvbmUgb2YgR0ZNJ3NcbiAqIGRlbGltaXRlciByb3dzIHByZXNlbnQg4oCUIGEgc3RyYXkgYmFja3RpY2sgaW4gb25lIGNlbGwgbXVzdCBub3QgcGFpciB3aXRoXG4gKiBvbmUgaW4gYSBsYXRlciByb3cuXG4gKi9cbmZ1bmN0aW9uIGlzVGFibGVSb3cobGluZTogc3RyaW5nLCBtZXRlcj86IFNjYW5NZXRlcik6IGJvb2xlYW4ge1xuICBsZXQgaSA9IDA7XG4gIHdoaWxlIChpIDwgbGluZS5sZW5ndGggJiYgKGxpbmVbaV0gPT09IFwiIFwiIHx8IGxpbmVbaV0gPT09IFwiXFx0XCIpKSB7XG4gICAgdGljayhtZXRlcik7XG4gICAgaSsrO1xuICB9XG4gIGlmIChpIDwgbGluZS5sZW5ndGggJiYgbGluZVtpXSA9PT0gXCJ8XCIpIHtcbiAgICB0aWNrKG1ldGVyKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKlxuICogQSBzZXRleHQgaGVhZGluZyB1bmRlcmxpbmUgKGA9PT1gIC8gYC0tLWApIG9yIGEgdGhlbWF0aWMgYnJlYWsgKGAtLS1gLFxuICogYCoqKmAsIGBfX19gKTogbGVhZGluZyB3aGl0ZXNwYWNlLCB0aGVuIG9uZSBvZiBgPSpfLWAgcmVwZWF0ZWQgd2l0aCBub1xuICogb3RoZXIgY2hhcmFjdGVyLCB0aGVuIHRyYWlsaW5nIHdoaXRlc3BhY2UgYW5kIGFuIG9wdGlvbmFsIGxpbmVcbiAqIHRlcm1pbmF0b3Ig4oCUIGBzcGxpdE1hcmtkb3duQ29kZWAncyBsaW5lcyBrZWVwIHRoZWlyIG93biBgXFxuYCwgc28gYCRgXG4gKiBhbG9uZSB3b3VsZCBuZXZlciBtYXRjaCBhIGxpbmUgdGhhdCBzdGlsbCBjYXJyaWVzIG9uZS4gVGhlIHRocmVlXG4gKiBxdWFudGlmaWVycyBuZXZlciBtYXRjaCB0aGUgc2FtZSBjaGFyYWN0ZXJzOiB0aGUgYmFja3JlZmVyZW5jZSBgXFwxKmBcbiAqIG1hdGNoZXMgb25seSB0aGUgZml4ZWQgbWFya2VyIGNoYXJhY3RlciwgdGhlIGxlYWRpbmcvdHJhaWxpbmcgYFsgXFx0XSpgXG4gKiBvbmx5IHNwYWNlL3RhYiwgc28gdGhlcmUgaXMgbm8gY2F0YXN0cm9waGljIGJhY2t0cmFja2luZyBvbiBhIGxvbmcgcnVuXG4gKiAoSXNzdWUgIzMzNTEgcmV2aWV3OyBzYW1lIGNsYXNzIG9mIHJpc2sgYXMgSXNzdWUgIzMxODYpLlxuICovXG5mdW5jdGlvbiBpc01hcmtlckNoYXIoY2hhcjogc3RyaW5nIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gIHJldHVybiBjaGFyID09PSBcIj1cIiB8fCBjaGFyID09PSBcIipcIiB8fCBjaGFyID09PSBcIl9cIiB8fCBjaGFyID09PSBcIi1cIjtcbn1cblxuZnVuY3Rpb24gaXNTZXRleHRPclRoZW1hdGljQnJlYWsobGluZTogc3RyaW5nLCBtZXRlcj86IFNjYW5NZXRlcik6IGJvb2xlYW4ge1xuICBsZXQgaSA9IDA7XG4gIHdoaWxlIChpIDwgbGluZS5sZW5ndGggJiYgKGxpbmVbaV0gPT09IFwiIFwiIHx8IGxpbmVbaV0gPT09IFwiXFx0XCIpKSB7XG4gICAgdGljayhtZXRlcik7XG4gICAgaSsrO1xuICB9XG4gIGNvbnN0IG1hcmtlciA9IGxpbmVbaV07XG4gIGlmICghaXNNYXJrZXJDaGFyKG1hcmtlcikpIHJldHVybiBmYWxzZTtcbiAgd2hpbGUgKGkgPCBsaW5lLmxlbmd0aCAmJiBsaW5lW2ldID09PSBtYXJrZXIpIHtcbiAgICB0aWNrKG1ldGVyKTtcbiAgICBpKys7XG4gIH1cbiAgd2hpbGUgKGkgPCBsaW5lLmxlbmd0aCAmJiAobGluZVtpXSA9PT0gXCIgXCIgfHwgbGluZVtpXSA9PT0gXCJcXHRcIikpIHtcbiAgICB0aWNrKG1ldGVyKTtcbiAgICBpKys7XG4gIH1cbiAgaWYgKGxpbmVbaV0gPT09IFwiXFxyXCIgJiYgbGluZVtpICsgMV0gPT09IFwiXFxuXCIpIHtcbiAgICB0aWNrKG1ldGVyKTtcbiAgICB0aWNrKG1ldGVyKTtcbiAgICBpICs9IDI7XG4gIH0gZWxzZSBpZiAobGluZVtpXSA9PT0gXCJcXG5cIikge1xuICAgIHRpY2sobWV0ZXIpO1xuICAgIGkrKztcbiAgfVxuICByZXR1cm4gaSA9PT0gbGluZS5sZW5ndGg7XG59XG5cbi8qKlxuICogRG9lcyBgbGluZWAgc3RhcnQgYSBuZXcgQ29tbW9uTWFyayBibG9jayB0aGF0IGEgcGFyYWdyYXBoIG5ldmVyIGNvbnRpbnVlc1xuICogaW50byAoSXNzdWUgIzMzNTEgcmV2aWV3KT8gQSBsaXRlcmFsIGJhY2t0aWNrIGluIG9uZSBsaXN0IGl0ZW0sIGhlYWRpbmcsXG4gKiB0YWJsZSByb3cgb3Igc2V0ZXh0L3RoZW1hdGljLWJyZWFrIGxpbmUgbXVzdCBub3QgcGFpciB3aXRoIGEgYmFja3RpY2sgaW5cbiAqIGEgbGF0ZXIgYmxvY2suIFRoZSBjYWxsZXIgcGFzc2VzIHRoZSBsaW5lIHdpdGggYW55IHF1b3RlIHByZWZpeCBhbHJlYWR5XG4gKiBzdHJpcHBlZCwgc28gYSBxdW90ZWQgbGlzdCBpdGVtLCBoZWFkaW5nLCB0YWJsZSByb3cgb3IgYnJlYWsgaXMgZGV0ZWN0ZWRcbiAqIHRvbyAocm91bmQgMykg4oCUIGEgYmxvY2stcXVvdGUgbWFya2VyIGl0c2VsZiBpcyBoYW5kbGVkIHNlcGFyYXRlbHkgYnkgdGhlXG4gKiBjYWxsZXIsIHNpbmNlIGNvbnNlY3V0aXZlIGA+YCBsaW5lcyBmb3JtIG9uZSBxdW90ZWQgcGFyYWdyYXBoIHJhdGhlciB0aGFuXG4gKiBlYWNoIGVuZGluZyBpdC5cbiAqL1xuZnVuY3Rpb24gc3RhcnRzTmV3QmxvY2sobGluZTogc3RyaW5nLCBtZXRlcj86IFNjYW5NZXRlcik6IGJvb2xlYW4ge1xuICByZXR1cm4gaXNBdHhIZWFkaW5nKGxpbmUsIG1ldGVyKSB8fCBpc0xpc3RJdGVtKGxpbmUsIG1ldGVyKSB8fFxuICAgIGlzVGFibGVSb3cobGluZSwgbWV0ZXIpIHx8IGlzU2V0ZXh0T3JUaGVtYXRpY0JyZWFrKGxpbmUsIG1ldGVyKTtcbn1cblxuLyoqXG4gKiBTcGxpdCB0ZXh0IGludG8gYWx0ZXJuYXRpbmcgXCJvdXRzaWRlIGNvZGVcIiAvIFwiaW5zaWRlIGNvZGVcIiBzZWdtZW50cywgc29cbiAqIGNhbGxlcnMgY2FuIHNjYW4gb3IgcmV3cml0ZSBvbmx5IHRoZSBwcm9zZSBhIHJlYWRlciBhY3R1YWxseSBzZWVzLlxuICogRmVuY2VkIGJsb2NrcyAoYGBgIG9yIH5+fiwgdG8gdGhlIG1hdGNoaW5nIGNsb3NlIG9yIGVuZCBvZiB0ZXh0KSBhbmRcbiAqIGlubGluZSBiYWNrdGljayBzcGFucyBhcmUgYm90aCBcImluc2lkZSBjb2RlXCIg4oCUIGEgdG9rZW4gbmFtZWQgZm9yXG4gKiBkaXNjdXNzaW9uIChgYCBgUkVEQUNUSU9OX1BMQUNFSE9MREVSYCBgYCkgaXMgbm90IGFuIHVuZmlsbGVkIHJlc3VsdC5cbiAqXG4gKiBUaGUgcmV0dXJuZWQgc2VnbWVudHMgY29uY2F0ZW5hdGUgYmFjayB0byBgdGV4dGAgZXhhY3RseS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNwbGl0TWFya2Rvd25Db2RlKFxuICB0ZXh0OiBzdHJpbmcsXG4gIG1ldGVyPzogU2Nhbk1ldGVyLFxuKTogTWFya2Rvd25TZWdtZW50W10ge1xuICBjb25zdCBzZWdtZW50czogTWFya2Rvd25TZWdtZW50W10gPSBbXTtcbiAgY29uc3QgbGluZXMgPSAodGV4dCA/PyBcIlwiKS5zcGxpdCgvKD88PVxcbikvKTsgLy8ga2VlcCBsaW5lIHRlcm1pbmF0b3JzIGF0dGFjaGVkXG4gIGxldCBpID0gMDtcbiAgbGV0IGZlbmNlQ3Vyc29yID0gXCJcIjtcbiAgbGV0IHBhcmFncmFwaCA9IFwiXCI7XG4gIGxldCBpbkZlbmNlID0gZmFsc2U7XG4gIGxldCBvcGVuZXI6IEZlbmNlTGluZSB8IG51bGwgPSBudWxsO1xuICAvLyBIb3cgbWFueSBibG9jay1xdW90ZSBsZXZlbHMgdGhlIG9wZW4gcGFyYWdyYXBoIHNpdHMgaW4gKDAgPSB1bnF1b3RlZCkg4oCUXG4gIC8vIHRyYWNrZWQgc2VwYXJhdGVseSBmcm9tIGBzdGFydHNOZXdCbG9ja2AgYmVjYXVzZSBjb25zZWN1dGl2ZSBgPmAgbGluZXNcbiAgLy8gYXQgdGhlIHNhbWUgZGVwdGggZm9ybSBvbmUgcXVvdGVkIHBhcmFncmFwaCAoSXNzdWUgIzMzNTEgcmV2aWV3KTogdGhlXG4gIC8vIHBhcmFncmFwaCBmbHVzaGVzIG9ubHkgd2hlcmUgdGhlIGRlcHRoIGNoYW5nZXMg4oCUIGEgcXVvdGUgc3RhcnRpbmcsXG4gIC8vIGVuZGluZywgb3IgbmVzdGluZyBkZWVwZXIgLyBzaGFsbG93ZXIgKHJvdW5kIDQpIOKAlCBub3Qgb24gZXZlcnkgYD5gIGxpbmUuXG4gIGxldCBjdXJyZW50UXVvdGVEZXB0aCA9IDA7XG4gIC8vIFdoZXRoZXIgdGhlIGN1cnJlbnQgbGluZSBpcyBpbnNpZGUgYW4gSFRNTCBjb21tZW50IG9wZW5lZCBvbiBhbiBlYXJsaWVyXG4gIC8vIGxpbmUgdGhhdCBoYXMgbm90IHlldCBjbG9zZWQgd2l0aCBgLS0+YCAocm91bmQgMykuXG4gIGxldCBpbkNvbW1lbnQgPSBmYWxzZTtcblxuICBmdW5jdGlvbiBwdXNoU2VnbWVudCh2YWx1ZTogc3RyaW5nLCBpbkNvZGU6IGJvb2xlYW4pIHtcbiAgICBpZiAodmFsdWUubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgbGFzdCA9IHNlZ21lbnRzW3NlZ21lbnRzLmxlbmd0aCAtIDFdO1xuICAgIGlmIChsYXN0ICYmIGxhc3QuaW5Db2RlID09PSBpbkNvZGUpIGxhc3QudmFsdWUgKz0gdmFsdWU7XG4gICAgZWxzZSBzZWdtZW50cy5wdXNoKHsgdmFsdWUsIGluQ29kZSB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGZsdXNoUGFyYWdyYXBoKCkge1xuICAgIGlmIChwYXJhZ3JhcGgubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgZm9yIChjb25zdCBzZWdtZW50IG9mIHNwbGl0SW5saW5lU3BhbnMocGFyYWdyYXBoLCBtZXRlcikpIHtcbiAgICAgIHB1c2hTZWdtZW50KHNlZ21lbnQudmFsdWUsIHNlZ21lbnQuaW5Db2RlKTtcbiAgICB9XG4gICAgcGFyYWdyYXBoID0gXCJcIjtcbiAgfVxuXG4gIHdoaWxlIChpIDwgbGluZXMubGVuZ3RoKSB7XG4gICAgY29uc3QgbGluZSA9IGxpbmVzW2ldITtcbiAgICBjb25zdCBmZW5jZU1hdGNoID0gcGFyc2VGZW5jZUxpbmUobGluZSwgbWV0ZXIpO1xuICAgIGlmIChmZW5jZU1hdGNoICYmICFpbkZlbmNlKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgY3VycmVudFF1b3RlRGVwdGggPSAwO1xuICAgICAgaW5GZW5jZSA9IHRydWU7XG4gICAgICBvcGVuZXIgPSBmZW5jZU1hdGNoO1xuICAgICAgZmVuY2VDdXJzb3IgKz0gbGluZTtcbiAgICAgIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoaW5GZW5jZSAmJiBvcGVuZXIgJiYgaXNDbG9zaW5nRmVuY2UobGluZSwgb3BlbmVyLCBtZXRlcikpIHtcbiAgICAgIGZlbmNlQ3Vyc29yICs9IGxpbmU7XG4gICAgICBwdXNoU2VnbWVudChmZW5jZUN1cnNvciwgdHJ1ZSk7XG4gICAgICBmZW5jZUN1cnNvciA9IFwiXCI7XG4gICAgICBpbkZlbmNlID0gZmFsc2U7XG4gICAgICBvcGVuZXIgPSBudWxsO1xuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpbkZlbmNlKSB7XG4gICAgICBmZW5jZUN1cnNvciArPSBsaW5lO1xuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIC8vIEEgbGluZSBpbnNpZGUgYW4gYWxyZWFkeS1vcGVuIEhUTUwgY29tbWVudCBzdGF5cyBwYXJ0IG9mIGl0IHVudGlsIHRoZVxuICAgIC8vIGxpbmUgdGhhdCBjbG9zZXMgaXQgd2l0aCBgLS0+YCDigJQgYmxhbmsgbGluZXMsIGxpc3QgbWFya2VycywgZXRjLiBkb1xuICAgIC8vIG5vdCBlbmQgYW4gSFRNTCBibG9jayB0aGUgd2F5IHRoZXkgZW5kIGEgcGFyYWdyYXBoIChyb3VuZCAzKS5cbiAgICBpZiAoaW5Db21tZW50KSB7XG4gICAgICBwYXJhZ3JhcGggKz0gbGluZTtcbiAgICAgIGlmIChsaW5lLmluY2x1ZGVzKFwiLS0+XCIpKSB7XG4gICAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICAgIGluQ29tbWVudCA9IGZhbHNlO1xuICAgICAgfVxuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIC8vIFRoZSBibGFuay1saW5lIGFuZCBibG9jay1zdGFydCBjaGVja3MgYmVsb3cgc2VlIHRoZSBxdW90ZWQgKmNvbnRlbnQqLFxuICAgIC8vIHdpdGggYW55IGA+YCBwcmVmaXggc3RyaXBwZWQg4oCUIGEgcXVvdGVkIGJsYW5rIGxpbmUsIGxpc3QgaXRlbSxcbiAgICAvLyBoZWFkaW5nLCB0YWJsZSByb3cgb3IgYnJlYWsgbXVzdCBlbmQgdGhlIHBhcmFncmFwaCB0aGUgc2FtZSB3YXkgdGhlXG4gICAgLy8gdW5xdW90ZWQgZm9ybSBkb2VzIChJc3N1ZSAjMzM1MSByZXZpZXcsIHJvdW5kIDMpLlxuICAgIGNvbnN0IGNvbnRlbnQgPSBzdHJpcFF1b3RlUHJlZml4KGxpbmUsIG1ldGVyKTtcbiAgICAvLyBBIGJsYW5rIGxpbmUgZW5kcyB0aGUgcGFyYWdyYXBoLCBzbyBhIGNvZGUgc3BhbiBjYW5ub3QgY3Jvc3MgaXQuXG4gICAgaWYgKGNvbnRlbnQudHJpbSgpID09PSBcIlwiKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgcHVzaFNlZ21lbnQobGluZSwgZmFsc2UpO1xuICAgICAgY3VycmVudFF1b3RlRGVwdGggPSAwO1xuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIC8vIEVudGVyaW5nLCBsZWF2aW5nIG9yIGNoYW5naW5nIHRoZSBkZXB0aCBvZiBhIGJsb2NrIHF1b3RlIGVuZHMgdGhlXG4gICAgLy8gcGFyYWdyYXBoOyBzdGF5aW5nIGF0IHRoZSBzYW1lIGRlcHRoIGRvZXMgbm90LCBzbyBjb25zZWN1dGl2ZSBxdW90ZWRcbiAgICAvLyBsaW5lcyBzdGF5IG9uZSBwYXJhZ3JhcGggYW5kIGEgc3BhbiBtYXkgc3RpbGwgd3JhcCBhY3Jvc3MgdGhlbSAoSXNzdWVcbiAgICAvLyAjMzM1MSByZXZpZXcpLiBBIGRlZXBlciBgPiA+IC4uLmAgbGluZSBvcGVucyBhIG5lc3RlZCBxdW90ZSB0aGF0XG4gICAgLy8gaW50ZXJydXB0cyB0aGUgb3V0ZXIgcGFyYWdyYXBoIChyb3VuZCA0KS4gQSBzaGFsbG93ZXIgbGluZSBjb3VsZCBiZSBhXG4gICAgLy8gQ29tbW9uTWFyayBsYXp5IGNvbnRpbnVhdGlvbiwgYnV0IGZsdXNoaW5nIHRoZXJlIHRvbyBpcyB0aGUgc2FmZVxuICAgIC8vIGRpcmVjdGlvbjogaXQgY2FuIG9ubHkgc3RvcCBhIHNwYW4gcGFpcmluZywgbmV2ZXIgaGlkZSBwcm9zZS5cbiAgICBjb25zdCBsaW5lUXVvdGVEZXB0aCA9IHF1b3RlRGVwdGgobGluZSwgbWV0ZXIpO1xuICAgIGlmIChsaW5lUXVvdGVEZXB0aCAhPT0gY3VycmVudFF1b3RlRGVwdGgpIHtcbiAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICBjdXJyZW50UXVvdGVEZXB0aCA9IGxpbmVRdW90ZURlcHRoO1xuICAgIH1cbiAgICAvLyBBIGxpbmUgc3RhcnRpbmcgYW4gSFRNTCBjb21tZW50IGVuZHMgdGhlIHBhcmFncmFwaDsgdGhlIGNvbW1lbnQgcnVuc1xuICAgIC8vIHRvIHRoZSBsaW5lIGhvbGRpbmcgYC0tPmAsIHdoaWNoIG1heSBiZSB0aGlzIHNhbWUgbGluZSAocm91bmQgMykuXG4gICAgaWYgKGlzSHRtbENvbW1lbnRTdGFydChjb250ZW50LCBtZXRlcikpIHtcbiAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICBwYXJhZ3JhcGggKz0gbGluZTtcbiAgICAgIGlmIChsaW5lLmluY2x1ZGVzKFwiLS0+XCIpKSB7XG4gICAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpbkNvbW1lbnQgPSB0cnVlO1xuICAgICAgfVxuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIC8vIEEgaGVhZGluZywgbGlzdCBpdGVtLCB0YWJsZSByb3cgb3Igc2V0ZXh0L3RoZW1hdGljLWJyZWFrIGxpbmUgYWxzb1xuICAgIC8vIGVuZHMgdGhlIHBhcmFncmFwaCwgdGhlIHNhbWUgd2F5IGEgYmxhbmsgbGluZSBkb2VzIChJc3N1ZSAjMzM1MVxuICAgIC8vIHJldmlldykuXG4gICAgaWYgKHN0YXJ0c05ld0Jsb2NrKGNvbnRlbnQsIG1ldGVyKSkge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIHBhcmFncmFwaCArPSBsaW5lO1xuICAgICAgLy8gQW4gQVRYIGhlYWRpbmcgaGFzIG5vIGNvbnRpbnVhdGlvbiBsaW5lLCBzbyBpdCBuZXZlciBtZXJnZXMgd2l0aFxuICAgICAgLy8gd2hhdGV2ZXIgZm9sbG93cyBpdC5cbiAgICAgIGlmIChpc0F0eEhlYWRpbmcoY29udGVudCwgbWV0ZXIpKSBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHBhcmFncmFwaCArPSBsaW5lO1xuICAgIGkrKztcbiAgfVxuICBpZiAoaW5GZW5jZSkgcHVzaFNlZ21lbnQoZmVuY2VDdXJzb3IsIHRydWUpO1xuICBlbHNlIGZsdXNoUGFyYWdyYXBoKCk7XG4gIHJldHVybiBzZWdtZW50cztcbn1cblxuLyoqXG4gKiBSZXBsYWNlIGV2ZXJ5IGluLWNvZGUgY2hhcmFjdGVyIChldmVyeXRoaW5nIGJ1dCBgXFxuYCkgd2l0aCBhIHNwYWNlLCBzbyB0aGVcbiAqIHJlc3VsdCBpcyB0aGUgc2FtZSBsZW5ndGgg4oCUIGFuZCBldmVyeSBvZmZzZXQgbGluZXMgdXAg4oCUIGFzIGB0ZXh0YCwgYnV0XG4gKiBjYXJyaWVzIG9ubHkgdGhlIHByb3NlIGEgcmVhZGVyIGFjdHVhbGx5IHNlZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYXNrTWFya2Rvd25Db2RlKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBzcGxpdE1hcmtkb3duQ29kZSh0ZXh0KVxuICAgIC5tYXAoKHNlZ21lbnQpID0+XG4gICAgICBzZWdtZW50LmluQ29kZSA/IHNlZ21lbnQudmFsdWUucmVwbGFjZSgvW15cXG5dL2csIFwiIFwiKSA6IHNlZ21lbnQudmFsdWVcbiAgICApXG4gICAgLmpvaW4oXCJcIik7XG59XG5cbi8qKlxuICogUmVtb3ZlIGFsbCBNYXJrZG93biBjb2RlIChmZW5jZWQgYmxvY2tzIGFuZCBpbmxpbmUgc3BhbnMsIGluY2x1ZGluZyB0aGVcbiAqIGZlbmNlIGxpbmVzIGFuZCB0aGVpciBsaW5lIGJyZWFrcywgYW5kIGFueSBsaW5lIGJyZWFrIGluc2lkZSBhbiBpbmxpbmVcbiAqIHNwYW4pIGZyb20gYHRleHRgLCBsZWF2aW5nIG9ubHkgdGhlIG5vbi1jb2RlIHByb3NlIGpvaW5lZCBiYWNrIHRvZ2V0aGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RyaXBNYXJrZG93bkNvZGUodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHNwbGl0TWFya2Rvd25Db2RlKHRleHQpXG4gICAgLmZpbHRlcigoc2VnbWVudCkgPT4gIXNlZ21lbnQuaW5Db2RlKVxuICAgIC5tYXAoKHNlZ21lbnQpID0+IHNlZ21lbnQudmFsdWUpXG4gICAgLmpvaW4oXCJcIik7XG59XG5cbi8qKiBTcGxpdCB0ZXh0IGludG8gcGh5c2ljYWwgbGluZXMgb24gZXZlcnkgbGluZSB0ZXJtaW5hdG9yICh0ZXJtaW5hdG9ycyBkcm9wcGVkKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzcGxpdE1hcmtkb3duTGluZXModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gKHRleHQgPz8gXCJcIikuc3BsaXQoL1xcclxcbnxbXFxuXFxyXFx1MjAyOFxcdTIwMjldLyk7XG59XG5cbi8qKiBXaGF0IGtpbmQgb2YgTWFya2Rvd24gYmxvY2sgYSB7QGxpbmsgTWFya2Rvd25Mb2dpY2FsVW5pdH0gaXMuICovXG5leHBvcnQgdHlwZSBNYXJrZG93blVuaXRLaW5kID1cbiAgfCBcInBhcmFncmFwaFwiXG4gIHwgXCJsaXN0LWl0ZW1cIlxuICB8IFwidGFibGUtcm93XCJcbiAgfCBcImhlYWRpbmdcIlxuICB8IFwiaHRtbFwiXG4gIHwgXCJicmVha1wiXG4gIHwgXCJjb2RlXCI7XG5cbi8qKiBPbmUgbG9naWNhbCBzdGF0ZW1lbnQ6IHRoZSBwaHlzaWNhbCBsaW5lcyB0aGF0IHJlYWQgYXMgYSBzaW5nbGUgYmxvY2suICovXG5leHBvcnQgaW50ZXJmYWNlIE1hcmtkb3duTG9naWNhbFVuaXQge1xuICBraW5kOiBNYXJrZG93blVuaXRLaW5kO1xuICAvKiogMC1iYXNlZCBpbmRleGVzIGludG8gdGhlIGBsaW5lc2AgYXJyYXkgcGFzc2VkIGluLCBhc2NlbmRpbmcgYW5kIGNvbnNlY3V0aXZlLiAqL1xuICBsaW5lczogbnVtYmVyW107XG4gIC8qKlxuICAgKiBFYWNoIHNvdXJjZSBsaW5lIHRyaW1tZWQsIG5vbi1lbXB0eSBvbmVzIGpvaW5lZCB3aXRoIGEgc2luZ2xlIHNwYWNlLiBRdW90ZVxuICAgKiBhbmQgbGlzdCBtYXJrZXJzIGFyZSBub3Qgc3RyaXBwZWQ6IGNhbGxlcnMgc3RyaXAgdGhlaXIgb3duIGRlY29yYXRpb24uXG4gICAqL1xuICB0ZXh0OiBzdHJpbmc7XG59XG5cbi8qKlxuICogR3JvdXAgcGh5c2ljYWwgTWFya2Rvd24gbGluZXMgaW50byBsb2dpY2FsIHVuaXRzIChJc3N1ZSAjMzM1NikuXG4gKlxuICogUFIgc3VtbWFyaWVzIGFyZSBoYXJkLXdyYXBwZWQgYXQgYWJvdXQgNzggY29sdW1ucywgc28gYHRleHQuc3BsaXQoXCJcXG5cIilgXG4gKiByZWFkcyBoYWxmIGEgY2xhaW0gcGVyIGxpbmU6IGEgZ2F0ZSB0aGF0IG1hdGNoZXMgb25lIHBoeXNpY2FsIGxpbmUgbWlzc2VzIGFcbiAqIHBocmFzZSB3cmFwcGVkIGFjcm9zcyB0d28uIE1hdGNoaW5nIHBlciB1bml0IGZpeGVzIHRoYXQsIGFuZCB0aGUgdW5pdFxuICogYm91bmRhcmllcyBzdG9wIG9uZSB1bml0J3MgZXZpZGVuY2UgZXhjdXNpbmcgYW5vdGhlciB1bml0J3MgYWRtaXNzaW9uLlxuICpcbiAqIE9uZSBsaW5lYXIgcGFzcywgb25lIG9wZW4gdW5pdCBhdCBhIHRpbWU6XG4gKiAtIEEgYmxhbmsgbGluZSAoYWZ0ZXIgdGhlIHF1b3RlIHByZWZpeCkgY2xvc2VzIHRoZSBvcGVuIHVuaXQgYW5kIGJlbG9uZ3MgdG9cbiAqICAgbm9uZS5cbiAqIC0gQSBmZW5jZSBvcGVuZXIgY2xvc2VzIHRoZSBvcGVuIHVuaXQ7IGV2ZXJ5IG5vbi1ibGFuayBsaW5lIGZyb20gaXQgdG8gaXRzXG4gKiAgIG1hdGNoaW5nIGNsb3NlciAob3IgdGhlIGVuZCBvZiBpbnB1dCkgaXMgaXRzIG93biBvbmUtbGluZSBgY29kZWAgdW5pdCwgc29cbiAqICAgYSBjYWxsZXIgaWdub3JpbmcgY29kZSBmaWx0ZXJzIGBraW5kID09PSBcImNvZGVcImAgYW5kIG9uZSB0aGF0IG11c3QgY2hlY2tcbiAqICAgZXZlcnkgbGluZSBzdGlsbCBzZWVzIGVhY2ggb25lLlxuICogLSBBIGNoYW5nZSBvZiBxdW90ZSBkZXB0aCBjbG9zZXMgdGhlIG9wZW4gdW5pdC5cbiAqIC0gQW4gSFRNTCBjb21tZW50IGlzIG9uZSBgaHRtbGAgdW5pdCB0aHJvdWdoIHRoZSBmaXJzdCBsaW5lIGhvbGRpbmcgYC0tPmAuXG4gKiAtIEFuIEFUWCBoZWFkaW5nLCBhIHNldGV4dCB1bmRlcmxpbmUgLyB0aGVtYXRpYyBicmVhayAoY2hlY2tlZCBiZWZvcmUgbGlzdFxuICogICBpdGVtcykgYW5kIGEgdGFibGUgcm93IGFyZSBlYWNoIHRoZWlyIG93biBvbmUtbGluZSB1bml0LlxuICogLSBBIGxpc3QgaXRlbSBvcGVucyBhIG5ldyBgbGlzdC1pdGVtYCB1bml0LCBhdCBhbnkgaW5kZW50LlxuICogLSBBbnkgb3RoZXIgbGluZSBleHRlbmRzIGFuIG9wZW4gYHBhcmFncmFwaGAgb3IgYGxpc3QtaXRlbWAgKGluZGVudGVkIG9yXG4gKiAgIGxhenkgYWxpa2UpLCBvdGhlcndpc2Ugb3BlbnMgYSBuZXcgYHBhcmFncmFwaGAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYXJrZG93bkxvZ2ljYWxVbml0cyhcbiAgbGluZXM6IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogTWFya2Rvd25Mb2dpY2FsVW5pdFtdIHtcbiAgY29uc3QgdW5pdHM6IE1hcmtkb3duTG9naWNhbFVuaXRbXSA9IFtdO1xuICBsZXQgb3BlbjogeyBraW5kOiBNYXJrZG93blVuaXRLaW5kOyBsaW5lczogbnVtYmVyW10gfSB8IG51bGwgPSBudWxsO1xuICBsZXQgb3BlbkRlcHRoID0gMDtcblxuICBjb25zdCBtYWtlID0gKFxuICAgIGtpbmQ6IE1hcmtkb3duVW5pdEtpbmQsXG4gICAgaWR4OiBudW1iZXJbXSxcbiAgKTogTWFya2Rvd25Mb2dpY2FsVW5pdCA9PiAoe1xuICAgIGtpbmQsXG4gICAgbGluZXM6IGlkeCxcbiAgICB0ZXh0OiBpZHgubWFwKChuKSA9PiBsaW5lc1tuXSEudHJpbSgpKS5maWx0ZXIoKHQpID0+IHQgIT09IFwiXCIpLmpvaW4oXCIgXCIpLFxuICB9KTtcbiAgY29uc3QgZmx1c2ggPSAoKSA9PiB7XG4gICAgaWYgKG9wZW4pIHVuaXRzLnB1c2gobWFrZShvcGVuLmtpbmQsIG9wZW4ubGluZXMpKTtcbiAgICBvcGVuID0gbnVsbDtcbiAgfTtcbiAgY29uc3Qgc2luZ2xlID0gKGtpbmQ6IE1hcmtkb3duVW5pdEtpbmQsIG46IG51bWJlcikgPT4ge1xuICAgIGZsdXNoKCk7XG4gICAgdW5pdHMucHVzaChtYWtlKGtpbmQsIFtuXSkpO1xuICB9O1xuXG4gIGxldCBpID0gMDtcbiAgd2hpbGUgKGkgPCBsaW5lcy5sZW5ndGgpIHtcbiAgICBjb25zdCBsaW5lID0gbGluZXNbaV0hO1xuICAgIGNvbnN0IGZlbmNlID0gcGFyc2VGZW5jZUxpbmUobGluZSk7XG4gICAgaWYgKGZlbmNlKSB7XG4gICAgICBmbHVzaCgpO1xuICAgICAgb3BlbkRlcHRoID0gMDtcbiAgICAgIGlmIChsaW5lLnRyaW0oKSAhPT0gXCJcIikgdW5pdHMucHVzaChtYWtlKFwiY29kZVwiLCBbaV0pKTtcbiAgICAgIGkrKztcbiAgICAgIHdoaWxlIChpIDwgbGluZXMubGVuZ3RoKSB7XG4gICAgICAgIGNvbnN0IGlubmVyID0gbGluZXNbaV0hO1xuICAgICAgICBpZiAoaW5uZXIudHJpbSgpICE9PSBcIlwiKSB1bml0cy5wdXNoKG1ha2UoXCJjb2RlXCIsIFtpXSkpO1xuICAgICAgICBpKys7XG4gICAgICAgIGlmIChpc0Nsb3NpbmdGZW5jZShpbm5lciwgZmVuY2UpKSBicmVhaztcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBjb250ZW50ID0gc3RyaXBRdW90ZVByZWZpeChsaW5lKTtcbiAgICBpZiAoY29udGVudC50cmltKCkgPT09IFwiXCIpIHtcbiAgICAgIGZsdXNoKCk7XG4gICAgICBvcGVuRGVwdGggPSAwO1xuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGRlcHRoID0gcXVvdGVEZXB0aChsaW5lKTtcbiAgICBpZiAoZGVwdGggIT09IG9wZW5EZXB0aCkge1xuICAgICAgZmx1c2goKTtcbiAgICAgIG9wZW5EZXB0aCA9IGRlcHRoO1xuICAgIH1cbiAgICBpZiAoaXNIdG1sQ29tbWVudFN0YXJ0KGNvbnRlbnQpKSB7XG4gICAgICBmbHVzaCgpO1xuICAgICAgY29uc3QgaWR4ID0gW2ldO1xuICAgICAgbGV0IGNsb3NlZCA9IGxpbmUuaW5jbHVkZXMoXCItLT5cIik7XG4gICAgICBpKys7XG4gICAgICB3aGlsZSAoIWNsb3NlZCAmJiBpIDwgbGluZXMubGVuZ3RoKSB7XG4gICAgICAgIGlkeC5wdXNoKGkpO1xuICAgICAgICBjbG9zZWQgPSBsaW5lc1tpXSEuaW5jbHVkZXMoXCItLT5cIik7XG4gICAgICAgIGkrKztcbiAgICAgIH1cbiAgICAgIHVuaXRzLnB1c2gobWFrZShcImh0bWxcIiwgaWR4KSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGlzQXR4SGVhZGluZyhjb250ZW50KSkge1xuICAgICAgc2luZ2xlKFwiaGVhZGluZ1wiLCBpKTtcbiAgICB9IGVsc2UgaWYgKGlzU2V0ZXh0T3JUaGVtYXRpY0JyZWFrKGNvbnRlbnQpKSB7XG4gICAgICBzaW5nbGUoXCJicmVha1wiLCBpKTtcbiAgICB9IGVsc2UgaWYgKGlzTGlzdEl0ZW0oY29udGVudCkpIHtcbiAgICAgIGZsdXNoKCk7XG4gICAgICBvcGVuID0geyBraW5kOiBcImxpc3QtaXRlbVwiLCBsaW5lczogW2ldIH07XG4gICAgfSBlbHNlIGlmIChpc1RhYmxlUm93KGNvbnRlbnQpKSB7XG4gICAgICBzaW5nbGUoXCJ0YWJsZS1yb3dcIiwgaSk7XG4gICAgfSBlbHNlIGlmIChcbiAgICAgIG9wZW4gJiYgKG9wZW4ua2luZCA9PT0gXCJwYXJhZ3JhcGhcIiB8fCBvcGVuLmtpbmQgPT09IFwibGlzdC1pdGVtXCIpXG4gICAgKSB7XG4gICAgICBvcGVuLmxpbmVzLnB1c2goaSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGZsdXNoKCk7XG4gICAgICBvcGVuID0geyBraW5kOiBcInBhcmFncmFwaFwiLCBsaW5lczogW2ldIH07XG4gICAgfVxuICAgIGkrKztcbiAgfVxuICBmbHVzaCgpO1xuICByZXR1cm4gdW5pdHM7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQTJFQyxHQUVELDJFQUEyRSxHQXdCM0UsU0FBUyxLQUFLLEtBQTRCO0VBQ3hDLElBQUksT0FBTyxNQUFNLEtBQUs7QUFDeEI7QUFFQSx5RUFBeUUsR0FDekUsU0FBUyxVQUFVLElBQVksRUFBRSxLQUFhO0VBQzVDLElBQUksU0FBUyxLQUFLLE1BQU0sRUFBRSxPQUFPO0VBQ2pDLE9BQU8sS0FBSyxRQUFRLENBQUMsU0FBUyxVQUFVLEtBQUssTUFBTSxHQUFHO0FBQ3hEO0FBRUE7Ozs7Q0FJQyxHQUNELE9BQU8sU0FBUyxlQUNkLElBQVksRUFDWixLQUFpQjtFQUVqQiwyRUFBMkU7RUFDM0Usc0VBQXNFO0VBQ3RFLDJFQUEyRTtF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
// denoCacheMetadata=2655541981439004473,16505720132467103265