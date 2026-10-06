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
/**
 * Validate a `repo`/`parentIssueNumber` pair the way every native sub-issue
 * reader needs to: a malformed slug or non-positive number can never have
 * native sub-issues, so the caller skips the API call entirely.
 */
function isValidSubIssueQuery(
  repo: string,
  parentIssueNumber: number,
): boolean {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return false;
  if (!Number.isInteger(parentIssueNumber) || parentIssueNumber <= 0) {
    return false;
  }
  return true;
}

export async function fetchNativeSubIssueNumbers(
  repo: string,
  parentIssueNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<number[]> {
  if (!isValidSubIssueQuery(repo, parentIssueNumber)) return [];

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

/**
 * A native sub-issue, with the repository that owns it (Issue #3319).
 *
 * A sub-issue can live in a different repository from its parent — GitHub's
 * native relationship is not confined to one repo — so `checkParentBlocked`
 * must resolve each child against its *own* repo, not the parent's.
 */
export interface SubIssueRef {
  /** The child issue's own `owner/repo`, independent of the parent's. */
  repo: string;
  /** The child issue number, within `repo`. */
  number: number;
}

/** Anchored on the end of the URL so no overlapping quantifier can backtrack. */
const REPOSITORY_URL_OWNER_NAME = /\/repos\/([^/\s]+)\/([^/\s]+)$/;

/**
 * Parse `owner/repo` out of a `repository_url`, falling back to `parentRepo`
 * when it is absent or does not match the expected shape.
 */
function repoFromRepositoryUrl(
  repositoryUrl: unknown,
  parentRepo: string,
): string {
  if (typeof repositoryUrl !== "string") return parentRepo;
  const match = REPOSITORY_URL_OWNER_NAME.exec(repositoryUrl);
  if (!match) return parentRepo;
  return `${match[1]}/${match[2]}`;
}

/**
 * Parse sub-issue refs from a `gh api --paginate --jq '[…]'` sub_issues read.
 *
 * `--paginate` applies the `--jq` filter per page, so the payload is one JSON
 * array per line (see {@link parseMarkerCommentPages} in
 * `marker_comment_pages.ts`, which this follows) — `--slurp`, which would
 * merge them into one array, is refused alongside `--jq`. A malformed line
 * throws: an unreadable page is a failure the caller must handle.
 *
 * Each child's own repo comes from its `repository_url`; a sub-issue in
 * another repository is not renumbered against `parentRepo`. Entries are
 * de-duplicated on `repo#number` (case-insensitive on the repo), keeping the
 * first-seen repo spelling, and sorted by repo (case-insensitive) then
 * number.
 *
 * @param payload - Raw stdout from the paginated sub_issues read.
 * @param parentRepo - The parent's own `owner/repo`, used as the fallback
 *   repo when an entry's `repository_url` is missing or malformed.
 */
export function parseNativeSubIssueRefPages(
  payload: string,
  parentRepo: string,
): SubIssueRef[] {
  const seen = new Map<string, SubIssueRef>();

  for (const line of payload.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error(`sub_issues page was not a JSON array: ${trimmed}`);
    }

    for (const entry of parsed) {
      if (entry === null || typeof entry !== "object") continue;
      const n = (entry as Record<string, unknown>).number;
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) continue;
      const repo = repoFromRepositoryUrl(
        (entry as Record<string, unknown>).repository_url,
        parentRepo,
      );
      const key = `${repo.toLowerCase()}#${n}`;
      if (!seen.has(key)) seen.set(key, { repo, number: n });
    }
  }

  return [...seen.values()].sort((a, b) => {
    const repoCmp = a.repo.toLowerCase().localeCompare(b.repo.toLowerCase());
    if (repoCmp !== 0) return repoCmp;
    return a.number - b.number;
  });
}

/**
 * Fetch a parent issue's native GitHub sub-issues, each with its own repo
 * (Issue #3319).
 *
 * Unlike {@link fetchNativeSubIssueNumbers}, this paginates explicitly
 * (`per_page=100`, `--paginate`) rather than relying on a single
 * `per_page=100` request — a parent with more than 100 children would
 * otherwise silently lose the rest. Invalid inputs (malformed slug or
 * non-positive issue number) return `[]`, matching the existing helper; a
 * `gh` failure, blank output or unparseable page throws, so a caller that
 * must not treat "the read failed" the same as "there are no sub-issues"
 * can tell them apart (Issue #3321).
 *
 * @param repo - Repository in `owner/repo` form.
 * @param parentIssueNumber - The parent issue number.
 * @param ghCommandFn - Injectable gh runner (`gh api ...`).
 */
export async function fetchNativeSubIssueRefs(
  repo: string,
  parentIssueNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<SubIssueRef[]> {
  if (!isValidSubIssueQuery(repo, parentIssueNumber)) return [];

  let raw: string;
  try {
    raw = await ghCommandFn([
      "api",
      `repos/${repo}/issues/${parentIssueNumber}/sub_issues?per_page=100`,
      "--paginate",
      "--jq",
      "[.[] | {number: .number, repository_url: .repository_url}]",
    ]);
  } catch (error) {
    throw new Error(
      `sub_issues lookup for ${repo}#${parentIssueNumber} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Issue #3321: a genuine "no sub-issues" page still carries the jq
  // filter's `[]` text, so blank stdout means the runner failed (or
  // returned nothing) rather than that the parent has no children. Treat
  // it as a failure instead of reading it as "not blocked".
  // Issue #3321: a genuine "no sub-issues" page still carries the jq
  // filter's `[]` text, so blank stdout means the runner failed (or
  // returned nothing) rather than that the parent has no children. Treat
  // it as a failure instead of reading it as "not blocked".
  if (raw.trim() === "") {
    throw new Error(
      `sub_issues lookup for ${repo}#${parentIssueNumber} returned empty output`,
    );
  }

  try {
    return parseNativeSubIssueRefPages(raw, repo);
  } catch (error) {
    throw new Error(
      `sub_issues lookup for ${repo}#${parentIssueNumber} returned unparseable output: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
