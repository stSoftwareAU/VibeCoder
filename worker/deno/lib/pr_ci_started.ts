/**
 * CI start detection helper for the Vibe Coder worker (Issue #2099).
 *
 * Detects whether GitHub Actions have started for a PR's head SHA.
 * Pure helper — all GitHub API access goes through an injected
 * `ghCommandFn` so tests can stub the responses.
 *
 * Companion to `pr_ci_nudge.ts`, which acts on the result to push the
 * PR into a running state when CI has not started (Issue #2094).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * The detected state of CI for a PR's head SHA.
 *
 * - `started` — at least one `check_run` exists (queued, in_progress, or completed).
 * - `queued` — no `check_run`s yet, but a `workflow_run` exists in `queued` state.
 * - `none` — no `check_run`s and no `workflow_run`s.
 */
export type CiStartStatus = "started" | "queued" | "none";

/**
 * A minimal subset of the `check-runs` GitHub API response we depend on.
 */
interface CheckRunsResponse {
  total_count?: number;
  check_runs?: Array<{ id: number; name?: string; status?: string }>;
}

/**
 * A minimal subset of the `actions/runs` GitHub API response we depend on.
 */
interface WorkflowRunsResponse {
  total_count?: number;
  workflow_runs?: Array<{
    id: number;
    status?: string;
    head_sha?: string;
    created_at?: string;
  }>;
}

/**
 * Determine whether CI has started for a PR's head SHA.
 *
 * @param repo - Repository in `owner/repo` format.
 * @param prNumber - The PR number (used to look up the head SHA if not supplied).
 * @param ghCommandFn - Injectable runner that executes a `gh` CLI command.
 * @param headSha - Optional explicit head SHA. When omitted, the function calls
 *   `gh pr view <n> --json headRefOid` to resolve it.
 * @returns The detected `CiStartStatus`.
 */
export async function getCiStartStatus(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
  headSha?: string,
): Promise<CiStartStatus> {
  const sha = headSha ?? (await resolveHeadSha(repo, prNumber, ghCommandFn));

  // 1. Any check_runs at all → CI has started (queued/in_progress/completed
  //    are all "started" from our perspective; we just want to know that
  //    GitHub Actions has noticed the SHA).
  const checkRunsRaw = await ghCommandFn([
    "api",
    `repos/${repo}/commits/${sha}/check-runs`,
  ]);
  const checkRuns = parseJson<CheckRunsResponse>(checkRunsRaw);
  if ((checkRuns.check_runs?.length ?? 0) > 0) {
    return "started";
  }

  // 2. No check_runs — look at workflow_runs. A `queued` workflow_run with
  //    no check_runs yet means GitHub is about to start running, which is
  //    nudgeable via `gh run rerun`.
  const workflowRunsRaw = await ghCommandFn([
    "api",
    `repos/${repo}/actions/runs?head_sha=${sha}`,
  ]);
  const workflowRuns = parseJson<WorkflowRunsResponse>(workflowRunsRaw);
  const queued = (workflowRuns.workflow_runs ?? []).find(
    (run) => run.status === "queued",
  );
  if (queued !== undefined) {
    return "queued";
  }

  // 3. Nothing — caller must nudge by pushing a trivial commit.
  return "none";
}

/**
 * Resolve a PR's head SHA via `gh pr view`.
 */
async function resolveHeadSha(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<string> {
  const raw = await ghCommandFn([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "headRefOid",
  ]);
  const parsed = parseJson<{ headRefOid?: string }>(raw);
  if (!parsed.headRefOid) {
    throw new Error(`could not resolve head SHA for ${repo}#${prNumber}`);
  }
  return parsed.headRefOid;
}

/**
 * Best-effort JSON parser — returns an empty object on parse failure so the
 * caller's optional-chained reads degrade gracefully.
 */
function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}
