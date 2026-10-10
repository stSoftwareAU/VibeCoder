/**
 * Standing-violation routing (Issues #3382, #3196).
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
 * standing violation instead of arming auto-merge.
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
 * Every `path:line` (or `path:line-end`) the evidence names, in order. Text
 * from the entry's `reason:` onward is ignored.
 */
export function citedLocations(evidence: string): CitedLocation[] {
  let text = evidence.slice(0, MAX_EVIDENCE_CHARS);
  const cut = text.search(REASON_CUT_RE);
  if (cut >= 0) text = text.slice(0, cut);
  const out: CitedLocation[] = [];
  for (const m of text.matchAll(LOCATION_RE)) {
    const path = m[1]!.replace(/^\.\//, "");
    if (!/[./]/.test(path)) continue;
    const a = Number(m[2]!);
    const b = m[3] === undefined ? a : Number(m[3]);
    out.push({ path, start: Math.min(a, b), end: Math.max(a, b) });
  }
  return out;
}

/**
 * The standing violations on lines the branch adds or changes. A violation
 * that cites no `path:line` is kept (fail closed): one the worker cannot place
 * is treated as on the branch's own lines.
 *
 * @param entries - Standards entries; non-standing ones are skipped.
 * @param changed - New-side changed line ranges per file, from the diff.
 */
export function ownLineStandingViolations(
  entries: readonly ReviewEntry[],
  changed: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>,
): StandingViolation[] {
  const out: StandingViolation[] = [];
  for (const entry of entries) {
    if (!isStandingViolation(entry)) continue;
    const cited = citedLocations(entry.evidence ?? "");
    const onOwnLines = cited.length === 0 || cited.some((loc) => {
      for (const [p, ranges] of changed) {
        if (p !== loc.path && !p.endsWith("/" + loc.path)) continue;
        if (ranges.some(([s, e]) => loc.start <= e && loc.end >= s)) {
          return true;
        }
      }
      return false;
    });
    if (onOwnLines) out.push({ text: entry.text, cited });
  }
  return out;
}

/**
 * Find the standing violations on the branch's own lines, reading the diff
 * against `base`. When the diff cannot be read, every standing violation is
 * returned and `notChecked` says why (fail closed).
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
  try {
    const changed = parseChangedLines(result.stdout);
    return {
      violations: ownLineStandingViolations(standing, changed),
      notChecked: null,
    };
  } catch (error) {
    return failClosed(
      `diff unreadable: ${error instanceof Error ? error.message : error}`,
    );
  }
}
