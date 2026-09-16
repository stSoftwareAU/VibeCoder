/**
 * Read one pull request's title (Issue #2103, part of #2060).
 *
 * The PR-feedback and CI-fix processors ask Graft for a source bundle using
 * the PR title plus the feedback or failing-check text as the query, and
 * neither is handed a title by the scan that dispatched it. This is the one
 * place that fetches it, so the two paths cannot drift into asking GitHub two
 * different questions.
 *
 * The read is a plain `gh pr view --json title`, routed through the caller's
 * own `gh` runner so a test needs no network. A failure is returned as an
 * error rather than swallowed — the caller warns and proceeds with the text
 * alone, because the bundle is an accelerator and a missing title must not
 * fail a run.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Logger, Result } from "../types.ts";

/** Run a `gh` command and return its stdout. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/**
 * Read a pull request's title.
 *
 * @param repo - Repository in `owner/repo` format
 * @param prNumber - PR number
 * @param gh - `gh` runner (injectable so tests need no network)
 * @returns The title, or an error naming why it could not be read
 */
export async function readPrTitle(
  repo: string,
  prNumber: number,
  gh: GhCommandFn,
): Promise<Result<string>> {
  let raw: string;
  try {
    raw = await gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "title",
      "--jq",
      ".title",
    ]);
  } catch (error) {
    return {
      ok: false,
      error: new Error(
        `gh pr view --json title failed for ${repo}#${prNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }

  const title = raw.trim();
  if (title === "") {
    // An empty answer is not a title. Reporting it as one would hand Graft a
    // query that silently lost half its terms.
    return {
      ok: false,
      error: new Error(
        `gh pr view --json title returned nothing for ${repo}#${prNumber}`,
      ),
    };
  }
  return { ok: true, value: title };
}

/**
 * The PR title for a Graft query, or `undefined` with one warning line.
 *
 * The warn-and-drop step both PR processors need, in one place: a title that
 * cannot be read must not fail the run (the bundle is an accelerator), must
 * not be silently absent either, and must be dropped from the query rather
 * than interpolated as an empty line.
 *
 * @param options - Repo, PR number, `gh` runner and the warning sink
 * @returns The title, or `undefined` when it could not be read
 */
export async function prTitleForGraftQuery(options: {
  repo: string;
  prNumber: number;
  gh: GhCommandFn;
  logger: Pick<Logger, "warn">;
}): Promise<string | undefined> {
  const { repo, prNumber, gh, logger } = options;
  const title = await readPrTitle(repo, prNumber, gh);
  if (title.ok) return title.value;
  logger.warn(`Graft query is missing the PR title: ${title.error.message}`, {
    repo,
    prNumber,
  });
  return undefined;
}
