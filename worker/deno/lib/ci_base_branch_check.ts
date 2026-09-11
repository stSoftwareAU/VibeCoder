/**
 * Is the same check already red on the pull request's base branch?
 * (Issue #1880, parent #1861.)
 *
 * When the CI-fix agent reports the failure as pre-existing on the base
 * branch, the worker must not take its word for it: a `Depends on
 * owner/repo#N` line is agent prose, and a deferral spends no attempt, so an
 * unverified one would park a pull request that a fix could still rescue.
 * This module is the verification — it asks GitHub what the *base branch's*
 * latest run of that same check concluded.
 *
 * Two properties it exists to hold:
 *
 * - **An error is never a `false`.** A failed API call, an unparseable body
 *   or a malformed payload returns an error, not "the base is green". The
 *   caller then falls through to the ordinary path and charges an attempt
 *   rather than deferring on a reading it never got.
 * - **The latest run wins.** A check re-run after an earlier failure is the
 *   current answer, so the runs are filtered by name and the highest id — the
 *   most recently created run — decides. An earlier red left in the list does
 *   not outvote a green re-run.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";

/** One check run, as the REST payload names it. */
interface BranchCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

/** Inputs for {@link isCheckRedOnBranch}. */
export interface IsCheckRedOnBranchOptions {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** Branch to read — the pull request's base ref. */
  branch: string;
  /** Name of the check to look for, compared exactly. */
  checkName: string;
  /** Runs a `gh` command — injected so tests make no live call. */
  ghCommandFn: (args: string[]) => Promise<string>;
}

/** The conclusion that counts as red. */
const FAILURE_CONCLUSION = "failure";

/**
 * Does the base branch's latest completed run of `checkName` conclude
 * `failure`?
 *
 * Reads `repos/{repo}/commits/{branch}/check-runs` — the same REST shape
 * `direct_merge.ts` consumes — and filters by name in this process rather
 * than through the API's `check_name` parameter, so one payload answers for
 * a name containing any character a query string would have to escape.
 *
 * @param options - Repo, branch, check name and the `gh` runner.
 * @returns `true` when the latest completed run of that check on that branch
 *   failed; `false` when it did not, or when the branch has no completed run
 *   of that check at all. An API or parse failure is an error, never `false`.
 */
export async function isCheckRedOnBranch(
  options: IsCheckRedOnBranchOptions,
): Promise<Result<boolean>> {
  const { repo, branch, checkName, ghCommandFn } = options;

  let raw: string;
  try {
    raw = await ghCommandFn([
      "api",
      // `per_page=100` rather than the default 30: a base head with many
      // checks would otherwise leave the one being verified off page one and
      // read as "not red", charging an attempt against a failure this branch
      // could never fix.
      `repos/${repo}/commits/${branch}/check-runs?per_page=100`,
      "--jq",
      "{check_runs: [.check_runs[] | {id, name, status, conclusion}]}",
    ]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(
        `Failed to read check runs for ${repo}@${branch}: ${message}`,
      ),
    };
  }

  let runs: BranchCheckRun[];
  try {
    runs = parseCheckRuns(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(
        `Failed to parse check runs for ${repo}@${branch}: ${message}`,
      ),
    };
  }

  const latest = latestCompletedRun(runs, checkName);
  if (latest === undefined) return { ok: true, value: false };
  return { ok: true, value: latest.conclusion === FAILURE_CONCLUSION };
}

/**
 * Read the check-run rows out of the API body.
 *
 * Every row is validated rather than cast: an id that is not a number could
 * not be ordered, and a missing name could not be matched, so a payload that
 * is not the documented shape is an error the caller sees.
 *
 * @param raw - The raw response body.
 * @returns The well-formed rows.
 * @throws When the body is not JSON, or carries no `check_runs` array.
 */
function parseCheckRuns(raw: string): BranchCheckRun[] {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("response is not an object");
  }
  const list = (parsed as { check_runs?: unknown }).check_runs;
  if (!Array.isArray(list)) throw new Error("response has no check_runs array");

  const runs: BranchCheckRun[] = [];
  for (const row of list) {
    if (row === null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record.id !== "number" || !Number.isFinite(record.id)) continue;
    if (typeof record.name !== "string") continue;
    runs.push({
      id: record.id,
      name: record.name,
      status: typeof record.status === "string" ? record.status : "",
      conclusion: typeof record.conclusion === "string"
        ? record.conclusion
        : null,
    });
  }
  return runs;
}

/**
 * The newest completed run of `checkName`, by run id.
 *
 * Only completed runs are considered: a queued or in-progress re-run has no
 * conclusion yet, and reading its empty conclusion as "not a failure" would
 * report a red base as green the moment someone re-ran the check.
 */
function latestCompletedRun(
  runs: readonly BranchCheckRun[],
  checkName: string,
): BranchCheckRun | undefined {
  let latest: BranchCheckRun | undefined;
  for (const run of runs) {
    if (run.name !== checkName) continue;
    if (run.status !== "completed") continue;
    if (latest === undefined || run.id > latest.id) latest = run;
  }
  return latest;
}
