/**
 * GitHub-compatible heading-anchor helpers (Issue #3424).
 *
 * GitHub Pages/GFM derives a heading's anchor slug with a fixed algorithm
 * (the same one `github-slugger` implements). Internal `#fragment` links must
 * match that slug exactly or they scroll to nothing. These helpers let tests
 * validate that in-repo anchor links resolve against the real headings rather
 * than eyeballing slugs by hand.
 *
 * Algorithm (matching GitHub):
 *   1. Lower-case the heading text.
 *   2. Remove every character that is not a Unicode letter, mark, number,
 *      connector punctuation (`\p{Pc}`, e.g. `_`), space, or ASCII hyphen —
 *      this strips most emoji, em-dashes, `#`, `/`, brackets, etc., but keeps
 *      combining marks such as the U+FE0F variation selector and connector
 *      punctuation such as underscore, matching `github-slugger` (Issue
 *      #3337).
 *   3. Replace spaces with hyphens (no trimming, no hyphen collapsing).
 *
 * Consequences worth noting, because they are the exact bugs this guards:
 *   - A leading emoji (`## 🥇 Title`) leaves a leading space that becomes a
 *     leading hyphen: `#-title`.
 *   - A space-padded em-dash or `+` (`a — b`, `a + b`) leaves two spaces that
 *     become a double hyphen: `a--b`.
 *   - An emoji with a U+FE0F variation selector (`## ⚠️ Title`) keeps the
 *     selector, so the id is `️-title`; a link writes it percent-encoded as
 *     `#%EF%B8%8F-title` (Issue #3292).
 *   - `## Host-level failures — \`callbacks.host_failure\`` keeps the
 *     underscore (connector punctuation) but drops the `.` and the
 *     backticks: `#host-level-failures--callbackshost_failure` (Issue
 *     #3337).
 *   - `_name_` written as emphasis (word-boundary underscores, outside a
 *     code span) is rendered by GitHub as `<em>name</em>` — the delimiters
 *     are dropped from the slug, unlike the connector-punctuation
 *     underscore in `callbacks.host_failure` above, which is intraword and
 *     has no emphasis meaning (review on PR #3363, Issue #3337).
 *
 * Australian English spelling used throughout (behaviour, normalise, etc.).
 */ /**
 * Characters GitHub keeps: Unicode letters, marks (e.g. U+FE0F variation
 * selector), numbers, connector punctuation (`\p{Pc}`, e.g. `_` — GitHub's
 * `github-slugger` keeps it, Issue #3337), spaces, ASCII hyphen.
 */ const STRIP = /[^\p{L}\p{M}\p{N}\p{Pc} -]/gu;
/** A backtick code span: `` `x` ``, ``` ``x`` ```, of any backtick run length. */ const CODE_SPAN = /(`+)(.*?)\1/g;
/**
 * An underscore emphasis/strong delimiter pair (`_word_`, `__word__`) at a
 * word boundary on both sides — the shape GitHub's renderer turns into
 * `<em>`/`<strong>` and drops from the text content. An underscore flanked
 * by a letter/number/underscore on either side (`host_failure`) is
 * intraword and left alone, matching CommonMark's underscore-emphasis rule
 * (review on PR #3363, Issue #3337).
 */ const EMPHASIS_UNDERSCORES = /(?<=^|[^\p{L}\p{N}_])(_{1,2})(?!\s)(.+?)(?<!\s)\1(?=$|[^\p{L}\p{N}_])/gu;
/**
 * Remove underscore emphasis delimiters outside backtick code spans, so the
 * slug reflects GitHub's rendered text content rather than the raw
 * Markdown source (review on PR #3363, Issue #3337).
 */ function stripEmphasisUnderscores(text) {
  let result = "";
  let lastIndex = 0;
  for (const span of text.matchAll(CODE_SPAN)){
    const start = span.index ?? 0;
    result += text.slice(lastIndex, start).replace(EMPHASIS_UNDERSCORES, "$2");
    result += span[0];
    lastIndex = start + span[0].length;
  }
  result += text.slice(lastIndex).replace(EMPHASIS_UNDERSCORES, "$2");
  return result;
}
/**
 * Slugify a single heading's text the way GitHub does. Does not apply the
 * duplicate-heading `-1`/`-2` suffixing — use {@link headingSlugs} for a whole
 * document where duplicates matter.
 */ export function githubSlug(headingText) {
  return stripEmphasisUnderscores(headingText).toLowerCase().replace(STRIP, "").replace(/ /g, "-");
}
/**
 * Walk a Markdown document line by line, yielding every line outside a
 * fenced code block (``` or ~~~, of any length ≥ 3) along with its 1-based
 * line number. Shared by {@link headingSlugs} and
 * {@link crossFileAnchorLinks} so both skip fences identically (Issue
 * #3337).
 */ function* linesOutsideFences(markdown) {
  let fence = null;
  const lines = markdown.split("\n");
  for(let i = 0; i < lines.length; i++){
    const line = (lines[i] ?? "").trimEnd();
    const fenceMatch = line.match(/^\s*(`|~)\1\1/);
    if (fenceMatch) {
      const marker = (fenceMatch[1] ?? "`").repeat(3);
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    yield {
      lineNumber: i + 1,
      line
    };
  }
}
/**
 * Extract every heading slug from a Markdown document, in document order,
 * skipping fenced code blocks. Duplicate slugs get GitHub's `-1`, `-2`, …
 * suffixes so the returned list mirrors the anchors GitHub actually emits.
 */ export function headingSlugs(markdown) {
  const slugs = [];
  const seen = new Map();
  for (const { line } of linesOutsideFences(markdown)){
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!heading) continue;
    const base = githubSlug(heading[2] ?? "");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.push(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}
/** A resolvable set of anchors for one document. */ export function anchorSet(markdown) {
  return new Set(headingSlugs(markdown));
}
// SIMPLE-ON-PURPOSE: link text with nested brackets and destinations containing parentheses or `<` are not matched — upgrade when a docs link needs either.
/**
 * Inline link destination: `[text](dest)` or `[text](<dest> "title")`.
 * Deliberately linear — the link-text class excludes `[`, and the
 * angle-bracket and bare destination classes exclude `<`/`(` respectively,
 * so every scan is bounded at the next start candidate instead of running to
 * the end of the paragraph (Issue #3337).
 */ const INLINE_LINK = /\[[^\[\]]*\]\(\s*(<[^<>]*>|[^\s()<]+)(?:\s+"[^"]*")?\s*\)/g;
/**
 * Reference-style link definition: `[label]: dest` or `[label]: <dest>`,
 * optionally followed by a title. Anchored to the (optionally indented)
 * start of the line (Issue #3337).
 */ const REF_DEF = /^[ \t]{0,3}\[[^\]]+\]:\s*(<[^>]*>|[^\s]+)/;
/**
 * An ATX heading line (`# Title` … `###### Title`). A heading is a single-line
 * block, so its links are scanned on their own and never joined to the lines
 * around it (Issue #4870).
 */ const HEADING_LINE = /^\s*#{1,6}(?:\s|$)/;
/**
 * A table row: a line whose first non-space character is `|`. Table rows are
 * single-line blocks, so their links are scanned on their own, never joined
 * to a neighbouring row (Issue #4870).
 */ const TABLE_ROW = /^\s*\|/;
/**
 * A list-item marker (`-`, `*`, `+`, `1.`, `1)`) followed by whitespace. An
 * item starts a new paragraph, but the lines after it that carry no marker
 * continue it, so a link wrapped inside an item is still found (Issue #4870).
 */ const LIST_ITEM_LINE = /^\s*(?:[-*+]|\d{1,9}[.)])\s/;
/** Any URI with a scheme (`https:`, `mailto:`, …), not a relative path. */ const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
/**
 * Replace every inline code span (`` `x` ``, `` ``x`` ``, …) in a piece of
 * text with spaces of the same length, so link-like text inside code spans is
 * never mistaken for a real Markdown link (Issue #3337). The text may be a
 * whole paragraph joined across lines, so a code span that wraps is blanked
 * too (Issue #4870).
 */ function blankCodeSpans(line) {
  return line.replace(/(`+)(.*?)\1/g, (m)=>" ".repeat(m.length));
}
/**
 * Parse a raw link destination into a `.md` target plus fragment, or null
 * when it is not a same-repo link to a Markdown file with a `#fragment`
 * (Issue #3337).
 */ function parseDestination(raw) {
  let dest = raw;
  if (dest.startsWith("<") && dest.endsWith(">")) {
    dest = dest.slice(1, -1);
  }
  if (SCHEME.test(dest)) return null;
  const hashIndex = dest.indexOf("#");
  if (hashIndex === -1) return null;
  const target = dest.slice(0, hashIndex);
  const fragment = dest.slice(hashIndex + 1);
  if (!/\.md$/i.test(target)) return null;
  if (fragment.length === 0) return null;
  return {
    target,
    fragment
  };
}
/**
 * Scan one paragraph, or one single-line block, for inline links (Issue
 * #4870). The lines are joined with a single space, which is the same length
 * as the newline it stands in for, so offsets stay simple. Code spans are
 * blanked across the join, so a wrapped code span is blanked too. Each link
 * is reported on the line its opening `[` sits on.
 */ function scanParagraph(paragraph, results) {
  if (paragraph.length === 0) return;
  const starts = [];
  let offset = 0;
  for (const { line } of paragraph){
    starts.push(offset);
    offset += line.length + 1;
  }
  const text = blankCodeSpans(paragraph.map(({ line })=>line).join(" "));
  // Match indices arrive in ascending order, so one forward pointer maps each
  // link to its line in linear time over the whole paragraph.
  let current = 0;
  for (const m of text.matchAll(INLINE_LINK)){
    const index = m.index ?? 0;
    while((starts[current + 1] ?? Infinity) <= index)current++;
    const parsed = parseDestination(m[1] ?? "");
    if (parsed) {
      results.push({
        line: paragraph[current]?.lineNumber ?? 0,
        target: parsed.target,
        fragment: parsed.fragment
      });
    }
  }
}
/**
 * Extract every relative link to a `.md` file that carries a `#fragment`
 * from a Markdown document: inline links (including the angle-bracket form
 * and an optional `"title"`) and reference definitions. Inline links are
 * matched per paragraph rather than per physical line, so link text that
 * soft-wraps across lines is found (Issue #4870); each link is reported on
 * the line its opening `[` sits on. A paragraph is never joined across a
 * blank line, a fenced code block, a heading, a table row or the start of
 * another list item — headings and table rows are scanned one line at a
 * time. Links inside fenced code blocks or inline code spans are skipped, as
 * are links with a URL scheme (`https:`, `mailto:`, …) — MD051-style checkers
 * only validate in-file fragments, so cross-file ones like these need their
 * own guard (Issue #3337).
 */ export function crossFileAnchorLinks(markdown) {
  const results = [];
  let paragraph = [];
  let previousLineNumber = 0;
  const flush = ()=>{
    scanParagraph(paragraph, results);
    paragraph = [];
  };
  for (const numbered of linesOutsideFences(markdown)){
    const { lineNumber, line } = numbered;
    // A gap in line numbers means a fenced block was skipped between the two
    // lines: never join across it.
    if (lineNumber !== previousLineNumber + 1) flush();
    previousLineNumber = lineNumber;
    if (line.trim() === "") {
      flush();
      continue;
    }
    const refMatch = blankCodeSpans(line).match(REF_DEF);
    if (refMatch) {
      flush();
      const parsed = parseDestination(refMatch[1] ?? "");
      if (parsed) {
        results.push({
          line: lineNumber,
          target: parsed.target,
          fragment: parsed.fragment
        });
      }
      continue;
    }
    if (HEADING_LINE.test(line) || TABLE_ROW.test(line)) {
      flush();
      scanParagraph([
        numbered
      ], results);
      continue;
    }
    if (LIST_ITEM_LINE.test(line)) flush();
    paragraph.push(numbered);
  }
  flush();
  return results;
}
/**
 * Decode a URL fragment, or null when it is malformed (e.g. a truncated
 * percent-escape). Used to resolve `#fragment` links back to a heading's raw
 * text (Issue #3337).
 */ export function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch  {
    return null;
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9tYXJrZG93bl9hbmNob3JzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogR2l0SHViLWNvbXBhdGlibGUgaGVhZGluZy1hbmNob3IgaGVscGVycyAoSXNzdWUgIzM0MjQpLlxuICpcbiAqIEdpdEh1YiBQYWdlcy9HRk0gZGVyaXZlcyBhIGhlYWRpbmcncyBhbmNob3Igc2x1ZyB3aXRoIGEgZml4ZWQgYWxnb3JpdGhtXG4gKiAodGhlIHNhbWUgb25lIGBnaXRodWItc2x1Z2dlcmAgaW1wbGVtZW50cykuIEludGVybmFsIGAjZnJhZ21lbnRgIGxpbmtzIG11c3RcbiAqIG1hdGNoIHRoYXQgc2x1ZyBleGFjdGx5IG9yIHRoZXkgc2Nyb2xsIHRvIG5vdGhpbmcuIFRoZXNlIGhlbHBlcnMgbGV0IHRlc3RzXG4gKiB2YWxpZGF0ZSB0aGF0IGluLXJlcG8gYW5jaG9yIGxpbmtzIHJlc29sdmUgYWdhaW5zdCB0aGUgcmVhbCBoZWFkaW5ncyByYXRoZXJcbiAqIHRoYW4gZXllYmFsbGluZyBzbHVncyBieSBoYW5kLlxuICpcbiAqIEFsZ29yaXRobSAobWF0Y2hpbmcgR2l0SHViKTpcbiAqICAgMS4gTG93ZXItY2FzZSB0aGUgaGVhZGluZyB0ZXh0LlxuICogICAyLiBSZW1vdmUgZXZlcnkgY2hhcmFjdGVyIHRoYXQgaXMgbm90IGEgVW5pY29kZSBsZXR0ZXIsIG1hcmssIG51bWJlcixcbiAqICAgICAgY29ubmVjdG9yIHB1bmN0dWF0aW9uIChgXFxwe1BjfWAsIGUuZy4gYF9gKSwgc3BhY2UsIG9yIEFTQ0lJIGh5cGhlbiDigJRcbiAqICAgICAgdGhpcyBzdHJpcHMgbW9zdCBlbW9qaSwgZW0tZGFzaGVzLCBgI2AsIGAvYCwgYnJhY2tldHMsIGV0Yy4sIGJ1dCBrZWVwc1xuICogICAgICBjb21iaW5pbmcgbWFya3Mgc3VjaCBhcyB0aGUgVStGRTBGIHZhcmlhdGlvbiBzZWxlY3RvciBhbmQgY29ubmVjdG9yXG4gKiAgICAgIHB1bmN0dWF0aW9uIHN1Y2ggYXMgdW5kZXJzY29yZSwgbWF0Y2hpbmcgYGdpdGh1Yi1zbHVnZ2VyYCAoSXNzdWVcbiAqICAgICAgIzMzMzcpLlxuICogICAzLiBSZXBsYWNlIHNwYWNlcyB3aXRoIGh5cGhlbnMgKG5vIHRyaW1taW5nLCBubyBoeXBoZW4gY29sbGFwc2luZykuXG4gKlxuICogQ29uc2VxdWVuY2VzIHdvcnRoIG5vdGluZywgYmVjYXVzZSB0aGV5IGFyZSB0aGUgZXhhY3QgYnVncyB0aGlzIGd1YXJkczpcbiAqICAgLSBBIGxlYWRpbmcgZW1vamkgKGAjIyDwn6WHIFRpdGxlYCkgbGVhdmVzIGEgbGVhZGluZyBzcGFjZSB0aGF0IGJlY29tZXMgYVxuICogICAgIGxlYWRpbmcgaHlwaGVuOiBgIy10aXRsZWAuXG4gKiAgIC0gQSBzcGFjZS1wYWRkZWQgZW0tZGFzaCBvciBgK2AgKGBhIOKAlCBiYCwgYGEgKyBiYCkgbGVhdmVzIHR3byBzcGFjZXMgdGhhdFxuICogICAgIGJlY29tZSBhIGRvdWJsZSBoeXBoZW46IGBhLS1iYC5cbiAqICAgLSBBbiBlbW9qaSB3aXRoIGEgVStGRTBGIHZhcmlhdGlvbiBzZWxlY3RvciAoYCMjIOKaoO+4jyBUaXRsZWApIGtlZXBzIHRoZVxuICogICAgIHNlbGVjdG9yLCBzbyB0aGUgaWQgaXMgYO+4jy10aXRsZWA7IGEgbGluayB3cml0ZXMgaXQgcGVyY2VudC1lbmNvZGVkIGFzXG4gKiAgICAgYCMlRUYlQjglOEYtdGl0bGVgIChJc3N1ZSAjMzI5MikuXG4gKiAgIC0gYCMjIEhvc3QtbGV2ZWwgZmFpbHVyZXMg4oCUIFxcYGNhbGxiYWNrcy5ob3N0X2ZhaWx1cmVcXGBgIGtlZXBzIHRoZVxuICogICAgIHVuZGVyc2NvcmUgKGNvbm5lY3RvciBwdW5jdHVhdGlvbikgYnV0IGRyb3BzIHRoZSBgLmAgYW5kIHRoZVxuICogICAgIGJhY2t0aWNrczogYCNob3N0LWxldmVsLWZhaWx1cmVzLS1jYWxsYmFja3Nob3N0X2ZhaWx1cmVgIChJc3N1ZVxuICogICAgICMzMzM3KS5cbiAqICAgLSBgX25hbWVfYCB3cml0dGVuIGFzIGVtcGhhc2lzICh3b3JkLWJvdW5kYXJ5IHVuZGVyc2NvcmVzLCBvdXRzaWRlIGFcbiAqICAgICBjb2RlIHNwYW4pIGlzIHJlbmRlcmVkIGJ5IEdpdEh1YiBhcyBgPGVtPm5hbWU8L2VtPmAg4oCUIHRoZSBkZWxpbWl0ZXJzXG4gKiAgICAgYXJlIGRyb3BwZWQgZnJvbSB0aGUgc2x1ZywgdW5saWtlIHRoZSBjb25uZWN0b3ItcHVuY3R1YXRpb25cbiAqICAgICB1bmRlcnNjb3JlIGluIGBjYWxsYmFja3MuaG9zdF9mYWlsdXJlYCBhYm92ZSwgd2hpY2ggaXMgaW50cmF3b3JkIGFuZFxuICogICAgIGhhcyBubyBlbXBoYXNpcyBtZWFuaW5nIChyZXZpZXcgb24gUFIgIzMzNjMsIElzc3VlICMzMzM3KS5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgdXNlZCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG5vcm1hbGlzZSwgZXRjLikuXG4gKi9cblxuLyoqXG4gKiBDaGFyYWN0ZXJzIEdpdEh1YiBrZWVwczogVW5pY29kZSBsZXR0ZXJzLCBtYXJrcyAoZS5nLiBVK0ZFMEYgdmFyaWF0aW9uXG4gKiBzZWxlY3RvciksIG51bWJlcnMsIGNvbm5lY3RvciBwdW5jdHVhdGlvbiAoYFxccHtQY31gLCBlLmcuIGBfYCDigJQgR2l0SHViJ3NcbiAqIGBnaXRodWItc2x1Z2dlcmAga2VlcHMgaXQsIElzc3VlICMzMzM3KSwgc3BhY2VzLCBBU0NJSSBoeXBoZW4uXG4gKi9cbmNvbnN0IFNUUklQID0gL1teXFxwe0x9XFxwe019XFxwe059XFxwe1BjfSAtXS9ndTtcblxuLyoqIEEgYmFja3RpY2sgY29kZSBzcGFuOiBgYCBgeGAgYGAsIGBgYCBgYHhgYCBgYGAsIG9mIGFueSBiYWNrdGljayBydW4gbGVuZ3RoLiAqL1xuY29uc3QgQ09ERV9TUEFOID0gLyhgKykoLio/KVxcMS9nO1xuXG4vKipcbiAqIEFuIHVuZGVyc2NvcmUgZW1waGFzaXMvc3Ryb25nIGRlbGltaXRlciBwYWlyIChgX3dvcmRfYCwgYF9fd29yZF9fYCkgYXQgYVxuICogd29yZCBib3VuZGFyeSBvbiBib3RoIHNpZGVzIOKAlCB0aGUgc2hhcGUgR2l0SHViJ3MgcmVuZGVyZXIgdHVybnMgaW50b1xuICogYDxlbT5gL2A8c3Ryb25nPmAgYW5kIGRyb3BzIGZyb20gdGhlIHRleHQgY29udGVudC4gQW4gdW5kZXJzY29yZSBmbGFua2VkXG4gKiBieSBhIGxldHRlci9udW1iZXIvdW5kZXJzY29yZSBvbiBlaXRoZXIgc2lkZSAoYGhvc3RfZmFpbHVyZWApIGlzXG4gKiBpbnRyYXdvcmQgYW5kIGxlZnQgYWxvbmUsIG1hdGNoaW5nIENvbW1vbk1hcmsncyB1bmRlcnNjb3JlLWVtcGhhc2lzIHJ1bGVcbiAqIChyZXZpZXcgb24gUFIgIzMzNjMsIElzc3VlICMzMzM3KS5cbiAqL1xuY29uc3QgRU1QSEFTSVNfVU5ERVJTQ09SRVMgPVxuICAvKD88PV58W15cXHB7TH1cXHB7Tn1fXSkoX3sxLDJ9KSg/IVxccykoLis/KSg/PCFcXHMpXFwxKD89JHxbXlxccHtMfVxccHtOfV9dKS9ndTtcblxuLyoqXG4gKiBSZW1vdmUgdW5kZXJzY29yZSBlbXBoYXNpcyBkZWxpbWl0ZXJzIG91dHNpZGUgYmFja3RpY2sgY29kZSBzcGFucywgc28gdGhlXG4gKiBzbHVnIHJlZmxlY3RzIEdpdEh1YidzIHJlbmRlcmVkIHRleHQgY29udGVudCByYXRoZXIgdGhhbiB0aGUgcmF3XG4gKiBNYXJrZG93biBzb3VyY2UgKHJldmlldyBvbiBQUiAjMzM2MywgSXNzdWUgIzMzMzcpLlxuICovXG5mdW5jdGlvbiBzdHJpcEVtcGhhc2lzVW5kZXJzY29yZXModGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IHJlc3VsdCA9IFwiXCI7XG4gIGxldCBsYXN0SW5kZXggPSAwO1xuICBmb3IgKGNvbnN0IHNwYW4gb2YgdGV4dC5tYXRjaEFsbChDT0RFX1NQQU4pKSB7XG4gICAgY29uc3Qgc3RhcnQgPSBzcGFuLmluZGV4ID8/IDA7XG4gICAgcmVzdWx0ICs9IHRleHQuc2xpY2UobGFzdEluZGV4LCBzdGFydCkucmVwbGFjZShcbiAgICAgIEVNUEhBU0lTX1VOREVSU0NPUkVTLFxuICAgICAgXCIkMlwiLFxuICAgICk7XG4gICAgcmVzdWx0ICs9IHNwYW5bMF07XG4gICAgbGFzdEluZGV4ID0gc3RhcnQgKyBzcGFuWzBdLmxlbmd0aDtcbiAgfVxuICByZXN1bHQgKz0gdGV4dC5zbGljZShsYXN0SW5kZXgpLnJlcGxhY2UoRU1QSEFTSVNfVU5ERVJTQ09SRVMsIFwiJDJcIik7XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbi8qKlxuICogU2x1Z2lmeSBhIHNpbmdsZSBoZWFkaW5nJ3MgdGV4dCB0aGUgd2F5IEdpdEh1YiBkb2VzLiBEb2VzIG5vdCBhcHBseSB0aGVcbiAqIGR1cGxpY2F0ZS1oZWFkaW5nIGAtMWAvYC0yYCBzdWZmaXhpbmcg4oCUIHVzZSB7QGxpbmsgaGVhZGluZ1NsdWdzfSBmb3IgYSB3aG9sZVxuICogZG9jdW1lbnQgd2hlcmUgZHVwbGljYXRlcyBtYXR0ZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnaXRodWJTbHVnKGhlYWRpbmdUZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gc3RyaXBFbXBoYXNpc1VuZGVyc2NvcmVzKGhlYWRpbmdUZXh0KVxuICAgIC50b0xvd2VyQ2FzZSgpXG4gICAgLnJlcGxhY2UoU1RSSVAsIFwiXCIpXG4gICAgLnJlcGxhY2UoLyAvZywgXCItXCIpO1xufVxuXG4vKiogT25lIGxpbmUgb2YgYSBkb2N1bWVudCwgcGFpcmVkIHdpdGggaXRzIDEtYmFzZWQgbGluZSBudW1iZXIuICovXG5pbnRlcmZhY2UgTnVtYmVyZWRMaW5lIHtcbiAgbGluZU51bWJlcjogbnVtYmVyO1xuICBsaW5lOiBzdHJpbmc7XG59XG5cbi8qKlxuICogV2FsayBhIE1hcmtkb3duIGRvY3VtZW50IGxpbmUgYnkgbGluZSwgeWllbGRpbmcgZXZlcnkgbGluZSBvdXRzaWRlIGFcbiAqIGZlbmNlZCBjb2RlIGJsb2NrIChgYGAgb3Igfn5+LCBvZiBhbnkgbGVuZ3RoIOKJpSAzKSBhbG9uZyB3aXRoIGl0cyAxLWJhc2VkXG4gKiBsaW5lIG51bWJlci4gU2hhcmVkIGJ5IHtAbGluayBoZWFkaW5nU2x1Z3N9IGFuZFxuICoge0BsaW5rIGNyb3NzRmlsZUFuY2hvckxpbmtzfSBzbyBib3RoIHNraXAgZmVuY2VzIGlkZW50aWNhbGx5IChJc3N1ZVxuICogIzMzMzcpLlxuICovXG5mdW5jdGlvbiogbGluZXNPdXRzaWRlRmVuY2VzKG1hcmtkb3duOiBzdHJpbmcpOiBHZW5lcmF0b3I8TnVtYmVyZWRMaW5lPiB7XG4gIGxldCBmZW5jZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3QgbGluZXMgPSBtYXJrZG93bi5zcGxpdChcIlxcblwiKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGxpbmUgPSAobGluZXNbaV0gPz8gXCJcIikudHJpbUVuZCgpO1xuICAgIGNvbnN0IGZlbmNlTWF0Y2ggPSBsaW5lLm1hdGNoKC9eXFxzKihgfH4pXFwxXFwxLyk7XG4gICAgaWYgKGZlbmNlTWF0Y2gpIHtcbiAgICAgIGNvbnN0IG1hcmtlciA9IChmZW5jZU1hdGNoWzFdID8/IFwiYFwiKS5yZXBlYXQoMyk7XG4gICAgICBpZiAoZmVuY2UgPT09IG51bGwpIGZlbmNlID0gbWFya2VyO1xuICAgICAgZWxzZSBpZiAobWFya2VyID09PSBmZW5jZSkgZmVuY2UgPSBudWxsO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChmZW5jZSAhPT0gbnVsbCkgY29udGludWU7XG5cbiAgICB5aWVsZCB7IGxpbmVOdW1iZXI6IGkgKyAxLCBsaW5lIH07XG4gIH1cbn1cblxuLyoqXG4gKiBFeHRyYWN0IGV2ZXJ5IGhlYWRpbmcgc2x1ZyBmcm9tIGEgTWFya2Rvd24gZG9jdW1lbnQsIGluIGRvY3VtZW50IG9yZGVyLFxuICogc2tpcHBpbmcgZmVuY2VkIGNvZGUgYmxvY2tzLiBEdXBsaWNhdGUgc2x1Z3MgZ2V0IEdpdEh1YidzIGAtMWAsIGAtMmAsIOKAplxuICogc3VmZml4ZXMgc28gdGhlIHJldHVybmVkIGxpc3QgbWlycm9ycyB0aGUgYW5jaG9ycyBHaXRIdWIgYWN0dWFsbHkgZW1pdHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFkaW5nU2x1Z3MobWFya2Rvd246IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgc2x1Z3M6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuXG4gIGZvciAoY29uc3QgeyBsaW5lIH0gb2YgbGluZXNPdXRzaWRlRmVuY2VzKG1hcmtkb3duKSkge1xuICAgIGNvbnN0IGhlYWRpbmcgPSBsaW5lLm1hdGNoKC9eKCN7MSw2fSlcXHMrKC4qPylcXHMqIypcXHMqJC8pO1xuICAgIGlmICghaGVhZGluZykgY29udGludWU7XG5cbiAgICBjb25zdCBiYXNlID0gZ2l0aHViU2x1ZyhoZWFkaW5nWzJdID8/IFwiXCIpO1xuICAgIGNvbnN0IGNvdW50ID0gc2Vlbi5nZXQoYmFzZSkgPz8gMDtcbiAgICBzZWVuLnNldChiYXNlLCBjb3VudCArIDEpO1xuICAgIHNsdWdzLnB1c2goY291bnQgPT09IDAgPyBiYXNlIDogYCR7YmFzZX0tJHtjb3VudH1gKTtcbiAgfVxuICByZXR1cm4gc2x1Z3M7XG59XG5cbi8qKiBBIHJlc29sdmFibGUgc2V0IG9mIGFuY2hvcnMgZm9yIG9uZSBkb2N1bWVudC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhbmNob3JTZXQobWFya2Rvd246IHN0cmluZyk6IFNldDxzdHJpbmc+IHtcbiAgcmV0dXJuIG5ldyBTZXQoaGVhZGluZ1NsdWdzKG1hcmtkb3duKSk7XG59XG5cbi8qKiBPbmUgY3Jvc3MtZmlsZSBgI2ZyYWdtZW50YCBsaW5rIGZvdW5kIGJ5IHtAbGluayBjcm9zc0ZpbGVBbmNob3JMaW5rc30uICovXG5leHBvcnQgaW50ZXJmYWNlIENyb3NzRmlsZUFuY2hvckxpbmsge1xuICAvKiogMS1iYXNlZCBsaW5lIG51bWJlciBvZiB0aGUgbGluaydzIG9wZW5pbmcgYFtgLiAqL1xuICBsaW5lOiBudW1iZXI7XG4gIC8qKiBUaGUgbGluaydzIHRhcmdldCBwYXRoLCBleGFjdGx5IGFzIHdyaXR0ZW4gKG5vdCB5ZXQgcmVzb2x2ZWQpLiAqL1xuICB0YXJnZXQ6IHN0cmluZztcbiAgLyoqIFRoZSBsaW5rJ3MgZnJhZ21lbnQsIHJhdyDigJQgc3RpbGwgcGVyY2VudC1lbmNvZGVkIGlmIGl0IHdhcyB3cml0dGVuIHNvLiAqL1xuICBmcmFnbWVudDogc3RyaW5nO1xufVxuXG4vLyBTSU1QTEUtT04tUFVSUE9TRTogbGluayB0ZXh0IHdpdGggbmVzdGVkIGJyYWNrZXRzIGFuZCBkZXN0aW5hdGlvbnMgY29udGFpbmluZyBwYXJlbnRoZXNlcyBvciBgPGAgYXJlIG5vdCBtYXRjaGVkIOKAlCB1cGdyYWRlIHdoZW4gYSBkb2NzIGxpbmsgbmVlZHMgZWl0aGVyLlxuLyoqXG4gKiBJbmxpbmUgbGluayBkZXN0aW5hdGlvbjogYFt0ZXh0XShkZXN0KWAgb3IgYFt0ZXh0XSg8ZGVzdD4gXCJ0aXRsZVwiKWAuXG4gKiBEZWxpYmVyYXRlbHkgbGluZWFyIOKAlCB0aGUgbGluay10ZXh0IGNsYXNzIGV4Y2x1ZGVzIGBbYCwgYW5kIHRoZVxuICogYW5nbGUtYnJhY2tldCBhbmQgYmFyZSBkZXN0aW5hdGlvbiBjbGFzc2VzIGV4Y2x1ZGUgYDxgL2AoYCByZXNwZWN0aXZlbHksXG4gKiBzbyBldmVyeSBzY2FuIGlzIGJvdW5kZWQgYXQgdGhlIG5leHQgc3RhcnQgY2FuZGlkYXRlIGluc3RlYWQgb2YgcnVubmluZyB0b1xuICogdGhlIGVuZCBvZiB0aGUgcGFyYWdyYXBoIChJc3N1ZSAjMzMzNykuXG4gKi9cbmNvbnN0IElOTElORV9MSU5LID1cbiAgL1xcW1teXFxbXFxdXSpcXF1cXChcXHMqKDxbXjw+XSo+fFteXFxzKCk8XSspKD86XFxzK1wiW15cIl0qXCIpP1xccypcXCkvZztcblxuLyoqXG4gKiBSZWZlcmVuY2Utc3R5bGUgbGluayBkZWZpbml0aW9uOiBgW2xhYmVsXTogZGVzdGAgb3IgYFtsYWJlbF06IDxkZXN0PmAsXG4gKiBvcHRpb25hbGx5IGZvbGxvd2VkIGJ5IGEgdGl0bGUuIEFuY2hvcmVkIHRvIHRoZSAob3B0aW9uYWxseSBpbmRlbnRlZClcbiAqIHN0YXJ0IG9mIHRoZSBsaW5lIChJc3N1ZSAjMzMzNykuXG4gKi9cbmNvbnN0IFJFRl9ERUYgPSAvXlsgXFx0XXswLDN9XFxbW15cXF1dK1xcXTpcXHMqKDxbXj5dKj58W15cXHNdKykvO1xuXG4vKipcbiAqIEFuIEFUWCBoZWFkaW5nIGxpbmUgKGAjIFRpdGxlYCDigKYgYCMjIyMjIyBUaXRsZWApLiBBIGhlYWRpbmcgaXMgYSBzaW5nbGUtbGluZVxuICogYmxvY2ssIHNvIGl0cyBsaW5rcyBhcmUgc2Nhbm5lZCBvbiB0aGVpciBvd24gYW5kIG5ldmVyIGpvaW5lZCB0byB0aGUgbGluZXNcbiAqIGFyb3VuZCBpdCAoSXNzdWUgIzQ4NzApLlxuICovXG5jb25zdCBIRUFESU5HX0xJTkUgPSAvXlxccyojezEsNn0oPzpcXHN8JCkvO1xuXG4vKipcbiAqIEEgdGFibGUgcm93OiBhIGxpbmUgd2hvc2UgZmlyc3Qgbm9uLXNwYWNlIGNoYXJhY3RlciBpcyBgfGAuIFRhYmxlIHJvd3MgYXJlXG4gKiBzaW5nbGUtbGluZSBibG9ja3MsIHNvIHRoZWlyIGxpbmtzIGFyZSBzY2FubmVkIG9uIHRoZWlyIG93biwgbmV2ZXIgam9pbmVkXG4gKiB0byBhIG5laWdoYm91cmluZyByb3cgKElzc3VlICM0ODcwKS5cbiAqL1xuY29uc3QgVEFCTEVfUk9XID0gL15cXHMqXFx8LztcblxuLyoqXG4gKiBBIGxpc3QtaXRlbSBtYXJrZXIgKGAtYCwgYCpgLCBgK2AsIGAxLmAsIGAxKWApIGZvbGxvd2VkIGJ5IHdoaXRlc3BhY2UuIEFuXG4gKiBpdGVtIHN0YXJ0cyBhIG5ldyBwYXJhZ3JhcGgsIGJ1dCB0aGUgbGluZXMgYWZ0ZXIgaXQgdGhhdCBjYXJyeSBubyBtYXJrZXJcbiAqIGNvbnRpbnVlIGl0LCBzbyBhIGxpbmsgd3JhcHBlZCBpbnNpZGUgYW4gaXRlbSBpcyBzdGlsbCBmb3VuZCAoSXNzdWUgIzQ4NzApLlxuICovXG5jb25zdCBMSVNUX0lURU1fTElORSA9IC9eXFxzKig/OlstKitdfFxcZHsxLDl9Wy4pXSlcXHMvO1xuXG4vKiogQW55IFVSSSB3aXRoIGEgc2NoZW1lIChgaHR0cHM6YCwgYG1haWx0bzpgLCDigKYpLCBub3QgYSByZWxhdGl2ZSBwYXRoLiAqL1xuY29uc3QgU0NIRU1FID0gL15bYS16QS1aXVthLXpBLVowLTkrLi1dKjovO1xuXG4vKipcbiAqIFJlcGxhY2UgZXZlcnkgaW5saW5lIGNvZGUgc3BhbiAoYGAgYHhgIGBgLCBgYCBgYHhgYCBgYCwg4oCmKSBpbiBhIHBpZWNlIG9mXG4gKiB0ZXh0IHdpdGggc3BhY2VzIG9mIHRoZSBzYW1lIGxlbmd0aCwgc28gbGluay1saWtlIHRleHQgaW5zaWRlIGNvZGUgc3BhbnMgaXNcbiAqIG5ldmVyIG1pc3Rha2VuIGZvciBhIHJlYWwgTWFya2Rvd24gbGluayAoSXNzdWUgIzMzMzcpLiBUaGUgdGV4dCBtYXkgYmUgYVxuICogd2hvbGUgcGFyYWdyYXBoIGpvaW5lZCBhY3Jvc3MgbGluZXMsIHNvIGEgY29kZSBzcGFuIHRoYXQgd3JhcHMgaXMgYmxhbmtlZFxuICogdG9vIChJc3N1ZSAjNDg3MCkuXG4gKi9cbmZ1bmN0aW9uIGJsYW5rQ29kZVNwYW5zKGxpbmU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBsaW5lLnJlcGxhY2UoLyhgKykoLio/KVxcMS9nLCAobSkgPT4gXCIgXCIucmVwZWF0KG0ubGVuZ3RoKSk7XG59XG5cbi8qKlxuICogUGFyc2UgYSByYXcgbGluayBkZXN0aW5hdGlvbiBpbnRvIGEgYC5tZGAgdGFyZ2V0IHBsdXMgZnJhZ21lbnQsIG9yIG51bGxcbiAqIHdoZW4gaXQgaXMgbm90IGEgc2FtZS1yZXBvIGxpbmsgdG8gYSBNYXJrZG93biBmaWxlIHdpdGggYSBgI2ZyYWdtZW50YFxuICogKElzc3VlICMzMzM3KS5cbiAqL1xuZnVuY3Rpb24gcGFyc2VEZXN0aW5hdGlvbihcbiAgcmF3OiBzdHJpbmcsXG4pOiB7IHRhcmdldDogc3RyaW5nOyBmcmFnbWVudDogc3RyaW5nIH0gfCBudWxsIHtcbiAgbGV0IGRlc3QgPSByYXc7XG4gIGlmIChkZXN0LnN0YXJ0c1dpdGgoXCI8XCIpICYmIGRlc3QuZW5kc1dpdGgoXCI+XCIpKSB7XG4gICAgZGVzdCA9IGRlc3Quc2xpY2UoMSwgLTEpO1xuICB9XG4gIGlmIChTQ0hFTUUudGVzdChkZXN0KSkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgaGFzaEluZGV4ID0gZGVzdC5pbmRleE9mKFwiI1wiKTtcbiAgaWYgKGhhc2hJbmRleCA9PT0gLTEpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IHRhcmdldCA9IGRlc3Quc2xpY2UoMCwgaGFzaEluZGV4KTtcbiAgY29uc3QgZnJhZ21lbnQgPSBkZXN0LnNsaWNlKGhhc2hJbmRleCArIDEpO1xuICBpZiAoIS9cXC5tZCQvaS50ZXN0KHRhcmdldCkpIHJldHVybiBudWxsO1xuICBpZiAoZnJhZ21lbnQubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcblxuICByZXR1cm4geyB0YXJnZXQsIGZyYWdtZW50IH07XG59XG5cbi8qKlxuICogU2NhbiBvbmUgcGFyYWdyYXBoLCBvciBvbmUgc2luZ2xlLWxpbmUgYmxvY2ssIGZvciBpbmxpbmUgbGlua3MgKElzc3VlXG4gKiAjNDg3MCkuIFRoZSBsaW5lcyBhcmUgam9pbmVkIHdpdGggYSBzaW5nbGUgc3BhY2UsIHdoaWNoIGlzIHRoZSBzYW1lIGxlbmd0aFxuICogYXMgdGhlIG5ld2xpbmUgaXQgc3RhbmRzIGluIGZvciwgc28gb2Zmc2V0cyBzdGF5IHNpbXBsZS4gQ29kZSBzcGFucyBhcmVcbiAqIGJsYW5rZWQgYWNyb3NzIHRoZSBqb2luLCBzbyBhIHdyYXBwZWQgY29kZSBzcGFuIGlzIGJsYW5rZWQgdG9vLiBFYWNoIGxpbmtcbiAqIGlzIHJlcG9ydGVkIG9uIHRoZSBsaW5lIGl0cyBvcGVuaW5nIGBbYCBzaXRzIG9uLlxuICovXG5mdW5jdGlvbiBzY2FuUGFyYWdyYXBoKFxuICBwYXJhZ3JhcGg6IE51bWJlcmVkTGluZVtdLFxuICByZXN1bHRzOiBDcm9zc0ZpbGVBbmNob3JMaW5rW10sXG4pOiB2b2lkIHtcbiAgaWYgKHBhcmFncmFwaC5sZW5ndGggPT09IDApIHJldHVybjtcblxuICBjb25zdCBzdGFydHM6IG51bWJlcltdID0gW107XG4gIGxldCBvZmZzZXQgPSAwO1xuICBmb3IgKGNvbnN0IHsgbGluZSB9IG9mIHBhcmFncmFwaCkge1xuICAgIHN0YXJ0cy5wdXNoKG9mZnNldCk7XG4gICAgb2Zmc2V0ICs9IGxpbmUubGVuZ3RoICsgMTtcbiAgfVxuXG4gIGNvbnN0IHRleHQgPSBibGFua0NvZGVTcGFucyhwYXJhZ3JhcGgubWFwKCh7IGxpbmUgfSkgPT4gbGluZSkuam9pbihcIiBcIikpO1xuXG4gIC8vIE1hdGNoIGluZGljZXMgYXJyaXZlIGluIGFzY2VuZGluZyBvcmRlciwgc28gb25lIGZvcndhcmQgcG9pbnRlciBtYXBzIGVhY2hcbiAgLy8gbGluayB0byBpdHMgbGluZSBpbiBsaW5lYXIgdGltZSBvdmVyIHRoZSB3aG9sZSBwYXJhZ3JhcGguXG4gIGxldCBjdXJyZW50ID0gMDtcbiAgZm9yIChjb25zdCBtIG9mIHRleHQubWF0Y2hBbGwoSU5MSU5FX0xJTkspKSB7XG4gICAgY29uc3QgaW5kZXggPSBtLmluZGV4ID8/IDA7XG4gICAgd2hpbGUgKChzdGFydHNbY3VycmVudCArIDFdID8/IEluZmluaXR5KSA8PSBpbmRleCkgY3VycmVudCsrO1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlRGVzdGluYXRpb24obVsxXSA/PyBcIlwiKTtcbiAgICBpZiAocGFyc2VkKSB7XG4gICAgICByZXN1bHRzLnB1c2goe1xuICAgICAgICBsaW5lOiBwYXJhZ3JhcGhbY3VycmVudF0/LmxpbmVOdW1iZXIgPz8gMCxcbiAgICAgICAgdGFyZ2V0OiBwYXJzZWQudGFyZ2V0LFxuICAgICAgICBmcmFnbWVudDogcGFyc2VkLmZyYWdtZW50LFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG5cbi8qKlxuICogRXh0cmFjdCBldmVyeSByZWxhdGl2ZSBsaW5rIHRvIGEgYC5tZGAgZmlsZSB0aGF0IGNhcnJpZXMgYSBgI2ZyYWdtZW50YFxuICogZnJvbSBhIE1hcmtkb3duIGRvY3VtZW50OiBpbmxpbmUgbGlua3MgKGluY2x1ZGluZyB0aGUgYW5nbGUtYnJhY2tldCBmb3JtXG4gKiBhbmQgYW4gb3B0aW9uYWwgYFwidGl0bGVcImApIGFuZCByZWZlcmVuY2UgZGVmaW5pdGlvbnMuIElubGluZSBsaW5rcyBhcmVcbiAqIG1hdGNoZWQgcGVyIHBhcmFncmFwaCByYXRoZXIgdGhhbiBwZXIgcGh5c2ljYWwgbGluZSwgc28gbGluayB0ZXh0IHRoYXRcbiAqIHNvZnQtd3JhcHMgYWNyb3NzIGxpbmVzIGlzIGZvdW5kIChJc3N1ZSAjNDg3MCk7IGVhY2ggbGluayBpcyByZXBvcnRlZCBvblxuICogdGhlIGxpbmUgaXRzIG9wZW5pbmcgYFtgIHNpdHMgb24uIEEgcGFyYWdyYXBoIGlzIG5ldmVyIGpvaW5lZCBhY3Jvc3MgYVxuICogYmxhbmsgbGluZSwgYSBmZW5jZWQgY29kZSBibG9jaywgYSBoZWFkaW5nLCBhIHRhYmxlIHJvdyBvciB0aGUgc3RhcnQgb2ZcbiAqIGFub3RoZXIgbGlzdCBpdGVtIOKAlCBoZWFkaW5ncyBhbmQgdGFibGUgcm93cyBhcmUgc2Nhbm5lZCBvbmUgbGluZSBhdCBhXG4gKiB0aW1lLiBMaW5rcyBpbnNpZGUgZmVuY2VkIGNvZGUgYmxvY2tzIG9yIGlubGluZSBjb2RlIHNwYW5zIGFyZSBza2lwcGVkLCBhc1xuICogYXJlIGxpbmtzIHdpdGggYSBVUkwgc2NoZW1lIChgaHR0cHM6YCwgYG1haWx0bzpgLCDigKYpIOKAlCBNRDA1MS1zdHlsZSBjaGVja2Vyc1xuICogb25seSB2YWxpZGF0ZSBpbi1maWxlIGZyYWdtZW50cywgc28gY3Jvc3MtZmlsZSBvbmVzIGxpa2UgdGhlc2UgbmVlZCB0aGVpclxuICogb3duIGd1YXJkIChJc3N1ZSAjMzMzNykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcm9zc0ZpbGVBbmNob3JMaW5rcyhcbiAgbWFya2Rvd246IHN0cmluZyxcbik6IENyb3NzRmlsZUFuY2hvckxpbmtbXSB7XG4gIGNvbnN0IHJlc3VsdHM6IENyb3NzRmlsZUFuY2hvckxpbmtbXSA9IFtdO1xuICBsZXQgcGFyYWdyYXBoOiBOdW1iZXJlZExpbmVbXSA9IFtdO1xuICBsZXQgcHJldmlvdXNMaW5lTnVtYmVyID0gMDtcbiAgY29uc3QgZmx1c2ggPSAoKTogdm9pZCA9PiB7XG4gICAgc2NhblBhcmFncmFwaChwYXJhZ3JhcGgsIHJlc3VsdHMpO1xuICAgIHBhcmFncmFwaCA9IFtdO1xuICB9O1xuXG4gIGZvciAoY29uc3QgbnVtYmVyZWQgb2YgbGluZXNPdXRzaWRlRmVuY2VzKG1hcmtkb3duKSkge1xuICAgIGNvbnN0IHsgbGluZU51bWJlciwgbGluZSB9ID0gbnVtYmVyZWQ7XG4gICAgLy8gQSBnYXAgaW4gbGluZSBudW1iZXJzIG1lYW5zIGEgZmVuY2VkIGJsb2NrIHdhcyBza2lwcGVkIGJldHdlZW4gdGhlIHR3b1xuICAgIC8vIGxpbmVzOiBuZXZlciBqb2luIGFjcm9zcyBpdC5cbiAgICBpZiAobGluZU51bWJlciAhPT0gcHJldmlvdXNMaW5lTnVtYmVyICsgMSkgZmx1c2goKTtcbiAgICBwcmV2aW91c0xpbmVOdW1iZXIgPSBsaW5lTnVtYmVyO1xuXG4gICAgaWYgKGxpbmUudHJpbSgpID09PSBcIlwiKSB7XG4gICAgICBmbHVzaCgpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgcmVmTWF0Y2ggPSBibGFua0NvZGVTcGFucyhsaW5lKS5tYXRjaChSRUZfREVGKTtcbiAgICBpZiAocmVmTWF0Y2gpIHtcbiAgICAgIGZsdXNoKCk7XG4gICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZURlc3RpbmF0aW9uKHJlZk1hdGNoWzFdID8/IFwiXCIpO1xuICAgICAgaWYgKHBhcnNlZCkge1xuICAgICAgICByZXN1bHRzLnB1c2goe1xuICAgICAgICAgIGxpbmU6IGxpbmVOdW1iZXIsXG4gICAgICAgICAgdGFyZ2V0OiBwYXJzZWQudGFyZ2V0LFxuICAgICAgICAgIGZyYWdtZW50OiBwYXJzZWQuZnJhZ21lbnQsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWYgKEhFQURJTkdfTElORS50ZXN0KGxpbmUpIHx8IFRBQkxFX1JPVy50ZXN0KGxpbmUpKSB7XG4gICAgICBmbHVzaCgpO1xuICAgICAgc2NhblBhcmFncmFwaChbbnVtYmVyZWRdLCByZXN1bHRzKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChMSVNUX0lURU1fTElORS50ZXN0KGxpbmUpKSBmbHVzaCgpO1xuICAgIHBhcmFncmFwaC5wdXNoKG51bWJlcmVkKTtcbiAgfVxuICBmbHVzaCgpO1xuXG4gIHJldHVybiByZXN1bHRzO1xufVxuXG4vKipcbiAqIERlY29kZSBhIFVSTCBmcmFnbWVudCwgb3IgbnVsbCB3aGVuIGl0IGlzIG1hbGZvcm1lZCAoZS5nLiBhIHRydW5jYXRlZFxuICogcGVyY2VudC1lc2NhcGUpLiBVc2VkIHRvIHJlc29sdmUgYCNmcmFnbWVudGAgbGlua3MgYmFjayB0byBhIGhlYWRpbmcncyByYXdcbiAqIHRleHQgKElzc3VlICMzMzM3KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlY29kZUZyYWdtZW50KGZyYWdtZW50OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gZGVjb2RlVVJJQ29tcG9uZW50KGZyYWdtZW50KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cbiJd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
// denoCacheMetadata=4425202222918371053,1990482781893058807