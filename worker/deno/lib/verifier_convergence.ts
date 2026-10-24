/**
 * Verifier convergence on a retry (Issue #4234, point 5).
 *
 * A recovery turn or retry hands the pre-PR verifier its previous findings,
 * which it must answer one by one. A finding it raises for the first time on
 * a line the change does not touch is reported but does not block that retry,
 * unless its severity is `critical` or `high`. Everything the diff cannot place
 * fails closed: it blocks.
 *
 * This module only splits and reshapes results. It is not wired into the
 * completion phase here.
 *
 * @module
 */

import {
  clip,
  PRE_PR_VERIFIER_COMMENT_HEADING,
  type PrePrVerifierResult,
  type ReviewFinding,
} from "./pre_pr_verifier.ts";

/** Heading of the comment that lists advisory findings. */
export const PRE_PR_VERIFIER_ADVISORY_HEADING =
  "**The pre-PR verifier noted advisory findings on unchanged lines.**";

/** Cap on one finding's text, as `previousFindings` carries it. */
const EARLIER_TEXT_MAX = 2000;

/**
 * Index of the first finding bullet in `buildPrePrVerifierGateComment`'s
 * layout: heading, blank, intro, blank, summary, blank, then the bullets.
 * `previousFindingsFromGateComment` round-trip tests guard this.
 */
const GATE_COMMENT_FIRST_BULLET_LINE = 6;

/** Complete problem/Fix text for one finding, the shape `previousFindings` carries. */
export function findingToEarlierText(f: ReviewFinding): string {
  const fix = f.fix ? ` — fix: ${f.fix}` : "";
  return clip(`\`${f.file}:${f.line}\` — ${f.problem}${fix}`, EARLIER_TEXT_MAX);
}

/**
 * Parse the findings back out of a posted pre-PR verifier gate comment: the
 * bullet lines under the heading, every one kept. [] when the comment is not
 * that comment.
 */
export function previousFindingsFromGateComment(commentBody: string): string[] {
  const lines = commentBody.split("\n");
  if (lines[0]?.trimEnd() !== PRE_PR_VERIFIER_COMMENT_HEADING) return [];
  const bullets: string[] = [];
  for (const line of lines.slice(GATE_COMMENT_FIRST_BULLET_LINE)) {
    if (!line.startsWith("- ")) break;
    bullets.push(line.slice(2).trim());
  }
  return bullets;
}

export interface ConvergenceSplit {
  blocking: ReviewFinding[];
  advisory: ReviewFinding[];
}

/**
 * Whether a finding on a retry is advisory: its severity is not `critical` or
 * `high`, it names a real file (not a synthetic `(...)` one), it has a line,
 * and that file:line is not a line the change touches. Anything the diff
 * cannot place is blocking.
 */
function isAdvisoryOnRetry(
  f: ReviewFinding,
  changed: { files: Map<string, number[]>; unparsed: number } | null,
): boolean {
  if (f.severity === "critical" || f.severity === "high") return false;
  if (f.file.trim() === "" || f.file.startsWith("(")) return false;
  if (!Number.isInteger(f.line) || f.line <= 0) return false;
  if (changed === null || changed.unparsed > 0) return false;
  const changedLines = changed.files.get(f.file);
  return !(changedLines?.includes(f.line) ?? false);
}

/**
 * Split a verifier's findings on a retry or recovery turn. `isRetry` false
 * blocks everything. `changed` is `parseDiffChangedLines(diff)`, or null when
 * the diff is unknown.
 */
export function splitFindingsForRetry(opts: {
  findings: readonly ReviewFinding[];
  isRetry: boolean;
  changed: { files: Map<string, number[]>; unparsed: number } | null;
}): ConvergenceSplit {
  const split: ConvergenceSplit = { blocking: [], advisory: [] };
  for (const f of opts.findings) {
    const advisory = opts.isRetry && isAdvisoryOnRetry(f, opts.changed);
    (advisory ? split.advisory : split.blocking).push(f);
  }
  return split;
}

/**
 * Rebuild a checked verifier result with only the blocking findings. Returns
 * the same object when nothing was demoted; a `not_checked` result passes
 * through unchanged.
 */
export function applyConvergence(
  result: PrePrVerifierResult,
  split: ConvergenceSplit,
): PrePrVerifierResult {
  if (result.status !== "checked" || split.advisory.length === 0) return result;
  return {
    ...result,
    review: { ...result.review, findings: [...split.blocking] },
  };
}

/** One comment body listing advisory findings, or "" when there are none. */
export function buildAdvisoryFindingsComment(
  advisory: readonly ReviewFinding[],
): string {
  if (advisory.length === 0) return "";
  return [
    PRE_PR_VERIFIER_ADVISORY_HEADING,
    "",
    "These were raised on lines this change does not touch, so they do not block this retry. Fix any that is real and in scope.",
    "",
    ...advisory.map((f) => `- ${findingToEarlierText(f)}`),
  ].join("\n");
}
