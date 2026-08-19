/**
 * Productive-work detector (Issue #2476).
 *
 * Returns the most-recent "productive work" epoch for a repo. **Productive
 * work** is defined as any of the following observable outputs landing on the
 * repo:
 *
 *   1. a pull request being **opened** (`gh pr list --state all`, newest
 *      `createdAt`);
 *   2. a pull request being **merged** (`gh pr list --state merged`, newest
 *      `mergedAt`); or
 *   3. a commit being **pushed** to the default branch (`gh api
 *      repos/{repo}/commits`, newest committer date).
 *
 * The detector returns the MAX epoch across those three sources, so a repo is
 * considered to have produced work as recently as its most recent signal of
 * any kind. When no source yields a usable timestamp the detector returns
 * `null` ("no signal").
 *
 * This is the "productive work" half of the combined 8h liveness guard
 * (#2472). It is deliberately standalone — it has **no import dependency on
 * the liveness guard**, so it is buildable and testable on its own.
 *
 * ## Product decision — bot-authored work counts
 *
 * This is a *fleet-output* signal, not an attribution check: the question is
 * "did anything productive happen in this repo recently?", not "who did it?".
 * We therefore **count any author**, including bots (Dependabot, Renovate, the
 * Vibe Coder itself). A repo whose only recent activity is a merged Renovate
 * PR is still demonstrably alive. This is the one product decision in the
 * change and is flagged as such in the PR summary.
 *
 * ## Injection and failure handling
 *
 * Following the `repo_busy_for_idle_task.ts` injection conventions, both the
 * `gh` runner (`ghCommandFn`, default the production {@link runGhCommand}
 * retry wrapper) and the clock (`nowFn`, default Unix seconds) are injectable
 * so the unit path never touches a real clock or an unstubbed `gh`.
 *
 * Each source is queried independently and any failure — a rejected `gh`
 * call, a non-array payload, or malformed JSON — is treated as "no signal"
 * for that source alone. One broken source never sinks the others, and if
 * every source is empty or broken the result is `null`. Future-dated
 * timestamps (clock skew or garbage data) are discarded against `nowFn` so a
 * bogus future date cannot dominate the max and defeat a liveness guard.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { runGhCommand } from "./github.ts";

export interface LatestProductiveWorkEpochOptions {
  /** Target repository in `owner/repo` form. */
  repo: string;
  /** Injectable gh runner — defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Injectable clock returning Unix seconds — defaults to the system clock. */
  nowFn?: () => number;
}

export interface ProductiveWorkResult {
  /** The repository this result describes (`owner/repo`). */
  repo: string;
  /**
   * Unix seconds of the most-recent productive-work signal, or `null` when
   * no source produced a usable timestamp.
   */
  lastProductiveEpoch: number | null;
}

/** Shape of a single PR row from `gh pr list --json createdAt,mergedAt`. */
interface PrRow {
  createdAt?: string;
  mergedAt?: string;
}

/** Shape of a single commit from `gh api repos/{repo}/commits`. */
interface CommitRow {
  commit?: { committer?: { date?: string } };
}

/**
 * Parse an ISO-8601 timestamp to Unix seconds, returning `null` for any
 * missing or unparseable value.
 */
function isoToEpoch(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/**
 * Run one source query and extract a candidate epoch via `extract`. Any
 * failure (rejected gh call, malformed JSON, non-array payload) is swallowed
 * and reported as `null` so a single broken source never sinks the others.
 */
async function querySource(
  gh: (args: string[]) => Promise<string>,
  args: string[],
  extract: (rows: unknown[]) => number | null,
): Promise<number | null> {
  let raw: string;
  try {
    raw = await gh(args);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return extract(parsed);
}

/**
 * Compute the most-recent productive-work epoch for `opts.repo`.
 *
 * See the module doc comment for the definition of "productive work", the
 * bot-author product decision, and the failure-handling contract.
 */
export async function latestProductiveWorkEpoch(
  opts: LatestProductiveWorkEpochOptions,
): Promise<ProductiveWorkResult> {
  const gh = opts.ghCommandFn ?? runGhCommand;
  const now = opts.nowFn ?? (() => Math.floor(Date.now() / 1000));
  const repo = opts.repo;

  // Most-recent PR opened (any state, any author).
  const prCreated = querySource(
    gh,
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--limit",
      "1",
      "--json",
      "createdAt",
    ],
    (rows) => isoToEpoch((rows[0] as PrRow | undefined)?.createdAt),
  );

  // Most-recent PR merged (any author).
  const prMerged = querySource(
    gh,
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "merged",
      "--limit",
      "1",
      "--json",
      "mergedAt",
    ],
    (rows) => isoToEpoch((rows[0] as PrRow | undefined)?.mergedAt),
  );

  // Most-recent default-branch commit (any author). The commits endpoint
  // returns newest-first, so the head element is the latest commit.
  const commitPushed = querySource(
    gh,
    ["api", `repos/${repo}/commits`],
    (rows) =>
      isoToEpoch((rows[0] as CommitRow | undefined)?.commit?.committer?.date),
  );

  const candidates = await Promise.all([prCreated, prMerged, commitPushed]);

  const ceiling = now();
  const usable = candidates.filter(
    (e): e is number => e !== null && e <= ceiling,
  );

  return {
    repo,
    lastProductiveEpoch: usable.length > 0 ? Math.max(...usable) : null,
  };
}
