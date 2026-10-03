/**
 * Match a PR summary's closure-block entries to the criteria they assess, by
 * their words rather than by their position in the list (Issue #3128).
 *
 * `degraded_delivery.ts` used to read `assessments[index]` — the closure
 * entry at the same index as the criterion. A reordered closure block, or a
 * criterion split across two entries, then misattributed statuses: with
 * criteria `[A, B]` and entries `missing — B`, `met — A`, the guard recorded
 * `A` missing and `B` met. This module replaces the positional read with a
 * content match.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type {
  ClosureEntry,
  CriterionStatus,
} from "./acceptance_criteria_gate.ts";

export type { CriterionStatus };

// Any run of characters that is not a Unicode letter or digit — the word
// separator for both criteria and entry subjects.
const NON_WORD_RE = /[^\p{L}\p{N}]+/u;

/** Lower-cased word set of `text`, for subset and Jaccard comparisons. */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(NON_WORD_RE)
      .filter((w) => w !== ""),
  );
}

// The earliest standalone status token, optionally wrapped in `**…**`, that
// opens an entry — the same leading status statusOf() in
// acceptance_criteria_gate.ts finds, stripped here so the remaining text is
// the entry's subject.
const LEADING_STATUS_RE =
  /^\s*(?:\*\*\s*)?(met|partial|missing|unrequested)(?:\s*\*\*)?\s*[—\-:]*\s*/i;

// The first labelled field — `evidence:`, `reviewer:` or `reason:` — that
// closes the subject off from the rest of the entry.
const LABEL_BOUNDARY_RE = /\b(?:evidence|reviewer|reason)\s*[:\-—]/i;

/** The entry's subject: the text between its leading status and its first
 * labelled field. */
function subjectOf(entry: ClosureEntry): string {
  const afterStatus = entry.text.replace(LEADING_STATUS_RE, "");
  const boundary = afterStatus.search(LABEL_BOUNDARY_RE);
  const subject = boundary === -1
    ? afterStatus
    : afterStatus.slice(0, boundary);
  return subject.trim();
}

/** Worst of two statuses — `missing` > `partial` > `met`. */
function worseOf(a: CriterionStatus, b: CriterionStatus): CriterionStatus {
  const rank: Record<CriterionStatus, number> = {
    missing: 2,
    partial: 1,
    met: 0,
  };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Match each closure entry to the criterion it assesses, by subject words
 * rather than list position.
 *
 * An entry matches a criterion when one word set is a subset of the other.
 * Among the criteria an entry matches, only the one with the strictly
 * highest Jaccard similarity is assigned the entry; a tie across different
 * criteria leaves the entry unassigned (ambiguous). `unrequested` entries,
 * and entries whose subject has no words, are skipped. A criterion assigned
 * no entry is `undefined`; one assigned several takes their worst status.
 *
 * A `partial` or `missing` entry that matches nothing, or ties, is not
 * dropped: it is returned in `unassignedGaps` so the degraded-run guard can
 * still file a follow-up that names it (Issue #3128).
 *
 * @param criteria - The stated scope items, in issue order.
 * @param entries - The parsed closure-block entries, in summary order.
 */
export function matchClosureEntries(
  criteria: readonly string[],
  entries: readonly ClosureEntry[],
): {
  statuses: (CriterionStatus | undefined)[];
  unassignedGaps: { status: "partial" | "missing"; subject: string }[];
} {
  const criterionWords = criteria.map((c) => words(c));
  const assigned: (CriterionStatus | undefined)[] = criteria.map(() =>
    undefined
  );
  const unassignedGaps: { status: "partial" | "missing"; subject: string }[] =
    [];

  // SIMPLE-ON-PURPOSE: a quadratic scan over criteria x entries is fine here
  // — an issue states a handful of criteria, not hundreds.
  for (const entry of entries) {
    if (entry.status === "unrequested") continue;
    const subjectWordSet = words(subjectOf(entry));
    if (subjectWordSet.size === 0) continue;

    let bestScore = -1;
    let bestIndex = -1;
    let tied = false;
    for (let i = 0; i < criteria.length; i++) {
      const criterionWordSet = criterionWords[i]!;
      const isSubsetEitherWay = isSubsetOf(subjectWordSet, criterionWordSet) ||
        isSubsetOf(criterionWordSet, subjectWordSet);
      if (!isSubsetEitherWay) continue;
      const score = jaccard(subjectWordSet, criterionWordSet);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
        tied = false;
      } else if (score === bestScore) {
        tied = true;
      }
    }
    if (bestIndex === -1 || tied) {
      if (entry.status === "partial" || entry.status === "missing") {
        unassignedGaps.push({
          status: entry.status,
          subject: subjectOf(entry),
        });
      }
      continue;
    }

    const status = entry.status;
    const existing = assigned[bestIndex];
    assigned[bestIndex] = existing === undefined
      ? status
      : worseOf(existing, status);
  }

  return { statuses: assigned, unassignedGaps };
}

/**
 * One status per criterion, same order as `criteria`.
 *
 * Prefer {@link matchClosureEntries} when an unassigned `partial` or
 * `missing` entry must still be reported.
 */
export function matchClosureStatuses(
  criteria: readonly string[],
  entries: readonly ClosureEntry[],
): (CriterionStatus | undefined)[] {
  return matchClosureEntries(criteria, entries).statuses;
}

function isSubsetOf(a: Set<string>, b: Set<string>): boolean {
  for (const w of a) {
    if (!b.has(w)) return false;
  }
  return true;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
