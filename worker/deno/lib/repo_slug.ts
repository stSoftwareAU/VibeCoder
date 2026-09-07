/**
 * Canonical `owner/repo` slug validation (Issues #2692, #1291).
 *
 * The pattern lives in its own module so the setup CLI can apply the same
 * guard the worker's config loader applies without importing the worker's
 * whole configuration graph. `lib/config.ts` re-exports
 * {@link REPO_SLUG_PATTERN}, so every existing importer is unchanged.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/**
 * Pattern matching a valid GitHub `owner/repo` slug.
 *
 * Each segment must begin with an alphanumeric, underscore, or hyphen —
 * never a dot. This rejects path-traversal and dot-only segments such as
 * `owner/..`, `owner/.`, or `../x` (Issue #2692): the slug is derived into
 * a filesystem path by `setupRepo()` and by the setup CLI's
 * `syncGitignoreForAllRepos()`, so a `..` segment would otherwise steer
 * writes above `WORK_DIR`. GitHub slugs never legitimately start with a
 * dot, so the constraint costs no valid input.
 */
export const REPO_SLUG_PATTERN =
  /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;

/** True when `repo` is a string in valid `owner/repo` form. */
export function isValidRepoSlug(repo: unknown): repo is string {
  return typeof repo === "string" && REPO_SLUG_PATTERN.test(repo);
}

/**
 * Render an untrusted slug inert for display in an error message, a log
 * line, or an issue body.
 *
 * A rejected slug still has to be *reported* — dropping it silently is the
 * failure mode this guard exists to prevent — but it must not carry shell or
 * Markdown metacharacters into the text that reports it (Issue #1291: the
 * precheck issue body is pasted into a repo admin's shell). Everything
 * outside the slug alphabet becomes `?`.
 */
export function renderInertRepoSlug(repo: unknown): string {
  const raw = typeof repo === "string" ? repo : String(repo);
  const clipped = raw.length > 80 ? `${raw.slice(0, 80)}...` : raw;
  const inert = clipped.replace(/[^A-Za-z0-9._/-]/g, "?");
  return inert === "" ? "(empty)" : inert;
}

/** Split a slug list into the entries that pass the guard and those that do not. */
export function partitionRepoSlugs(
  repos: readonly unknown[],
): { valid: string[]; invalid: unknown[] } {
  const valid: string[] = [];
  const invalid: unknown[] = [];
  for (const repo of repos) {
    if (isValidRepoSlug(repo)) valid.push(repo);
    else invalid.push(repo);
  }
  return { valid, invalid };
}

/**
 * Assert every entry of `repos` is a valid slug, throwing an error that names
 * each rejected entry (rendered inert) and where it came from.
 *
 * @param repos - The candidate slugs.
 * @param source - Human-readable origin, e.g. `VIBE_REPOS` or the config path.
 * @returns The validated slugs, so callers can assign the result directly.
 * @throws When any entry fails {@link REPO_SLUG_PATTERN}.
 */
export function assertValidRepoSlugs(
  repos: readonly unknown[],
  source: string,
): string[] {
  const { valid, invalid } = partitionRepoSlugs(repos);
  if (invalid.length > 0) {
    const rendered = invalid.map((repo) => `"${renderInertRepoSlug(repo)}"`)
      .join(", ");
    throw new Error(
      `Invalid repository slug(s) in ${source}: ${rendered}. ` +
        "Repositories must be in owner/repo format, and neither segment may " +
        "start with a dot. Fix the entry rather than removing the guard.",
    );
  }
  return valid;
}

/** One `repos` entry dropped as a case-variant, and the entry it duplicates. */
export interface DuplicateRepoSlug {
  /** The spelling that was kept — the first occurrence, in list order. */
  kept: string;
  /** The later spelling that was ignored. */
  dropped: string;
}

/** Outcome of {@link dedupeRepoSlugs}. */
export interface RepoSlugDedupResult {
  /** The de-duplicated list, in input order, in the first-seen spelling. */
  repos: string[];
  /** Every dropped entry, in input order. Callers must report these. */
  duplicates: DuplicateRepoSlug[];
}

/**
 * De-duplicate a `repos` list case-insensitively (Issue #1546).
 *
 * GitHub repository names are case-insensitive, so `owner/Repo` and
 * `owner/repo` are one repository. A `.config.json` listing both ran every
 * per-repository scan twice and let the two slots of one worker race each
 * other for the same issue, while anything keyed by the configured spelling
 * — watermarks, caches, the write-repo allowlist — forked into two states
 * that could disagree.
 *
 * The first spelling wins, because it is the one the operator's file already
 * established elsewhere. Dropped entries are returned rather than swallowed:
 * the operator's file has a defect worth naming.
 *
 * @param repos - The configured slugs, in file order.
 */
export function dedupeRepoSlugs(
  repos: readonly string[],
): RepoSlugDedupResult {
  const kept: string[] = [];
  const duplicates: DuplicateRepoSlug[] = [];
  const seen = new Map<string, string>();

  for (const repo of repos) {
    const key = repo.trim().toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      duplicates.push({ kept: first, dropped: repo });
      continue;
    }
    seen.set(key, repo);
    kept.push(repo);
  }

  return { repos: kept, duplicates };
}

/**
 * The operator-facing sentence for one dropped duplicate.
 *
 * Both spellings are rendered inert ({@link renderInertRepoSlug}) because the
 * warning is written to logs and to setup output, and a `repos` entry is
 * operator-supplied text.
 */
export function duplicateRepoSlugWarning(
  duplicate: DuplicateRepoSlug,
): string {
  const dropped = renderInertRepoSlug(duplicate.dropped);
  const kept = renderInertRepoSlug(duplicate.kept);
  // An identical entry is the same defect with a different cause, and
  // "duplicates itself" would misdescribe it.
  if (dropped === kept) {
    return `repos: "${kept}" is listed twice — ignoring the second`;
  }
  return `repos: "${dropped}" duplicates "${kept}" (GitHub repository names ` +
    "are case-insensitive) — ignoring the second";
}
