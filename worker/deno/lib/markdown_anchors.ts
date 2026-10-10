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
 */

/**
 * Characters GitHub keeps: Unicode letters, marks (e.g. U+FE0F variation
 * selector), numbers, connector punctuation (`\p{Pc}`, e.g. `_` — GitHub's
 * `github-slugger` keeps it, Issue #3337), spaces, ASCII hyphen.
 */
const STRIP = /[^\p{L}\p{M}\p{N}\p{Pc} -]/gu;

/** A backtick code span: `` `x` ``, ``` ``x`` ```, of any backtick run length. */
const CODE_SPAN = /(`+)(.*?)\1/g;

/**
 * An underscore emphasis/strong delimiter pair (`_word_`, `__word__`) at a
 * word boundary on both sides — the shape GitHub's renderer turns into
 * `<em>`/`<strong>` and drops from the text content. An underscore flanked
 * by a letter/number/underscore on either side (`host_failure`) is
 * intraword and left alone, matching CommonMark's underscore-emphasis rule
 * (review on PR #3363, Issue #3337).
 */
const EMPHASIS_UNDERSCORES =
  /(?<=^|[^\p{L}\p{N}_])(_{1,2})(?!\s)(.+?)(?<!\s)\1(?=$|[^\p{L}\p{N}_])/gu;

/**
 * Remove underscore emphasis delimiters outside backtick code spans, so the
 * slug reflects GitHub's rendered text content rather than the raw
 * Markdown source (review on PR #3363, Issue #3337).
 */
function stripEmphasisUnderscores(text: string): string {
  let result = "";
  let lastIndex = 0;
  for (const span of text.matchAll(CODE_SPAN)) {
    const start = span.index ?? 0;
    result += text.slice(lastIndex, start).replace(
      EMPHASIS_UNDERSCORES,
      "$2",
    );
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
 */
export function githubSlug(headingText: string): string {
  return stripEmphasisUnderscores(headingText)
    .toLowerCase()
    .replace(STRIP, "")
    .replace(/ /g, "-");
}

/** One line of a document, paired with its 1-based line number. */
interface NumberedLine {
  lineNumber: number;
  line: string;
}

/**
 * Walk a Markdown document line by line, yielding every line outside a
 * fenced code block (``` or ~~~, of any length ≥ 3) along with its 1-based
 * line number. Shared by {@link headingSlugs} and
 * {@link crossFileAnchorLinks} so both skip fences identically (Issue
 * #3337).
 */
function* linesOutsideFences(markdown: string): Generator<NumberedLine> {
  let fence: string | null = null;

  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trimEnd();
    const fenceMatch = line.match(/^\s*(`|~)\1\1/);
    if (fenceMatch) {
      const marker = (fenceMatch[1] ?? "`").repeat(3);
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;

    yield { lineNumber: i + 1, line };
  }
}

/**
 * Extract every heading slug from a Markdown document, in document order,
 * skipping fenced code blocks. Duplicate slugs get GitHub's `-1`, `-2`, …
 * suffixes so the returned list mirrors the anchors GitHub actually emits.
 */
export function headingSlugs(markdown: string): string[] {
  const slugs: string[] = [];
  const seen = new Map<string, number>();

  for (const { line } of linesOutsideFences(markdown)) {
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!heading) continue;

    const base = githubSlug(heading[2] ?? "");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.push(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

/** A resolvable set of anchors for one document. */
export function anchorSet(markdown: string): Set<string> {
  return new Set(headingSlugs(markdown));
}

/** One cross-file `#fragment` link found by {@link crossFileAnchorLinks}. */
export interface CrossFileAnchorLink {
  /** 1-based line number the link appears on. */
  line: number;
  /** The link's target path, exactly as written (not yet resolved). */
  target: string;
  /** The link's fragment, raw — still percent-encoded if it was written so. */
  fragment: string;
}

// SIMPLE-ON-PURPOSE: link text with nested brackets and destinations containing parentheses or `<` are not matched — upgrade when a docs link needs either.
/**
 * Inline link destination: `[text](dest)` or `[text](<dest> "title")`.
 * Deliberately linear — the link-text class excludes `[`, and the
 * angle-bracket and bare destination classes exclude `<`/`(` respectively,
 * so every scan is bounded at the next start candidate instead of running to
 * end of line (Issue #3337).
 */
const INLINE_LINK =
  /\[[^\[\]]*\]\(\s*(<[^<>]*>|[^\s()<]+)(?:\s+"[^"]*")?\s*\)/g;

/**
 * Reference-style link definition: `[label]: dest` or `[label]: <dest>`,
 * optionally followed by a title. Anchored to the (optionally indented)
 * start of the line (Issue #3337).
 */
const REF_DEF = /^[ \t]{0,3}\[[^\]]+\]:\s*(<[^>]*>|[^\s]+)/;

/** Any URI with a scheme (`https:`, `mailto:`, …), not a relative path. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Replace every inline code span (`` `x` ``, `` ``x`` ``, …) on a single
 * line with spaces of the same length, so link-like text inside code spans
 * is never mistaken for a real Markdown link (Issue #3337).
 */
function blankCodeSpans(line: string): string {
  return line.replace(/(`+)(.*?)\1/g, (m) => " ".repeat(m.length));
}

/**
 * Parse a raw link destination into a `.md` target plus fragment, or null
 * when it is not a same-repo link to a Markdown file with a `#fragment`
 * (Issue #3337).
 */
function parseDestination(
  raw: string,
): { target: string; fragment: string } | null {
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

  return { target, fragment };
}

/**
 * Extract every relative link to a `.md` file that carries a `#fragment`
 * from a Markdown document: inline links (including the angle-bracket form
 * and an optional `"title"`) and reference definitions. Links inside fenced
 * code blocks or inline code spans are skipped, as are links with a URL
 * scheme (`https:`, `mailto:`, …) — MD051-style checkers only validate
 * in-file fragments, so cross-file ones like these need their own guard
 * (Issue #3337).
 */
export function crossFileAnchorLinks(
  markdown: string,
): CrossFileAnchorLink[] {
  const results: CrossFileAnchorLink[] = [];

  for (const { lineNumber, line } of linesOutsideFences(markdown)) {
    const blanked = blankCodeSpans(line);

    const refMatch = blanked.match(REF_DEF);
    if (refMatch) {
      const parsed = parseDestination(refMatch[1] ?? "");
      if (parsed) {
        results.push({
          line: lineNumber,
          target: parsed.target,
          fragment: parsed.fragment,
        });
      }
      continue;
    }

    for (const m of blanked.matchAll(INLINE_LINK)) {
      const parsed = parseDestination(m[1] ?? "");
      if (parsed) {
        results.push({
          line: lineNumber,
          target: parsed.target,
          fragment: parsed.fragment,
        });
      }
    }
  }

  return results;
}

/**
 * Decode a URL fragment, or null when it is malformed (e.g. a truncated
 * percent-escape). Used to resolve `#fragment` links back to a heading's raw
 * text (Issue #3337).
 */
export function decodeFragment(fragment: string): string | null {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return null;
  }
}
