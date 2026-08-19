/**
 * Priority-ordered finding capper for the best-practices idle-task
 * template (Issue #2148, parent #2143).
 *
 * The best-practices scan can produce many candidate findings across
 * several severities; only the top `max` (default 6) are reported in a
 * single run. The capper is a pure, side-effect-free helper so its
 * priority semantics can be unit-tested in isolation from the surrounding
 * orchestration and from GitHub I/O.
 *
 * Priority order (highest first):
 *
 *   1. `missing-linter` — a synthetic finding raised when
 *      `checkLinterInCI()` reports the bucket's standard linter is not
 *      wired into a CI workflow. Always lands first because a missing
 *      CI gate enables every other class of regression.
 *   2. `high`           — severity:high findings from the orchestrating
 *      Claude run.
 *   3. `medium`         — severity:medium findings.
 *   4. `low`            — severity:low findings.
 *
 * Within the same priority bucket the original input order is preserved
 * (stable sort) — the issue spec is explicit that "within the same
 * priority preserve the order Claude emitted".
 *
 * Australian English used throughout (behaviour, organisation).
 */

/**
 * Finding severity bands used by the best-practices template.
 *
 * `missing-linter` is the synthetic top-priority severity — it is not
 * emitted by Claude itself; the template injects it when the linter
 * pre-check (`checkLinterInCI()`) fails for a language-targeted run.
 */
export type Severity = "missing-linter" | "high" | "medium" | "low";

/** Single candidate finding flowing through the capper. */
export interface Finding {
  /** Stable `BP-<12 hex>` id (or `BP-LINTER-<bucket>` for missing-linter). */
  id: string;
  /** Severity band — drives priority ordering. */
  severity: Severity;
  /** Human-readable finding title (used verbatim as the issue title). */
  title: string;
  /** Markdown finding body (used verbatim as the issue body). */
  body: string;
}

/**
 * Numeric priority for each severity. Lower = higher priority. Exposed
 * so callers (and tests) can reason about the ordering without
 * duplicating the table.
 */
export const SEVERITY_PRIORITY: Readonly<Record<Severity, number>> = {
  "missing-linter": 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Sort `findings` by priority and return the first `max` entries.
 *
 * The sort is stable: two findings of the same severity retain their
 * input order, so a caller emitting `[high-A, high-B, medium-C]` always
 * sees the same relative order after capping.
 *
 * The input array is **not** mutated — the function builds a fresh
 * sorted projection and slices it.
 *
 * @param findings Candidate findings to cap.
 * @param max Maximum number of findings to keep. Values `<= 0` produce
 *   an empty array; values larger than `findings.length` return every
 *   finding in sorted order.
 * @returns A new array of at most `max` findings, priority-ordered.
 */
export function cap(findings: Finding[], max: number): Finding[] {
  if (max <= 0) return [];
  // Index-tagged stable sort: tie-break by original position so equal
  // severities preserve emission order.
  const indexed = findings.map((f, i) => ({ f, i }));
  indexed.sort((a, b) => {
    const sa = SEVERITY_PRIORITY[a.f.severity];
    const sb = SEVERITY_PRIORITY[b.f.severity];
    if (sa !== sb) return sa - sb;
    return a.i - b.i;
  });
  return indexed.slice(0, max).map(({ f }) => f);
}
