/**
 * Stale `path:line` citation check for review-fix pushes (Issue #3341).
 *
 * A `Branch outcomes:` entry cites the file and line a flipped outcome
 * lives at, e.g. `worker/deno/lib/foo.ts:42`. A review-fix round can edit
 * the cited file without renumbering the list, so a citation can be left
 * pointing at the previous head's line numbers (PR #3160, PR #3312 review
 * evidence: citations were left at the previous head's line numbers after
 * the fix push, e.g. a cited check had moved from line 398 to 434).
 *
 * This module is the deterministic, pure check for that drift: given the
 * PR summary at the previous head, the PR summary now, the files this push
 * changed, and that push's `git diff -U0` hunks per file, it reports which
 * old citations moved without being renumbered, and which cited lines were
 * changed or removed while their entry's text stayed exactly as it was
 * (carrying a stale verdict forward). No IO happens here — every regex is
 * hardcoded against untrusted (agent-authored, issue-steered) text, and
 * `pr_feedback_drift_check.ts` is the caller that gathers the git state and
 * posts the findings.
 */

import {
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
  MAX_SCAN_CHARS,
  parseBranchOutcomes,
} from "./branch_outcomes_gate.ts";

/** One `path:N` or `path:N-M` citation in a Branch-outcomes entry. */
export interface LineCitation {
  path: string;
  start: number;
  end: number;
  text: string;
  entry: string;
}

/** URLs, excluded so a link such as `https://x/y.ts:12` is never read as a citation. */
const URL_RE = /https?:\/\/\S+/g;

/**
 * Characters (besides whitespace) that split an entry into candidate
 * tokens. A comma is only a splitter when it is NOT directly followed by a
 * digit: `worker/deno/lib/foo.ts:720-725,735-738` is a single token (so its
 * second range survives), while `` `a.ts:12`, `b.ts:3` `` still splits on
 * the comma that separates the two backticked citations (the PR #3312
 * replay of `docs/archive/pr-summaries/pr-summary-3288.md`).
 */
const TOKEN_SPLIT_RE = /[\s`()[\];"'<>|*]+|,(?!\d)/;

/** Cap on a single token's length before it is considered a candidate citation. */
const MAX_TOKEN_CHARS = 300;

/**
 * The trailing `:N` or `:N-M` (en-dash accepted) line suffix of a token,
 * with optional later `,N`/`,N-M`/`/N`/`/N-M` groups (comma- or
 * slash-joined extra lines in the same citation, e.g.
 * `foo.ts:720-725,735-738` or `foo.ts:1147/1158/1169`), and optional
 * trailing punctuation. Unanchored at the start: `exec` finds it wherever
 * it starts, and everything before `match.index` is the path — a path
 * itself containing `/` followed by digits (`lib/2024/x.ts:5`) is
 * unaffected, since the suffix only ever starts at the leading `:`. Each
 * repeat group must start with `,` or `/`, characters digits cannot match,
 * so the groups stay disjoint and the match stays linear in the token's
 * length (no adjacent unbounded quantifiers over the same character class).
 */
const LINE_SUFFIX_RE =
  /:(\d{1,7}(?:[-–]\d{1,7})?(?:[,\/]\d{1,7}(?:[-–]\d{1,7})?)*)[.,:!]*$/;

/** One `N` or `N-M` part split out of a `LINE_SUFFIX_RE` capture group. */
const RANGE_PART_RE = /^(\d{1,7})(?:[-–](\d{1,7}))?$/;

/** A path shaped like a repo-relative file with an extension. */
const PATH_CHARS_RE = /^[A-Za-z0-9_.\-\/]+$/;
const HAS_EXTENSION_RE = /\.[A-Za-z0-9]+$/;

/** A token whose line suffix parsed but whose line number(s) were unusable. */
export interface MalformedCitation {
  /** The raw token as written. */
  token: string;
  /** The extracted, `./`-stripped path (used to resolve against changed files). */
  path: string;
}

/**
 * Extract every `path:N`/`path:N-M` line citation from free text, tokenised
 * the same way `branch_outcomes_gate.ts`'s `namedTestPaths` tokenises
 * entries: URLs removed, split on the same punctuation class (plus a
 * comma not directly followed by a digit — see `TOKEN_SPLIT_RE`), long
 * tokens skipped.
 *
 * One token can carry more than one line reference —
 * `foo.ts:720-725,735-738` and `foo.ts:1147/1158/1169` both parse into
 * several citations sharing the same path (seen in the archived
 * `pr-summary-3288.md` and `pr-summary-3250.md`).
 * Each `N`/`N-M` part is checked on its own: line 0 or an end before its
 * start makes only that part `malformed` (with the shared path), while the
 * token's other, well-formed parts are still returned as citations.
 *
 * A token that is only a bare `:N`/`:N-M` suffix (no path before the
 * colon, e.g. a later `` `:821` `` naming a second line for the citation
 * `` `foo.ts:820` `` a few words earlier) inherits the path of the most
 * recent citation or malformed citation already extracted from this same
 * `text` — with no earlier citation to inherit from, it is ignored.
 *
 * Deliberately two small regexes (shape, then line suffix) rather than one
 * regex spanning path and extension and digits together: a single pattern
 * with adjacent `+`/`*` quantifiers over attacker-controlled text is the
 * classic ReDoS shape this repository's regexes are vetted against (see
 * CODING-STANDARDS "Vet every regex on untrusted text"). The line-suffix
 * repeat group is bounded the same way: each repeat must start with a `,`
 * or `/` that a digit cannot match, so the groups can never overlap or
 * backtrack into each other.
 */
export function extractLineCitations(
  text: string,
): {
  citations: Omit<LineCitation, "entry">[];
  malformed: MalformedCitation[];
} {
  const citations: Omit<LineCitation, "entry">[] = [];
  const malformed: MalformedCitation[] = [];
  let lastPath: string | undefined;

  const withoutUrls = text.replace(URL_RE, " ");
  for (const rawToken of withoutUrls.split(TOKEN_SPLIT_RE)) {
    if (!rawToken) continue;
    if (rawToken.length > MAX_TOKEN_CHARS) continue;

    const match = LINE_SUFFIX_RE.exec(rawToken);
    if (!match) continue;

    const pathPart = rawToken.slice(0, match.index);
    let path: string;
    if (pathPart === "") {
      // A bare `:N`/`:N-M` suffix: inherit the most recent path.
      if (lastPath === undefined) continue;
      path = lastPath;
    } else {
      let candidate = pathPart;
      if (candidate.startsWith("./")) candidate = candidate.slice(2);
      if (candidate.startsWith("/")) continue;
      if (
        !candidate || !PATH_CHARS_RE.test(candidate) ||
        !HAS_EXTENSION_RE.test(candidate)
      ) {
        continue;
      }
      path = candidate;
    }

    lastPath = path;

    for (const part of match[1]!.split(/[,\/]/)) {
      const rangeMatch = RANGE_PART_RE.exec(part);
      if (!rangeMatch) continue; // Unreachable given LINE_SUFFIX_RE's shape.

      const start = Number(rangeMatch[1]);
      const end = rangeMatch[2] !== undefined ? Number(rangeMatch[2]) : start;

      if (start === 0 || end < start) {
        malformed.push({ token: rawToken, path });
        continue;
      }

      const textForm = end === start
        ? `${path}:${start}`
        : `${path}:${start}-${end}`;
      citations.push({ path, start, end, text: textForm });
    }
  }

  return { citations, malformed };
}

/** Whitespace-normalise an entry for exact comparison across pushes. */
function normaliseEntry(entry: string): string {
  return entry.replace(/\s+/g, " ").trim();
}

/**
 * Every line citation found in a PR summary's `Branch outcomes:` list
 * entries, and in the header's inline body when non-empty — deliberately
 * NOT `record.scanText` (tables, and prose outside the list-shaped entries):
 * the issue's drift check starts with "Branch outcomes entries only", the
 * same list `branch_outcomes_gate.ts` itself requires and verifies test
 * paths against.
 */
export function branchOutcomeCitations(
  summary: string,
): {
  citations: LineCitation[];
  malformed: MalformedCitation[];
  truncated: boolean;
} {
  const record = parseBranchOutcomes(summary);
  const citations: LineCitation[] = [];
  const malformed: MalformedCitation[] = [];

  const texts: string[] = [...record.entries];
  if (record.body.trim() !== "") texts.push(record.body);

  for (const rawEntry of texts) {
    const entry = normaliseEntry(rawEntry);
    const found = extractLineCitations(entry);
    for (const citation of found.citations) {
      citations.push({ ...citation, entry });
    }
    malformed.push(...found.malformed);
  }

  const truncated = summary.length > MAX_SCAN_CHARS ||
    record.entries.length >= MAX_ENTRIES ||
    record.entries.some((entry) => entry.length >= MAX_ENTRY_CHARS);

  return { citations, malformed, truncated };
}

/** One hunk from `git diff -U0` output. */
export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** A `git diff -U0` hunk header, e.g. `@@ -12,3 +12,0 @@`. */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** `git diff`'s marker for a file it declines to diff as text. */
const BINARY_MARKER_RE = /^Binary files .* differ$/m;

/**
 * Parse the hunks out of a `git diff -U0` text, sorted by `oldStart`. Null
 * when git reported the file as binary rather than diffing it as text — a
 * caller then has no line mapping to check against and must report the
 * citation as not checked rather than treating "no hunks" as "no changes".
 */
export function parseDiffHunks(diff: string): DiffHunk[] | null {
  if (BINARY_MARKER_RE.test(diff)) return null;

  const hunks: DiffHunk[] = [];
  for (const line of diff.split(/\r\n|\n/)) {
    const match = HUNK_HEADER_RE.exec(line);
    if (!match) continue;
    hunks.push({
      oldStart: Number(match[1]),
      oldCount: match[2] !== undefined ? Number(match[2]) : 1,
      newStart: Number(match[3]),
      newCount: match[4] !== undefined ? Number(match[4]) : 1,
    });
  }

  hunks.sort((a, b) => a.oldStart - b.oldStart);
  return hunks;
}

/** The result of mapping one previous-head line number through a diff. */
export type MappedLine = { kind: "kept"; line: number } | { kind: "removed" };

/**
 * Map an old (previous-head) line number `n` to the current head through a
 * sorted list of `-U0` hunks.
 *
 * A pure insertion (`oldCount === 0`) shifts lines strictly after the
 * insertion point by `+newCount`; `oldStart` for such a hunk names the old
 * line the insertion follows (0 meaning "before the first line"), so a line
 * at or before `oldStart` is unaffected. A real removal (`oldCount > 0`)
 * removes old lines `[oldStart, oldStart + oldCount - 1]`: `n` inside that
 * range has no home at the head at all; a hunk entirely before `n` shifts it
 * by `newCount - oldCount`; a hunk at or after `n` has not happened yet by
 * the time we reach line `n`, so the scan stops.
 */
export function mapOldLine(
  hunks: readonly DiffHunk[],
  n: number,
): MappedLine {
  let offset = 0;
  for (const hunk of hunks) {
    if (hunk.oldCount === 0) {
      // Pure insertion after old line `hunk.oldStart`.
      if (hunk.oldStart < n) offset += hunk.newCount;
      continue;
    }
    const removedStart = hunk.oldStart;
    const removedEnd = hunk.oldStart + hunk.oldCount - 1;
    if (n >= removedStart && n <= removedEnd) {
      return { kind: "removed" };
    }
    if (removedEnd < n) {
      offset += hunk.newCount - hunk.oldCount;
      continue;
    }
    // Hunk starts at or after n: nothing earlier has changed n further.
    break;
  }
  return { kind: "kept", line: n + offset };
}

/** Resolution of a cited path against the files a push changed. */
export type ResolvedPath =
  | { kind: "match"; path: string }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: string[] };

/**
 * Resolve a cited path against the files this push changed: an exact match
 * wins outright; otherwise a changed file ending in `/${cited}` (a
 * basename-style citation resolving to its directory) is a candidate — one
 * candidate is a match, more than one is ambiguous, none is "not this
 * push's concern".
 */
export function resolveCitedPath(
  cited: string,
  changedFiles: readonly string[],
): ResolvedPath {
  if (changedFiles.includes(cited)) return { kind: "match", path: cited };

  const suffix = `/${cited}`;
  const candidates = changedFiles.filter((file) => file.endsWith(suffix));
  if (candidates.length === 1) return { kind: "match", path: candidates[0]! };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "none" };
}

/**
 * The changed files the previous summary's Branch-outcomes list cites by
 * line, resolved against `changedFiles`, de-duplicated, in first-seen order.
 */
export function changedFilesCitedBy(
  previousSummary: string,
  changedFiles: readonly string[],
): string[] {
  const { citations } = branchOutcomeCitations(previousSummary);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const citation of citations) {
    const resolved = resolveCitedPath(citation.path, changedFiles);
    if (resolved.kind !== "match") continue;
    if (seen.has(resolved.path)) continue;
    seen.add(resolved.path);
    result.push(resolved.path);
  }
  return result;
}

/** Input to {@link findStaleCitations}. */
export interface CitationCheckInput {
  summaryPath: string;
  previousSummary: string;
  currentSummary: string;
  changedFiles: readonly string[];
  hunksByPath: ReadonlyMap<string, readonly DiffHunk[]>;
}

/** The new `path:line` text for a moved citation, `?` for a removed endpoint. */
function newCitationText(
  path: string,
  start: MappedLine,
  end: MappedLine,
): string {
  const startText = start.kind === "kept" ? String(start.line) : "?";
  const endText = end.kind === "kept" ? String(end.line) : "?";
  return startText === endText
    ? `${path}:${startText}`
    : `${path}:${startText}-${endText}`;
}

/** Whether `[start, end]` overlaps a hunk's removed old-line range. */
function overlapsRemoval(
  hunks: readonly DiffHunk[],
  start: number,
  end: number,
): boolean {
  for (const hunk of hunks) {
    if (hunk.oldCount === 0) continue;
    const removedStart = hunk.oldStart;
    const removedEnd = hunk.oldStart + hunk.oldCount - 1;
    if (start <= removedEnd && end >= removedStart) return true;
  }
  return false;
}

/**
 * Compare a push's previous-head and current PR summaries' Branch-outcomes
 * citations against that push's diff, to find citations left at the
 * previous head's line numbers.
 *
 * For each distinct (resolved path, start, end, entry) citation in the
 * previous summary:
 *   - the cited path resolves to none of this push's changed files → the
 *     line cannot have moved under this push, so it is skipped, never
 *     reported;
 *   - the cited path is ambiguous among the changed files → unchecked;
 *   - this push's diff of the resolved path was not supplied (or was
 *     binary) → unchecked;
 *   - the cited line(s) moved (mapped to a different line number) and the
 *     current summary cites the OLD numbers more times than previous
 *     citations legitimately map onto them → stale: the citation needs
 *     renumbering. The "legitimately map onto them" clause excludes a
 *     current citation that is really a *different* previous citation
 *     correctly renumbered onto this one's old number (e.g. previous `:941`
 *     and `:943` both shift to `:943` and `:945`) — that coincidence must
 *     not read as "`:943` is still here unrenamed";
 *   - the cited line(s) were changed or removed by this push's diff (not
 *     just moved) and the entry's own text is unchanged (apart from
 *     whitespace) from the previous head → stale: the result was carried
 *     over without re-reading the new code at that line.
 *
 * A citation malformed at the previous head (line 0, or an inverted range)
 * is reported as unchecked when its path resolves to a changed file, since
 * it is not a usable line reference either way. A previous list longer than
 * the gate's own parser reads is reported as unchecked in its own right,
 * since citations past the cap were never even extracted.
 */
export function findStaleCitations(
  input: CitationCheckInput,
): { stale: string[]; unchecked: string[] } {
  const old = branchOutcomeCitations(input.previousSummary);
  const cur = branchOutcomeCitations(input.currentSummary);

  const curKeyCounts = new Map<string, number>();
  const curEntries = new Set<string>();
  for (const citation of cur.citations) {
    const resolved = resolveCitedPath(citation.path, input.changedFiles);
    if (resolved.kind === "match") {
      const key = `${resolved.path}:${citation.start}-${citation.end}`;
      curKeyCounts.set(key, (curKeyCounts.get(key) ?? 0) + 1);
    }
    curEntries.add(citation.entry);
  }

  // How many previous citations the diff maps onto each `path:newLine` key.
  // A citation that correctly renumbers onto another previous citation's OLD
  // number (e.g. 941/943 both shift to 943/945) must not read as "that other
  // citation is still there unrenamed" — see the loop below, which only
  // flags a `curKeyCounts` hit beyond what this multiset already explains
  // (PR #3375 review).
  const expectedAtKey = new Map<string, number>();
  for (const citation of old.citations) {
    const resolved = resolveCitedPath(citation.path, input.changedFiles);
    if (resolved.kind !== "match") continue;
    const hunks = input.hunksByPath.get(resolved.path);
    if (hunks === undefined) continue;
    const ms = mapOldLine(hunks, citation.start);
    const me = mapOldLine(hunks, citation.end);
    if (ms.kind !== "kept" || me.kind !== "kept") continue;
    const key = `${resolved.path}:${ms.line}-${me.line}`;
    expectedAtKey.set(key, (expectedAtKey.get(key) ?? 0) + 1);
  }

  const stale: string[] = [];
  const unchecked: string[] = [];
  const staleSeen = new Set<string>();
  const uncheckedSeen = new Set<string>();

  const pushStale = (message: string) => {
    if (staleSeen.has(message)) return;
    staleSeen.add(message);
    stale.push(message);
  };
  const pushUnchecked = (message: string) => {
    if (uncheckedSeen.has(message)) return;
    uncheckedSeen.add(message);
    unchecked.push(message);
  };

  if (old.truncated) {
    pushUnchecked(
      `${input.summaryPath}: the Branch outcomes list at the previous head is longer than the parser reads, so citations past the cap were not checked`,
    );
  }

  for (const malformed of old.malformed) {
    const resolved = resolveCitedPath(malformed.path, input.changedFiles);
    if (resolved.kind !== "match") continue;
    pushUnchecked(
      `${input.summaryPath}: \`${malformed.token}\` is not a usable line citation, so it was not checked`,
    );
  }

  const dedupeSeen = new Set<string>();

  for (const citation of old.citations) {
    const resolved = resolveCitedPath(citation.path, input.changedFiles);

    if (resolved.kind === "none") continue;

    const dedupeKey = `${
      resolved.kind === "match" ? resolved.path : resolved.candidates.join(",")
    }:${citation.start}-${citation.end}:${citation.entry}`;
    if (dedupeSeen.has(dedupeKey)) continue;
    dedupeSeen.add(dedupeKey);

    if (resolved.kind === "ambiguous") {
      pushUnchecked(
        `${input.summaryPath}: \`${citation.text}\` matches more than one file this push changed (${
          resolved.candidates.join(", ")
        }), so it was not checked`,
      );
      continue;
    }

    const path = resolved.path;
    const hunks = input.hunksByPath.get(path);
    if (hunks === undefined) {
      pushUnchecked(
        `${input.summaryPath}: this push's diff of ${path} could not be read as text, so \`${citation.text}\` was not checked`,
      );
      continue;
    }

    const ms = mapOldLine(hunks, citation.start);
    const me = mapOldLine(hunks, citation.end);
    const removedInRange = overlapsRemoval(hunks, citation.start, citation.end);
    const moved = (ms.kind === "kept" && ms.line !== citation.start) ||
      (me.kind === "kept" && me.line !== citation.end);

    const oldKey = `${path}:${citation.start}-${citation.end}`;
    const curCount = curKeyCounts.get(oldKey) ?? 0;
    const expectedCount = expectedAtKey.get(oldKey) ?? 0;
    if (moved && curCount > expectedCount) {
      const newText = newCitationText(path, ms, me);
      const plural = citation.start !== citation.end;
      pushStale(
        `${input.summaryPath}: Branch outcomes still cites \`${citation.text}\`, but this push moved ${
          plural ? "those lines" : "that line"
        } to ${newText} — renumber it to the head`,
      );
      continue;
    }

    if (removedInRange && curEntries.has(citation.entry)) {
      pushStale(
        `${input.summaryPath}: this push changed or removed the code at \`${citation.text}\`, but its Branch outcomes entry is unchanged from the previous head — re-read the line at the head, renumber it, and re-run its flip rather than carrying the old result over`,
      );
      continue;
    }
  }

  return { stale, unchecked };
}
