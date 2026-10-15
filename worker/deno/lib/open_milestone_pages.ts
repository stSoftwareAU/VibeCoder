/**
 * Bounded listing of a repository's open milestones (Issue #3609).
 *
 * `gh api repos/<repo>/milestones` returns GitHub's default page of 30
 * milestones, and the milestone-completion scan read only that page. Every
 * open milestone past the thirtieth was invisible to completion and deadlock
 * detection, so a repository with more than 30 open milestones silently
 * stopped completing them.
 *
 * These helpers request explicit pages of {@link MILESTONES_PER_PAGE} (the
 * GitHub REST maximum), stop on a short page, and cap the walk at
 * {@link MAX_MILESTONE_PAGES}. At the cap with a full last page the listing is
 * truncated: it logs a WARNING and returns what it read, so the scan still
 * handles the milestones it can see and the truncation stays visible — rather
 * than throwing and skipping the whole repository.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Page size requested per call — the GitHub REST maximum. */
export const MILESTONES_PER_PAGE = 100;

/**
 * Hard page cap. 10 pages x 100 = 1000 open milestones; a repository at that
 * bound may have later milestones left unhandled, with a WARNING.
 */
export const MAX_MILESTONE_PAGES = 10;

type GhFn = (args: string[]) => Promise<string>;

/** Build the `gh api` arguments for one explicit page of open milestones. */
export function buildOpenMilestonesPageArgs(
  repo: string,
  page: number,
): string[] {
  return [
    "api",
    `repos/${repo}/milestones?state=open&per_page=${MILESTONES_PER_PAGE}&page=${page}`,
  ];
}

/** Parse one page's response into a raw array, tolerating an empty body. */
function parsePage(raw: string, repo: string, page: number): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected a milestones array for ${repo} (page ${page}), got ${
        parsed === null ? "null" : typeof parsed
      }`,
    );
  }
  return parsed;
}

/**
 * Fetch every open milestone of a repository, bounded to
 * {@link MAX_MILESTONE_PAGES}.
 *
 * At the page cap with a full last page, the milestones read so far are
 * returned after a WARNING through `log`; the scan then handles those and the
 * rest wait for a later cycle.
 *
 * @returns the merged raw milestone objects, in GitHub's listing order.
 * @throws when a page cannot be fetched or parsed. A partial listing from a
 *   failed page is never returned, so a truncated read is not mistaken for a
 *   complete one.
 */
export async function fetchOpenMilestonePages(
  repo: string,
  ghFn: GhFn,
  log: (message: string) => void,
): Promise<unknown[]> {
  const milestones: unknown[] = [];
  for (let page = 1; page <= MAX_MILESTONE_PAGES; page++) {
    const pageMilestones = parsePage(
      await ghFn(buildOpenMilestonesPageArgs(repo, page)),
      repo,
      page,
    );
    milestones.push(...pageMilestones);
    if (pageMilestones.length < MILESTONES_PER_PAGE) return milestones;
    if (page === MAX_MILESTONE_PAGES) {
      log(
        `WARNING: ${repo} has at least ${
          MAX_MILESTONE_PAGES * MILESTONES_PER_PAGE
        } open milestones — the milestone completion scan read only the first ${MAX_MILESTONE_PAGES} pages; any later milestones are not handled this cycle (Issue #3609)`,
      );
    }
  }
  return milestones;
}
