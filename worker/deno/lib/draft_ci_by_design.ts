/**
 * Which red checks on a draft PR cannot pass there (Issue #4951).
 *
 * A fleet draft runs no CI job (`if: ... !github.event.pull_request.draft`),
 * yet `gate` (`if: always()`) still runs and fails on purpose: every job it
 * needs is skipped. Handing that failure to the CI fixer wastes an agent run
 * per scan. A job that actually ran and failed on a draft is a real failure
 * and still goes to the fixer.
 *
 * Pure: the skipped-check read is injected, so the rule is testable without
 * `gh`.
 */

import type { JobNeedsMap } from "./workflow_job_needs.ts";

/** The fleet's required aggregator; it fails on every draft by design. */
export const DRAFT_BY_DESIGN_CHECK = "gate";

/**
 * Drop the red checks of a draft that cannot pass there: `gate`, or a check
 * whose `needs:` (per `jobNeeds`) were all skipped on this head.
 *
 * `readSkippedNames` is called at most once, and only when a non-`gate` red
 * check has `needs:` to judge. A check with no `needs:` entry (or an empty
 * one) is never by design: with nothing to skip, it ran on its own merits.
 *
 * @param redChecks The draft's red checks.
 * @param jobNeeds The `needs:` topology, or `null` when there is no clone.
 * @param readSkippedNames Names of the head's skipped checks.
 * @returns The red checks that are real failures.
 */
export async function dropDraftByDesignFailures<T extends { name: string }>(
  redChecks: readonly T[],
  jobNeeds: JobNeedsMap | null,
  readSkippedNames: () => Promise<ReadonlySet<string>>,
): Promise<T[]> {
  const kept: T[] = [];
  let skipped: ReadonlySet<string> | undefined;
  for (const check of redChecks) {
    if (check.name === DRAFT_BY_DESIGN_CHECK) continue;
    const needs = jobNeeds?.get(check.name) ?? [];
    if (needs.length > 0) {
      skipped ??= await readSkippedNames();
      if (needs.every((need) => skipped!.has(need))) continue;
    }
    kept.push(check);
  }
  return kept;
}
