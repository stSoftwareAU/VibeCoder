/**
 * Dependency-audit check classifier (Issue #3141, parent #3116).
 *
 * A failing dependency audit names a vulnerable package the pull request can
 * fix itself — bump it, or replace it — so the worker must never defer one to
 * the base branch on a `Depends on` line. A deferral charges no attempt and
 * adds no `needs-human`, so an unfixed advisory deferred that way could park
 * every open pull request without anyone seeing it.
 *
 * Pure: no I/O, so the CI-fix processor and the review skill share one
 * definition of "this is a dependency audit".
 */

/**
 * A security advisory ID: `GHSA-xxxx-xxxx-xxxx` (GitHub) or
 * `RUSTSEC-YYYY-NNNN` (RustSec). Not global, so `exec` always returns the
 * first ID in the text without carrying `lastIndex` between calls.
 */
export const ADVISORY_ID_PATTERN =
  /\b(?:GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|RUSTSEC-\d{4}-\d{4})\b/;

/** `audit` as a whole word, so `cargo audit` matches and `auditor-ui` does not. */
const AUDIT_NAME_PATTERN = /\baudit\b/i;

/**
 * Is this failing check a dependency audit?
 *
 * @param checkName - The failing check's name, e.g. `audit (Deno Audit)`.
 * @param failureText - The failure's annotations and log excerpt; pass `""`
 *   when only the name is known.
 * @returns True when the name contains `audit` as a whole word
 *   (case-insensitive), or the failure text names a GHSA or RUSTSEC advisory.
 */
export function isDependencyAuditCheck(
  checkName: string,
  failureText: string,
): boolean {
  return AUDIT_NAME_PATTERN.test(checkName) ||
    ADVISORY_ID_PATTERN.test(failureText);
}
