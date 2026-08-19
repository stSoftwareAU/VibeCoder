/**
 * Native GitHub sub-issue enumeration (Issue #2900).
 *
 * Planning links each sub-issue it creates to the parent via GitHub's native
 * sub-issue relationship. That link is the authoritative record of "the
 * sub-issues this planning run produced" — it is tracked by GitHub itself and
 * survives any formatting quirk in Claude's output.
 *
 * The auto-milestone path (Issue #2863) previously derived the sub-issue set
 * solely from text-extracted issue URLs in Claude's output
 * (`extractSubIssueNumbers`). When that extraction missed the URLs — Claude
 * printed them in an unexpected shape, or the run closed via a recovery path —
 * the auto-milestone saw fewer than two sub-issues and silently skipped, so the
 * sub-issues kept their default branch as the PR base instead of the milestone
 * feature branch (the symptom reported in #2900).
 *
 * This helper reads the native sub-issue list straight from the GitHub API so
 * the milestone assignment no longer depends on fragile text extraction. It is
 * best-effort: any failure (network, malformed JSON, no sub-issues endpoint)
 * yields an empty list and the caller falls back to the text-extracted numbers.
 *
 * Australian English spelling used throughout.
 */

/**
 * Fetch the issue numbers of a parent issue's native GitHub sub-issues.
 *
 * Returns the sub-issue numbers sorted ascending and de-duplicated. Best-effort:
 * on any error or malformed response the result is an empty array — the caller
 * treats "no native sub-issues found" the same as "the endpoint was
 * unavailable" and falls back to its other sources.
 *
 * @param repo - Repository in `owner/repo` form.
 * @param parentIssueNumber - The parent (planning) issue number.
 * @param ghCommandFn - Injectable gh runner (`gh api ...`).
 */
export async function fetchNativeSubIssueNumbers(
  repo: string,
  parentIssueNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<number[]> {
  // Validate inputs defensively — a malformed repo or non-positive issue
  // number can never have native sub-issues, so skip the API call entirely.
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return [];
  if (!Number.isInteger(parentIssueNumber) || parentIssueNumber <= 0) return [];

  let raw: string;
  try {
    raw = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${parentIssueNumber}/sub_issues?per_page=100`,
    ]);
  } catch {
    return [];
  }

  return parseNativeSubIssueNumbers(raw);
}

/**
 * Parse the sub-issue numbers from a `sub_issues` API response body.
 *
 * Exported for direct unit testing. A malformed or non-array body yields an
 * empty array.
 */
export function parseNativeSubIssueNumbers(raw: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const numbers = new Set<number>();
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const n = (entry as Record<string, unknown>).number;
    if (typeof n === "number" && Number.isInteger(n) && n > 0) {
      numbers.add(n);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}
