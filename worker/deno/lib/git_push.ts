/**
 * Git push operations (Issue #912).
 *
 * Provides functions for pushing commits, detecting push rejections,
 * detecting existing PRs, and finding open PRs.
 *
 * Migrated from worker/shared/git_operations.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand, runGitCommandChecked } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import {
  recoverFromPushRejection,
  refuseUnlessHeadExtends,
} from "./git_push_recovery.ts";
import type { PushLineageOptions } from "./git_push_recovery.ts";
import { describeUnpushedCommits } from "./git_remote_head.ts";
import {
  type BranchCurrencyOutcome,
  ensureBranchCurrent,
} from "./branch_currency.ts";
import { mergeOntoBase } from "./pr_raise_sync.ts";
import {
  assertSafeGitRef,
  assertSafeRefComponent,
  buildFetchArgs,
  buildPushArgs,
} from "./git_ref_args.ts";
import { assertSafeToCommit, inspectStagedFiles } from "./pre_commit_safety.ts";
import { isWorkerStatePath } from "./worker_state_paths.ts";
import { runPreFlightGate } from "./pre_flight_gate.ts";
import { redactedHeadTail } from "./redacted_text.ts";
import {
  PrePushGateInfrastructureError,
  runPrePushGate,
} from "./pre_push_gate.ts";
import type { PreFlightRunner } from "./pre_flight_gate.ts";
import { getPreFlightCommands } from "./repo_config.ts";
import type { RepoConfig } from "../types.ts";
import { appendRunIdTrailer, assertRunIdTrailer, getRunId } from "./run_id.ts";
import { runGhOrThrow } from "./gh_spawn.ts";

/**
 * Pre-flight gate specification passed to {@link commitAndPushPending}
 * (Issue #3577). Omit the spec to disable the gate — the repo then commits and
 * pushes with zero added latency, which is what the WIP checkpoint, timeout
 * preservation and declared hand-off pushes rely on. Passing a spec turns on
 * Step 1b's changed-file checks (Issue #3689: deno/cargo fmt, markdownlint,
 * cspell, the Floci deploy test and the repository's ShellCheck policy), then
 * cargo deny when applicable (Issue #4626), even when `commands` is empty; an
 * empty list only means no repo pre-flight commands run. A spec with
 * `shellcheckOnly` runs the ShellCheck policy and cargo deny for changed cargo
 * inputs (Issues #4631 and #4626).
 *
 * `ciCargoOnly` (Issue #4630) narrows Step 1b to the repo CI's own cargo
 * clippy and test-target compile plus the ShellCheck policy and cargo deny for
 * changed cargo inputs: no fmt, lint, markdownlint, cspell or Floci checks, and
 * no pre-flight commands. See {@link CI_CARGO_ONLY_PRE_FLIGHT}.
 */
export interface PreFlightGateSpec {
  /** Commands to run before the automated commit, in listed order. */
  commands: readonly string[];
  /** Per-command timeout in seconds (defaults to the gate's own default). */
  timeoutSeconds?: number;
  /** Injectable command runner (defaults to the real subprocess runner). */
  runner?: PreFlightRunner;
  /**
   * Run only the repo CI's cargo clippy and test-target compile (plus the
   * ShellCheck policy and cargo deny for changed cargo inputs) over the
   * unpushed commits (Issue #4630). Omit for the full changed-file gate.
   */
  ciCargoOnly?: boolean;
  /**
   * Step 1b validates the repository's ShellCheck policy for the pushed
   * scripts, plus the CI cargo-deny check when the pushed paths include a
   * cargo input, and leaves the formatter policy of a repair without
   * pre-flight commands unchanged (Issues #4631 and #4626).
   */
  shellcheckOnly?: boolean;
}

/**
 * The gate the repair processors (CI fix and PR feedback) pass when a repo has
 * no pre-flight commands (Issue #4630). Their repairs otherwise reach the
 * branch with no gate, and CI then fails on clippy. Only the repo CI's cargo
 * clippy and test-target compile run, plus the ShellCheck policy and the CI
 * cargo-deny check for changed cargo inputs (Issues #4631 and #4626). Frozen so that no caller can change the
 * shared spec. To inject a runner, copy it: `{ ...CI_CARGO_ONLY_PRE_FLIGHT,
 * runner }`.
 */
export const CI_CARGO_ONLY_PRE_FLIGHT = Object.freeze<PreFlightGateSpec>({
  commands: Object.freeze([]),
  ciCargoOnly: true,
});

/**
 * Resolve a repo's pre-flight gate into a {@link PreFlightGateSpec}, or
 * `undefined` when the repo has no gate configured (Issue #3577).
 *
 * A convenience for the automated-commit call sites: pass the result straight
 * to {@link commitAndPushPending}. Returns `undefined` (not an empty spec) so
 * a caller that passes it straight through leaves a repo with no entry
 * ungated; the issue completion phase substitutes `{ commands: [] }` instead,
 * so it still runs the changed-file checks (Issue #3689). The spelling and
 * merge-conflict repair processors use {@link resolveRepairPreFlightSpec}; the
 * CI-fix and PR-feedback repair processors substitute
 * {@link CI_CARGO_ONLY_PRE_FLIGHT} (Issue #4630). Throws on malformed config
 * via `getPreFlightCommands` — but config is already validated at load
 * (Issue #3577), so this is defence in depth.
 */
export function resolvePreFlightSpec(
  repoConfigs: Record<string, RepoConfig> | undefined,
  repo: string,
): PreFlightGateSpec | undefined {
  const commands = getPreFlightCommands(repoConfigs, repo);
  return commands.length > 0 ? { commands } : undefined;
}

/**
 * {@link resolvePreFlightSpec} for the spelling and merge-conflict PR repair
 * processors (the CI-fix and PR-feedback processors use
 * {@link CI_CARGO_ONLY_PRE_FLIGHT} instead): a repo with no pre-flight commands
 * still gets the ShellCheck publication check, plus the CI cargo-deny check
 * when the pushed paths include a cargo input, and nothing else, before the
 * repair is pushed (Issues #4631 and #4626). WIP checkpoint, timeout-preservation and
 * declared hand-off pushes never call this; they stay ungated on purpose.
 */
export function resolveRepairPreFlightSpec(
  repoConfigs: Record<string, RepoConfig> | undefined,
  repo: string,
): PreFlightGateSpec {
  return resolvePreFlightSpec(repoConfigs, repo) ??
    { commands: [], shellcheckOnly: true };
}

/**
 * Detect non-fast-forward push rejection from push output (Issue #186).
 *
 * When a PR is raised, automated tasks (reformatting, CI checks, etc.) may push
 * commits to the remote branch. This detects the specific rejection so the worker
 * can recover automatically.
 *
 * @param pushOutput - The stderr/stdout from git push
 * @returns True if the push was rejected due to non-fast-forward
 */
export function detectPushRejection(pushOutput: string): boolean {
  if (!pushOutput) return false;
  return /\(fetch first\)|\(non-fast-forward\)/.test(pushOutput);
}

/**
 * Extract an existing PR URL from gh error output (Issue #184).
 *
 * When gh pr create fails because a PR already exists for the branch,
 * the error message includes the URL of the existing PR.
 *
 * @param errorOutput - The stderr/stdout from gh pr create
 * @returns The PR URL if found, or null
 */
export function detectExistingPr(errorOutput: string): string | null {
  if (!errorOutput) return null;
  if (!/already exists/i.test(errorOutput)) return null;

  const match = errorOutput.match(
    /https:\/\/github\.com\/[^\s]+\/pull\/\d+/,
  );
  return match ? match[0] : null;
}

/**
 * Find an open PR for a given branch (Issue #386).
 *
 * @param repo - Repository in "owner/repo" format
 * @param branchName - The head branch to search for
 * @param ghCommandFn - Injected gh command function (for testing)
 * @returns Result with the PR URL if found
 */
export async function findOpenPrForBranch(
  repo: string,
  branchName: string,
  ghCommandFn?: (args: string[]) => Promise<string>,
): Promise<Result<string | null>> {
  if (!branchName) {
    return { ok: true, value: null };
  }

  try {
    const runGh = ghCommandFn ?? defaultGhCommand;
    const output = await runGh([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branchName,
      "--state",
      "open",
      "--json",
      "url",
      "--jq",
      ".[0].url",
    ]);

    const prUrl = output.trim();
    return { ok: true, value: prUrl || null };
  } catch (error: unknown) {
    return {
      ok: false,
      error: new Error(
        `Failed to find open PR for branch '${branchName}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }
}

/**
 * Recover gracefully when a PR already exists (Issue #184).
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number being worked on
 * @param prUrl - The URL of the existing PR
 * @param prBody - Optional updated PR body content to apply
 * @param ghCommandFn - Injected gh command function (for testing)
 * @returns Result indicating success
 */
export async function recoverExistingPr(
  repo: string,
  issueNumber: number,
  prUrl: string,
  prBody?: string,
  ghCommandFn?: (args: string[]) => Promise<string>,
): Promise<Result<string>> {
  if (!prUrl) {
    return { ok: false, error: new Error("Empty PR URL") };
  }

  const messages: string[] = [
    `SELF-HEALING: Found existing PR for issue #${issueNumber}: ${prUrl}`,
    "SELF-HEALING: A previous run likely created this PR before timing out",
  ];

  // Update the existing PR body with converted screenshot URLs (Issue #328)
  if (prBody) {
    const prNumber = prUrl.split("/").pop();
    try {
      const runGh = ghCommandFn ?? defaultGhCommand;
      await runGh([
        "pr",
        "edit",
        String(prNumber),
        "--repo",
        repo,
        "--body",
        prBody,
      ]);
      messages.push("SELF-HEALING: PR body updated successfully");
    } catch (err) {
      console.warn(
        `[git-push] Failed to update PR body for PR #${prNumber} in ${repo}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      messages.push("Failed to update PR body (non-fatal)");
    }
  }

  messages.push(
    "SELF-HEALING: Treating as successful — no need to create a new PR",
  );

  return { ok: true, value: messages.join("\n") };
}

/**
 * Resolve the repository's default branch from the local clone (Issue #2584).
 *
 * Uses `git symbolic-ref refs/remotes/origin/HEAD` — the same local resolution
 * `setupRepo()` relies on — so the push guard needs no GitHub API call and works
 * purely from the working tree selected by `options.cwd`. A `git clone` sets
 * `origin/HEAD` to the remote's default branch, so this resolves correctly for
 * every monitored clone.
 *
 * @param options - Git command options (cwd selects the repo)
 * @returns The default branch name, or null when it cannot be determined
 *   (e.g. `origin/HEAD` is unset).
 */
export async function resolveLocalDefaultBranch(
  options: GitCommandOptions = {},
): Promise<string | null> {
  const result = await runGitCommand(
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    options,
  );
  if (result.ok && result.value.code === 0) {
    const branch = result.value.stdout.trim().replace(
      "refs/remotes/origin/",
      "",
    );
    return branch || null;
  }
  return null;
}

/**
 * Central push-choke-point guard (Issue #2584).
 *
 * The default branch must be strictly read-only for the worker: it may only
 * ever change via a verified, human-reviewed merge — never a direct push of
 * formatting, version, or dependency-bump commits. This guard refuses any push
 * whose target branch equals the repository's default branch.
 *
 * - **Fails closed on the default branch.** When the resolved default branch
 *   matches `branchName` the push is rejected with an explicit error.
 * - **Fails open when the default cannot be resolved.** If `origin/HEAD` is
 *   unset the default branch is unknown, so a legitimate feature-branch push is
 *   never blocked by a transient lookup failure. Direct-to-default is only
 *   possible when `branchName` literally equals the resolved default, so the
 *   read-only invariant still holds for every clone where `origin/HEAD` is set
 *   (the normal case).
 *
 * @param branchName - The branch about to be pushed
 * @param options - Git command options (cwd selects the repo)
 * @param allowDefaultBranch - Opt-out reserved for legitimate merge machinery
 *   that must update the default-branch ref. Defaults to `false` (forbid).
 * @returns Ok when the push may proceed; an error Result when it targets the
 *   default branch and the opt-out was not supplied.
 */
export async function assertPushTargetAllowed(
  branchName: string,
  options: GitCommandOptions = {},
  allowDefaultBranch = false,
): Promise<Result<void>> {
  if (allowDefaultBranch) return { ok: true, value: undefined };

  const defaultBranch = await resolveLocalDefaultBranch(options);
  if (defaultBranch !== null && branchName === defaultBranch) {
    return {
      ok: false,
      error: new Error(
        `Refusing to push to the default branch '${branchName}': the default ` +
          `branch is read-only for the worker and may only change via a ` +
          `verified merge (Issue #2584). Push to a feature or milestone ` +
          `branch instead.`,
      ),
    };
  }
  return { ok: true, value: undefined };
}

/**
 * Push any local commits that haven't been pushed to origin (Issue #105).
 *
 * When responding to PR comments, Claude sometimes makes commits but doesn't push them.
 * This ensures changes are never left unpushed on an unattended machine.
 *
 * Also handles the first-time push of a freshly created feature branch
 * (Issue #1463 regression): a branch that is not on the remote yet must be
 * pushed with `-u` so the upstream is created — treating "no upstream" as
 * "0 commits to push" silently skips the push and leaves the remote branch
 * missing, and `gh pr create` then fails with "No commits between …".
 *
 * The unpushed count comes from {@link describeUnpushedCommits} (Issue #211),
 * which measures against the branch's own remote head — `ls-remote` when the
 * clone keeps no remote-tracking ref for it — rather than against every origin
 * ref, which on a single-branch clone counts commits ahead of the default
 * branch and reports a fully pushed branch as four commits behind.
 *
 * @param branchName - The branch to push
 * @param options - Git command options
 * @param allowDefaultBranch - Opt-out for the read-only default-branch guard
 *   (Issue #2584). Defaults to `false` (forbid pushing to the default branch).
 * @returns Result with the number of commits pushed (0 when already in sync)
 */
export async function pushUnpushedCommits(
  branchName: string,
  options: PushLineageOptions = {},
  allowDefaultBranch = false,
  beforePush?: () => Promise<Result<void>>,
): Promise<Result<number>> {
  // Read-only default-branch guard (Issue #2584) — refuse before doing any
  // work when the target is the repo's default branch.
  const guard = await assertPushTargetAllowed(
    branchName,
    options,
    allowDefaultBranch,
  );
  if (!guard.ok) {
    return { ok: false, error: guard.error };
  }

  // Refuse an option-injecting ref before any remote lookup runs (Issue #148).
  // Named for this slot so the failure says which argument was refused.
  try {
    assertSafeGitRef(branchName, "push branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  // Issue #4165: do not push a checkout that does not extend the head this
  // pass started from. An in-sync short-circuit below would otherwise report
  // success for history that is not this pass's work.
  const lineage = await refuseUnlessHeadExtends(options);
  if (!lineage.ok) return lineage;

  // Count what the branch's *own* remote head is missing (Issue #211). The
  // old probe pair — `origin/<branch>..HEAD`, falling back to
  // `HEAD --not --remotes=origin` — reports "commits ahead of the default
  // branch" on any clone without a remote-tracking ref for this branch (a
  // single-branch clone never gains one, even after a successful push), so a
  // fully pushed branch looked four commits behind.
  const stateResult = await describeUnpushedCommits(branchName, options);
  if (!stateResult.ok) {
    return { ok: false, error: stateResult.error };
  }
  const unpushedCount = stateResult.value.count;

  // Short-circuit only when the branch exists on the remote and holds every
  // local commit. When it does not exist yet we still push, so `-u` creates
  // the upstream ref.
  if (stateResult.value.sha !== null && unpushedCount === 0) {
    return { ok: true, value: 0 };
  }

  // Use -u so the first push sets the upstream tracking ref. This is a
  // no-op when the ref is already configured, so it is safe for both the
  // first-time push and subsequent pushes. The branch is routed through
  // `buildPushArgs` (Issue #148), which rejects a dash-leading name and
  // inserts `--end-of-options` so git can only read it as a refspec — this
  // is the push every automated commit uses, WIP preservation included.
  let pushArgs: string[];
  try {
    pushArgs = buildPushArgs("origin", branchName, { setUpstream: true });
  } catch (err) {
    // A refused ref is a loud failure Result, never a silent skip: the
    // caller reports it exactly as it reports any other push failure.
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  const pushResult = await runGitCommand(pushArgs, options);

  if (!pushResult.ok) {
    return { ok: false, error: pushResult.error };
  }

  if (pushResult.value.code !== 0) {
    const pushOutput = pushResult.value.stderr + pushResult.value.stdout;

    // Self-healing: attempt recovery from non-fast-forward rejection (Issue #186)
    if (detectPushRejection(pushOutput)) {
      const recoveryResult = await recoverFromPushRejection(
        branchName,
        options,
        undefined,
        beforePush,
      );
      if (recoveryResult.ok) {
        return { ok: true, value: unpushedCount };
      }
      // Issue #211: the recovery error names the step that failed — fetch,
      // merge (conflict), or the plain retry push (Issue #2808) — and carries
      // git's stderr. Dropping it left callers logging a bare
      // "push failed" with nothing to act on.
      return {
        ok: false,
        error: new Error(
          `Failed to push unpushed commits: ${pushOutput}\n` +
            `Recovery from the rejection also failed: ${recoveryResult.error.message}`,
        ),
      };
    }

    return {
      ok: false,
      error: new Error(`Failed to push unpushed commits: ${pushOutput}`),
    };
  }

  return { ok: true, value: unpushedCount };
}

/**
 * Merge `baseBranch` into the checked-out PR branch just before its fix is
 * pushed, so the fix and the branch update go out together (owner rule
 * 2026-11-03).
 *
 * Acts only when there is something to push to a branch that already exists
 * on origin: a pass with no fix pushes nothing, as before, and a brand-new
 * branch is brought up to date by the PR-raise sync instead. The merge is the
 * PR-raise sync's own (`ensureBranchCurrent` with `mergeOntoBase`): a plain
 * merge commit, never a rebase or force-push, refused on a dirty tree, and
 * aborted on a conflict so the fix is pushed as before and the conflict lane
 * takes over. Never fails the push.
 *
 * @returns What the sync did, or `undefined` when it had nothing to do.
 */
export async function mergeBaseBeforePush(
  branchName: string,
  baseBranch: string,
  options: GitCommandOptions = {},
): Promise<BranchCurrencyOutcome | undefined> {
  const state = await describeUnpushedCommits(branchName, options);
  if (!state.ok || state.value.sha === null || state.value.count === 0) {
    return undefined;
  }
  const outcome = await ensureBranchCurrent({
    branch: branchName,
    baseBranch,
    runGit: runGitCommand,
    cwd: options.cwd,
    rebase: mergeOntoBase,
    log: (message) => console.log(message),
  });
  if (outcome.kind === "declined" || outcome.kind === "unknown") {
    console.warn(
      `Pushing '${branchName}' without '${baseBranch}' merged in, so CI may ` +
        `run again when the branch is updated: ${outcome.detail}`,
    );
  }
  return outcome;
}

/**
 * The PR's base branch: the one the caller already knows, otherwise read from
 * GitHub. `undefined` when it cannot be read, so the fix is pushed as before
 * rather than failing the pass.
 */
export async function prBaseForSync(
  known: string | undefined,
  repo: string,
  prNumber: number,
  gh: (args: string[]) => Promise<string>,
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<string | undefined> {
  if (known !== undefined && known.trim() !== "") return known.trim();
  try {
    const base = (await gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "baseRefName",
      "--jq",
      ".baseRefName",
    ])).trim();
    if (base !== "") return base;
    warn(`PR #${prNumber} reported no base branch; base merge unavailable`);
  } catch (error) {
    warn(
      `Could not read the base branch of PR #${prNumber}; base merge unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return undefined;
}

/**
 * The ref a failing CI cargo check is compared against for a PR repair: the
 * PR's base as `origin/<branch>`, or `""` when the base is unknown. `""` is not
 * a usable ref, so `runPrePushGate` reports such a comparison as unavailable
 * (infrastructure) rather than as a verdict, in the worker's own gate
 * ({@link CommitAndPushOptions.requireCargoBaseComparison}) and in the agent's
 * pre-push hook (`RunClaudeOptions.ciCargoCompareRef`) alike (Issue #4630).
 */
export function prBaseCompareRef(base: string | undefined): string {
  return base !== undefined && base.trim() !== ""
    ? `origin/${base.trim()}`
    : "";
}

/**
 * What {@link CommitAndPushPendingResult.finalUnpushedCount} was measured
 * against (Issue #211).
 *
 * A count is only proof that the work landed when it was taken against the
 * branch's own head on the remote, so the reference point is reported
 * alongside the number rather than left for the reader to assume.
 */
export type FinalUnpushedSource =
  /** Counted against the branch's head on origin — an authoritative answer. */
  | "remote-head"
  /** Origin has no such branch yet, so every local commit is unpushed. */
  | "remote-absent";

/**
 * Result of {@link commitAndPushPending}.
 */
export interface CommitAndPushPendingResult {
  /** Whether the helper created a new commit from previously uncommitted changes. */
  committedNewChanges: boolean;
  /** Number of commits actually pushed to origin. */
  commitsPushed: number;
  /** Number of commits still unpushed after the push attempt (0 = clean). */
  finalUnpushedCount: number;
  /** What {@link finalUnpushedCount} was measured against. */
  finalUnpushedSource: FinalUnpushedSource;
}

/**
 * Result of {@link unstageWorkerStateFiles}.
 */
export interface UnstageWorkerStateResult {
  /** How many staged paths remain — 0 means there is nothing real to commit. */
  remainingStaged: number;
}

/**
 * Stage with intent — drop the worker's own state files from the index
 * (Issue #1661, part of #1644; Issue #1711).
 *
 * The worker writes `.heartbeat_<owner>_<repo>_<n>` and
 * `.heartbeat-marker_<owner>_<repo>_<n>` into the directory it runs from
 * (and, before Issue #1652, `.vibe_default_branch` — older clones may still
 * carry one), and its prompts ask the agent to write its PR reply
 * into `.pr_response_message` there (Issue #1711). When that is a repository
 * clone, `git add -A` stages them and the pre-commit safety gate (Issue #1758)
 * refuses the entire commit — a merge-conflict resolution or a CI fix is lost
 * over a file the worker itself put there.
 *
 * So this runs BETWEEN `git add -A` and the gate: the gate never sees them and
 * is left completely unchanged, and a genuinely hidden or secret-bearing file
 * is still refused exactly as before. Each unstaged path is warned about
 * rather than swallowed — a heartbeat or cache file in the tree is a bug worth
 * seeing — but it is not a reason to fail the commit. The file itself is
 * untouched on disk; only the index entry goes. That matters for the reply:
 * `readPrResponseMessage` consumes it *after* the push.
 *
 * A failing `git reset` is returned as an error, never ignored: carrying
 * worker state into the gate is precisely what this exists to prevent.
 */
export async function unstageWorkerStateFiles(
  options: GitCommandOptions,
): Promise<Result<UnstageWorkerStateResult>> {
  const inspection = await inspectStagedFiles(options);
  if (!inspection.ok) {
    return { ok: false, error: inspection.error };
  }

  const staged = [...inspection.value.violations, ...inspection.value.safe];
  const workerState = staged.filter(isWorkerStatePath);
  const remainingStaged = staged.length - workerState.length;

  if (workerState.length === 0) {
    return { ok: true, value: { remainingStaged } };
  }

  // `--` guards the path list; `git reset -- <paths>` also behaves on an
  // unborn HEAD, where it resets the named paths against the empty tree.
  const resetResult = await runGitCommand(
    ["reset", "--", ...workerState],
    options,
  );
  if (!resetResult.ok) {
    return { ok: false, error: resetResult.error };
  }
  if (resetResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        "Failed to unstage worker-owned state files (Issue #1661): " +
          `${resetResult.value.stderr.trim()}`,
      ),
    };
  }

  console.warn(
    "[git-push] Unstaged worker-owned state file(s) before the pre-commit " +
      "safety gate (Issue #1661) — the worker wrote these into the clone, " +
      "which is itself a bug worth fixing:\n" +
      workerState.map((p) => `  - ${p}`).join("\n"),
  );

  return { ok: true, value: { remainingStaged } };
}

/**
 * Unstage the worker's own state files, then run the pre-commit safety gate
 * when anything real remains staged (Issue #4394).
 *
 * When nothing remains staged there is nothing to gate, so the gate is skipped
 * and the caller sees `remainingStaged === 0`. A failure from either step is
 * returned as an error.
 */
export async function unstageStateAndAssertSafe(
  options: GitCommandOptions,
): Promise<Result<UnstageWorkerStateResult>> {
  const unstaged = await unstageWorkerStateFiles(options);
  if (!unstaged.ok) return unstaged;
  if (unstaged.value.remainingStaged === 0) return unstaged;

  const safe = await assertSafeToCommit(options);
  return safe.ok ? unstaged : { ok: false, error: safe.error };
}

/**
 * Head and tail budgets for the gate output carried in a returned error (PR
 * #3716 review). The head holds the line that names the failing command; the
 * tail holds the end of its output. The error reaches a PR comment (the
 * PR-processor "fixed locally but failed to push" reply), and GitHub refuses a
 * comment body over 65,536 characters; a few KB stays far under it.
 */
export const PRE_PUSH_GATE_REASON_HEAD_CHARS = 2000;
export const PRE_PUSH_GATE_REASON_TAIL_CHARS = 2000;

/** Redact a gate's output, then keep only its head and tail. */
function capGateText(text: string): string {
  return redactedHeadTail(
    text,
    PRE_PUSH_GATE_REASON_HEAD_CHARS,
    PRE_PUSH_GATE_REASON_TAIL_CHARS,
  );
}

/**
 * The pre-push gate gave a verdict on the branch's content (PR #3716 review):
 * a changed-file or pre-flight command failed, or a plan could not be built.
 * {@link gateUnpushedCommits} returns
 * any other error (a git or remote lookup that failed or timed out) as an
 * infrastructure error,
 * so a caller that blames the branch for a failed gate can tell the two apart.
 */
export class PrePushGateBlockedError extends Error {
  readonly kind = "verdict" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PrePushGateBlockedError";
  }
}

/**
 * What {@link gateUnpushedCommits} found, so a caller can log it (Issue
 * #3770): `noop` ran no check because nothing needed gating — no unpushed
 * commit, or no commit of the branch's own ahead of `baseRef` — and `passed`
 * ran and names the changed-file checks that passed (the repo's pre-flight
 * commands, when configured, run too and are not listed).
 */
export type PrePushGateOutcome =
  | { kind: "noop" }
  | { kind: "passed"; checksRun: string[] };

/**
 * Run the pre-push gate over the commits about to be pushed (Issue #3689).
 *
 * A no-op when nothing is unpushed. Synthesises the stdin git would hand a
 * pre-push hook (`<local ref> <local sha> <remote ref> <remote sha>`), using
 * forty zeros when the branch has no local tracking ref. Pre-flight commands
 * are skipped when Step 1 already ran them this call. Any failure — including
 * being unable to determine the state — is returned as an error so the caller
 * refuses to push (fail closed), except a failing CI cargo check that fails the
 * same way on `compareRef` (the PR base), which `runPrePushGate` logs as a
 * `[PRE_PUSH_WARNING]` and lets through. Only a verdict on the branch's content is a
 * {@link PrePushGateBlockedError}; a failed git or remote lookup is a
 * `PrePushGateInfrastructureError` with no `[PRE_PUSH_BLOCKED]`
 * prefix, so it is not reported as the branch failing its checks.
 *
 * With `baseRef` the gate covers every non-merge commit the branch has ahead
 * of that ref, pushed or not (Issue #3689): the execute phase's WIP
 * checkpoints push the agent's commits ungated, so the completion phase
 * checks the whole branch before it raises the PR. It is a no-op only when
 * the branch has no commit of its own ahead of `baseRef`. That mode never
 * reads the remote head: the range is local, so no `ls-remote` or `fetch` runs.
 *
 * `compareRef` (the PR base, for a repair push) lets the CI cargo checks tell a
 * failure the base already has from a new one; with a `baseRef` it defaults to
 * that ref.
 */
export async function gateUnpushedCommits(
  branchName: string,
  options: GitCommandOptions,
  preFlight: PreFlightGateSpec,
  preFlightAlreadyRan = false,
  baseRef?: string,
  compareRef?: string,
): Promise<
  Result<
    PrePushGateOutcome,
    PrePushGateBlockedError | PrePushGateInfrastructureError
  >
> {
  let remoteSha = "0".repeat(40);
  if (baseRef === undefined) {
    const state = await describeUnpushedCommits(branchName, options);
    if (!state.ok) {
      return {
        ok: false,
        error: new PrePushGateInfrastructureError(state.error.message, {
          cause: state.error,
        }),
      };
    }
    if (state.value.count === 0) return { ok: true, value: { kind: "noop" } };
    if (state.value.source === "tracking-ref" && state.value.sha) {
      remoteSha = state.value.sha;
    }
  } else {
    // Whole-branch mode: WIP checkpoints may already have pushed the commits,
    // so "nothing unpushed" says nothing. Skip only when the branch has no
    // commit of its own ahead of the base.
    try {
      assertSafeGitRef(baseRef, "gate base ref");
    } catch (error) {
      return {
        ok: false,
        error: new PrePushGateBlockedError(
          `[PRE_PUSH_BLOCKED] ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      };
    }
    const ahead = await runGitCommand(
      ["rev-list", "--count", "--no-merges", `${baseRef}..HEAD`],
      options,
    );
    if (!ahead.ok) {
      return {
        ok: false,
        error: new PrePushGateInfrastructureError(ahead.error.message, {
          cause: ahead.error,
        }),
      };
    }
    const aheadCount = Number.parseInt(ahead.value.stdout.trim(), 10);
    if (ahead.value.code !== 0 || !Number.isFinite(aheadCount)) {
      return {
        ok: false,
        error: new PrePushGateInfrastructureError(
          `git rev-list ${baseRef}..HEAD failed: ${
            ahead.value.stderr.trim() || `exit ${ahead.value.code}`
          }`,
        ),
      };
    }
    if (aheadCount === 0) return { ok: true, value: { kind: "noop" } };
  }

  const head = await runGitCommand(["rev-parse", "HEAD"], options);
  if (!head.ok) {
    return {
      ok: false,
      error: new PrePushGateInfrastructureError(head.error.message, {
        cause: head.error,
      }),
    };
  }
  if (head.value.code !== 0) {
    return {
      ok: false,
      error: new PrePushGateInfrastructureError(
        `git rev-parse HEAD failed: ${head.value.stderr.trim()}`,
      ),
    };
  }
  const ref = `refs/heads/${branchName}`;
  // Loaded here, not imported at the top: a static import would put the YAML
  // parser (`@std/yaml/parse`) into the graph of the agent's pre-push hook.
  // This module is never reached from the hook's entry point; only the
  // worker's own gates call it.
  const { repoCiCargoChecks } = await import("./ci_cargo_checks.ts");
  const gate = await runPrePushGate({
    cwd: options.cwd ?? Deno.cwd(),
    stdin: `${ref} ${head.value.stdout.trim()} ${ref} ${remoteSha}\n`,
    preFlightCommands: preFlightAlreadyRan ? [] : preFlight.commands,
    shellcheckOnly: preFlight.shellcheckOnly,
    timeoutSeconds: preFlight.timeoutSeconds,
    runner: preFlight.runner,
    ciCargoOnly: preFlight.ciCargoOnly,
    findCiCargo: repoCiCargoChecks,
    baseRef,
    compareRef,
  });
  if (!gate.ok) {
    // A lookup that failed is not a verdict: pass it on unmarked.
    if (gate.error instanceof PrePushGateInfrastructureError) {
      return { ok: false, error: gate.error };
    }
    return {
      ok: false,
      error: new PrePushGateBlockedError(
        `[PRE_PUSH_BLOCKED] ${capGateText(gate.error.message)}\n` +
          `Unpushed commits on ${branchName} were not pushed.`,
        { cause: gate.error },
      ),
    };
  }
  return {
    ok: true,
    value: { kind: "passed", checksRun: gate.value.checksRun },
  };
}

/**
 * Commit any uncommitted working-tree changes and push every unpushed commit
 * to origin (Issue #1643 — "Why we forget to push?").
 *
 * The Vibe Coder runs unattended. Phase processors used to gate the push
 * step on Claude's stdout output (`claudeOutput.length > 0`), which is not
 * a reliable signal of whether commits exist locally. When Claude committed
 * silently — or left uncommitted changes — the push step was skipped and
 * the work was lost on the local machine. This helper closes that gap by
 * using git itself as the source of truth:
 *
 *   1. `git status --porcelain` — if dirty, stage and commit with the
 *      provided message.
 *   1a. Step 1a — when `formatBeforeGate` is supplied, it runs (the PR
 *      processors pass the repository's formatters over the unpushed
 *      commits, which commit their own result). It cannot fail the call: a
 *      throw is logged and Step 1b still checks everything.
 *   1b. Step 1b — when `preFlight` is supplied, `gateUnpushedCommits` runs
 *      the changed-file pre-push checks (`runPrePushGate`) over the unpushed
 *      commits, including any the agent committed but never pushed (nothing
 *      runs when no commit is unpushed). When Step 1 committed nothing it
 *      also re-runs the repo's pre-flight commands; when Step 1 committed,
 *      those commands already ran there and are not repeated. A spec with
 *      `ciCargoOnly` (Issue #4630) runs only the repo CI's cargo clippy and
 *      test-target compile, the ShellCheck policy and cargo deny for changed
 *      cargo inputs (Issue #4626), in this step. A block
 *      refuses the push. With no pre-flight spec Step 1b does not run, so
 *      WIP checkpoint pushes are never refused. The gate output in the
 *      returned error is cut to a head and a tail (as is Step 1's pre-flight
 *      block), because PR processors post it in a comment. A caller that omits
 *      `preFlight` gets no Step 1b at all, so the push is ungated.
 *   1c. Step 1c — when `options.syncBaseBranch` is set and there is a fix to
 *      push to an existing branch, {@link mergeBaseBeforePush} merges that
 *      base in, so the fix and the branch update go out in one push.
 *   2. `pushUnpushedCommits` — push every commit ahead of origin (handles
 *      first-time push and non-fast-forward recovery internally).
 *   3. Re-count unpushed commits against the branch's own remote head —
 *      `finalUnpushedCount` MUST be 0, and `finalUnpushedSource` names what
 *      that count was measured against, for the caller to claim the push
 *      succeeded honestly.
 *
 * Callers should always invoke this at the end of any Claude-driven phase.
 * It is idempotent — when there is nothing to commit and nothing to push
 * it reports `committedNewChanges: false, commitsPushed: 0` and a
 * `finalUnpushedCount` of 0.
 *
 * @param branchName - The branch to push
 * @param commitMessage - Commit message used when staging dirty working-tree changes
 * @param options - Git command options
 * @param allowDefaultBranch - Opt-out for the read-only default-branch guard
 *   (Issue #2584). Defaults to `false` (forbid pushing to the default branch).
 * @param preFlight - Optional mandatory pre-flight gate (Issue #3577). When
 *   supplied with a non-empty `commands` list, the commands run at the
 *   `assertSafeToCommit()` chokepoint before the automated commit, and again
 *   in Step 1b when Step 1 committed nothing and unpushed commits exist; the
 *   first non-zero exit (or a command that cannot be started, or a timeout)
 *   blocks BOTH the commit and the push. There is no override flag. Supplying
 *   a spec, even one with an empty `commands` list, also turns on Step 1b's
 *   changed-file checks (Issue #3689). Omit to leave the repo unaffected
 *   (zero added latency, no gate); a `shellcheckOnly` spec runs the
 *   repository ShellCheck policy, plus the CI cargo-deny check when the pushed
 *   paths include a cargo input (Issues #4631 and #4626). A spec with
 *   `ciCargoOnly` narrows Step 1b to the repo CI's cargo checks, that
 *   ShellCheck policy and the same cargo-deny check (Issue #4630).
 * @param runId - Run id stamped into the `Vibe-Coder-Run-Id` commit trailer
 *   (Issue #963). Omit in production: it then falls back to {@link getRunId},
 *   which reads `VIBE_RUN_ID` and generates-and-caches one when unset, exactly
 *   as before. Supplying it is what lets a test prove the trailer without
 *   setting `VIBE_RUN_ID` on the process — a mutation that races every other
 *   test in the run (Issue #880). The value is stamped verbatim; the trailer's
 *   format is `appendRunIdTrailer`'s and is unaffected by where the id came
 *   from.
 * @param formatBeforeGate - Optional Step 1a hook, run after Step 1's commit
 *   and before Step 1b's gate whether or not `preFlight` is supplied. Never
 *   fatal.
 * @returns Result with details of what was committed and pushed
 */
export async function commitAndPushPending(
  branchName: string,
  commitMessage: string,
  options: PushLineageOptions = {},
  allowDefaultBranch = false,
  preFlight?: PreFlightGateSpec,
  runId?: string,
  formatBeforeGate?: () => Promise<void>,
  beforePush?: () => Promise<Result<void>>,
): Promise<Result<CommitAndPushPendingResult>> {
  // Read-only default-branch guard (Issue #2584) — refuse up front, before
  // staging or committing anything, when the target is the default branch.
  const guard = await assertPushTargetAllowed(
    branchName,
    options,
    allowDefaultBranch,
  );
  if (!guard.ok) {
    return { ok: false, error: guard.error };
  }

  // Issue #4165: refuse before staging or committing when the checkout is
  // not the pass's own history. Committing onto it would only add to the
  // history the push below is about to refuse.
  const lineage = await refuseUnlessHeadExtends(options);
  if (!lineage.ok) return lineage;

  // Step 1 — detect uncommitted changes.
  const statusResult = await runGitCommand(["status", "--porcelain"], options);
  if (!statusResult.ok) {
    return { ok: false, error: statusResult.error };
  }
  if (statusResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `git status failed: ${statusResult.value.stderr.trim()}`,
      ),
    };
  }

  let committedNewChanges = false;
  if (statusResult.value.stdout.trim().length > 0) {
    const addResult = await runGitCommand(["add", "-A"], options);
    if (!addResult.ok) {
      return { ok: false, error: addResult.error };
    }
    if (addResult.value.code !== 0) {
      return {
        ok: false,
        error: new Error(`git add failed: ${addResult.value.stderr.trim()}`),
      };
    }

    // Stage with intent (Issues #1661, #1711) — remove the worker's own
    // state files from the index before the safety gate sees them, so a
    // stray `.heartbeat_*`, `.vibe_default_branch` or the agent's
    // `.pr_response_message` in the clone can no longer cost the whole
    // commit.
    const unstageResult = await unstageWorkerStateFiles(options);
    if (!unstageResult.ok) {
      await runGitCommand(["reset", "--"], options);
      return { ok: false, error: unstageResult.error };
    }

    // Commit only when something real survived the unstaging. When
    // everything pending was worker state the index is now empty, so the
    // gates and the commit are skipped and the result reports "nothing
    // committed" honestly — rather than inventing an empty commit or failing
    // on git's "nothing added to commit".
    if (unstageResult.value.remainingStaged > 0) {
      // Pre-commit safety gate (Issue #1758) — refuse to commit any
      // hidden or secret-bearing file. On violation, unstage everything
      // so the worker does not silently carry secrets in the index.
      const safetyResult = await assertSafeToCommit(options);
      if (!safetyResult.ok) {
        await runGitCommand(["reset", "--"], options);
        return { ok: false, error: safetyResult.error };
      }

      // Pre-flight enforcement gate (Issue #3577) — run the repo's configured
      // mandatory pre-flight commands at this same chokepoint. A non-zero exit,
      // a command that cannot be started, or a timeout is a hard BLOCK: return
      // before the commit so BOTH the commit and the push are refused. There is
      // no override. On block, unstage so the worker does not silently carry the
      // broken change in the index. The captured command output rides on the
      // returned error so the fixer sees the real failure, not a bare
      // "pre-flight failed".
      if (preFlight && preFlight.commands.length > 0) {
        const gateResult = await runPreFlightGate(preFlight.commands, {
          cwd: options.cwd,
          env: options.env,
          timeoutSeconds: preFlight.timeoutSeconds,
          runner: preFlight.runner,
        });
        if (!gateResult.ok) {
          await runGitCommand(["reset", "--"], options);
          // Capped like Step 1b's: the message reaches a PR comment.
          const capped = capGateText(gateResult.error.message);
          return {
            ok: false,
            error: capped === gateResult.error.message
              ? gateResult.error
              : new Error(capped, { cause: gateResult.error }),
          };
        }
      }

      // Run-id traceability (Issue #2381) — stamp the commit with the
      // canonical run id so the push is attributable to a specific worker
      // run. assertRunIdTrailer is the pre-commit gate; appendRunIdTrailer
      // guarantees it passes for worker-authored commits.
      const finalMessage = appendRunIdTrailer(
        commitMessage,
        runId ?? getRunId(),
      );
      const trailerGate = assertRunIdTrailer(finalMessage);
      if (!trailerGate.ok) {
        await runGitCommand(["reset", "--"], options);
        return { ok: false, error: trailerGate.error };
      }

      const commitResult = await runGitCommand(
        ["commit", "-m", finalMessage],
        options,
      );
      if (!commitResult.ok) {
        return { ok: false, error: commitResult.error };
      }
      // `git commit` exits non-zero when there is nothing to commit. The
      // status check above means this should not happen, but be defensive.
      if (commitResult.value.code !== 0) {
        const combined =
          `${commitResult.value.stdout}\n${commitResult.value.stderr}`.trim();
        // Tolerate "nothing to commit" — treat as no new commit.
        if (!/nothing to commit/i.test(combined)) {
          return {
            ok: false,
            error: new Error(`git commit failed: ${combined}`),
          };
        }
      } else {
        committedNewChanges = true;
      }
    }
  }

  // Step 1a — the repository's formatters over the unpushed commits, now
  // including Step 1's (follow-up to #3806). A formatting-only miss is fixed
  // and committed here rather than failing Step 1b, or — with no pre-flight
  // configured — reaching CI. Never fatal: a hook that throws is logged and
  // Step 1b still checks everything.
  if (formatBeforeGate) {
    try {
      await formatBeforeGate();
    } catch (error) {
      console.warn(
        `repo formatters: skipped before the push gate: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Step 1b — gate commits the agent made but never pushed itself (Issue
  // #3689). The agent's per-run pre-push hook only covers the agent's own
  // `git push`; these commits would otherwise leave ungated by the
  // changed-file checks. Final-mile callers (those passing `preFlight`) only.
  if (preFlight) {
    const gate = await gateUnpushedCommits(
      branchName,
      options,
      preFlight,
      committedNewChanges,
      undefined,
      // A CI cargo failure the PR base already has is no verdict on this push.
      (options.compareBaseBranch ?? options.syncBaseBranch)
        ? `origin/${options.compareBaseBranch ?? options.syncBaseBranch}`
        : options.requireCargoBaseComparison
        ? ""
        : undefined,
    );
    if (!gate.ok) {
      return { ok: false, error: gate.error };
    }
  }

  // Issue #3784: inspect the committed, formatted head before it leaves the host.
  // Unlike formatting, this callback is a gate: an error prevents the push.
  if (beforePush) {
    const verified = await beforePush();
    if (!verified.ok) return verified;
  }

  // Step 1c — bring an open PR's branch up to date with its base in this
  // same push (owner rule 2026-11-03). Every push to an open PR runs the full
  // CI; a fix pushed onto a branch that is behind leaves the PR BEHIND, and
  // the later branch update runs CI a second time for the same fix. Placed
  // after the gates, so they judge only this pass's own commits.
  if (options.syncBaseBranch) {
    await mergeBaseBeforePush(branchName, options.syncBaseBranch, options);
  }

  // Step 2 — push any unpushed commits. pushUnpushedCommits handles
  // first-time push and non-fast-forward recovery internally. The
  // default-branch guard already ran above, so skip the redundant re-check
  // (Issue #2584).
  const pushResult = await pushUnpushedCommits(
    branchName,
    options,
    true,
    beforePush,
  );
  if (!pushResult.ok) {
    return { ok: false, error: pushResult.error };
  }

  // Step 3 — verify the branch is in sync with origin. This is the honest
  // post-condition the caller needs: 0 means we did our job; >0 means we
  // still have local work that the user is being lied to about.
  //
  // Issue #211: counted against this branch's own remote head. The previous
  // `HEAD --not --remotes=origin` counted commits ahead of the default branch
  // whenever no remote-tracking ref existed for the branch, so a successful
  // push reported `commitsPushed=4 finalUnpushedCount=4` — self-contradictory,
  // and enough to trigger a bogus recovery and a "please check the branch
  // status" comment to a human. A count that cannot be determined is an error,
  // never a silent 0.
  const remainingResult = await describeUnpushedCommits(branchName, options);
  if (!remainingResult.ok) {
    return { ok: false, error: remainingResult.error };
  }

  return {
    ok: true,
    value: {
      committedNewChanges,
      commitsPushed: pushResult.value,
      finalUnpushedCount: remainingResult.value.count,
      finalUnpushedSource: remainingResult.value.sha === null
        ? "remote-absent"
        : "remote-head",
    },
  };
}

/** Default gh command runner — routed through the shared chokepoint. */
async function defaultGhCommand(args: string[]): Promise<string> {
  return await runGhOrThrow(args);
}

/**
 * Ensure the local default branch is current with the remote (Issue #230).
 *
 * @param defaultBranch - The name of the default branch
 * @param options - Git command options
 * @returns Result indicating success
 */
export async function ensureDefaultBranchCurrent(
  defaultBranch: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  // The default branch (once read from `.vibe_default_branch` inside the
  // clone, Issue #1269; now from `.git/vibe/default_branch`, Issue #1652)
  // reaches git as a positional here and in the `git branch -f` below, and is
  // interpolated
  // into `origin/<branch>` — so it is validated as a ref *component*, not
  // merely checked for a leading dash.
  try {
    assertSafeRefComponent(defaultBranch, "default branch name");
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  // Fetch the latest changes
  const fetchResult = await runGitCommandChecked(
    buildFetchArgs("origin", defaultBranch),
    options,
  );

  // Issue #4358: git's stderr, a timeout, or a spawn error. Same wording as
  // the fetch failure in git_branch_sync.ts — dropping the detail left the
  // milestone tip log with no reason.
  if (!fetchResult.ok) {
    const detail = fetchResult.error.message.trim();
    return {
      ok: false,
      error: new Error(
        `Failed to fetch origin/${defaultBranch}: ${
          detail || "git reported no output"
        }`,
      ),
    };
  }

  // Check current branch
  const currentBranchResult = await runGitCommand(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    options,
  );

  const currentBranch = currentBranchResult.ok
    ? currentBranchResult.value.stdout.trim()
    : "";

  if (currentBranch === defaultBranch) {
    // If on the default branch, reset to remote
    await runGitCommand(
      ["reset", "--hard", `origin/${defaultBranch}`],
      options,
    );
  } else {
    // Update the local ref without checking out
    await runGitCommand(
      ["branch", "-f", defaultBranch, `origin/${defaultBranch}`],
      options,
    );
  }

  return {
    ok: true,
    value: `Local ${defaultBranch} is now current with origin`,
  };
}
