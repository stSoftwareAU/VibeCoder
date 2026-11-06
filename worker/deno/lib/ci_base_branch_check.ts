/**
 * What does the base branch say about the check that failed on a pull request?
 * (Issue #1880, parent #1861; the evidence states were reworked by Issue #4680.)
 *
 * When the CI-fix agent reports the failure as pre-existing on the base
 * branch, the worker must not take its word for it: a `Depends on
 * owner/repo#N` line is agent prose, and a deferral spends no attempt, so an
 * unverified one would park a pull request that a fix could still rescue.
 * This module is the verification. It reads the base branch's runs of the
 * same check and reports which of five states they show: `red`, `green`,
 * `no-run`, `stale` or `unavailable`. Only `red` may justify a deferral.
 *
 * Properties it exists to hold:
 *
 * - **An error is never a verdict.** A failed API call, an unparseable body,
 *   a malformed payload or an identity that cannot be resolved is
 *   `unavailable`, never `green` or `red`. The caller then falls through to the
 *   ordinary path and charges an attempt rather than deferring on a reading it
 *   never got.
 * - **The latest run wins.** A check re-run after an earlier failure is the
 *   current answer, so the highest-id completed run of the check on the branch
 *   head decides. An earlier red left in the list does not outvote a green
 *   re-run.
 * - **Tree-equivalent evidence.** A PR-only workflow never runs on the branch
 *   head. When the head has no applicable run, the runs of the same workflow on
 *   the head of a pull request merged as the head count, but only for a commit
 *   whose tree is identical to the head's. Any failed lookup there leaves the
 *   reading unverified.
 * - **Identity, not name.** A run counts only when its app matches the failing
 *   check's app and, for GitHub Actions, its workflow path matches the failing
 *   check's path. A same-named check from elsewhere is not evidence. When the
 *   failing identity cannot be resolved, nothing is read by name alone.
 *
 * A completed run on the branch head maps to a state by its conclusion:
 * `success` is `green`; `failure` is `red`; `cancelled`, `skipped`, `neutral`,
 * `timed_out`, `action_required` and `stale` are `no-run`, since none of them
 * says the code passes or fails; any other conclusion is `unavailable`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";

/** Identity of the failing check on the PR: a same-named check from another workflow is not evidence. */
export interface CheckIdentity {
  name: string;
  appSlug: string | null;
  workflowPath: string | null;
}

/** What the base branch's runs of the failing check show. */
export type BaseBranchCheckEvidence =
  /**
   * The latest completed run on the branch head concluded `failure`. `sha` is
   * the commit the run is for; `treeEquivalentTo` is set only when that is not
   * the branch head but a commit with the identical tree (Issue #4680).
   */
  | { state: "red"; sha: string; runId: number; treeEquivalentTo?: string }
  /** The latest completed run on the branch head concluded `success`. */
  | {
    state: "green";
    sha: string;
    runId: number;
    conclusion: string;
    treeEquivalentTo?: string;
  }
  /** No completed run of an applicable check (e.g. a PR-only workflow). */
  | { state: "no-run" }
  /** An applicable run exists only for a commit other than the branch head. */
  | { state: "stale"; evidenceSha: string; baseSha: string }
  /** Any API/parse failure or unresolvable identity. */
  | { state: "unavailable"; reason: string };

/** Inputs for {@link readBaseBranchCheck}. */
export interface ReadBaseBranchCheckOptions {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** Branch to read — the pull request's base ref. */
  branch: string;
  /** Identity of the failing check on the pull request. */
  failing: CheckIdentity;
  /** Runs a `gh` command — injected so tests make no live call. */
  ghCommandFn: (args: string[]) => Promise<string>;
}

/** The app slug that marks a check run as a GitHub Actions job. */
const GITHUB_ACTIONS_APP = "github-actions";

/** The conclusions that count as green and red. */
const SUCCESS_CONCLUSION = "success";
const FAILURE_CONCLUSION = "failure";

/** Conclusions that say nothing about the code on the branch: `no-run`. */
const NO_VERDICT_CONCLUSIONS: ReadonlySet<string> = new Set([
  "cancelled",
  "skipped",
  "neutral",
  "timed_out",
  "action_required",
  "stale",
]);

/** The jq filter that shapes a check-runs payload into {@link BranchCheckRun} rows. */
const CHECK_RUNS_JQ =
  "{check_runs: [.check_runs[] | {id, name, status, conclusion, head_sha, app_slug: .app.slug, details_url}]}";

/** A full 40-character commit SHA, as the commits endpoint returns it. */
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** A check-run id: digits only. Anything else (e.g. a merge-queue id) is refused. */
const CHECK_RUN_ID_PATTERN = /^\d+$/;

/** The workflow run id inside a check run's `details_url`. */
const WORKFLOW_RUN_ID_PATTERN = /\/actions\/runs\/(\d+)/;

/** One check run, as the REST payload names it. */
interface BranchCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string | null;
  appSlug: string | null;
  detailsUrl: string | null;
}

/** A completed run of the failing check that the identity check accepted. */
interface Candidate {
  run: BranchCheckRun;
  headSha: string;
}

/**
 * Read what the base branch's runs of the failing check show.
 *
 * Reads the branch head, then `repos/{repo}/commits/{branch}/check-runs` — the
 * same REST shape `direct_merge.ts` consumes — and filters in this process
 * rather than through the API's `check_name` parameter, so one payload answers
 * for a name containing any character a query string would have to escape.
 *
 * @param options - Repo, branch, failing identity and the `gh` runner.
 * @returns The evidence state. Only `red` is a reading the caller may defer on.
 */
export async function readBaseBranchCheck(
  options: ReadBaseBranchCheckOptions,
): Promise<BaseBranchCheckEvidence> {
  const { repo, branch, failing, ghCommandFn } = options;

  // Checked before any call: without an app there is no telling this check
  // from a same-named one, so nothing is read by name alone. A GitHub Actions
  // check without its workflow path is the same case: a same-named job of
  // another workflow would match it.
  if (failing.appSlug === null) {
    return {
      state: "unavailable",
      reason: `identity of check "${failing.name}" is unresolved`,
    };
  }
  if (failing.appSlug === GITHUB_ACTIONS_APP && failing.workflowPath === null) {
    return {
      state: "unavailable",
      reason:
        `identity of check "${failing.name}" is unresolved: no workflow path`,
    };
  }

  let headSha: string;
  try {
    headSha = await readBranchHeadSha(repo, branch, ghCommandFn);
  } catch (error: unknown) {
    return unavailable(
      `Failed to read head of ${repo}@${branch}: ${errorMessage(error)}`,
    );
  }

  let raw: string;
  try {
    raw = await ghCommandFn([
      "api",
      // `per_page=100` rather than the default 30: a base head with many
      // checks would otherwise leave the one being verified off page one and
      // read as "no run", charging an attempt against a failure this branch
      // could never fix.
      `repos/${repo}/commits/${branch}/check-runs?per_page=100`,
      "--jq",
      CHECK_RUNS_JQ,
    ]);
  } catch (error: unknown) {
    return unavailable(
      `Failed to read check runs for ${repo}@${branch}: ${errorMessage(error)}`,
    );
  }

  let runs: BranchCheckRun[];
  try {
    runs = parseCheckRuns(raw);
  } catch (error: unknown) {
    return unavailable(
      `Failed to parse check runs for ${repo}@${branch}: ${
        errorMessage(error)
      }`,
    );
  }

  let candidates: Candidate[];
  try {
    candidates = await applicableCandidates(runs, failing, repo, ghCommandFn);
  } catch (error: unknown) {
    return unavailable(
      `Failed to resolve workflow of ${failing.name} on ${repo}@${branch}: ${
        errorMessage(error)
      }`,
    );
  }

  const latestOnHead = newest(
    candidates.filter((candidate) => candidate.headSha === headSha),
  );
  const headVerdict = latestOnHead === undefined
    ? undefined
    : verdictOf(latestOnHead);
  if (headVerdict !== undefined && headVerdict.state !== "no-run") {
    return headVerdict;
  }

  // Issue #4680: a PR-only workflow never runs on the branch head itself, but
  // it ran on the head of the pull request that was merged into it. When that
  // commit has the identical tree, its run of the same workflow is the same
  // code under the same workflow: commit-bound evidence, not a name match.
  const equivalent = await readTreeEquivalentVerdict({
    repo,
    headSha,
    failing,
    ghCommandFn,
  });
  if (equivalent !== undefined) return equivalent;

  // A cancelled or skipped head run says nothing about the code, and the
  // identical-tree evidence above did not answer either.
  if (headVerdict !== undefined) return headVerdict;

  const latestElsewhere = newest(candidates);
  if (latestElsewhere === undefined) return { state: "no-run" };
  return {
    state: "stale",
    evidenceSha: latestElsewhere.headSha,
    baseSha: headSha,
  };
}

/** Most pull-request heads consulted for tree-equivalent evidence. */
const MAX_EQUIVALENT_HEADS = 5;

/**
 * A verdict from a run of the failing check on a commit whose tree is the
 * branch head's tree (Issue #4680).
 *
 * The pull requests merged as the branch head (`commits/{sha}/pulls`) are
 * listed; for each head commit other than the branch head, the commit's tree
 * is compared with the branch head's tree. Only an identical tree counts, and
 * only a completed run of the same check, app and workflow on that commit.
 * The newest such run decides, exactly as on the branch head. A conclusion
 * that says nothing about the code (`no-run`, `unavailable`) is skipped.
 *
 * A failure of any lookup here is not a verdict: the caller keeps the
 * unverified reading it already had.
 *
 * @returns `red` or `green` with `treeEquivalentTo` set, or undefined when no
 *   such run exists or a lookup failed.
 */
async function readTreeEquivalentVerdict(options: {
  repo: string;
  headSha: string;
  failing: CheckIdentity;
  ghCommandFn: (args: string[]) => Promise<string>;
}): Promise<BaseBranchCheckEvidence | undefined> {
  const { repo, headSha, failing, ghCommandFn } = options;
  try {
    const headTree = await readTreeSha(repo, headSha, ghCommandFn);
    const pulls = parseRecordList(
      await ghCommandFn([
        "api",
        `repos/${repo}/commits/${headSha}/pulls?per_page=${MAX_EQUIVALENT_HEADS}`,
        "--jq",
        "[.[] | {head_sha: .head.sha}]",
      ]),
    );
    const heads = new Set<string>();
    for (const pull of pulls) {
      const sha = stringOrNull(pull.head_sha);
      if (sha !== null && SHA_PATTERN.test(sha) && sha !== headSha) {
        heads.add(sha);
      }
    }

    let best: Candidate | undefined;
    for (const sha of heads) {
      if (await readTreeSha(repo, sha, ghCommandFn) !== headTree) continue;
      const runs = parseCheckRuns(
        await ghCommandFn([
          "api",
          `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
          "--jq",
          CHECK_RUNS_JQ,
        ]),
      );
      const found = (await applicableCandidates(
        runs,
        failing,
        repo,
        ghCommandFn,
      )).filter((candidate) =>
        candidate.headSha === sha && isVerdict(candidate.run)
      );
      const latest = newest(found);
      if (
        latest !== undefined &&
        (best === undefined || latest.run.id > best.run.id)
      ) {
        best = latest;
      }
    }
    if (best === undefined) return undefined;
    const verdict = verdictOf(best);
    if (verdict.state !== "red" && verdict.state !== "green") return undefined;
    return { ...verdict, treeEquivalentTo: headSha };
  } catch {
    return undefined;
  }
}

/** Whether a run's conclusion is `success` or `failure`. */
function isVerdict(run: BranchCheckRun): boolean {
  return run.conclusion === SUCCESS_CONCLUSION ||
    run.conclusion === FAILURE_CONCLUSION;
}

/**
 * Read a commit's tree SHA.
 *
 * @throws When the call fails or the answer is not a SHA.
 */
async function readTreeSha(
  repo: string,
  sha: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<string> {
  const tree = (await ghCommandFn([
    "api",
    `repos/${repo}/commits/${sha}`,
    "--jq",
    ".commit.tree.sha",
  ])).trim();
  if (!SHA_PATTERN.test(tree)) throw new Error("commit tree is not a SHA");
  return tree;
}

/**
 * Parse a body that must be a JSON array of objects.
 *
 * @throws When the body is not JSON or not an array.
 */
function parseRecordList(raw: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("response is not an array");
  return parsed.filter((row): row is Record<string, unknown> =>
    row !== null && typeof row === "object"
  );
}

/**
 * Resolve the failing PR check's identity from its check-run id.
 *
 * Reads `repos/{repo}/check-runs/{id}` and, for a GitHub Actions check, the
 * workflow path of the run its `details_url` names. A check-run id that is not
 * digits is refused rather than guessed at, and so is a check run that names
 * no app: an identity without an app cannot tell the check from a same-named
 * one elsewhere.
 *
 * @param options - Repo, check-run id, the name the check must carry, and the
 *   `gh` runner.
 * @returns The identity, or an error carrying the cause.
 */
export async function readCheckIdentity(options: {
  repo: string;
  checkRunId: string;
  checkName: string;
  ghCommandFn: (args: string[]) => Promise<string>;
}): Promise<Result<CheckIdentity>> {
  const { repo, checkRunId, checkName, ghCommandFn } = options;

  if (!CHECK_RUN_ID_PATTERN.test(checkRunId)) {
    return {
      ok: false,
      error: new Error(
        `Check run id "${checkRunId}" is not numeric; its identity is not resolved`,
      ),
    };
  }

  try {
    const raw = await ghCommandFn([
      "api",
      `repos/${repo}/check-runs/${checkRunId}`,
      "--jq",
      "{name, app_slug: .app.slug, details_url}",
    ]);
    const record = parseRecord(raw);
    if (typeof record.name !== "string") {
      throw new Error("response has no name");
    }
    if (record.name !== checkName) {
      throw new Error(
        `check run ${checkRunId} is "${record.name}", not "${checkName}"`,
      );
    }
    const appSlug = stringOrNull(record.app_slug);
    if (appSlug === null) throw new Error("response has no app slug");
    const detailsUrl = stringOrNull(record.details_url);

    let workflowPath: string | null = null;
    if (appSlug === GITHUB_ACTIONS_APP) {
      const workflowRunId = workflowRunIdOf(detailsUrl);
      if (workflowRunId !== null) {
        workflowPath = await readWorkflowPath(repo, workflowRunId, ghCommandFn);
      }
    }
    return {
      ok: true,
      value: { name: record.name, appSlug, workflowPath },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: new Error(
        `Failed to resolve identity of check run ${checkRunId} in ${repo}: ${
          errorMessage(error)
        }`,
      ),
    };
  }
}

/**
 * The verdict a completed run on the branch head gives.
 *
 * @param latest - The newest completed run of the failing check on the head.
 * @returns The state its conclusion names.
 */
function verdictOf(latest: Candidate): BaseBranchCheckEvidence {
  const { run, headSha } = latest;
  if (run.conclusion === SUCCESS_CONCLUSION) {
    return {
      state: "green",
      sha: headSha,
      runId: run.id,
      conclusion: SUCCESS_CONCLUSION,
    };
  }
  if (run.conclusion === FAILURE_CONCLUSION) {
    return { state: "red", sha: headSha, runId: run.id };
  }
  if (run.conclusion !== null && NO_VERDICT_CONCLUSIONS.has(run.conclusion)) {
    return { state: "no-run" };
  }
  return unavailable(
    `check run ${run.id} concluded ${run.conclusion ?? "with no conclusion"}`,
  );
}

/**
 * Read the branch head commit SHA.
 *
 * @param repo - Repository in `owner/repo` form.
 * @param branch - Branch to read.
 * @param ghCommandFn - The `gh` runner.
 * @returns The 40-character lower-case SHA.
 * @throws When the call fails or the answer is not a commit SHA.
 */
async function readBranchHeadSha(
  repo: string,
  branch: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<string> {
  const sha = (await ghCommandFn([
    "api",
    `repos/${repo}/commits/${branch}`,
    "--jq",
    ".sha",
  ])).trim();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`branch head is not a commit SHA`);
  }
  return sha;
}

/**
 * The completed runs of the failing check that match its identity.
 *
 * A run is applicable when its name and app match the failing check and, for
 * GitHub Actions, its workflow path matches too. A candidate whose workflow
 * path cannot be read, or that carries no head SHA, is an error: it cannot be
 * placed, and dropping it silently could let an older run stand in for it.
 *
 * @param runs - The parsed check runs of the branch.
 * @param failing - The failing check's identity.
 * @param repo - Repository in `owner/repo` form.
 * @param ghCommandFn - The `gh` runner.
 * @returns The applicable completed runs, each with its head SHA.
 * @throws When a candidate's workflow path or head SHA cannot be read.
 */
async function applicableCandidates(
  runs: readonly BranchCheckRun[],
  failing: CheckIdentity,
  repo: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<Candidate[]> {
  // Workflow path per workflow run id, so each run is read once per call.
  const pathCache = new Map<string, string>();
  const found: Candidate[] = [];

  for (const run of runs) {
    if (run.name !== failing.name || run.status !== "completed") continue;
    if (run.appSlug !== failing.appSlug) continue;

    if (failing.workflowPath !== null && run.appSlug === GITHUB_ACTIONS_APP) {
      const path = await workflowPathOf(run, repo, ghCommandFn, pathCache);
      if (path !== failing.workflowPath) continue;
    }

    if (run.headSha === null) {
      throw new Error(`check run ${run.id} has no head SHA`);
    }
    found.push({ run, headSha: run.headSha });
  }
  return found;
}

/**
 * The workflow path of a GitHub Actions check run, read once per workflow run.
 *
 * @param run - The check run whose `details_url` names the workflow run.
 * @param repo - Repository in `owner/repo` form.
 * @param ghCommandFn - The `gh` runner.
 * @param cache - Paths already read in this call, keyed by workflow run id.
 * @returns The workflow path.
 * @throws When the URL names no workflow run, or the read fails.
 */
async function workflowPathOf(
  run: BranchCheckRun,
  repo: string,
  ghCommandFn: (args: string[]) => Promise<string>,
  cache: Map<string, string>,
): Promise<string> {
  const workflowRunId = workflowRunIdOf(run.detailsUrl);
  if (workflowRunId === null) {
    throw new Error(`check run ${run.id} names no workflow run`);
  }
  const cached = cache.get(workflowRunId);
  if (cached !== undefined) return cached;
  const path = await readWorkflowPath(repo, workflowRunId, ghCommandFn);
  cache.set(workflowRunId, path);
  return path;
}

/**
 * Read the workflow path a workflow run belongs to.
 *
 * @param repo - Repository in `owner/repo` form.
 * @param workflowRunId - The workflow run id, as digits.
 * @param ghCommandFn - The `gh` runner.
 * @returns The path, such as `.github/workflows/ci.yml`.
 * @throws When the call fails or the path is empty.
 */
async function readWorkflowPath(
  repo: string,
  workflowRunId: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<string> {
  const path = (await ghCommandFn([
    "api",
    `repos/${repo}/actions/runs/${workflowRunId}`,
    "--jq",
    ".path",
  ])).trim();
  if (path === "") throw new Error(`workflow run ${workflowRunId} has no path`);
  return path;
}

/**
 * The workflow run id named by a check run's `details_url`.
 *
 * @param detailsUrl - The URL, or null when the payload carried none.
 * @returns The digits of the run id, or null when the URL names no run.
 */
function workflowRunIdOf(detailsUrl: string | null): string | null {
  if (detailsUrl === null) return null;
  return WORKFLOW_RUN_ID_PATTERN.exec(detailsUrl)?.[1] ?? null;
}

/**
 * The run with the highest id: the most recently created.
 *
 * @param candidates - Candidate runs.
 * @returns The newest, or undefined when there are none.
 */
function newest(candidates: readonly Candidate[]): Candidate | undefined {
  let latest: Candidate | undefined;
  for (const candidate of candidates) {
    if (latest === undefined || candidate.run.id > latest.run.id) {
      latest = candidate;
    }
  }
  return latest;
}

/**
 * Read the check-run rows out of the API body.
 *
 * A row without a numeric id or a string name cannot be ordered or matched,
 * so it is skipped, as it always was. Other fields are read leniently here;
 * {@link applicableCandidates} refuses a candidate that lacks what it needs.
 *
 * @param raw - The raw response body.
 * @returns The well-formed rows.
 * @throws When the body is not JSON, or carries no `check_runs` array.
 */
function parseCheckRuns(raw: string): BranchCheckRun[] {
  const parsed = parseRecord(raw);
  const list = parsed.check_runs;
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
      conclusion: stringOrNull(record.conclusion),
      headSha: stringOrNull(record.head_sha),
      appSlug: stringOrNull(record.app_slug),
      detailsUrl: stringOrNull(record.details_url),
    });
  }
  return runs;
}

/**
 * Parse a body that must be a JSON object.
 *
 * @param raw - The raw response body.
 * @returns The object's fields.
 * @throws When the body is not JSON or not an object.
 */
function parseRecord(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("response is not an object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * A string field, or null when it is absent or not a string.
 *
 * @param value - The field as parsed.
 * @returns The string, or null.
 */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * An `unavailable` evidence state.
 *
 * @param reason - Why the base branch could not be read.
 * @returns The state.
 */
function unavailable(reason: string): BaseBranchCheckEvidence {
  return { state: "unavailable", reason };
}

/**
 * The message of a thrown value.
 *
 * @param error - What was thrown.
 * @returns Its message.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
