/**
 * Nudge CI to run on a PR (Issue #2099).
 *
 * GitHub deliberately suppresses `pull_request` workflows when a PR is
 * raised by a workflow authenticated with `GITHUB_TOKEN` (anti-recursion).
 * The Vibe Coder works around this by nudging CI:
 *
 *   - `queued` — re-run the most recent queued `workflow_run` via
 *     `gh run rerun`.
 *   - `none`   — push a trivial empty commit on the PR's head branch.
 *
 * `started` is a no-op; callers should not invoke `nudgeCi` in that
 * case but the function defends against it.
 *
 * Pure helper — all `gh` and `git` access goes through injected runners
 * so tests can stub them.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { buildCheckoutArgs, buildPushArgs } from "./git_ref_args.ts";
import type { Result } from "../types.ts";
import type { CiStartStatus } from "./pr_ci_started.ts";
import { assertNever } from "./assert_never.ts";

/** Action taken by `nudgeCi`. */
export type NudgeAction = "rerun" | "empty-commit" | "noop";

/** Successful nudge outcome. */
export interface NudgeOutcome {
  /** Which action was taken. */
  action: NudgeAction;
  /** Human-readable description for logs / PR comments. */
  description: string;
}

/** Options for {@link nudgeCi}. */
export interface NudgeCiOptions {
  /** Repository in `owner/repo` format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Head branch name (must already be checked out for the `none` path). */
  headBranch: string;
  /** Head SHA — used to locate the queued workflow_run. */
  headSha: string;
  /** The status returned by {@link getCiStartStatus}. */
  status: CiStartStatus;
  /** Injected `gh` CLI runner. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /** Injected `git` CLI runner. */
  gitCommandFn: (args: string[]) => Promise<string>;
}

/**
 * The empty-commit message used when status is `none`. Includes the words
 * "Vibe Coder" so reviewers immediately understand why the commit exists.
 */
const EMPTY_COMMIT_MESSAGE = "chore: nudge CI (Vibe Coder)\n\n" +
  "Empty commit pushed by the Vibe Coder to trigger GitHub Actions, which " +
  "suppresses `pull_request` workflows on PRs raised by GITHUB_TOKEN. " +
  "Safe to ignore. See Issue #2094.";

/**
 * Nudge CI to run on the given PR.
 *
 * @param opts - See {@link NudgeCiOptions}.
 * @returns A {@link Result} describing the action taken or the failure.
 */
export async function nudgeCi(
  opts: NudgeCiOptions,
): Promise<Result<NudgeOutcome, Error>> {
  switch (opts.status) {
    case "started":
      return {
        ok: true,
        value: {
          action: "noop",
          description:
            `CI already started on ${opts.repo}#${opts.prNumber}; no nudge required`,
        },
      };
    case "queued":
      return await rerunQueuedWorkflow(opts);
    case "none":
      return await pushEmptyCommit(opts);
    default:
      // Exhaustiveness guard (Issue #2568). Adding a `CiStartStatus` variant
      // without a case above is a compile error here, so a new state can never
      // silently fall through to a runtime error path.
      return assertNever(opts.status);
  }
}

/**
 * Re-run the most recent queued `workflow_run` for the head SHA.
 */
async function rerunQueuedWorkflow(
  opts: NudgeCiOptions,
): Promise<Result<NudgeOutcome, Error>> {
  let runId: number;
  try {
    const raw = await opts.ghCommandFn([
      "api",
      `repos/${opts.repo}/actions/runs?head_sha=${opts.headSha}`,
    ]);
    const parsed = JSON.parse(raw) as {
      workflow_runs?: Array<
        { id: number; status?: string; created_at?: string }
      >;
    };
    const queued = (parsed.workflow_runs ?? [])
      .filter((r) => r.status === "queued")
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    const first = queued[0];
    if (first === undefined || first.id === undefined) {
      return {
        ok: false,
        error: new Error(
          `no queued workflow_run found for ${opts.repo}@${opts.headSha}`,
        ),
      };
    }
    runId = first.id;
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `failed to look up queued workflow_run: ${errorMessage(err)}`,
      ),
    };
  }

  try {
    await opts.ghCommandFn([
      "run",
      "rerun",
      String(runId),
      "--repo",
      opts.repo,
    ]);
  } catch (err) {
    return {
      ok: false,
      error: new Error(`gh run rerun failed: ${errorMessage(err)}`),
    };
  }

  return {
    ok: true,
    value: {
      action: "rerun",
      description:
        `Re-ran queued workflow_run ${runId} on ${opts.repo}#${opts.prNumber} ` +
        `(head ${opts.headSha.slice(0, 7)})`,
    },
  };
}

/**
 * Push a trivial empty commit on the PR's head branch.
 *
 * Assumes the repo is already cloned and `cwd` is the working tree.
 */
async function pushEmptyCommit(
  opts: NudgeCiOptions,
): Promise<Result<NudgeOutcome, Error>> {
  // Checkout — defensive; if already on the branch this is a no-op.
  try {
    await opts.gitCommandFn(buildCheckoutArgs(opts.headBranch));
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `git checkout ${opts.headBranch} failed: ${errorMessage(err)}`,
      ),
    };
  }

  // Empty commit — `--allow-empty` is the supported flag for this exact use case.
  try {
    await opts.gitCommandFn([
      "commit",
      "--allow-empty",
      "-m",
      EMPTY_COMMIT_MESSAGE,
    ]);
  } catch (err) {
    return {
      ok: false,
      error: new Error(`git commit --allow-empty failed: ${errorMessage(err)}`),
    };
  }

  // Push — surface the actual git error so the operator can diagnose.
  try {
    await opts.gitCommandFn(buildPushArgs("origin", opts.headBranch));
  } catch (err) {
    return {
      ok: false,
      error: new Error(`git push failed: ${errorMessage(err)}`),
    };
  }

  return {
    ok: true,
    value: {
      action: "empty-commit",
      description:
        `Pushed empty commit to ${opts.repo}@${opts.headBranch} to nudge CI ` +
        `on PR #${opts.prNumber}`,
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
