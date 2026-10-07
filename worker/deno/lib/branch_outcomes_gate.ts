/**
 * PR-summary branch-outcomes gate (Issue #3147).
 *
 * "Every outcome of a branch you add needs a test that reaches it" (rule
 * #3069) was prose only: nothing in the worker checked it. Fleet PRs shipped
 * a new branch with no test reaching it (GRQ-AutoTrader#2368,
 * VibeCoder#3132, #3065, #3068), review-fix rounds repeated the same gap on
 * their own rework, and #3132 went further — the PR summary named tests that
 * did not even exist in the branch.
 *
 * This module is the deterministic gate for that rule's artefact: a
 * `Branch outcomes:` list in the PR summary. It activates whenever a PR's
 * diff changes a file that is neither a test nor a documentation file (the
 * same trigger as `docs_sweep_gate.ts`), and then requires the list to be
 * present — either naming each outcome and the test that reaches it, or an
 * honest `none added` when the diff adds no branch — and requires every test
 * path the list names to actually exist at HEAD, so a fabricated citation
 * cannot pass.
 *
 * A later gap (Issue #3288, GRQ-AutoTrader#2682, VibeCoder#3282): an entry
 * can satisfy every rule above while admitting, in its own words, that no
 * test actually reaches the outcome it names — "no test reaches it", a flip
 * that "never went red", or one that "left the suite green". The gate above
 * never read the PROSE of an entry, only its shape, so this sailed straight
 * through. This module now also blocks any entry (or stray text the list
 * parser itself skipped, so an admission cannot dodge the check merely by
 * sitting in a table row or after a sibling bullet) that admits its own
 * outcome is unreached, with a single narrow exemption for an outcome the
 * issue genuinely puts out of scope, or one no test can reach at all.
 *
 * Modelled on `docs_sweep_gate.ts`: pure functions, hardcoded regexes (no
 * `new RegExp()` built from input), and a bounded scan of the PR summary —
 * agent-authored and steered by an untrusted issue body, so it is treated as
 * untrusted text throughout.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { codeChangingFiles } from "./docs_sweep_gate.ts";
import { isTestFilePath } from "./security_fix_gate.ts";
import type { Result } from "../types.ts";

/** Cap on untrusted text scanned by the gate's regexes (defence in depth). */
const MAX_SCAN_CHARS = 200_000;

/** Cap on one Branch-outcomes entry after continuation lines are joined. */
const MAX_ENTRY_CHARS = 4_000;

/** Cap on the number of entries parsed out of one list. */
const MAX_ENTRIES = 100;

/** Every line terminator, so a lone CR or Unicode separator cannot stay inside a line. */
const LINE_TERMINATOR_RE = /\r\n|[\n\r\u2028\u2029]/;

/** A list marker leading a line, stripped before matching. */
const LIST_MARKER_RE = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/;

/** A markdown heading, capturing its `#` run so the level can be read off. */
const HEADING_RE = /^\s{0,3}(#{1,6})\s/;

/** The heading level (1-6) of a raw line, or 0 when it is not a heading. */
function headingLevel(line: string): number {
  const match = line.match(HEADING_RE);
  return match ? match[1]!.length : 0;
}

/**
 * Fallback section-boundary level used when a `Branch outcomes` header has
 * no heading anywhere above it in the document (so there is no enclosing
 * section to take the boundary from).
 */
const FALLBACK_SECTION_HEADING_LEVEL = 2;

/**
 * Heading depth at which a heading reads as a document section boundary
 * rather than a grouping sub-heading nested under one — e.g. a `####
 * path/to/file.ts` label grouping entries under a `**Branch outcomes:**`
 * paragraph is a level-4 heading, while `## Summary`/`## Test Plan` (the
 * sections PR summaries in this repository actually use) sit at level 1-2.
 * A heading at or shallower than this level ends a Branch-outcomes scan; a
 * deeper one is skipped over so the entries or text nested under it are
 * still read.
 *
 * A fixed level (previously 3) is wrong: a `### path/to/file.ts` grouping
 * heading directly under a `## Test Plan` section is itself only one level
 * deeper than its enclosing section, so a universal level-3 cutoff treated
 * it as a boundary and stopped the scan before the list it grouped (PR
 * #3160 review, seventh round). For an **inline** header (e.g.
 * `**Branch outcomes:**`), the boundary is relative to the nearest heading
 * above the header — any heading no deeper than that enclosing heading
 * ends the scan; a heading nested deeper than it (however shallow in
 * absolute terms) is a grouping sub-heading and is skipped. With no
 * enclosing heading at all, `FALLBACK_SECTION_HEADING_LEVEL` applies. For a
 * **heading-form** header (e.g. `### Branch outcomes`), this function is
 * not used at all — the header's own level is the boundary directly, so a
 * sibling heading at that same level still ends the scan even though it is
 * only one level deeper than the enclosing section (PR #3160 review, eighth
 * round).
 */
function sectionBoundaryLevel(enclosingHeadingLevel: number): number {
  return enclosingHeadingLevel > 0
    ? enclosingHeadingLevel
    : FALLBACK_SECTION_HEADING_LEVEL;
}

/** The `Branch outcomes` prefix once markdown decoration is stripped. */
const BRANCH_OUTCOMES_PREFIX_RE = /^branch\s+outcomes\s*[:\-–—]/i;

/**
 * A markdown heading form of the header: `# Branch outcomes` (colon
 * optional). No trailing `\s*` before `$`: `stripDecoration` already trims
 * the line, and a second `\s*` adjacent to the optional `:?` let a long run
 * of spaces followed by a non-matching character backtrack quadratically
 * (PR #3160 review).
 */
const BRANCH_OUTCOMES_HEADING_RE = /^#{1,6}\s*branch\s+outcomes\s*:?$/i;

/**
 * Strip list marker and `*`/backtick decoration from a line.
 *
 * Underscore is deliberately NOT stripped here, unlike `docs_sweep_gate.ts`'s
 * decoration strip: a Branch-outcomes entry routinely cites a test path such
 * as `worker/deno/tests/foo_test.ts`, and stripping every underscore would
 * corrupt that path before `namedTestPaths` ever sees it.
 */
function stripDecoration(line: string): string {
  return line
    .replace(LIST_MARKER_RE, "")
    .replace(/[*`]/g, "")
    .trim();
}

/** Leading-space indent of a raw (undecorated) line. */
function leadingIndent(raw: string): number {
  const match = raw.match(/^\s*/);
  return match ? match[0].length : 0;
}

/** The `Branch outcomes` list parsed out of a PR summary. */
export interface BranchOutcomesRecord {
  /** Whether a `Branch outcomes` header was found at all. */
  present: boolean;
  /** Whether the header's inline body is an honest `none`/`none added` declaration. */
  noneDeclared: boolean;
  /** The inline body after the header's separator (`""` for a heading form). */
  body: string;
  /** Parsed list entries (empty when `noneDeclared`, a heading, or no list follows). */
  entries: string[];
  /**
   * Raw (pre-decoration) line indices behind each member of `entries`, in
   * the same order — `entryLineIndices[2]` lists the lines that fed
   * `entries[2]`, in document order. The admission check blanks test
   * citations straight from these raw lines rather than re-parsing a
   * separately blanked copy of the whole document (Issue #3288, PR #3312
   * review round 3): an independent re-parse can identify different
   * header/entry boundaries than the real one and block an honest summary
   * on a shape mismatch that was never an actual line merge.
   */
  entryLineIndices: number[][];
  /**
   * Every line between the header and the next section-boundary heading (or
   * the next `Branch outcomes` header, or the end of the document), scanned
   * for named test paths only — independent of the list-shaped
   * `entries`/`body` parsing above. A sibling bullet, a markdown table, or a
   * loose list broken by an indented paragraph all stop `collectEntries`
   * before a test path further down is ever added to `entries` or `body`; a
   * header with inline text still has this field cover that text (PR #3160
   * review). A deeper grouping heading (e.g. a `#### path/to/file.ts` label
   * directly below a `**Branch outcomes:**` paragraph) does not end the scan
   * (PR #3160 review, sixth round).
   */
  scanText: string;
  /**
   * Decoration-stripped, non-empty lines from each header's scanned region
   * (the same region `scanText` is built from) that were NOT folded into a
   * recorded `entries` member or into the inline body/wrap text — a table
   * row, prose after the list, a sibling bullet that ended the list, an
   * entry dropped once `entries.length` reached `MAX_ENTRIES`, or a
   * continuation/entry line whose content was cut by `capEntry`.
   *
   * Purpose (Issue #3288): the unreached-outcome admission check reads this
   * field so an admission sitting in text the list-shaped parser legitimately
   * skips is still caught — fail closed, per CODING-STANDARDS' "Writing a
   * gate over text" rule 3 (a gate must not trust the shape of the input it
   * is policing more than the words in it).
   */
  uncapturedLines: string[];
  /** Raw line index behind each member of `uncapturedLines`, in the same order. */
  uncapturedLineIndices: number[];
  /**
   * Raw line indices behind each contribution folded into `body`, grouped
   * in the same order `body` joins them (one group per inline header body
   * or wrapped-prose contribution) — used to blank `body` per group, the
   * same construction `entryLineIndices` supports for `entries`.
   */
  bodyLineIndexGroups: number[][];
}

/**
 * Whether a (decoration-stripped) body is an honest `none` declaration:
 * exactly `none` or `none added`, plus trailing punctuation — never a prefix
 * match. `none added this round; the earlier rounds' arms: ...` or
 * `none added; existing worker/deno/tests/gone_test.ts covers it` both carry
 * real content after the word `none` and must fall through to the normal
 * scan below, or the list (or test citation) that follows is never checked
 * (PR #3160 review, sixth round).
 */
const NONE_BODY_RE = /^none(?:\s+added)?\s*[.:;!]*$/i;
function isNoneBody(body: string): boolean {
  return NONE_BODY_RE.test(body.trim());
}

/**
 * Parse every `Branch outcomes` header in a PR summary. The first mention
 * does not decide alone: a later header's list is still collected, and the
 * lines an inline header wraps onto stay part of its body so a path on the
 * next line is still checked.
 */
export function parseBranchOutcomes(
  prSummaryContent: string,
): BranchOutcomesRecord {
  const raw = (prSummaryContent ?? "").slice(0, MAX_SCAN_CHARS);
  const lines = raw.split(LINE_TERMINATOR_RE);
  const entries: string[] = [];
  const entryLineIndices: number[][] = [];
  const bodyParts: string[] = [];
  const bodyLineIndexGroups: number[][] = [];
  const scanTextParts: string[] = [];
  const uncapturedLines: string[] = [];
  const uncapturedLineIndices: number[] = [];
  let present = false;
  let onlyNone = true;
  let lastHeadingLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const stripped = stripDecoration(rawLine);
    const inlineMatch = stripped.match(BRANCH_OUTCOMES_PREFIX_RE);
    const heading = BRANCH_OUTCOMES_HEADING_RE.test(stripped);
    if (!inlineMatch && !heading) {
      const lvl = headingLevel(rawLine);
      if (lvl > 0) lastHeadingLevel = lvl;
      continue;
    }

    present = true;
    // For a heading-form header, the boundary is the header's OWN level: a
    // sibling heading at that same level is a new section and must end the
    // scan, even when it is only one level deeper than the enclosing
    // section — deriving the boundary from the enclosing heading instead let
    // an empty `### Branch outcomes` fall through into the next `###`
    // section's bullets (PR #3160 review, eighth round). An inline header
    // has no "own level"; it keeps falling back to the nearest heading
    // above it.
    const ownLevel = heading ? headingLevel(rawLine) : 0;
    const boundaryLevel = ownLevel > 0
      ? ownLevel
      : sectionBoundaryLevel(lastHeadingLevel);
    if (heading) lastHeadingLevel = ownLevel;
    const body = inlineMatch
      ? stripped.slice(inlineMatch[0].length).trim()
      : "";
    if (isNoneBody(body)) {
      if (body) {
        bodyParts.push(body);
        bodyLineIndexGroups.push([i]);
      }
      // An honest `none` still gets its trailing region scanned for a named
      // test path: a review-fix rewording ("none added." + a refreshed list
      // of the earlier rounds' arms) must not let an invented citation past
      // the header's own words (PR #3160 review, seventh round). None of
      // this region's lines are folded into a recorded entry here, so every
      // non-empty line in it is uncaptured (Issue #3288).
      const region = scanRegion(lines, i + 1, boundaryLevel);
      scanTextParts.push(region.text);
      for (const idx of region.indices) {
        uncapturedLines.push(stripDecoration(lines[idx]!));
        uncapturedLineIndices.push(idx);
      }
      continue;
    }

    onlyNone = false;
    if (body) {
      bodyParts.push(body);
      bodyLineIndexGroups.push([i]);
    }
    const headerIndent = inlineMatch && LIST_MARKER_RE.test(rawLine)
      ? leadingIndent(rawLine)
      : -1;
    const collected = collectEntries(lines, i + 1, headerIndent, boundaryLevel);
    const capturedLines = new Set<number>();
    for (let k = 0; k < collected.entries.length; k++) {
      if (entries.length >= MAX_ENTRIES) break;
      entries.push(collected.entries[k]!);
      entryLineIndices.push([...collected.entryLines[k]!]);
      for (const idx of collected.entryLines[k]!) capturedLines.add(idx);
    }
    if (collected.bodyExtra) {
      bodyParts.push(collected.bodyExtra);
      bodyLineIndexGroups.push([...collected.bodyExtraLines]);
      for (const idx of collected.bodyExtraLines) capturedLines.add(idx);
    }
    const region = scanRegion(lines, i + 1, boundaryLevel);
    scanTextParts.push(region.text);
    for (const idx of region.indices) {
      if (!capturedLines.has(idx)) {
        uncapturedLines.push(stripDecoration(lines[idx]!));
        uncapturedLineIndices.push(idx);
      }
    }
    i = collected.nextIndex - 1;
  }

  return {
    present,
    noneDeclared: present && onlyNone,
    body: bodyParts.join(" "),
    entries,
    entryLineIndices,
    scanText: scanTextParts.join(" "),
    uncapturedLines,
    uncapturedLineIndices,
    bodyLineIndexGroups,
  };
}

/**
 * Every line from `startIndex` to the next section-boundary heading (level
 * at or above `boundaryLevel`, see `sectionBoundaryLevel`), the next `Branch
 * outcomes` header, or the end of the document — scanned (decoration
 * stripped) for `namedTestPaths` only. Deliberately independent of
 * `collectEntries`: that function's list-shaped parsing legitimately stops
 * on a sibling bullet, a table row, or prose after a blank line, any of
 * which can still name a test the header logically covers (PR #3160
 * review). A deeper grouping heading (e.g. a `#### path/to/file.ts` label
 * nested under a `**Branch outcomes:**` paragraph) does not end the scan
 * (PR #3160 review, sixth round). Stopping at the next header, or a
 * section-boundary heading, keeps every header's scan disjoint, so the
 * combined cost across a whole PR summary stays linear.
 *
 * Also returns the raw line indices behind `text`, so `parseBranchOutcomes`
 * can tell which of this header's scanned lines were never folded into a
 * recorded entry or the inline body/wrap text — those become
 * `BranchOutcomesRecord.uncapturedLines` (Issue #3288).
 */
function scanRegion(
  lines: string[],
  startIndex: number,
  boundaryLevel: number,
): { text: string; indices: number[] } {
  const parts: string[] = [];
  const indices: number[] = [];
  for (let j = startIndex; j < lines.length; j++) {
    const line = lines[j]!;
    const lvl = headingLevel(line);
    if (lvl > 0 && lvl <= boundaryLevel) break;
    const stripped = stripDecoration(line);
    if (
      BRANCH_OUTCOMES_PREFIX_RE.test(stripped) ||
      BRANCH_OUTCOMES_HEADING_RE.test(stripped)
    ) {
      break;
    }
    if (stripped) {
      parts.push(stripped);
      indices.push(j);
    }
  }
  return { text: parts.join(" "), indices };
}

/**
 * Entries and wrapped body text that follow one `Branch outcomes` header. A
 * heading deeper than `boundaryLevel` (see `sectionBoundaryLevel`) is
 * skipped over rather than ending the scan, so a `#### path/to/file.ts`
 * grouping heading between the header and its list does not hide that list
 * from `entries` (PR #3160 review, sixth round).
 *
 * Also reports, per entry, which line indices actually contributed to its
 * final (possibly `capEntry`-truncated) text, and which lines made up
 * `bodyExtra` — so `parseBranchOutcomes` can build the captured-line set
 * `uncapturedLines` is the complement of (Issue #3288). A line whose content
 * was cut by `capEntry` (the joined text exceeded `MAX_ENTRY_CHARS`) is not
 * counted as captured: its words never actually reached the text the rest of
 * the gate reads.
 */
function collectEntries(
  lines: string[],
  startIndex: number,
  headerIndent: number,
  boundaryLevel: number,
): {
  entries: string[];
  entryLines: number[][];
  bodyExtra: string;
  bodyExtraLines: number[];
  nextIndex: number;
} {
  const entries: string[] = [];
  const entryLines: number[][] = [];
  const wrap: string[] = [];
  const wrapLines: number[] = [];
  let sawBlank = false;
  let wrapping = true;
  let j = startIndex;

  for (; j < lines.length; j++) {
    const line = lines[j]!;

    if (line.trim() === "") {
      sawBlank = true;
      wrapping = false;
      continue;
    }
    const lvl = headingLevel(line);
    if (lvl > 0 && lvl <= boundaryLevel) break;
    if (lvl > 0) continue; // A deeper grouping heading: skip it, keep scanning.

    const indent = leadingIndent(line);
    if (LIST_MARKER_RE.test(line)) {
      if (indent <= headerIndent) break;
      // No MAX_ENTRIES cap here: parseBranchOutcomes' copy loop always
      // trims the merged result to MAX_ENTRIES regardless of how many
      // entries this call collects, so a cap here is never independently
      // observable — it was removed as dead weight (PR #3160 review).
      //
      // `wrapping` is not reset here: `entries.length > 0` already shuts
      // the wrap branch below once any entry exists, making a reset here
      // unobservable dead code (PR #3160 review, seventh round).
      const value = stripDecoration(line);
      const capped = capEntry(value);
      entries.push(capped);
      entryLines.push(capped.length < value.length ? [] : [j]);
      sawBlank = false;
      continue;
    }

    // A continuation of the previous entry, indented past the header.
    if (!sawBlank && entries.length > 0 && indent > headerIndent) {
      const lastIndex = entries.length - 1;
      const joinedRaw = `${entries[lastIndex]} ${stripDecoration(line)}`.trim();
      const capped = capEntry(joinedRaw);
      entries[lastIndex] = capped;
      if (capped.length === joinedRaw.length) {
        entryLines[lastIndex]!.push(j);
      }
      continue;
    }

    // Lines an inline header wraps onto, before the first list item.
    if (entries.length === 0 && wrapping) {
      wrap.push(stripDecoration(line));
      wrapLines.push(j);
      continue;
    }

    if (entries.length === 0) continue;
    break;
  }

  return {
    entries,
    entryLines,
    bodyExtra: wrap.join(" ").trim(),
    bodyExtraLines: wrapLines,
    nextIndex: j,
  };
}

/** Cap one entry's length. */
function capEntry(entry: string): string {
  return entry.length > MAX_ENTRY_CHARS
    ? entry.slice(0, MAX_ENTRY_CHARS)
    : entry;
}

/** URLs, excluded from token scanning so a link is never mistaken for a path. */
const URL_RE = /https?:\/\/\S+/g;

/** Characters (besides whitespace) that split a line into candidate tokens. */
const TOKEN_SPLIT_RE = /[\s`()[\],;"'<>|]+/;

/** A token shaped like a repo-relative path with an extension. */
const PATH_SHAPE_RE = /^[A-Za-z0-9_.\-\/]+\.[A-Za-z0-9]+$/;

/** Cap on a single token's length before it is considered a candidate path. */
const MAX_TOKEN_CHARS = 300;

/** Cap on the number of named test paths returned. */
const MAX_NAMED_TEST_PATHS = 50;

/**
 * Extract one candidate path token from a raw token: cut at the first `:`
 * (handles `path:42` and `path::name`), strip a leading `./` and trailing
 * `.`/`!` punctuation.
 */
function normaliseToken(token: string): string {
  const cut = token.split(":")[0] ?? "";
  let value = cut;
  if (value.startsWith("./")) value = value.slice(2);
  value = value.replace(/[.!]+$/, "");
  return value;
}

/**
 * The test file paths named across a branch-outcomes record's entries, body
 * and scanned region text.
 *
 * No `noneDeclared` guard here, and deliberately so: an honest `none`/`none
 * added` header's own `body` holds nothing but that declaration, but its
 * `scanText` is still populated from the region after the header (PR #3160
 * review, seventh round) — a review-fix rewording ("none added." followed
 * by a refreshed list of the earlier rounds' arms) must not let an invented
 * citation past the header's own honest word.
 *
 * Only paths shaped like, and recognised as, a test file are returned — a
 * branch-location citation such as `worker/deno/lib/foo.ts:42` is not a test
 * file and is therefore not existence-checked here, and a Rust inline test
 * named only as `module::tests::name` (no test-file path at all) is simply
 * never checked by this gate.
 */
export function namedTestPaths(record: BranchOutcomesRecord): string[] {
  const texts = [...record.entries];
  if (record.body) texts.push(record.body);
  if (record.scanText) texts.push(record.scanText);
  return testPathsIn(texts);
}

/**
 * The test file paths named across an arbitrary set of texts — the shared
 * token-scanning loop `namedTestPaths` uses over a whole record, refactored
 * out (Issue #3288) so the unreached-outcome admission check can run the
 * identical "does this ONE unit name a test path" test over a single unit.
 */
function testPathsIn(texts: readonly string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    const withoutUrls = text.replace(URL_RE, " ");
    for (const rawToken of withoutUrls.split(TOKEN_SPLIT_RE)) {
      if (!rawToken) continue;
      if (rawToken.length > MAX_TOKEN_CHARS) continue;
      const token = normaliseToken(rawToken);
      if (!token || token.startsWith("/")) continue;
      if (!PATH_SHAPE_RE.test(token)) continue;
      if (!isTestFilePath(token)) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      found.push(token);
      if (found.length >= MAX_NAMED_TEST_PATHS) return found;
    }
  }

  return found;
}

/** Bare placeholder values the inline body is checked against. */
const PLACEHOLDER_VALUES = new Set([
  "tbd",
  "todo",
  "n/a",
  "na",
  "-",
  "—",
  "?",
]);

/** Cap on the value scanned by `isBarePlaceholder`'s trailing-decoration regex. */
const MAX_PLACEHOLDER_SCAN_CHARS = 64;

/**
 * Whether an inline body is a bare placeholder rather than a real entry or
 * an honest `none added`.
 */
function isBarePlaceholder(body: string): boolean {
  const normalised = body
    .trim()
    .slice(0, MAX_PLACEHOLDER_SCAN_CHARS)
    .replace(/[.!\s]+$/g, "")
    .toLowerCase();
  return PLACEHOLDER_VALUES.has(normalised);
}

/**
 * Blank the parts of a backtick code span that are not the entry's own
 * words, group by group (lines joined so a span opened on one line and
 * closed on the next — hard-wrapped fleet summaries do this routinely —
 * still pairs correctly; PR #3312 review), for every CLOSED span (an
 * odd-indexed segment of a `` ` ``-split group that is not the group's last
 * segment — an unterminated trailing backtick never closes, so the dangling
 * last segment is left alone):
 *
 *  - a `path::name`-shaped span keeps only the part before the first `::`:
 *    `` `worker/deno/tests/foo_test.ts::flags no test reaches` `` becomes
 *    `` `worker/deno/tests/foo_test.ts` ``, and `` `handler::tests::min_hold` ``
 *    becomes `` `handler` ``. A quoted test NAME that happens to contain an
 *    admission phrase (e.g. a test literally named "flags an entry no test
 *    reaches") must not itself trip the admission check below — only the
 *    identifier before the first `::` is kept, since that is the part the
 *    rest of this gate (`namedTestPaths`) treats as meaningful.
 *  - any OTHER span containing whitespace is blanked outright: a span with a
 *    space is prose, a test name, or a shell command quoted as code (e.g.
 *    `` `cargo test --workspace` ``, or a bare test-name span in a list that
 *    already cited its path earlier, as in the `completion - a Test Plan
 *    bullet citing a behaviour no test covers blocks; …` shape) — none of it
 *    is the entry's OWN prose, so a backticked admission such as
 *    `` `no test reaches it` `` is never read as one: the admission has to
 *    be in the entry's own words (bold is fine; a code span is not).
 *  - a span with NO whitespace (a bare path, `path:line`, or identifier) is
 *    left unchanged — there is nothing to blank, and `namedTestPaths` /
 *    `unitLabel` still need to read it.
 *
 * Splits each group on the backtick character rather than using a regex, so
 * there is nothing here that can backtrack.
 *
 * Groups lines by more than blank-line boundaries (PR #3312 review, round
 * 2): a blank line always starts a fresh group, but so does EVERY
 * list-marker line (`` `- ` ``, `` `* ` ``, `1. `, …) and every other line
 * that is not an indented continuation of the line before it. A tight list
 * — no blank line between items, the shape this repo's own lists (including
 * this one) are written in — is otherwise one unbroken run of non-blank
 * lines; grouping the whole run together let a single stray backtick in one
 * item (an escaped `` \` ``, a double-backtick span, or any other odd
 * backtick) flip which segments count as "inside a span" for every LATER
 * item too, so a genuine admission in item 2 could be blanked away by a
 * pairing accident in item 1. Resetting at each list-marker line scopes
 * pairing to one item (plus its own indented continuation lines) at a time,
 * so one item's stray backtick can never reach another's. The same reset
 * applies to the header line itself and to any other non-indented line, so
 * a stray backtick in prose directly above the header cannot erase the
 * header once it is blanked.
 *
 * A line continues the current group only when it is NOT a list-marker line
 * and is indented relative to the start of the line (so it reads as a
 * continuation of a bullet or of wrapped prose, not a new block); any other
 * non-blank line starts its own fresh group. Lines within one group are
 * joined with `\n` and pass through `blankLineCitationNames` as a single
 * string — `split("\`")` does not care that the string contains embedded
 * newlines, so a span that opens on one line and closes on an indented
 * continuation line is still paired exactly as it would be if the two lines
 * had never been wrapped.
 */
function blankTestCitationNames(text: string): string {
  const lines = text.split(LINE_TERMINATOR_RE);
  const out: string[] = [];
  let group: string[] = [];
  const flushGroup = () => {
    if (group.length === 0) return;
    out.push(...blankLineCitationNames(group.join("\n")).split("\n"));
    group = [];
  };
  for (const line of lines) {
    if (line.trim() === "") {
      flushGroup();
      out.push(line);
      continue;
    }
    const isContinuation = group.length > 0 &&
      !LIST_MARKER_RE.test(line) &&
      leadingIndent(line) > 0;
    if (!isContinuation) flushGroup();
    group.push(line);
  }
  flushGroup();
  return out.join("\n");
}

/**
 * Blank test/command citations in the raw lines at `indices` (in document
 * order), then decoration-strip and space-join the result — the same shape
 * `collectEntries`/`scanRegion` build entry and uncaptured-line text in.
 * Operating on exactly the raw lines the real parse already attributed to
 * one entry, one body contribution, or one uncaptured line (Issue #3288, PR
 * #3312 review round 3) leaves nothing to re-derive, so there is nothing
 * that can disagree in shape with the real parse — unlike blanking the
 * whole document and re-parsing it from scratch, which can identify
 * different header/entry boundaries (a backtick-quoted mid-prose mention of
 * the header phrase reads as a header before blanking but not after) and
 * falsely block an honest summary on a "merged line" that never merged.
 */
function blankedUnitText(
  lines: readonly string[],
  indices: readonly number[],
): string {
  // No early-return for an empty `indices` (e.g. a capEntry-truncated
  // entry, see parseBranchOutcomes): `[].join("\n")` is already `""`, and
  // blanking/splitting/filtering `""` produces `""` too, so a guard here
  // would be unreachable-observable dead code.
  const rawSlice = indices.map((i) => lines[i]).join("\n");
  return blankTestCitationNames(rawSlice)
    .split(LINE_TERMINATOR_RE)
    .map(stripDecoration)
    .filter((line) => line.length > 0)
    .join(" ");
}

/** A closed code-span segment containing whitespace somewhere. */
const SPAN_HAS_WHITESPACE_RE = /\s/;

/** `blankTestCitationNames`' per-paragraph worker. */
function blankLineCitationNames(line: string): string {
  const segments = line.split("`");
  for (let k = 1; k < segments.length - 1; k += 2) {
    const segment = segments[k]!;
    const sep = segment.indexOf("::");
    if (sep >= 0) {
      segments[k] = segment.slice(0, sep);
    } else if (SPAN_HAS_WHITESPACE_RE.test(segment)) {
      segments[k] = "";
    }
  }
  return segments.join("`");
}

/**
 * Strong admission phrases: these block an entry regardless of whether it
 * also names a test path or mentions a red flip — the words themselves are
 * already an unambiguous confession that the outcome is unreached.
 */
/**
 * Source of the negated-red pattern, used by `STRONG_ADMISSION_RES` below.
 * Deliberately NOT folded into `recordsRedFlip`'s global strip
 * (`NEGATED_RED_GLOBAL_RE`): `admitsUnreached` runs `STRONG_ADMISSION_RES`
 * first and returns immediately on any match, so by the time
 * `recordsRedFlip` ever runs on a unit, that unit cannot match this source —
 * including it in the global strip too is unreachable dead code, not a
 * drift guard (PR #3312 review, round 2).
 *

 * Deliberately narrower than a bare "negation word, up to N words, `red`":
 * a corpus run over `docs/archive/pr-summaries/` turned up genuinely
 * COVERED entries that happen to carry an unrelated negation ahead of a
 * `red` that is NOT negated at all — "flipped to **never** add, test went
 * **red**" (pr-summary-3223.md:178), "flipped to **no** split, test went
 * **red**" (3244.md:126), "**No** gap: `…`. Flipped: **red**."
 * (3255.md:109), "flipped to **never** attach/blocked, ... went **red**"
 * (3257.md:80,124). A loose "negation ... red" match fired on all of these.
 * Requiring the negation to govern a go/turn verb DIRECTLY ("never went
 * red", "did not go red", "no test went red", "didn't go red") still catches
 * every real admission while leaving an unrelated negation elsewhere in the
 * sentence alone.
 */
const NEGATED_RED_SOURCE = "(?:\\bnever|\\bnot|n['’]t|\\bno\\s+tests?)\\s+" +
  "(?:go|goes|went|gone|going|turn|turns|turned|turning)\\s+" +
  "(?:\\S+\\s+){0,2}red\\b";

const STRONG_ADMISSION_RES: readonly RegExp[] = [
  // "no test(s) (yet) reach(es)/cover(s)/exercise(s) <outcome>"
  /\bno\s+tests?\s+(?:yet\s+)?(?:reach(?:es)?|covers?|exercises?)\b/i,
  // "not reached/covered/exercised by any/a test(s)"
  /\bnot\s+(?:reached|covered|exercised)\s+by\s+(?:any|a)\s+tests?\b/i,
  // A negated flip to red: "never went red", "did not go red", "no test(s)
  // went red", "didn't go red" (curly apostrophe too), "never turned red".
  new RegExp(NEGATED_RED_SOURCE, "i"),
];

/**
 * Weak admission phrases: these block an entry only when it names no test
 * path AND records no red flip — past-tense or otherwise hedged wording
 * ("stayed green" in the SAME breath as a named test and a red flip) is a
 * covered entry, not an admission.
 */
const WEAK_ADMISSION_RES: readonly RegExp[] = [
  /\bunreach(?:ed|able)\b/i,
  /\buntested\b/i,
  // "stayed/stays/stay/remained/.../left/leaves/leave <=6 words> green"
  /\b(?:stayed|stays|stay|remained|remains|remain|kept|keeps|left|leaves|leave)\s+(?:\S+\s+){0,6}green\b/i,
];

/**
 * Further phrasings where `red` appears but no flip actually went red (PR
 * #3312 review): a bare negation directly adjacent to `red` with no go/turn
 * verb between ("left it green, not red", "stayed green, never red"), an
 * "instead of (...) red" contrast ("kept it green instead of turning it
 * red"), a stated future obligation ("a test that goes red is still to
 * add"), and an explicit "needs/should ... red" ask. `NEGATED_RED_SOURCE`
 * above is deliberately narrow (direct negation of a go/turn verb only), so
 * these are additive, not a replacement — they only feed the global
 * `recordsRedFlip` strip, never the single-match `STRONG_ADMISSION_RES`
 * entry (a bare "not red" is weak wording, not an unambiguous confession on
 * its own).
 */
const OTHER_NEGATED_RED_SOURCES = [
  "(?:\\bnever|\\bnot|n['’]t)\\s+red\\b",
  "\\binstead\\s+of\\s+(?:\\S+\\s+){0,3}red\\b",
  "\\b(?:needs?|should)\\s+(?:\\S+\\s+){0,3}red\\b",
  "\\bred\\b[,:]?\\s+(?:is\\s+)?still\\s+to\\s+add\\b",
];

/**
 * Global variant of the weaker negated-red patterns, for stripping before
 * the red check. Built from `OTHER_NEGATED_RED_SOURCES` only —
 * `NEGATED_RED_SOURCE` is deliberately excluded (see its own doc comment
 * above): a unit matching it has already made `admitsUnreached` return at
 * the `STRONG_ADMISSION_RES` loop, so `recordsRedFlip` never sees one, and
 * including it here was unreachable (PR #3312 review, round 2).
 */
const NEGATED_RED_GLOBAL_RE = new RegExp(
  OTHER_NEGATED_RED_SOURCES.join("|"),
  "gi",
);

/** A bare mention of `red`, checked after negated-red phrases are stripped out. */
const RED_RE = /\bred\b/i;

/** Whether a unit records a red flip — a test that actually went red. */
function recordsRedFlip(unit: string): boolean {
  return RED_RE.test(unit.replace(NEGATED_RED_GLOBAL_RE, " "));
}

/** Whether a single unit of text admits that no test reaches its outcome. */
function admitsUnreached(unit: string): boolean {
  for (const re of STRONG_ADMISSION_RES) {
    if (re.test(unit)) return true;
  }
  if (testPathsIn([unit]).length > 0 || recordsRedFlip(unit)) return false;
  for (const re of WEAK_ADMISSION_RES) {
    if (re.test(unit)) return true;
  }
  return false;
}

/**
 * The one allowed exception: an outcome the issue puts out of scope, or one
 * no test can reach, written `exempt (out of scope): <reason>` or
 * `exempt (untestable): <reason>` with a real reason (at least 3 words
 * containing a letter). Any other parenthesised word is not an exemption.
 */
const EXEMPT_RE =
  /\bexempt\s*\(\s*(?:out\s+of\s+scope|untestable)\s*\)\s*:([^\n]*)/i;

/** A "word" for the exemption-reason word count: anything containing a letter. */
const WORD_WITH_LETTER_RE = /[A-Za-z]/;

/** Number of words in `reason` that contain at least one letter. */
function reasonWordCount(reason: string): number {
  return reason
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0 && WORD_WITH_LETTER_RE.test(word))
    .length;
}

/** Verdict `evaluateUnitAdmission` reaches for one unit of text. */
type UnitAdmissionVerdict = "admits" | "exempt-no-reason" | null;

/**
 * Evaluate one unit (an entry, the record body, or an uncaptured line) for
 * the unreached-outcome admission rule. A matched `exempt (...)` clause
 * decides the unit outright — admission wording elsewhere in the same unit
 * is not separately re-checked once a real exemption reason is present.
 */
function evaluateUnitAdmission(unit: string): UnitAdmissionVerdict {
  const exemptMatch = unit.match(EXEMPT_RE);
  if (exemptMatch) {
    const reason = exemptMatch[1] ?? "";
    return reasonWordCount(reason) >= 3 ? null : "exempt-no-reason";
  }
  return admitsUnreached(unit) ? "admits" : null;
}

/** Cap on a unit's first-N-characters fallback label. */
const LABEL_MAX_CHARS = 80;

/** A leading digit run, optionally followed by `-digits` or `/digits`. */
const LABEL_TRAILING_DIGITS_RE = /^(\d+(?:[-/]\d+)?)/;

/**
 * The LABEL a problem message names an admitting (or badly-exempted) unit
 * by: the first token (same split `namedTestPaths` uses) whose part before
 * the first `:` is path-shaped and whose part after starts with a digit,
 * rendered `path:<digits>` — otherwise the unit's first 80 characters,
 * `…`-suffixed when cut.
 */
function unitLabel(unit: string): string {
  for (const rawToken of unit.split(TOKEN_SPLIT_RE)) {
    if (!rawToken || rawToken.length > MAX_TOKEN_CHARS) continue;
    const colonIndex = rawToken.indexOf(":");
    if (colonIndex < 0) continue;
    const pathPart = rawToken.slice(0, colonIndex);
    const afterPart = rawToken.slice(colonIndex + 1);
    if (!PATH_SHAPE_RE.test(pathPart)) continue;
    const digits = afterPart.match(LABEL_TRAILING_DIGITS_RE);
    if (!digits) continue;
    return `${pathPart}:${digits[1]}`;
  }
  const trimmed = unit.trim();
  return trimmed.length > LABEL_MAX_CHARS
    ? `${trimmed.slice(0, LABEL_MAX_CHARS)}…`
    : trimmed;
}

/** The blanked (test-citation-safe) text for each unit {@link evaluateUnreachedAdmissions} checks. */
interface BlankedUnits {
  entries: readonly string[];
  body: string;
  uncapturedLines: readonly string[];
}

/**
 * Run the unreached-outcome admission check (Issue #3288) over every
 * blanked unit of a `Branch outcomes` record: each entry, the record's own
 * body when non-empty, and every uncaptured line.
 */
function evaluateUnreachedAdmissions(
  blanked: BlankedUnits,
): { problems: string[]; unreachedEntries: string[] } {
  const units: string[] = [...blanked.entries];
  if (blanked.body) units.push(blanked.body);
  for (const line of blanked.uncapturedLines) units.push(line);

  const problems: string[] = [];
  const unreachedEntries: string[] = [];

  for (const unit of units) {
    const verdict = evaluateUnitAdmission(unit);
    if (verdict === null) continue;
    const label = unitLabel(unit);
    if (verdict === "exempt-no-reason") {
      problems.push(
        `the \`Branch outcomes:\` entry for \`${label}\` is marked exempt ` +
          "but gives no reason — say why the issue puts the outcome out of " +
          "scope, or why no test can reach it",
      );
    } else {
      unreachedEntries.push(label);
      problems.push(
        `the \`Branch outcomes:\` entry for \`${label}\` admits no test ` +
          "reaches its outcome — add a test that goes red when the outcome " +
          "is flipped, or remove the branch; only an outcome the issue puts " +
          "out of scope, or one no test can reach, may stand, written " +
          "`exempt (out of scope): <reason>` or `exempt (untestable): " +
          "<reason>`",
      );
    }
  }

  return { problems, unreachedEntries };
}

/** Verdict of the branch-outcomes gate. */
export interface BranchOutcomesGateResult {
  /** True when the diff changes a non-test, non-doc file. */
  applicable: boolean;
  /** True when the gate passes (always true when not applicable). */
  valid: boolean;
  /** False when the changed-files list could not be read at all. */
  changedFilesKnown: boolean;
  /** The code-changing files found (empty when the list is unknown). */
  codeFiles: string[];
  /** The parsed `Branch outcomes` record. */
  record: BranchOutcomesRecord;
  /** Test paths named in the list. */
  namedTests: string[];
  /** Of `namedTests`, those not found at HEAD. */
  missingTests: string[];
  /**
   * LABELs of entries that admit no test reaches their outcome (Issue
   * #3288), in order. Empty when the gate is not applicable, or none admit.
   */
  unreachedEntries: string[];
  /** One line per rule broken — empty when the gate passes. */
  problems: string[];
}

/** Up to how many code files are named in a "no list" problem. */
const MAX_NAMED_CODE_FILES = 5;

/** Render the changed code files for a problem message. */
function describeCodeFiles(codeFiles: readonly string[]): string {
  const named = codeFiles.slice(0, MAX_NAMED_CODE_FILES).join(", ");
  const extra = codeFiles.length - MAX_NAMED_CODE_FILES;
  return extra > 0 ? `${named} and ${extra} more` : named;
}

/** Input to {@link validateBranchOutcomes}. */
export interface ValidateBranchOutcomesInput {
  /** The branch's changed files, or `null` when the diff could not be read. */
  changedFiles: readonly string[] | null;
  /** The PR summary content (or assembled body). */
  prSummaryContent: string;
  /**
   * Test file paths that exist at HEAD, or `null` when they could not be
   * confirmed. Only consulted when the list names at least one test path.
   */
  testsAtHead: ReadonlySet<string> | null;
}

/**
 * Verify that a PR summary records the outcomes a new branch adds, and that
 * every test it names actually exists at HEAD.
 *
 * Rules, all deterministic:
 *   1. `changedFiles === null` (the diff could not be read) → the gate
 *      APPLIES. Absence of evidence is not treated as a branch-free diff.
 *   2. A known changed-files list with no code-changing file → not
 *      applicable, valid.
 *   3. Applicable with no `Branch outcomes` list → blocked.
 *   4. Present and `none added` → valid.
 *   5. Present, not none, zero entries and an empty inline body → blocked
 *      (lists no outcomes).
 *   6. Present, not none, zero entries and a bare placeholder inline body →
 *      blocked.
 *   7. The list names at least one test path but `testsAtHead === null` →
 *      blocked (fail closed).
 *   8. A named test path absent from `testsAtHead` → blocked, named in
 *      `missingTests`.
 *   9. Present: any entry, the inline body, or a line the list parser itself
 *      skipped (table row, sibling bullet, prose after the list, …) that
 *      admits no test reaches its outcome → blocked, labels named in
 *      `unreachedEntries` (Issue #3288). Test/command citations are blanked
 *      per-unit from the raw lines `parseBranchOutcomes` already attributed
 *      to that unit (`entryLineIndices`, `bodyLineIndexGroups`,
 *      `uncapturedLineIndices`), not by re-parsing a separately blanked
 *      copy of the whole document — so there is no independent re-parse
 *      that can disagree in shape with the real one (PR #3312 review,
 *      round 3).
 *  10. An `exempt (out of scope): <reason>` / `exempt (untestable): <reason>`
 *      clause with fewer than 3 real words of reason → blocked — an
 *      exemption with no stated reason is not an exemption.
 */
export function validateBranchOutcomes(
  input: ValidateBranchOutcomesInput,
): BranchOutcomesGateResult {
  const record = parseBranchOutcomes(input.prSummaryContent ?? "");
  const lines = (input.prSummaryContent ?? "")
    .slice(0, MAX_SCAN_CHARS)
    .split(LINE_TERMINATOR_RE);

  if (input.changedFiles === null) {
    return evaluateApplicable(record, lines, [], false, input.testsAtHead);
  }

  const codeFiles = codeChangingFiles(input.changedFiles);
  if (codeFiles.length === 0) {
    return {
      applicable: false,
      valid: true,
      changedFilesKnown: true,
      codeFiles: [],
      record,
      namedTests: [],
      missingTests: [],
      unreachedEntries: [],
      problems: [],
    };
  }

  return evaluateApplicable(record, lines, codeFiles, true, input.testsAtHead);
}

/** Shared rule evaluation for the `changedFiles === null` and known cases. */
function evaluateApplicable(
  record: BranchOutcomesRecord,
  lines: readonly string[],
  codeFiles: string[],
  changedFilesKnown: boolean,
  testsAtHead: ReadonlySet<string> | null,
): BranchOutcomesGateResult {
  const problems: string[] = [];
  const namedTests = namedTestPaths(record);
  const missingTests: string[] = [];
  let unreachedEntries: string[] = [];

  if (!record.present) {
    const diffDescription = changedFilesKnown
      ? `code files (${describeCodeFiles(codeFiles)})`
      : "the changed files could not be read, so the list is required";
    problems.push(
      `the PR summary carries no \`Branch outcomes:\` list, but the diff changes ${diffDescription}`,
    );
  } else if (record.entries.length === 0 && record.body.trim() === "") {
    problems.push(
      "the `Branch outcomes:` list names no outcomes — list each outcome the diff adds, or write `Branch outcomes: none added`",
    );
  } else if (record.entries.length === 0 && isBarePlaceholder(record.body)) {
    problems.push(
      "the `Branch outcomes:` list's value is a bare placeholder — list each outcome and the test that reaches it, or write `Branch outcomes: none added`",
    );
  } else if (namedTests.length > 0 && testsAtHead === null) {
    problems.push(
      "the list names a test but the worker could not confirm the named tests exist at the head, so the list is unverifiable",
    );
  } else if (testsAtHead !== null) {
    for (const path of namedTests) {
      if (!testsAtHead.has(path)) missingTests.push(path);
    }
    if (missingTests.length > 0) {
      problems.push(
        `the \`Branch outcomes:\` list names a test that does not exist at ` +
          `the head: ${
            missingTests.join(", ")
          } — test paths are checked relative to the repository root ` +
          `(e.g. \`worker/deno/tests/foo_test.ts\`, not \`tests/foo_test.ts\`), ` +
          `not to the directory a test command runs from`,
      );
    }
  }

  if (record.present) {
    // Blank test/command citations straight from the raw lines the real
    // parse already attributed to each entry, body contribution and
    // uncaptured line — never by re-parsing a separately blanked copy of
    // the whole document, which could identify different header/entry
    // boundaries than the real parse and block an honest summary on a
    // shape mismatch that was never a real line merge (PR #3312 review,
    // round 3; see `blankedUnitText`).
    const blanked: BlankedUnits = {
      entries: record.entryLineIndices.map((idxs) =>
        blankedUnitText(lines, idxs)
      ),
      body: record.bodyLineIndexGroups
        .map((idxs) => blankedUnitText(lines, idxs))
        .join(" "),
      uncapturedLines: record.uncapturedLineIndices.map((idx) =>
        blankedUnitText(lines, [idx])
      ),
    };
    const admission = evaluateUnreachedAdmissions(blanked);
    problems.push(...admission.problems);
    unreachedEntries = admission.unreachedEntries;
  }

  return {
    applicable: true,
    valid: problems.length === 0,
    changedFilesKnown,
    codeFiles,
    record,
    namedTests,
    missingTests,
    unreachedEntries,
    problems,
  };
}

/**
 * Build the issue comment posted when the branch-outcomes gate blocks PR
 * creation. Names every rule broken and restates the required shape plus the
 * procedure, so the next attempt can fix the summary without re-deriving it.
 */
export function buildBranchOutcomesGateComment(
  result: BranchOutcomesGateResult,
): string {
  const problems = result.problems.map((problem) => `- ${problem}`).join("\n");
  return [
    "⚠️ **Branch outcomes not recorded.** This diff changes code, so the PR " +
    "summary must record every outcome the new branches add before the PR " +
    "is raised:",
    "",
    problems,
    "",
    "Procedure:",
    "",
    "1. For every new condition, match arm, exit-code check, or " +
    "trait/interface default this diff's branches add, list its outcomes — " +
    "success, absent/empty, error, fail-closed default, and so on.",
    "2. Name the test that reaches each outcome.",
    "3. Flip the outcome on purpose (break the guard, invert the condition) " +
    "and confirm the named test actually goes red. A test that stays green " +
    "either way does not reach the outcome.",
    "4. A review-fix commit must re-enumerate EVERY branch its own rework " +
    "adds and refresh the list to the current head — not only the branches " +
    "a review finding named.",
    "5. Every test path named in the list must exist at the head, named " +
    "relative to the **repository root** (e.g. `worker/deno/tests/foo_test.ts`, " +
    "not `tests/foo_test.ts`, even when the test command itself runs from a " +
    "subdirectory such as `worker/deno`) — a fabricated, stale, or " +
    "wrongly-relative citation blocks the PR.",
    "6. An entry that admits its outcome is unreached — `no test reaches " +
    "it`, a flip that never went red or left the suite green — is work " +
    "still to do: add the test that goes red, or remove the branch; only " +
    "an outcome the issue puts out of scope, or one no test can reach, may " +
    "stand, written `exempt (out of scope): <reason>` or " +
    "`exempt (untestable): <reason>`.",
    "",
    "Add a `Branch outcomes` list to " +
    "`docs/archive/pr-summaries/pr-summary-<issue>.md` in this shape:",
    "",
    "```markdown",
    "**Branch outcomes:**",
    "- `worker/deno/lib/foo.ts:42` — error (unreadable file) — " +
    "`worker/deno/tests/foo_test.ts::rejects an unreadable file` — flipped " +
    "to success, test went red",
    "- `worker/deno/lib/foo.ts:48` — absent (no entries) — " +
    "`worker/deno/tests/foo_test.ts::returns empty for no entries` — " +
    "flipped to error, test went red",
    "```",
    "",
    "`**Branch outcomes:** none added` is the honest answer for a diff that " +
    "adds no branch.",
  ].join("\n");
}

/**
 * Look up which of the named test paths exist at `HEAD`, via
 * `git --literal-pathspecs ls-tree -r --name-only HEAD -- <paths...>`.
 *
 * `runGit` is invoked with the repository root as its working directory, so
 * every path in `paths` is resolved relative to the repository root — a
 * citation such as `tests/foo_test.ts` for a test actually at
 * `worker/deno/tests/foo_test.ts` reads as missing (Issue #3160), even though
 * `git ls-files tests/foo_test.ts` run from `worker/deno` would find it.
 *
 * Paths come from untrusted PR-summary text but are passed as argv entries
 * after `--`, never interpolated into a shell, and `--literal-pathspecs`
 * stops git treating any of them as a glob. Returns an empty set without
 * calling git when `paths` is empty (nothing to confirm), and returns `null`
 * (fail closed) on any error or non-zero exit.
 */
export async function lookupTestsAtHead(
  paths: readonly string[],
  runGit: (
    args: string[],
  ) => Promise<Result<{ code: number; stdout: string; stderr: string }>>,
): Promise<ReadonlySet<string> | null> {
  if (paths.length === 0) return new Set();

  const result = await runGit([
    "--literal-pathspecs",
    "ls-tree",
    "-r",
    "--name-only",
    "HEAD",
    "--",
    ...paths,
  ]);

  if (!result.ok || result.value.code !== 0) return null;

  return new Set(
    result.value.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}
