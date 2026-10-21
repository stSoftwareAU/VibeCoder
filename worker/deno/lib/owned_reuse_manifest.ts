/**
 * The owned-reuse cap's scanner and manifest (Issue #3854).
 *
 * A dedup hit may suppress a filing; only an owned, open match may be reused
 * or written to. A `reused` outcome says the worker took an existing artefact
 * instead of filing one, so a module that produces that outcome without
 * finding the artefact through an owned lookup is a bypass. This file
 * classifies source text; `tests/owned_reuse_cap_test.ts` holds the tree to
 * the manifests below, in both directions.
 *
 * Australian English spelling used throughout.
 */

/** Helpers that find an owned, open artefact; a module that calls one is exempt. */
const OWNED_LOOKUP_HELPERS = [
  "findOwnedOpenArtefact",
  "findOpenMilestoneFixPr",
  "findOpenIssueByFindingId",
];

// A call to a helper; a declaration of one is not a call, so `function` is excluded.
const OWNED_LOOKUP_CALL = new RegExp(
  `(?<!function\\s+)\\b(?:${OWNED_LOOKUP_HELPERS.join("|")})\\s*\\(`,
);

// A "reused" string, or one ending in -reused, in double, single or backtick quotes.
const REUSED_LITERAL = /(["'`])(?:[\w-]*-)?reused\1/g;

// A `reused: true` field on an outcome object.
const REUSED_FIELD = /\breused\s*:\s*true\b/;

// Equality operators either side of the literal mark a consumer that compares.
const COMPARISON_BEFORE = /(?:===|!==|==|!=)\s*$/;
const COMPARISON_AFTER = /^\s*(?:===|!==|==|!=)/;

// A line that is only a comment, so its prose is not a producer.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

function isComparisonOperand(
  line: string,
  start: number,
  end: number,
): boolean {
  return COMPARISON_BEFORE.test(line.slice(0, start)) ||
    COMPARISON_AFTER.test(line.slice(end));
}

function lineHasProducer(line: string): boolean {
  for (const match of line.matchAll(REUSED_LITERAL)) {
    if (
      !isComparisonOperand(
        line,
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      )
    ) {
      return true;
    }
  }
  return REUSED_FIELD.test(line);
}

/**
 * Finds the lines in a module that produce a `reused` outcome with no owned lookup.
 *
 * @param source - The module's source text
 * @returns 1-based line numbers of producers; `[]` when the module calls an
 *   owned lookup helper, so it is exempt
 */
export function findUnownedReuseSites(source: string): number[] {
  // A module that calls an owned lookup is where the check lives, so it is exempt.
  if (OWNED_LOOKUP_CALL.test(source)) return [];
  const sites: number[] = [];
  source.split("\n").forEach((line, index) => {
    if (COMMENT_LINE.test(line)) return;
    if (lineHasProducer(line)) sites.push(index + 1);
  });
  return sites;
}

/**
 * Files, relative to `worker/deno`, that produce a `reused` outcome without an
 * owned lookup. Shrink-only: a fixed file is removed, a new one is a failure.
 */
export const OWNED_REUSE_UNVERIFIED_FILES: readonly string[] = [
];

/**
 * Exempt files whose `reused` string is not an artefact reuse, each with the
 * reason. The cap test fails an entry that no longer holds a producer.
 */
export const OWNED_REUSE_NOT_ARTEFACT_FILES: Record<string, string> = {
  "commands/suggest_improvements.ts":
    "tallies routed outcomes by action; it counts the reused result from lib/issue_routing_filing.ts and reuses nothing itself",
  "lib/lifecycle_ledger.ts":
    "the reused flag records whether a lifecycle experiment assignment was reused; it is not an issue or PR",
  "lib/phases/execute_phase.ts":
    "logs whether a lifecycle experiment assignment was reused; it is not an issue or PR",
  "lib/pr_merge_conflict_processor.ts":
    "switch case on the fix-pr-reused outcome that lib/conflict_takeover.ts produces after findOpenMilestoneFixPr; it does not decide reuse",
};
