/**
 * Standing-violation routing (Issues #3382, #3196, #3613).
 *
 * The #3196 gate refuses a Standards `violation` that is left standing, but it
 * reads only the PR summary and cannot see the diff. This module reads the
 * diff to find which standing violations sit on lines the branch adds or
 * changes, so the completion phase can (a) hand those to the in-run recovery
 * turn as code fixes, and (b) withhold auto-merge when such a violation
 * survives that turn.
 *
 * A violation on unchanged context is not routed here: its remedy is
 * `pre-existing, filed #<n>`, which is a summary change, not a code change.
 *
 * A violation whose cited location cannot be placed (its path matches no file
 * in the diff and no file at HEAD) is treated as on the branch's own lines, so
 * an unplaceable citation fails closed rather than arming auto-merge (Issue
 * #3613).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type DocsSweepGitRunner,
  parseChangedLines,
} from "./docs_sweep_hits.ts";
import {
  isStandingViolation,
  type ReviewEntry,
  validateIndependentReview,
} from "./independent_review_gate.ts";

/**
 * The PR label the worker applies when it finalises a PR with an own-line
 * standing violation instead of arming auto-merge. It is also applied when a
 * pre-PR verifier finding survives the recovery turn (Issue #3697). For that
 * verifier-only hold the PR-feedback pass removes the label after a verified
 * fix on the PR's own head, but not for a hold that also covers a standing
 * violation. The Priority 1.65 sweep skips and disarms a PR carrying it (Issue
 * #3517), and the CI-fix pass does not re-arm one after pushing a fix (Issue
 * #3685).
 */
export const STANDING_VIOLATION_LABEL = "standing-violation";

/** A `path:line` or `path:line-end` location an entry's evidence names. */
export interface CitedLocation {
  path: string;
  start: number;
  end: number;
}

/** A standing violation the worker routes to a code-capable turn. */
export interface StandingViolation {
  /** The entry text. */
  text: string;
  /** What the evidence names; empty when it names no `path:line`. */
  cited: readonly CitedLocation[];
}

/** Cap on the evidence text scanned, bounding the regex work. */
const MAX_EVIDENCE_CHARS = 2_000;

/** The evidence label value runs on into the reason; cut it there. */
const REASON_CUT_RE = /\breason\s*[:\-—]/i;

/** A `path:line` or `path:line-end` citation (bounded quantifiers). */
const LOCATION_RE = /([\w.\/-]{1,300}):(\d{1,7})(?:[-–](\d{1,7}))?/g;

/**
 * The text between an opening backtick and a citation, when the citation was
 * cut short by a space in a backticked path (Issue #3613).
 */
const SPACED_PATH_PREFIX_RE = /^[\w.\/ -]+$/;

/**
 * Every `path:line` (or `path:line-end`) the evidence names, in order. Text
 * from the entry's `reason:` onward is ignored. A path with spaces inside
 * backticks (for example `` `dir/run callback x.ts:3` ``, where the writer
 * meant underscores) is reported whole, so a rewritten path stays unresolvable
 * rather than shrinking to a tail that might match a real file (Issue #3613).
 */
export function citedLocations(evidence: string): CitedLocation[] {
  let text = evidence.slice(0, MAX_EVIDENCE_CHARS);
  const cut = text.search(REASON_CUT_RE);
  if (cut >= 0) text = text.slice(0, cut);
  const ticks: number[] = [];
  for (let i = text.indexOf("`"); i >= 0; i = text.indexOf("`", i + 1)) {
    ticks.push(i);
  }
  // Matches arrive in order, so `next` only moves forward: it counts the
  // backticks before the current match.
  let next = 0;
  const out: CitedLocation[] = [];
  for (const m of text.matchAll(LOCATION_RE)) {
    const at = m.index;
    while (next < ticks.length && ticks[next]! < at) next++;
    let path = m[1]!;
    if (next % 2 === 1) {
      const prefix = text.slice(ticks[next - 1]! + 1, at);
      if (SPACED_PATH_PREFIX_RE.test(prefix)) path = prefix + path;
    }
    path = path.replace(/^\.\//, "");
    if (!/[./]/.test(path)) continue;
    const a = Number(m[2]!);
    const b = m[3] === undefined ? a : Number(m[3]);
    out.push({ path, start: Math.min(a, b), end: Math.max(a, b) });
  }
  return out;
}

/** True when `cited` names `file` or a path ending in `/` + `cited`. */
function pathMatches(file: string, cited: string): boolean {
  return file === cited || file.endsWith("/" + cited);
}

/**
 * The standing violations on lines the branch adds or changes. A violation
 * that cites no `path:line` is kept (fail closed): one the worker cannot place
 * is treated as on the branch's own lines. So is a violation whose cited
 * location cannot be placed: none of its cited paths matches a diff file or a
 * file at HEAD (Issue #3613). A citation of a real file at HEAD that the diff
 * does not change is not own-line, and neither is a citation of a diff file
 * outside its changed ranges.
 *
 * @param entries - Standards entries; non-standing ones are skipped.
 * @param changed - New-side changed line ranges per file, from the diff.
 * @param headFiles - Repo-relative paths of every file at HEAD.
 */
export function ownLineStandingViolations(
  entries: readonly ReviewEntry[],
  changed: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>,
  headFiles: ReadonlySet<string>,
): StandingViolation[] {
  const placeable = (path: string): boolean => {
    for (const file of changed.keys()) {
      if (pathMatches(file, path)) return true;
    }
    for (const file of headFiles) {
      if (pathMatches(file, path)) return true;
    }
    return false;
  };
  const overlapsChanged = (loc: CitedLocation): boolean => {
    for (const [p, ranges] of changed) {
      if (!pathMatches(p, loc.path)) continue;
      if (ranges.some(([s, e]) => loc.start <= e && loc.end >= s)) {
        return true;
      }
    }
    return false;
  };
  const out: StandingViolation[] = [];
  for (const entry of entries) {
    if (!isStandingViolation(entry)) continue;
    const cited = citedLocations(entry.evidence ?? "");
    const onOwnLines = cited.length === 0 ||
      cited.some(overlapsChanged) ||
      !cited.some((loc) => placeable(loc.path));
    if (onOwnLines) out.push({ text: entry.text, cited });
  }
  return out;
}

/**
 * Find the standing violations on the branch's own lines, reading the diff
 * against `base`. When the diff cannot be read, every standing violation is
 * returned and `notChecked` says why (fail closed). The same holds when the
 * HEAD file listing is needed (a standing violation cites no path the diff
 * changes) and cannot be read (Issue #3613).
 */
export async function findOwnLineStandingViolations(opts: {
  issueBody: string;
  prSummaryContent: string;
  base: string | null;
  runGit: DocsSweepGitRunner;
}): Promise<{ violations: StandingViolation[]; notChecked: string | null }> {
  const review = validateIndependentReview({
    issueBody: opts.issueBody,
    prSummaryContent: opts.prSummaryContent,
  });
  const standing = review.standardsEntries.filter(isStandingViolation);
  if (!review.applicable || standing.length === 0) {
    return { violations: [], notChecked: null };
  }
  const failClosed = (notChecked: string) => ({
    violations: standing.map((e) => ({
      text: e.text,
      cited: citedLocations(e.evidence ?? ""),
    })),
    notChecked,
  });
  if (opts.base === null) return failClosed("base ref unresolvable");

  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await opts.runGit([
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--unified=0",
      `${opts.base}...HEAD`,
    ]);
  } catch (error) {
    return failClosed(
      `git diff failed: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (result.code !== 0) {
    return failClosed(
      `git diff exited ${result.code}: ${result.stderr.trim()}`,
    );
  }
  let changed: Map<string, Array<[number, number]>>;
  try {
    changed = parseChangedLines(result.stdout);
  } catch (error) {
    return failClosed(
      `diff unreadable: ${error instanceof Error ? error.message : error}`,
    );
  }

  // The HEAD listing is needed only when some violation cites a location and
  // none of its citations names a changed file (Issue #3613).
  const diffPaths = [...changed.keys()];
  const needsHead = standing.some((e) => {
    const cited = citedLocations(e.evidence ?? "");
    return cited.length > 0 &&
      !cited.some((loc) => diffPaths.some((p) => pathMatches(p, loc.path)));
  });
  let headFiles: ReadonlySet<string> = new Set<string>();
  if (needsHead) {
    let listing: { code: number; stdout: string; stderr: string };
    try {
      listing = await opts.runGit([
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        "HEAD",
      ]);
    } catch (error) {
      return failClosed(
        `git ls-tree failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (listing.code !== 0) {
      return failClosed(
        `git ls-tree exited ${listing.code}: ${listing.stderr.trim()}`,
      );
    }
    headFiles = new Set(listing.stdout.split("\0").filter((f) => f !== ""));
  }
  return {
    violations: ownLineStandingViolations(standing, changed, headFiles),
    notChecked: null,
  };
}
