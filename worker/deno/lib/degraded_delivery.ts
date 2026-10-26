/**
 * Scope assessment: which of an issue's accepted criteria a PR summary shows
 * as delivered, and which it does not (Issues #2562, #3128).
 *
 * Pure. It reads the issue's accepted scope (`## Acceptance criteria`, or the
 * grill-me `### Accepted scope so far` / `Done when` lists) and the PR body's
 * closure block, matches entries to criteria by their words, not by their
 * position (Issue #3128), and reports every criterion short of `met`.
 *
 * Its consumers decide what a shortfall means:
 *
 * - `unmet_criteria_gate.ts` (Issue #4146): any unmet criterion blocks the PR,
 *   and the run keeps working until every criterion is met. This replaced the
 *   degraded-delivery guard (#2562, #3506), which raised the partial PR anyway
 *   and filed a `Finish #N` follow-up for the rest — the owner ruled that
 *   "partially completed" is never a resolution.
 * - `claim_freshness.ts`: a merged PR that still shows shortfalls does not
 *   count as having delivered the issue.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type ClosureEntry,
  extractAcceptedScope,
  parseClosureEntries,
} from "./acceptance_criteria_gate.ts";
import {
  gapSubject,
  matchClosureEntries,
  subjectOf,
} from "./closure_criterion_match.ts";

/** Why a scope item counts as not delivered. */
export type ShortfallStatus = "partial" | "missing" | "unassessed";

/** One shortfall: a scope item not shown as met, or an unmatched gap the closure block reported. */
export interface DegradedShortfall {
  /**
   * The scope item, as the issue states it. A gap the closure block left
   * unmatched carries the entry's own subject instead — its `reason:` when
   * that subject has no words.
   */
  criterion: string;
  /** `partial`/`missing` as the summary said, or `unassessed` when it said nothing. */
  status: ShortfallStatus;
}

/** Stand-in scope item for an issue that states no criteria or scope. */
export const UNSTATED_SCOPE_ITEM =
  "The issue as written — it states no acceptance criteria or accepted scope, " +
  "so the whole body needs checking against what this PR delivered";

// Deliberately narrow: unknown words keep a gap actionable. In particular,
// unknown implementation or tooling details remain actionable in legacy entries.
const MERGE_CHECK_WORDS = new Set(
  "ci quality sh gate gates check checks required clean code review independent routine pass passes passing green and the all must be is are before merge merging verified verification execution not yet pending awaiting run runs ran executed complete completed only still on pr a this will locally has been"
    .split(" "),
);

function mergeCheckWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function isMergeCheckOnly(text: string): boolean {
  const words = mergeCheckWords(text);
  return words.some((word) => ["ci", "quality", "review"].includes(word)) &&
    words.every((word) => MERGE_CHECK_WORDS.has(word));
}

/** Current check results in evidence; a later clean result supersedes its failure. */
function hasFailedMergeCheck(evidence: string): boolean {
  const failed = new Map<string, boolean>();
  const declarations = evidence.matchAll(
    /(?:^|[;.—]\s*)((?:(?:required|local|all|unit|integration)\s+)?(?:CI(?:\s+checks?)?|quality(?:\s+gates?)?|gates?|(?:(?:clean|code|independent)\s+)?reviews?|tests?))\s*:?\s*(?:(?:is|are|was|were|has|have|now|still|currently)\s+)*(failed|failing|broken|not (?:clean|green|passing)|rejected|blocking findings?|passed|pass|passing|clean|green|fixed|resolved)\b/gi,
  );
  for (const match of declarations) {
    const name = match[1]!.toLowerCase();
    const check = name.includes("review")
      ? "review"
      : name.includes("test")
      ? name.replace(/^(?:required|local|all)\s+/, "").replace(
        /tests?$/,
        "tests",
      )
      : name.includes("quality") || name.includes("gate")
      ? "quality"
      : "ci";
    failed.set(
      check,
      !/^(?:passed|pass|passing|clean|green|fixed|resolved)$/i.test(match[2]!),
    );
  }
  return [...failed.values()].some(Boolean);
}

/** Pending merge checks are visible in the summary, not unfinished work. */
export function isPendingMergeCheck(entry: ClosureEntry): boolean {
  if (entry.status !== "partial" && entry.status !== "missing") return false;
  const evidence = entry.text.match(
    /\bevidence\s*[:—-]\s*([\s\S]*?)(?:\s+[—-]\s+(?:reviewer|reason|remaining)\s*[:—-]|$)/i,
  )?.[1] ?? "";
  if (hasFailedMergeCheck(evidence)) return false;
  // A mixed criterion can have completed product work and only verification
  // left. The generator states that explicitly while retaining its partial
  // closure status; CI/review/acceptance gates still judge the original entry.
  if (
    /\breason:\s*(?:CI not yet verified|awaiting code review|quality gate not yet run)\s*[—-]\s*remaining:\s*merge-verification-only\s*$/i
      .test(entry.text)
  ) return true;
  const subject = subjectOf(entry);
  const reason = entry.text.match(/\breason\s*[:\-—]\s*([\s\S]+)$/i)?.[1] ?? "";
  return isMergeCheckOnly(subject) &&
    /^(?:(?:required )?CI (?:(?:is |still )?pending|not yet verified)|awaiting (?:independent |clean )?code review|(?:required )?quality (?:gate )?(?:not yet (?:run|executed|complete|completed)|pending)|(?:clean )?code review pending)[.!]?$/i
      .test(reason.trim());
}

/**
 * Match the issue's accepted scope against the PR body's closure block: which
 * items are delivered (`met`) and which are shortfalls. Pure, and independent
 * of how the run was routed, so a PR-body re-sync can re-run it (Issue #3350).
 */
export function assessScopeShortfalls(
  issueBody: string,
  prBody: string,
): { delivered: string[]; shortfalls: DegradedShortfall[] } {
  const stated = extractAcceptedScope(issueBody);
  const parsed = parseClosureEntries(prBody);
  const pending = parsed.filter(isPendingMergeCheck);
  const entries = parsed.filter((entry) => !isPendingMergeCheck(entry));

  if (stated.length === 0) {
    // An issue that states no scope has no criterion to match, so every entry
    // is unassigned (PR #3676 review). Each `met` entry is what the run says it
    // delivered, and each `partial` or `missing` entry is a shortfall named by
    // its own subject, so a degraded run keeps the gap it reported.
    const { unassignedGaps } = matchClosureEntries([], entries);
    return {
      delivered: entries
        .filter((entry) => entry.status === "met")
        .map((entry) => gapSubject(entry)),
      shortfalls: [
        { criterion: UNSTATED_SCOPE_ITEM, status: "unassessed" },
        ...unassignedGaps.map((gap) => ({
          criterion: gap.subject,
          status: gap.status,
        })),
      ],
    };
  }

  // Closure entries are matched to criteria by their words, not by list
  // position (Issue #3128): an entry that matches no criterion, or more than
  // one equally well, assesses nothing, so its criterion is `unassessed`; a
  // criterion split across several entries takes their worst status. A
  // `partial` or `missing` entry left unassigned is still a shortfall, named
  // by its own subject, so a paraphrased gap is not dropped.
  const match = matchClosureEntries(stated, entries);

  const delivered: string[] = [];
  const shortfalls: DegradedShortfall[] = [];
  stated.forEach((criterion, index) => {
    const status = match.statuses[index];
    if (status === "met") {
      delivered.push(criterion);
    } else if (status === "partial" || status === "missing") {
      shortfalls.push({ criterion, status });
    } else {
      if (
        isMergeCheckOnly(criterion) &&
        matchClosureEntries([criterion], pending).statuses[0] !== undefined
      ) return;
      shortfalls.push({ criterion, status: "unassessed" });
    }
  });
  for (const gap of match.unassignedGaps) {
    shortfalls.push({ criterion: gap.subject, status: gap.status });
  }

  return { delivered, shortfalls };
}
