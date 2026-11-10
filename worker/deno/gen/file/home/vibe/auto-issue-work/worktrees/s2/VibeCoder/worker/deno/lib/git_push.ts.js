/**
 * Git push operations (Issue #912).
 *
 * Provides functions for pushing commits, detecting push rejections,
 * detecting existing PRs, and finding open PRs.
 *
 * Migrated from worker/shared/git_operations.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { runGitCommand, runGitCommandChecked } from "./git_timeout.ts";
import { recoverFromPushRejection, refuseUnlessHeadExtends } from "./git_push_recovery.ts";
import { describeUnpushedCommits } from "./git_remote_head.ts";
import { ensureBranchCurrent } from "./branch_currency.ts";
import { mergeOntoBase } from "./pr_raise_sync.ts";
import { assertSafeGitRef, assertSafeRefComponent, buildFetchArgs, buildPushArgs } from "./git_ref_args.ts";
import { assertSafeToCommit, inspectStagedFiles } from "./pre_commit_safety.ts";
import { isWorkerStatePath } from "./worker_state_paths.ts";
import { runPreFlightGate } from "./pre_flight_gate.ts";
import { redactedHeadTail } from "./redacted_text.ts";
import { PrePushGateInfrastructureError, runPrePushGate } from "./pre_push_gate.ts";
import { getPreFlightCommands } from "./repo_config.ts";
import { appendRunIdTrailer, assertRunIdTrailer, getRunId } from "./run_id.ts";
import { runGhOrThrow } from "./gh_spawn.ts";
/**
 * Resolve a repo's pre-flight gate into a {@link PreFlightGateSpec}, or
 * `undefined` when the repo has no gate configured (Issue #3577).
 *
 * A convenience for the automated-commit call sites: pass the result straight
 * to {@link commitAndPushPending}. Returns `undefined` (not an empty spec) so
 * a caller that passes it straight through leaves a repo with no entry
 * ungated; the issue completion phase substitutes `{ commands: [] }` instead,
 * so it still runs the changed-file checks (Issue #3689), and the PR repair
 * processors use {@link resolveRepairPreFlightSpec}. Throws on malformed
 * config via `getPreFlightCommands` — but config is already validated at load
 * (Issue #3577), so this is defence in depth.
 */ export function resolvePreFlightSpec(repoConfigs, repo) {
  const commands = getPreFlightCommands(repoConfigs, repo);
  return commands.length > 0 ? {
    commands
  } : undefined;
}
/**
 * {@link resolvePreFlightSpec} for the PR repair processors (CI-fix, review
 * feedback, spelling, merge conflict): a repo with no pre-flight commands
 * still gets the ShellCheck publication check, plus the CI cargo-deny check
 * when the pushed paths include a cargo input, and nothing else, before the
 * repair is pushed (Issues #4631 and #4626). WIP checkpoint, timeout-preservation and
 * declared hand-off pushes never call this; they stay ungated on purpose.
 */ export function resolveRepairPreFlightSpec(repoConfigs, repo) {
  return resolvePreFlightSpec(repoConfigs, repo) ?? {
    commands: [],
    shellcheckOnly: true
  };
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
 */ export function detectPushRejection(pushOutput) {
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
 */ export function detectExistingPr(errorOutput) {
  if (!errorOutput) return null;
  if (!/already exists/i.test(errorOutput)) return null;
  const match = errorOutput.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  return match ? match[0] : null;
}
/**
 * Find an open PR for a given branch (Issue #386).
 *
 * @param repo - Repository in "owner/repo" format
 * @param branchName - The head branch to search for
 * @param ghCommandFn - Injected gh command function (for testing)
 * @returns Result with the PR URL if found
 */ export async function findOpenPrForBranch(repo, branchName, ghCommandFn) {
  if (!branchName) {
    return {
      ok: true,
      value: null
    };
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
      ".[0].url"
    ]);
    const prUrl = output.trim();
    return {
      ok: true,
      value: prUrl || null
    };
  } catch (error) {
    return {
      ok: false,
      error: new Error(`Failed to find open PR for branch '${branchName}': ${error instanceof Error ? error.message : String(error)}`)
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
 */ export async function recoverExistingPr(repo, issueNumber, prUrl, prBody, ghCommandFn) {
  if (!prUrl) {
    return {
      ok: false,
      error: new Error("Empty PR URL")
    };
  }
  const messages = [
    `SELF-HEALING: Found existing PR for issue #${issueNumber}: ${prUrl}`,
    "SELF-HEALING: A previous run likely created this PR before timing out"
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
        prBody
      ]);
      messages.push("SELF-HEALING: PR body updated successfully");
    } catch (err) {
      console.warn(`[git-push] Failed to update PR body for PR #${prNumber} in ${repo}: ${err instanceof Error ? err.message : String(err)}`);
      messages.push("Failed to update PR body (non-fatal)");
    }
  }
  messages.push("SELF-HEALING: Treating as successful — no need to create a new PR");
  return {
    ok: true,
    value: messages.join("\n")
  };
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
 */ export async function resolveLocalDefaultBranch(options = {}) {
  const result = await runGitCommand([
    "symbolic-ref",
    "refs/remotes/origin/HEAD"
  ], options);
  if (result.ok && result.value.code === 0) {
    const branch = result.value.stdout.trim().replace("refs/remotes/origin/", "");
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
 */ export async function assertPushTargetAllowed(branchName, options = {}, allowDefaultBranch = false) {
  if (allowDefaultBranch) return {
    ok: true,
    value: undefined
  };
  const defaultBranch = await resolveLocalDefaultBranch(options);
  if (defaultBranch !== null && branchName === defaultBranch) {
    return {
      ok: false,
      error: new Error(`Refusing to push to the default branch '${branchName}': the default ` + `branch is read-only for the worker and may only change via a ` + `verified merge (Issue #2584). Push to a feature or milestone ` + `branch instead.`)
    };
  }
  return {
    ok: true,
    value: undefined
  };
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
 */ export async function pushUnpushedCommits(branchName, options = {}, allowDefaultBranch = false, beforePush) {
  // Read-only default-branch guard (Issue #2584) — refuse before doing any
  // work when the target is the repo's default branch.
  const guard = await assertPushTargetAllowed(branchName, options, allowDefaultBranch);
  if (!guard.ok) {
    return {
      ok: false,
      error: guard.error
    };
  }
  // Refuse an option-injecting ref before any remote lookup runs (Issue #148).
  // Named for this slot so the failure says which argument was refused.
  try {
    assertSafeGitRef(branchName, "push branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err))
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
    return {
      ok: false,
      error: stateResult.error
    };
  }
  const unpushedCount = stateResult.value.count;
  // Short-circuit only when the branch exists on the remote and holds every
  // local commit. When it does not exist yet we still push, so `-u` creates
  // the upstream ref.
  if (stateResult.value.sha !== null && unpushedCount === 0) {
    return {
      ok: true,
      value: 0
    };
  }
  // Use -u so the first push sets the upstream tracking ref. This is a
  // no-op when the ref is already configured, so it is safe for both the
  // first-time push and subsequent pushes. The branch is routed through
  // `buildPushArgs` (Issue #148), which rejects a dash-leading name and
  // inserts `--end-of-options` so git can only read it as a refspec — this
  // is the push every automated commit uses, WIP preservation included.
  let pushArgs;
  try {
    pushArgs = buildPushArgs("origin", branchName, {
      setUpstream: true
    });
  } catch (err) {
    // A refused ref is a loud failure Result, never a silent skip: the
    // caller reports it exactly as it reports any other push failure.
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err))
    };
  }
  const pushResult = await runGitCommand(pushArgs, options);
  if (!pushResult.ok) {
    return {
      ok: false,
      error: pushResult.error
    };
  }
  if (pushResult.value.code !== 0) {
    const pushOutput = pushResult.value.stderr + pushResult.value.stdout;
    // Self-healing: attempt recovery from non-fast-forward rejection (Issue #186)
    if (detectPushRejection(pushOutput)) {
      const recoveryResult = await recoverFromPushRejection(branchName, options, undefined, beforePush);
      if (recoveryResult.ok) {
        return {
          ok: true,
          value: unpushedCount
        };
      }
      // Issue #211: the recovery error names the step that failed — fetch,
      // merge (conflict), or the plain retry push (Issue #2808) — and carries
      // git's stderr. Dropping it left callers logging a bare
      // "push failed" with nothing to act on.
      return {
        ok: false,
        error: new Error(`Failed to push unpushed commits: ${pushOutput}\n` + `Recovery from the rejection also failed: ${recoveryResult.error.message}`)
      };
    }
    return {
      ok: false,
      error: new Error(`Failed to push unpushed commits: ${pushOutput}`)
    };
  }
  return {
    ok: true,
    value: unpushedCount
  };
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
 */ export async function mergeBaseBeforePush(branchName, baseBranch, options = {}) {
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
    log: (message)=>console.log(message)
  });
  if (outcome.kind === "declined" || outcome.kind === "unknown") {
    console.warn(`Pushing '${branchName}' without '${baseBranch}' merged in, so CI may ` + `run again when the branch is updated: ${outcome.detail}`);
  }
  return outcome;
}
/**
 * The PR's base branch: the one the caller already knows, otherwise read from
 * GitHub. `undefined` when it cannot be read, so the fix is pushed as before
 * rather than failing the pass.
 */ export async function prBaseForSync(known, repo, prNumber, gh, warn = (message)=>console.warn(message)) {
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
      ".baseRefName"
    ])).trim();
    if (base !== "") return base;
    warn(`PR #${prNumber} reported no base branch; fix pushed without it`);
  } catch (error) {
    warn(`Could not read the base branch of PR #${prNumber}; fix pushed without it: ${error instanceof Error ? error.message : String(error)}`);
  }
  return undefined;
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
 */ export async function unstageWorkerStateFiles(options) {
  const inspection = await inspectStagedFiles(options);
  if (!inspection.ok) {
    return {
      ok: false,
      error: inspection.error
    };
  }
  const staged = [
    ...inspection.value.violations,
    ...inspection.value.safe
  ];
  const workerState = staged.filter(isWorkerStatePath);
  const remainingStaged = staged.length - workerState.length;
  if (workerState.length === 0) {
    return {
      ok: true,
      value: {
        remainingStaged
      }
    };
  }
  // `--` guards the path list; `git reset -- <paths>` also behaves on an
  // unborn HEAD, where it resets the named paths against the empty tree.
  const resetResult = await runGitCommand([
    "reset",
    "--",
    ...workerState
  ], options);
  if (!resetResult.ok) {
    return {
      ok: false,
      error: resetResult.error
    };
  }
  if (resetResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error("Failed to unstage worker-owned state files (Issue #1661): " + `${resetResult.value.stderr.trim()}`)
    };
  }
  console.warn("[git-push] Unstaged worker-owned state file(s) before the pre-commit " + "safety gate (Issue #1661) — the worker wrote these into the clone, " + "which is itself a bug worth fixing:\n" + workerState.map((p)=>`  - ${p}`).join("\n"));
  return {
    ok: true,
    value: {
      remainingStaged
    }
  };
}
/**
 * Unstage the worker's own state files, then run the pre-commit safety gate
 * when anything real remains staged (Issue #4394).
 *
 * When nothing remains staged there is nothing to gate, so the gate is skipped
 * and the caller sees `remainingStaged === 0`. A failure from either step is
 * returned as an error.
 */ export async function unstageStateAndAssertSafe(options) {
  const unstaged = await unstageWorkerStateFiles(options);
  if (!unstaged.ok) return unstaged;
  if (unstaged.value.remainingStaged === 0) return unstaged;
  const safe = await assertSafeToCommit(options);
  return safe.ok ? unstaged : {
    ok: false,
    error: safe.error
  };
}
/**
 * Head and tail budgets for the gate output carried in a returned error (PR
 * #3716 review). The head holds the line that names the failing command; the
 * tail holds the end of its output. The error reaches a PR comment (the
 * PR-processor "fixed locally but failed to push" reply), and GitHub refuses a
 * comment body over 65,536 characters; a few KB stays far under it.
 */ export const PRE_PUSH_GATE_REASON_HEAD_CHARS = 2000;
export const PRE_PUSH_GATE_REASON_TAIL_CHARS = 2000;
/** Redact a gate's output, then keep only its head and tail. */ function capGateText(text) {
  return redactedHeadTail(text, PRE_PUSH_GATE_REASON_HEAD_CHARS, PRE_PUSH_GATE_REASON_TAIL_CHARS);
}
/**
 * The pre-push gate gave a verdict on the branch's content (PR #3716 review):
 * a changed-file or pre-flight command failed, or a plan could not be built.
 * {@link gateUnpushedCommits} returns
 * any other error (a git or remote lookup that failed or timed out) as an
 * infrastructure error,
 * so a caller that blames the branch for a failed gate can tell the two apart.
 */ export class PrePushGateBlockedError extends Error {
  kind = "verdict";
  constructor(message, options){
    super(message, options);
    this.name = "PrePushGateBlockedError";
  }
}
/**
 * Run the pre-push gate over the commits about to be pushed (Issue #3689).
 *
 * A no-op when nothing is unpushed. Synthesises the stdin git would hand a
 * pre-push hook (`<local ref> <local sha> <remote ref> <remote sha>`), using
 * forty zeros when the branch has no local tracking ref. Pre-flight commands
 * are skipped when Step 1 already ran them this call. Any failure — including
 * being unable to determine the state — is returned as an error so the caller
 * refuses to push (fail closed). Only a verdict on the branch's content is a
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
 */ export async function gateUnpushedCommits(branchName, options, preFlight, preFlightAlreadyRan = false, baseRef) {
  let remoteSha = "0".repeat(40);
  if (baseRef === undefined) {
    const state = await describeUnpushedCommits(branchName, options);
    if (!state.ok) {
      return {
        ok: false,
        error: new PrePushGateInfrastructureError(state.error.message, {
          cause: state.error
        })
      };
    }
    if (state.value.count === 0) return {
      ok: true,
      value: {
        kind: "noop"
      }
    };
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
        error: new PrePushGateBlockedError(`[PRE_PUSH_BLOCKED] ${error instanceof Error ? error.message : String(error)}`)
      };
    }
    const ahead = await runGitCommand([
      "rev-list",
      "--count",
      "--no-merges",
      `${baseRef}..HEAD`
    ], options);
    if (!ahead.ok) {
      return {
        ok: false,
        error: new PrePushGateInfrastructureError(ahead.error.message, {
          cause: ahead.error
        })
      };
    }
    const aheadCount = Number.parseInt(ahead.value.stdout.trim(), 10);
    if (ahead.value.code !== 0 || !Number.isFinite(aheadCount)) {
      return {
        ok: false,
        error: new PrePushGateInfrastructureError(`git rev-list ${baseRef}..HEAD failed: ${ahead.value.stderr.trim() || `exit ${ahead.value.code}`}`)
      };
    }
    if (aheadCount === 0) return {
      ok: true,
      value: {
        kind: "noop"
      }
    };
  }
  const head = await runGitCommand([
    "rev-parse",
    "HEAD"
  ], options);
  if (!head.ok) {
    return {
      ok: false,
      error: new PrePushGateInfrastructureError(head.error.message, {
        cause: head.error
      })
    };
  }
  if (head.value.code !== 0) {
    return {
      ok: false,
      error: new PrePushGateInfrastructureError(`git rev-parse HEAD failed: ${head.value.stderr.trim()}`)
    };
  }
  const ref = `refs/heads/${branchName}`;
  const gate = await runPrePushGate({
    cwd: options.cwd ?? Deno.cwd(),
    stdin: `${ref} ${head.value.stdout.trim()} ${ref} ${remoteSha}\n`,
    preFlightCommands: preFlightAlreadyRan ? [] : preFlight.commands,
    shellcheckOnly: preFlight.shellcheckOnly,
    timeoutSeconds: preFlight.timeoutSeconds,
    runner: preFlight.runner,
    baseRef
  });
  if (!gate.ok) {
    // A lookup that failed is not a verdict: pass it on unmarked.
    if (gate.error instanceof PrePushGateInfrastructureError) {
      return {
        ok: false,
        error: gate.error
      };
    }
    return {
      ok: false,
      error: new PrePushGateBlockedError(`[PRE_PUSH_BLOCKED] ${capGateText(gate.error.message)}\n` + `Unpushed commits on ${branchName} were not pushed.`, {
        cause: gate.error
      })
    };
  }
  return {
    ok: true,
    value: {
      kind: "passed",
      checksRun: gate.value.checksRun
    }
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
 *      those commands already ran there and are not repeated. A block
 *      refuses the push. With no pre-flight spec Step 1b does not run, so
 *      WIP checkpoint pushes are never refused. The gate output in the
 *      returned error is cut to a head and a tail (as is Step 1's pre-flight
 *      block), because PR processors post it in a comment.
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
 *   paths include a cargo input (Issues #4631 and #4626).
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
 */ export async function commitAndPushPending(branchName, commitMessage, options = {}, allowDefaultBranch = false, preFlight, runId, formatBeforeGate, beforePush) {
  // Read-only default-branch guard (Issue #2584) — refuse up front, before
  // staging or committing anything, when the target is the default branch.
  const guard = await assertPushTargetAllowed(branchName, options, allowDefaultBranch);
  if (!guard.ok) {
    return {
      ok: false,
      error: guard.error
    };
  }
  // Issue #4165: refuse before staging or committing when the checkout is
  // not the pass's own history. Committing onto it would only add to the
  // history the push below is about to refuse.
  const lineage = await refuseUnlessHeadExtends(options);
  if (!lineage.ok) return lineage;
  // Step 1 — detect uncommitted changes.
  const statusResult = await runGitCommand([
    "status",
    "--porcelain"
  ], options);
  if (!statusResult.ok) {
    return {
      ok: false,
      error: statusResult.error
    };
  }
  if (statusResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`git status failed: ${statusResult.value.stderr.trim()}`)
    };
  }
  let committedNewChanges = false;
  if (statusResult.value.stdout.trim().length > 0) {
    const addResult = await runGitCommand([
      "add",
      "-A"
    ], options);
    if (!addResult.ok) {
      return {
        ok: false,
        error: addResult.error
      };
    }
    if (addResult.value.code !== 0) {
      return {
        ok: false,
        error: new Error(`git add failed: ${addResult.value.stderr.trim()}`)
      };
    }
    // Stage with intent (Issues #1661, #1711) — remove the worker's own
    // state files from the index before the safety gate sees them, so a
    // stray `.heartbeat_*`, `.vibe_default_branch` or the agent's
    // `.pr_response_message` in the clone can no longer cost the whole
    // commit.
    const unstageResult = await unstageWorkerStateFiles(options);
    if (!unstageResult.ok) {
      await runGitCommand([
        "reset",
        "--"
      ], options);
      return {
        ok: false,
        error: unstageResult.error
      };
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
        await runGitCommand([
          "reset",
          "--"
        ], options);
        return {
          ok: false,
          error: safetyResult.error
        };
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
          runner: preFlight.runner
        });
        if (!gateResult.ok) {
          await runGitCommand([
            "reset",
            "--"
          ], options);
          // Capped like Step 1b's: the message reaches a PR comment.
          const capped = capGateText(gateResult.error.message);
          return {
            ok: false,
            error: capped === gateResult.error.message ? gateResult.error : new Error(capped, {
              cause: gateResult.error
            })
          };
        }
      }
      // Run-id traceability (Issue #2381) — stamp the commit with the
      // canonical run id so the push is attributable to a specific worker
      // run. assertRunIdTrailer is the pre-commit gate; appendRunIdTrailer
      // guarantees it passes for worker-authored commits.
      const finalMessage = appendRunIdTrailer(commitMessage, runId ?? getRunId());
      const trailerGate = assertRunIdTrailer(finalMessage);
      if (!trailerGate.ok) {
        await runGitCommand([
          "reset",
          "--"
        ], options);
        return {
          ok: false,
          error: trailerGate.error
        };
      }
      const commitResult = await runGitCommand([
        "commit",
        "-m",
        finalMessage
      ], options);
      if (!commitResult.ok) {
        return {
          ok: false,
          error: commitResult.error
        };
      }
      // `git commit` exits non-zero when there is nothing to commit. The
      // status check above means this should not happen, but be defensive.
      if (commitResult.value.code !== 0) {
        const combined = `${commitResult.value.stdout}\n${commitResult.value.stderr}`.trim();
        // Tolerate "nothing to commit" — treat as no new commit.
        if (!/nothing to commit/i.test(combined)) {
          return {
            ok: false,
            error: new Error(`git commit failed: ${combined}`)
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
      console.warn(`repo formatters: skipped before the push gate: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Step 1b — gate commits the agent made but never pushed itself (Issue
  // #3689). The agent's per-run pre-push hook only covers the agent's own
  // `git push`; these commits would otherwise leave ungated by the
  // changed-file checks. Final-mile callers (those passing `preFlight`) only.
  if (preFlight) {
    const gate = await gateUnpushedCommits(branchName, options, preFlight, committedNewChanges);
    if (!gate.ok) {
      return {
        ok: false,
        error: gate.error
      };
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
  const pushResult = await pushUnpushedCommits(branchName, options, true, beforePush);
  if (!pushResult.ok) {
    return {
      ok: false,
      error: pushResult.error
    };
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
    return {
      ok: false,
      error: remainingResult.error
    };
  }
  return {
    ok: true,
    value: {
      committedNewChanges,
      commitsPushed: pushResult.value,
      finalUnpushedCount: remainingResult.value.count,
      finalUnpushedSource: remainingResult.value.sha === null ? "remote-absent" : "remote-head"
    }
  };
}
/** Default gh command runner — routed through the shared chokepoint. */ async function defaultGhCommand(args) {
  return await runGhOrThrow(args);
}
/**
 * Ensure the local default branch is current with the remote (Issue #230).
 *
 * @param defaultBranch - The name of the default branch
 * @param options - Git command options
 * @returns Result indicating success
 */ export async function ensureDefaultBranchCurrent(defaultBranch, options = {}) {
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
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
  // Fetch the latest changes
  const fetchResult = await runGitCommandChecked(buildFetchArgs("origin", defaultBranch), options);
  // Issue #4358: git's stderr, a timeout, or a spawn error. Same wording as
  // the fetch failure in git_branch_sync.ts — dropping the detail left the
  // milestone tip log with no reason.
  if (!fetchResult.ok) {
    const detail = fetchResult.error.message.trim();
    return {
      ok: false,
      error: new Error(`Failed to fetch origin/${defaultBranch}: ${detail || "git reported no output"}`)
    };
  }
  // Check current branch
  const currentBranchResult = await runGitCommand([
    "rev-parse",
    "--abbrev-ref",
    "HEAD"
  ], options);
  const currentBranch = currentBranchResult.ok ? currentBranchResult.value.stdout.trim() : "";
  if (currentBranch === defaultBranch) {
    // If on the default branch, reset to remote
    await runGitCommand([
      "reset",
      "--hard",
      `origin/${defaultBranch}`
    ], options);
  } else {
    // Update the local ref without checking out
    await runGitCommand([
      "branch",
      "-f",
      defaultBranch,
      `origin/${defaultBranch}`
    ], options);
  }
  return {
    ok: true,
    value: `Local ${defaultBranch} is now current with origin`
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfcHVzaC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEdpdCBwdXNoIG9wZXJhdGlvbnMgKElzc3VlICM5MTIpLlxuICpcbiAqIFByb3ZpZGVzIGZ1bmN0aW9ucyBmb3IgcHVzaGluZyBjb21taXRzLCBkZXRlY3RpbmcgcHVzaCByZWplY3Rpb25zLFxuICogZGV0ZWN0aW5nIGV4aXN0aW5nIFBScywgYW5kIGZpbmRpbmcgb3BlbiBQUnMuXG4gKlxuICogTWlncmF0ZWQgZnJvbSB3b3JrZXIvc2hhcmVkL2dpdF9vcGVyYXRpb25zLnNoLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyBydW5HaXRDb21tYW5kLCBydW5HaXRDb21tYW5kQ2hlY2tlZCB9IGZyb20gXCIuL2dpdF90aW1lb3V0LnRzXCI7XG5pbXBvcnQgdHlwZSB7IEdpdENvbW1hbmRPcHRpb25zIH0gZnJvbSBcIi4vZ2l0X3RpbWVvdXQudHNcIjtcbmltcG9ydCB7XG4gIHJlY292ZXJGcm9tUHVzaFJlamVjdGlvbixcbiAgcmVmdXNlVW5sZXNzSGVhZEV4dGVuZHMsXG59IGZyb20gXCIuL2dpdF9wdXNoX3JlY292ZXJ5LnRzXCI7XG5pbXBvcnQgdHlwZSB7IFB1c2hMaW5lYWdlT3B0aW9ucyB9IGZyb20gXCIuL2dpdF9wdXNoX3JlY292ZXJ5LnRzXCI7XG5pbXBvcnQgeyBkZXNjcmliZVVucHVzaGVkQ29tbWl0cyB9IGZyb20gXCIuL2dpdF9yZW1vdGVfaGVhZC50c1wiO1xuaW1wb3J0IHtcbiAgdHlwZSBCcmFuY2hDdXJyZW5jeU91dGNvbWUsXG4gIGVuc3VyZUJyYW5jaEN1cnJlbnQsXG59IGZyb20gXCIuL2JyYW5jaF9jdXJyZW5jeS50c1wiO1xuaW1wb3J0IHsgbWVyZ2VPbnRvQmFzZSB9IGZyb20gXCIuL3ByX3JhaXNlX3N5bmMudHNcIjtcbmltcG9ydCB7XG4gIGFzc2VydFNhZmVHaXRSZWYsXG4gIGFzc2VydFNhZmVSZWZDb21wb25lbnQsXG4gIGJ1aWxkRmV0Y2hBcmdzLFxuICBidWlsZFB1c2hBcmdzLFxufSBmcm9tIFwiLi9naXRfcmVmX2FyZ3MudHNcIjtcbmltcG9ydCB7IGFzc2VydFNhZmVUb0NvbW1pdCwgaW5zcGVjdFN0YWdlZEZpbGVzIH0gZnJvbSBcIi4vcHJlX2NvbW1pdF9zYWZldHkudHNcIjtcbmltcG9ydCB7IGlzV29ya2VyU3RhdGVQYXRoIH0gZnJvbSBcIi4vd29ya2VyX3N0YXRlX3BhdGhzLnRzXCI7XG5pbXBvcnQgeyBydW5QcmVGbGlnaHRHYXRlIH0gZnJvbSBcIi4vcHJlX2ZsaWdodF9nYXRlLnRzXCI7XG5pbXBvcnQgeyByZWRhY3RlZEhlYWRUYWlsIH0gZnJvbSBcIi4vcmVkYWN0ZWRfdGV4dC50c1wiO1xuaW1wb3J0IHtcbiAgUHJlUHVzaEdhdGVJbmZyYXN0cnVjdHVyZUVycm9yLFxuICBydW5QcmVQdXNoR2F0ZSxcbn0gZnJvbSBcIi4vcHJlX3B1c2hfZ2F0ZS50c1wiO1xuaW1wb3J0IHR5cGUgeyBQcmVGbGlnaHRSdW5uZXIgfSBmcm9tIFwiLi9wcmVfZmxpZ2h0X2dhdGUudHNcIjtcbmltcG9ydCB7IGdldFByZUZsaWdodENvbW1hbmRzIH0gZnJvbSBcIi4vcmVwb19jb25maWcudHNcIjtcbmltcG9ydCB0eXBlIHsgUmVwb0NvbmZpZyB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgYXBwZW5kUnVuSWRUcmFpbGVyLCBhc3NlcnRSdW5JZFRyYWlsZXIsIGdldFJ1bklkIH0gZnJvbSBcIi4vcnVuX2lkLnRzXCI7XG5pbXBvcnQgeyBydW5HaE9yVGhyb3cgfSBmcm9tIFwiLi9naF9zcGF3bi50c1wiO1xuXG4vKipcbiAqIFByZS1mbGlnaHQgZ2F0ZSBzcGVjaWZpY2F0aW9uIHBhc3NlZCB0byB7QGxpbmsgY29tbWl0QW5kUHVzaFBlbmRpbmd9XG4gKiAoSXNzdWUgIzM1NzcpLiBPbWl0IHRoZSBzcGVjIHRvIGRpc2FibGUgdGhlIGdhdGUg4oCUIHRoZSByZXBvIHRoZW4gY29tbWl0cyBhbmRcbiAqIHB1c2hlcyB3aXRoIHplcm8gYWRkZWQgbGF0ZW5jeSwgd2hpY2ggaXMgd2hhdCB0aGUgV0lQIGNoZWNrcG9pbnQsIHRpbWVvdXRcbiAqIHByZXNlcnZhdGlvbiBhbmQgZGVjbGFyZWQgaGFuZC1vZmYgcHVzaGVzIHJlbHkgb24uIFBhc3NpbmcgYSBzcGVjIHR1cm5zIG9uXG4gKiBTdGVwIDFiJ3MgY2hhbmdlZC1maWxlIGNoZWNrcyAoSXNzdWUgIzM2ODk6IGRlbm8vY2FyZ28gZm10LCBtYXJrZG93bmxpbnQsXG4gKiBjc3BlbGwsIHRoZSBGbG9jaSBkZXBsb3kgdGVzdCBhbmQgdGhlIHJlcG9zaXRvcnkncyBTaGVsbENoZWNrIHBvbGljeSksIHRoZW5cbiAqIGNhcmdvIGRlbnkgd2hlbiBhcHBsaWNhYmxlIChJc3N1ZSAjNDYyNiksIGV2ZW4gd2hlbiBgY29tbWFuZHNgIGlzIGVtcHR5OyBhblxuICogZW1wdHkgbGlzdCBvbmx5IG1lYW5zIG5vIHJlcG8gcHJlLWZsaWdodCBjb21tYW5kcyBydW4uIEEgc3BlYyB3aXRoXG4gKiBgc2hlbGxjaGVja09ubHlgIHJ1bnMgdGhlIFNoZWxsQ2hlY2sgcG9saWN5IGFuZCBjYXJnbyBkZW55IGZvciBjaGFuZ2VkIGNhcmdvXG4gKiBpbnB1dHMgKElzc3VlcyAjNDYzMSBhbmQgIzQ2MjYpLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFByZUZsaWdodEdhdGVTcGVjIHtcbiAgLyoqIENvbW1hbmRzIHRvIHJ1biBiZWZvcmUgdGhlIGF1dG9tYXRlZCBjb21taXQsIGluIGxpc3RlZCBvcmRlci4gKi9cbiAgY29tbWFuZHM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogUGVyLWNvbW1hbmQgdGltZW91dCBpbiBzZWNvbmRzIChkZWZhdWx0cyB0byB0aGUgZ2F0ZSdzIG93biBkZWZhdWx0KS4gKi9cbiAgdGltZW91dFNlY29uZHM/OiBudW1iZXI7XG4gIC8qKiBJbmplY3RhYmxlIGNvbW1hbmQgcnVubmVyIChkZWZhdWx0cyB0byB0aGUgcmVhbCBzdWJwcm9jZXNzIHJ1bm5lcikuICovXG4gIHJ1bm5lcj86IFByZUZsaWdodFJ1bm5lcjtcbiAgLyoqXG4gICAqIFN0ZXAgMWIgdmFsaWRhdGVzIHRoZSByZXBvc2l0b3J5J3MgU2hlbGxDaGVjayBwb2xpY3kgZm9yIHRoZSBwdXNoZWRcbiAgICogc2NyaXB0cywgcGx1cyB0aGUgQ0kgY2FyZ28tZGVueSBjaGVjayB3aGVuIHRoZSBwdXNoZWQgcGF0aHMgaW5jbHVkZSBhXG4gICAqIGNhcmdvIGlucHV0LCBhbmQgbGVhdmVzIHRoZSBmb3JtYXR0ZXIgcG9saWN5IG9mIGEgcmVwYWlyIHdpdGhvdXRcbiAgICogcHJlLWZsaWdodCBjb21tYW5kcyB1bmNoYW5nZWQgKElzc3VlcyAjNDYzMSBhbmQgIzQ2MjYpLlxuICAgKi9cbiAgc2hlbGxjaGVja09ubHk/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIFJlc29sdmUgYSByZXBvJ3MgcHJlLWZsaWdodCBnYXRlIGludG8gYSB7QGxpbmsgUHJlRmxpZ2h0R2F0ZVNwZWN9LCBvclxuICogYHVuZGVmaW5lZGAgd2hlbiB0aGUgcmVwbyBoYXMgbm8gZ2F0ZSBjb25maWd1cmVkIChJc3N1ZSAjMzU3NykuXG4gKlxuICogQSBjb252ZW5pZW5jZSBmb3IgdGhlIGF1dG9tYXRlZC1jb21taXQgY2FsbCBzaXRlczogcGFzcyB0aGUgcmVzdWx0IHN0cmFpZ2h0XG4gKiB0byB7QGxpbmsgY29tbWl0QW5kUHVzaFBlbmRpbmd9LiBSZXR1cm5zIGB1bmRlZmluZWRgIChub3QgYW4gZW1wdHkgc3BlYykgc29cbiAqIGEgY2FsbGVyIHRoYXQgcGFzc2VzIGl0IHN0cmFpZ2h0IHRocm91Z2ggbGVhdmVzIGEgcmVwbyB3aXRoIG5vIGVudHJ5XG4gKiB1bmdhdGVkOyB0aGUgaXNzdWUgY29tcGxldGlvbiBwaGFzZSBzdWJzdGl0dXRlcyBgeyBjb21tYW5kczogW10gfWAgaW5zdGVhZCxcbiAqIHNvIGl0IHN0aWxsIHJ1bnMgdGhlIGNoYW5nZWQtZmlsZSBjaGVja3MgKElzc3VlICMzNjg5KSwgYW5kIHRoZSBQUiByZXBhaXJcbiAqIHByb2Nlc3NvcnMgdXNlIHtAbGluayByZXNvbHZlUmVwYWlyUHJlRmxpZ2h0U3BlY30uIFRocm93cyBvbiBtYWxmb3JtZWRcbiAqIGNvbmZpZyB2aWEgYGdldFByZUZsaWdodENvbW1hbmRzYCDigJQgYnV0IGNvbmZpZyBpcyBhbHJlYWR5IHZhbGlkYXRlZCBhdCBsb2FkXG4gKiAoSXNzdWUgIzM1NzcpLCBzbyB0aGlzIGlzIGRlZmVuY2UgaW4gZGVwdGguXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlUHJlRmxpZ2h0U3BlYyhcbiAgcmVwb0NvbmZpZ3M6IFJlY29yZDxzdHJpbmcsIFJlcG9Db25maWc+IHwgdW5kZWZpbmVkLFxuICByZXBvOiBzdHJpbmcsXG4pOiBQcmVGbGlnaHRHYXRlU3BlYyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGNvbW1hbmRzID0gZ2V0UHJlRmxpZ2h0Q29tbWFuZHMocmVwb0NvbmZpZ3MsIHJlcG8pO1xuICByZXR1cm4gY29tbWFuZHMubGVuZ3RoID4gMCA/IHsgY29tbWFuZHMgfSA6IHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiB7QGxpbmsgcmVzb2x2ZVByZUZsaWdodFNwZWN9IGZvciB0aGUgUFIgcmVwYWlyIHByb2Nlc3NvcnMgKENJLWZpeCwgcmV2aWV3XG4gKiBmZWVkYmFjaywgc3BlbGxpbmcsIG1lcmdlIGNvbmZsaWN0KTogYSByZXBvIHdpdGggbm8gcHJlLWZsaWdodCBjb21tYW5kc1xuICogc3RpbGwgZ2V0cyB0aGUgU2hlbGxDaGVjayBwdWJsaWNhdGlvbiBjaGVjaywgcGx1cyB0aGUgQ0kgY2FyZ28tZGVueSBjaGVja1xuICogd2hlbiB0aGUgcHVzaGVkIHBhdGhzIGluY2x1ZGUgYSBjYXJnbyBpbnB1dCwgYW5kIG5vdGhpbmcgZWxzZSwgYmVmb3JlIHRoZVxuICogcmVwYWlyIGlzIHB1c2hlZCAoSXNzdWVzICM0NjMxIGFuZCAjNDYyNikuIFdJUCBjaGVja3BvaW50LCB0aW1lb3V0LXByZXNlcnZhdGlvbiBhbmRcbiAqIGRlY2xhcmVkIGhhbmQtb2ZmIHB1c2hlcyBuZXZlciBjYWxsIHRoaXM7IHRoZXkgc3RheSB1bmdhdGVkIG9uIHB1cnBvc2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlUmVwYWlyUHJlRmxpZ2h0U3BlYyhcbiAgcmVwb0NvbmZpZ3M6IFJlY29yZDxzdHJpbmcsIFJlcG9Db25maWc+IHwgdW5kZWZpbmVkLFxuICByZXBvOiBzdHJpbmcsXG4pOiBQcmVGbGlnaHRHYXRlU3BlYyB7XG4gIHJldHVybiByZXNvbHZlUHJlRmxpZ2h0U3BlYyhyZXBvQ29uZmlncywgcmVwbykgPz9cbiAgICB7IGNvbW1hbmRzOiBbXSwgc2hlbGxjaGVja09ubHk6IHRydWUgfTtcbn1cblxuLyoqXG4gKiBEZXRlY3Qgbm9uLWZhc3QtZm9yd2FyZCBwdXNoIHJlamVjdGlvbiBmcm9tIHB1c2ggb3V0cHV0IChJc3N1ZSAjMTg2KS5cbiAqXG4gKiBXaGVuIGEgUFIgaXMgcmFpc2VkLCBhdXRvbWF0ZWQgdGFza3MgKHJlZm9ybWF0dGluZywgQ0kgY2hlY2tzLCBldGMuKSBtYXkgcHVzaFxuICogY29tbWl0cyB0byB0aGUgcmVtb3RlIGJyYW5jaC4gVGhpcyBkZXRlY3RzIHRoZSBzcGVjaWZpYyByZWplY3Rpb24gc28gdGhlIHdvcmtlclxuICogY2FuIHJlY292ZXIgYXV0b21hdGljYWxseS5cbiAqXG4gKiBAcGFyYW0gcHVzaE91dHB1dCAtIFRoZSBzdGRlcnIvc3Rkb3V0IGZyb20gZ2l0IHB1c2hcbiAqIEByZXR1cm5zIFRydWUgaWYgdGhlIHB1c2ggd2FzIHJlamVjdGVkIGR1ZSB0byBub24tZmFzdC1mb3J3YXJkXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXRlY3RQdXNoUmVqZWN0aW9uKHB1c2hPdXRwdXQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIXB1c2hPdXRwdXQpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIC9cXChmZXRjaCBmaXJzdFxcKXxcXChub24tZmFzdC1mb3J3YXJkXFwpLy50ZXN0KHB1c2hPdXRwdXQpO1xufVxuXG4vKipcbiAqIEV4dHJhY3QgYW4gZXhpc3RpbmcgUFIgVVJMIGZyb20gZ2ggZXJyb3Igb3V0cHV0IChJc3N1ZSAjMTg0KS5cbiAqXG4gKiBXaGVuIGdoIHByIGNyZWF0ZSBmYWlscyBiZWNhdXNlIGEgUFIgYWxyZWFkeSBleGlzdHMgZm9yIHRoZSBicmFuY2gsXG4gKiB0aGUgZXJyb3IgbWVzc2FnZSBpbmNsdWRlcyB0aGUgVVJMIG9mIHRoZSBleGlzdGluZyBQUi5cbiAqXG4gKiBAcGFyYW0gZXJyb3JPdXRwdXQgLSBUaGUgc3RkZXJyL3N0ZG91dCBmcm9tIGdoIHByIGNyZWF0ZVxuICogQHJldHVybnMgVGhlIFBSIFVSTCBpZiBmb3VuZCwgb3IgbnVsbFxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0RXhpc3RpbmdQcihlcnJvck91dHB1dDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICghZXJyb3JPdXRwdXQpIHJldHVybiBudWxsO1xuICBpZiAoIS9hbHJlYWR5IGV4aXN0cy9pLnRlc3QoZXJyb3JPdXRwdXQpKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBtYXRjaCA9IGVycm9yT3V0cHV0Lm1hdGNoKFxuICAgIC9odHRwczpcXC9cXC9naXRodWJcXC5jb21cXC9bXlxcc10rXFwvcHVsbFxcL1xcZCsvLFxuICApO1xuICByZXR1cm4gbWF0Y2ggPyBtYXRjaFswXSA6IG51bGw7XG59XG5cbi8qKlxuICogRmluZCBhbiBvcGVuIFBSIGZvciBhIGdpdmVuIGJyYW5jaCAoSXNzdWUgIzM4NikuXG4gKlxuICogQHBhcmFtIHJlcG8gLSBSZXBvc2l0b3J5IGluIFwib3duZXIvcmVwb1wiIGZvcm1hdFxuICogQHBhcmFtIGJyYW5jaE5hbWUgLSBUaGUgaGVhZCBicmFuY2ggdG8gc2VhcmNoIGZvclxuICogQHBhcmFtIGdoQ29tbWFuZEZuIC0gSW5qZWN0ZWQgZ2ggY29tbWFuZCBmdW5jdGlvbiAoZm9yIHRlc3RpbmcpXG4gKiBAcmV0dXJucyBSZXN1bHQgd2l0aCB0aGUgUFIgVVJMIGlmIGZvdW5kXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmaW5kT3BlblByRm9yQnJhbmNoKFxuICByZXBvOiBzdHJpbmcsXG4gIGJyYW5jaE5hbWU6IHN0cmluZyxcbiAgZ2hDb21tYW5kRm4/OiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPixcbik6IFByb21pc2U8UmVzdWx0PHN0cmluZyB8IG51bGw+PiB7XG4gIGlmICghYnJhbmNoTmFtZSkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogbnVsbCB9O1xuICB9XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBydW5HaCA9IGdoQ29tbWFuZEZuID8/IGRlZmF1bHRHaENvbW1hbmQ7XG4gICAgY29uc3Qgb3V0cHV0ID0gYXdhaXQgcnVuR2goW1xuICAgICAgXCJwclwiLFxuICAgICAgXCJsaXN0XCIsXG4gICAgICBcIi0tcmVwb1wiLFxuICAgICAgcmVwbyxcbiAgICAgIFwiLS1oZWFkXCIsXG4gICAgICBicmFuY2hOYW1lLFxuICAgICAgXCItLXN0YXRlXCIsXG4gICAgICBcIm9wZW5cIixcbiAgICAgIFwiLS1qc29uXCIsXG4gICAgICBcInVybFwiLFxuICAgICAgXCItLWpxXCIsXG4gICAgICBcIi5bMF0udXJsXCIsXG4gICAgXSk7XG5cbiAgICBjb25zdCBwclVybCA9IG91dHB1dC50cmltKCk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBwclVybCB8fCBudWxsIH07XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBGYWlsZWQgdG8gZmluZCBvcGVuIFBSIGZvciBicmFuY2ggJyR7YnJhbmNoTmFtZX0nOiAke1xuICAgICAgICAgIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKVxuICAgICAgICB9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIFJlY292ZXIgZ3JhY2VmdWxseSB3aGVuIGEgUFIgYWxyZWFkeSBleGlzdHMgKElzc3VlICMxODQpLlxuICpcbiAqIEBwYXJhbSByZXBvIC0gUmVwb3NpdG9yeSBpbiBcIm93bmVyL3JlcG9cIiBmb3JtYXRcbiAqIEBwYXJhbSBpc3N1ZU51bWJlciAtIFRoZSBpc3N1ZSBudW1iZXIgYmVpbmcgd29ya2VkIG9uXG4gKiBAcGFyYW0gcHJVcmwgLSBUaGUgVVJMIG9mIHRoZSBleGlzdGluZyBQUlxuICogQHBhcmFtIHByQm9keSAtIE9wdGlvbmFsIHVwZGF0ZWQgUFIgYm9keSBjb250ZW50IHRvIGFwcGx5XG4gKiBAcGFyYW0gZ2hDb21tYW5kRm4gLSBJbmplY3RlZCBnaCBjb21tYW5kIGZ1bmN0aW9uIChmb3IgdGVzdGluZylcbiAqIEByZXR1cm5zIFJlc3VsdCBpbmRpY2F0aW5nIHN1Y2Nlc3NcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlY292ZXJFeGlzdGluZ1ByKFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIHByVXJsOiBzdHJpbmcsXG4gIHByQm9keT86IHN0cmluZyxcbiAgZ2hDb21tYW5kRm4/OiAoYXJnczogc3RyaW5nW10pID0+IFByb21pc2U8c3RyaW5nPixcbik6IFByb21pc2U8UmVzdWx0PHN0cmluZz4+IHtcbiAgaWYgKCFwclVybCkge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IG5ldyBFcnJvcihcIkVtcHR5IFBSIFVSTFwiKSB9O1xuICB9XG5cbiAgY29uc3QgbWVzc2FnZXM6IHN0cmluZ1tdID0gW1xuICAgIGBTRUxGLUhFQUxJTkc6IEZvdW5kIGV4aXN0aW5nIFBSIGZvciBpc3N1ZSAjJHtpc3N1ZU51bWJlcn06ICR7cHJVcmx9YCxcbiAgICBcIlNFTEYtSEVBTElORzogQSBwcmV2aW91cyBydW4gbGlrZWx5IGNyZWF0ZWQgdGhpcyBQUiBiZWZvcmUgdGltaW5nIG91dFwiLFxuICBdO1xuXG4gIC8vIFVwZGF0ZSB0aGUgZXhpc3RpbmcgUFIgYm9keSB3aXRoIGNvbnZlcnRlZCBzY3JlZW5zaG90IFVSTHMgKElzc3VlICMzMjgpXG4gIGlmIChwckJvZHkpIHtcbiAgICBjb25zdCBwck51bWJlciA9IHByVXJsLnNwbGl0KFwiL1wiKS5wb3AoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcnVuR2ggPSBnaENvbW1hbmRGbiA/PyBkZWZhdWx0R2hDb21tYW5kO1xuICAgICAgYXdhaXQgcnVuR2goW1xuICAgICAgICBcInByXCIsXG4gICAgICAgIFwiZWRpdFwiLFxuICAgICAgICBTdHJpbmcocHJOdW1iZXIpLFxuICAgICAgICBcIi0tcmVwb1wiLFxuICAgICAgICByZXBvLFxuICAgICAgICBcIi0tYm9keVwiLFxuICAgICAgICBwckJvZHksXG4gICAgICBdKTtcbiAgICAgIG1lc3NhZ2VzLnB1c2goXCJTRUxGLUhFQUxJTkc6IFBSIGJvZHkgdXBkYXRlZCBzdWNjZXNzZnVsbHlcIik7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgIGBbZ2l0LXB1c2hdIEZhaWxlZCB0byB1cGRhdGUgUFIgYm9keSBmb3IgUFIgIyR7cHJOdW1iZXJ9IGluICR7cmVwb306ICR7XG4gICAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICAgIH1gLFxuICAgICAgKTtcbiAgICAgIG1lc3NhZ2VzLnB1c2goXCJGYWlsZWQgdG8gdXBkYXRlIFBSIGJvZHkgKG5vbi1mYXRhbClcIik7XG4gICAgfVxuICB9XG5cbiAgbWVzc2FnZXMucHVzaChcbiAgICBcIlNFTEYtSEVBTElORzogVHJlYXRpbmcgYXMgc3VjY2Vzc2Z1bCDigJQgbm8gbmVlZCB0byBjcmVhdGUgYSBuZXcgUFJcIixcbiAgKTtcblxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IG1lc3NhZ2VzLmpvaW4oXCJcXG5cIikgfTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSByZXBvc2l0b3J5J3MgZGVmYXVsdCBicmFuY2ggZnJvbSB0aGUgbG9jYWwgY2xvbmUgKElzc3VlICMyNTg0KS5cbiAqXG4gKiBVc2VzIGBnaXQgc3ltYm9saWMtcmVmIHJlZnMvcmVtb3Rlcy9vcmlnaW4vSEVBRGAg4oCUIHRoZSBzYW1lIGxvY2FsIHJlc29sdXRpb25cbiAqIGBzZXR1cFJlcG8oKWAgcmVsaWVzIG9uIOKAlCBzbyB0aGUgcHVzaCBndWFyZCBuZWVkcyBubyBHaXRIdWIgQVBJIGNhbGwgYW5kIHdvcmtzXG4gKiBwdXJlbHkgZnJvbSB0aGUgd29ya2luZyB0cmVlIHNlbGVjdGVkIGJ5IGBvcHRpb25zLmN3ZGAuIEEgYGdpdCBjbG9uZWAgc2V0c1xuICogYG9yaWdpbi9IRUFEYCB0byB0aGUgcmVtb3RlJ3MgZGVmYXVsdCBicmFuY2gsIHNvIHRoaXMgcmVzb2x2ZXMgY29ycmVjdGx5IGZvclxuICogZXZlcnkgbW9uaXRvcmVkIGNsb25lLlxuICpcbiAqIEBwYXJhbSBvcHRpb25zIC0gR2l0IGNvbW1hbmQgb3B0aW9ucyAoY3dkIHNlbGVjdHMgdGhlIHJlcG8pXG4gKiBAcmV0dXJucyBUaGUgZGVmYXVsdCBicmFuY2ggbmFtZSwgb3IgbnVsbCB3aGVuIGl0IGNhbm5vdCBiZSBkZXRlcm1pbmVkXG4gKiAgIChlLmcuIGBvcmlnaW4vSEVBRGAgaXMgdW5zZXQpLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUxvY2FsRGVmYXVsdEJyYW5jaChcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcInN5bWJvbGljLXJlZlwiLCBcInJlZnMvcmVtb3Rlcy9vcmlnaW4vSEVBRFwiXSxcbiAgICBvcHRpb25zLFxuICApO1xuICBpZiAocmVzdWx0Lm9rICYmIHJlc3VsdC52YWx1ZS5jb2RlID09PSAwKSB7XG4gICAgY29uc3QgYnJhbmNoID0gcmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKCkucmVwbGFjZShcbiAgICAgIFwicmVmcy9yZW1vdGVzL29yaWdpbi9cIixcbiAgICAgIFwiXCIsXG4gICAgKTtcbiAgICByZXR1cm4gYnJhbmNoIHx8IG51bGw7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogQ2VudHJhbCBwdXNoLWNob2tlLXBvaW50IGd1YXJkIChJc3N1ZSAjMjU4NCkuXG4gKlxuICogVGhlIGRlZmF1bHQgYnJhbmNoIG11c3QgYmUgc3RyaWN0bHkgcmVhZC1vbmx5IGZvciB0aGUgd29ya2VyOiBpdCBtYXkgb25seVxuICogZXZlciBjaGFuZ2UgdmlhIGEgdmVyaWZpZWQsIGh1bWFuLXJldmlld2VkIG1lcmdlIOKAlCBuZXZlciBhIGRpcmVjdCBwdXNoIG9mXG4gKiBmb3JtYXR0aW5nLCB2ZXJzaW9uLCBvciBkZXBlbmRlbmN5LWJ1bXAgY29tbWl0cy4gVGhpcyBndWFyZCByZWZ1c2VzIGFueSBwdXNoXG4gKiB3aG9zZSB0YXJnZXQgYnJhbmNoIGVxdWFscyB0aGUgcmVwb3NpdG9yeSdzIGRlZmF1bHQgYnJhbmNoLlxuICpcbiAqIC0gKipGYWlscyBjbG9zZWQgb24gdGhlIGRlZmF1bHQgYnJhbmNoLioqIFdoZW4gdGhlIHJlc29sdmVkIGRlZmF1bHQgYnJhbmNoXG4gKiAgIG1hdGNoZXMgYGJyYW5jaE5hbWVgIHRoZSBwdXNoIGlzIHJlamVjdGVkIHdpdGggYW4gZXhwbGljaXQgZXJyb3IuXG4gKiAtICoqRmFpbHMgb3BlbiB3aGVuIHRoZSBkZWZhdWx0IGNhbm5vdCBiZSByZXNvbHZlZC4qKiBJZiBgb3JpZ2luL0hFQURgIGlzXG4gKiAgIHVuc2V0IHRoZSBkZWZhdWx0IGJyYW5jaCBpcyB1bmtub3duLCBzbyBhIGxlZ2l0aW1hdGUgZmVhdHVyZS1icmFuY2ggcHVzaCBpc1xuICogICBuZXZlciBibG9ja2VkIGJ5IGEgdHJhbnNpZW50IGxvb2t1cCBmYWlsdXJlLiBEaXJlY3QtdG8tZGVmYXVsdCBpcyBvbmx5XG4gKiAgIHBvc3NpYmxlIHdoZW4gYGJyYW5jaE5hbWVgIGxpdGVyYWxseSBlcXVhbHMgdGhlIHJlc29sdmVkIGRlZmF1bHQsIHNvIHRoZVxuICogICByZWFkLW9ubHkgaW52YXJpYW50IHN0aWxsIGhvbGRzIGZvciBldmVyeSBjbG9uZSB3aGVyZSBgb3JpZ2luL0hFQURgIGlzIHNldFxuICogICAodGhlIG5vcm1hbCBjYXNlKS5cbiAqXG4gKiBAcGFyYW0gYnJhbmNoTmFtZSAtIFRoZSBicmFuY2ggYWJvdXQgdG8gYmUgcHVzaGVkXG4gKiBAcGFyYW0gb3B0aW9ucyAtIEdpdCBjb21tYW5kIG9wdGlvbnMgKGN3ZCBzZWxlY3RzIHRoZSByZXBvKVxuICogQHBhcmFtIGFsbG93RGVmYXVsdEJyYW5jaCAtIE9wdC1vdXQgcmVzZXJ2ZWQgZm9yIGxlZ2l0aW1hdGUgbWVyZ2UgbWFjaGluZXJ5XG4gKiAgIHRoYXQgbXVzdCB1cGRhdGUgdGhlIGRlZmF1bHQtYnJhbmNoIHJlZi4gRGVmYXVsdHMgdG8gYGZhbHNlYCAoZm9yYmlkKS5cbiAqIEByZXR1cm5zIE9rIHdoZW4gdGhlIHB1c2ggbWF5IHByb2NlZWQ7IGFuIGVycm9yIFJlc3VsdCB3aGVuIGl0IHRhcmdldHMgdGhlXG4gKiAgIGRlZmF1bHQgYnJhbmNoIGFuZCB0aGUgb3B0LW91dCB3YXMgbm90IHN1cHBsaWVkLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYXNzZXJ0UHVzaFRhcmdldEFsbG93ZWQoXG4gIGJyYW5jaE5hbWU6IHN0cmluZyxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMgPSB7fSxcbiAgYWxsb3dEZWZhdWx0QnJhbmNoID0gZmFsc2UsXG4pOiBQcm9taXNlPFJlc3VsdDx2b2lkPj4ge1xuICBpZiAoYWxsb3dEZWZhdWx0QnJhbmNoKSByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuXG4gIGNvbnN0IGRlZmF1bHRCcmFuY2ggPSBhd2FpdCByZXNvbHZlTG9jYWxEZWZhdWx0QnJhbmNoKG9wdGlvbnMpO1xuICBpZiAoZGVmYXVsdEJyYW5jaCAhPT0gbnVsbCAmJiBicmFuY2hOYW1lID09PSBkZWZhdWx0QnJhbmNoKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBSZWZ1c2luZyB0byBwdXNoIHRvIHRoZSBkZWZhdWx0IGJyYW5jaCAnJHticmFuY2hOYW1lfSc6IHRoZSBkZWZhdWx0IGAgK1xuICAgICAgICAgIGBicmFuY2ggaXMgcmVhZC1vbmx5IGZvciB0aGUgd29ya2VyIGFuZCBtYXkgb25seSBjaGFuZ2UgdmlhIGEgYCArXG4gICAgICAgICAgYHZlcmlmaWVkIG1lcmdlIChJc3N1ZSAjMjU4NCkuIFB1c2ggdG8gYSBmZWF0dXJlIG9yIG1pbGVzdG9uZSBgICtcbiAgICAgICAgICBgYnJhbmNoIGluc3RlYWQuYCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xufVxuXG4vKipcbiAqIFB1c2ggYW55IGxvY2FsIGNvbW1pdHMgdGhhdCBoYXZlbid0IGJlZW4gcHVzaGVkIHRvIG9yaWdpbiAoSXNzdWUgIzEwNSkuXG4gKlxuICogV2hlbiByZXNwb25kaW5nIHRvIFBSIGNvbW1lbnRzLCBDbGF1ZGUgc29tZXRpbWVzIG1ha2VzIGNvbW1pdHMgYnV0IGRvZXNuJ3QgcHVzaCB0aGVtLlxuICogVGhpcyBlbnN1cmVzIGNoYW5nZXMgYXJlIG5ldmVyIGxlZnQgdW5wdXNoZWQgb24gYW4gdW5hdHRlbmRlZCBtYWNoaW5lLlxuICpcbiAqIEFsc28gaGFuZGxlcyB0aGUgZmlyc3QtdGltZSBwdXNoIG9mIGEgZnJlc2hseSBjcmVhdGVkIGZlYXR1cmUgYnJhbmNoXG4gKiAoSXNzdWUgIzE0NjMgcmVncmVzc2lvbik6IGEgYnJhbmNoIHRoYXQgaXMgbm90IG9uIHRoZSByZW1vdGUgeWV0IG11c3QgYmVcbiAqIHB1c2hlZCB3aXRoIGAtdWAgc28gdGhlIHVwc3RyZWFtIGlzIGNyZWF0ZWQg4oCUIHRyZWF0aW5nIFwibm8gdXBzdHJlYW1cIiBhc1xuICogXCIwIGNvbW1pdHMgdG8gcHVzaFwiIHNpbGVudGx5IHNraXBzIHRoZSBwdXNoIGFuZCBsZWF2ZXMgdGhlIHJlbW90ZSBicmFuY2hcbiAqIG1pc3NpbmcsIGFuZCBgZ2ggcHIgY3JlYXRlYCB0aGVuIGZhaWxzIHdpdGggXCJObyBjb21taXRzIGJldHdlZW4g4oCmXCIuXG4gKlxuICogVGhlIHVucHVzaGVkIGNvdW50IGNvbWVzIGZyb20ge0BsaW5rIGRlc2NyaWJlVW5wdXNoZWRDb21taXRzfSAoSXNzdWUgIzIxMSksXG4gKiB3aGljaCBtZWFzdXJlcyBhZ2FpbnN0IHRoZSBicmFuY2gncyBvd24gcmVtb3RlIGhlYWQg4oCUIGBscy1yZW1vdGVgIHdoZW4gdGhlXG4gKiBjbG9uZSBrZWVwcyBubyByZW1vdGUtdHJhY2tpbmcgcmVmIGZvciBpdCDigJQgcmF0aGVyIHRoYW4gYWdhaW5zdCBldmVyeSBvcmlnaW5cbiAqIHJlZiwgd2hpY2ggb24gYSBzaW5nbGUtYnJhbmNoIGNsb25lIGNvdW50cyBjb21taXRzIGFoZWFkIG9mIHRoZSBkZWZhdWx0XG4gKiBicmFuY2ggYW5kIHJlcG9ydHMgYSBmdWxseSBwdXNoZWQgYnJhbmNoIGFzIGZvdXIgY29tbWl0cyBiZWhpbmQuXG4gKlxuICogQHBhcmFtIGJyYW5jaE5hbWUgLSBUaGUgYnJhbmNoIHRvIHB1c2hcbiAqIEBwYXJhbSBvcHRpb25zIC0gR2l0IGNvbW1hbmQgb3B0aW9uc1xuICogQHBhcmFtIGFsbG93RGVmYXVsdEJyYW5jaCAtIE9wdC1vdXQgZm9yIHRoZSByZWFkLW9ubHkgZGVmYXVsdC1icmFuY2ggZ3VhcmRcbiAqICAgKElzc3VlICMyNTg0KS4gRGVmYXVsdHMgdG8gYGZhbHNlYCAoZm9yYmlkIHB1c2hpbmcgdG8gdGhlIGRlZmF1bHQgYnJhbmNoKS5cbiAqIEByZXR1cm5zIFJlc3VsdCB3aXRoIHRoZSBudW1iZXIgb2YgY29tbWl0cyBwdXNoZWQgKDAgd2hlbiBhbHJlYWR5IGluIHN5bmMpXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwdXNoVW5wdXNoZWRDb21taXRzKFxuICBicmFuY2hOYW1lOiBzdHJpbmcsXG4gIG9wdGlvbnM6IFB1c2hMaW5lYWdlT3B0aW9ucyA9IHt9LFxuICBhbGxvd0RlZmF1bHRCcmFuY2ggPSBmYWxzZSxcbiAgYmVmb3JlUHVzaD86ICgpID0+IFByb21pc2U8UmVzdWx0PHZvaWQ+Pixcbik6IFByb21pc2U8UmVzdWx0PG51bWJlcj4+IHtcbiAgLy8gUmVhZC1vbmx5IGRlZmF1bHQtYnJhbmNoIGd1YXJkIChJc3N1ZSAjMjU4NCkg4oCUIHJlZnVzZSBiZWZvcmUgZG9pbmcgYW55XG4gIC8vIHdvcmsgd2hlbiB0aGUgdGFyZ2V0IGlzIHRoZSByZXBvJ3MgZGVmYXVsdCBicmFuY2guXG4gIGNvbnN0IGd1YXJkID0gYXdhaXQgYXNzZXJ0UHVzaFRhcmdldEFsbG93ZWQoXG4gICAgYnJhbmNoTmFtZSxcbiAgICBvcHRpb25zLFxuICAgIGFsbG93RGVmYXVsdEJyYW5jaCxcbiAgKTtcbiAgaWYgKCFndWFyZC5vaykge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGd1YXJkLmVycm9yIH07XG4gIH1cblxuICAvLyBSZWZ1c2UgYW4gb3B0aW9uLWluamVjdGluZyByZWYgYmVmb3JlIGFueSByZW1vdGUgbG9va3VwIHJ1bnMgKElzc3VlICMxNDgpLlxuICAvLyBOYW1lZCBmb3IgdGhpcyBzbG90IHNvIHRoZSBmYWlsdXJlIHNheXMgd2hpY2ggYXJndW1lbnQgd2FzIHJlZnVzZWQuXG4gIHRyeSB7XG4gICAgYXNzZXJ0U2FmZUdpdFJlZihicmFuY2hOYW1lLCBcInB1c2ggYnJhbmNoIG5hbWVcIik7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIgOiBuZXcgRXJyb3IoU3RyaW5nKGVycikpLFxuICAgIH07XG4gIH1cblxuICAvLyBJc3N1ZSAjNDE2NTogZG8gbm90IHB1c2ggYSBjaGVja291dCB0aGF0IGRvZXMgbm90IGV4dGVuZCB0aGUgaGVhZCB0aGlzXG4gIC8vIHBhc3Mgc3RhcnRlZCBmcm9tLiBBbiBpbi1zeW5jIHNob3J0LWNpcmN1aXQgYmVsb3cgd291bGQgb3RoZXJ3aXNlIHJlcG9ydFxuICAvLyBzdWNjZXNzIGZvciBoaXN0b3J5IHRoYXQgaXMgbm90IHRoaXMgcGFzcydzIHdvcmsuXG4gIGNvbnN0IGxpbmVhZ2UgPSBhd2FpdCByZWZ1c2VVbmxlc3NIZWFkRXh0ZW5kcyhvcHRpb25zKTtcbiAgaWYgKCFsaW5lYWdlLm9rKSByZXR1cm4gbGluZWFnZTtcblxuICAvLyBDb3VudCB3aGF0IHRoZSBicmFuY2gncyAqb3duKiByZW1vdGUgaGVhZCBpcyBtaXNzaW5nIChJc3N1ZSAjMjExKS4gVGhlXG4gIC8vIG9sZCBwcm9iZSBwYWlyIOKAlCBgb3JpZ2luLzxicmFuY2g+Li5IRUFEYCwgZmFsbGluZyBiYWNrIHRvXG4gIC8vIGBIRUFEIC0tbm90IC0tcmVtb3Rlcz1vcmlnaW5gIOKAlCByZXBvcnRzIFwiY29tbWl0cyBhaGVhZCBvZiB0aGUgZGVmYXVsdFxuICAvLyBicmFuY2hcIiBvbiBhbnkgY2xvbmUgd2l0aG91dCBhIHJlbW90ZS10cmFja2luZyByZWYgZm9yIHRoaXMgYnJhbmNoIChhXG4gIC8vIHNpbmdsZS1icmFuY2ggY2xvbmUgbmV2ZXIgZ2FpbnMgb25lLCBldmVuIGFmdGVyIGEgc3VjY2Vzc2Z1bCBwdXNoKSwgc28gYVxuICAvLyBmdWxseSBwdXNoZWQgYnJhbmNoIGxvb2tlZCBmb3VyIGNvbW1pdHMgYmVoaW5kLlxuICBjb25zdCBzdGF0ZVJlc3VsdCA9IGF3YWl0IGRlc2NyaWJlVW5wdXNoZWRDb21taXRzKGJyYW5jaE5hbWUsIG9wdGlvbnMpO1xuICBpZiAoIXN0YXRlUmVzdWx0Lm9rKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogc3RhdGVSZXN1bHQuZXJyb3IgfTtcbiAgfVxuICBjb25zdCB1bnB1c2hlZENvdW50ID0gc3RhdGVSZXN1bHQudmFsdWUuY291bnQ7XG5cbiAgLy8gU2hvcnQtY2lyY3VpdCBvbmx5IHdoZW4gdGhlIGJyYW5jaCBleGlzdHMgb24gdGhlIHJlbW90ZSBhbmQgaG9sZHMgZXZlcnlcbiAgLy8gbG9jYWwgY29tbWl0LiBXaGVuIGl0IGRvZXMgbm90IGV4aXN0IHlldCB3ZSBzdGlsbCBwdXNoLCBzbyBgLXVgIGNyZWF0ZXNcbiAgLy8gdGhlIHVwc3RyZWFtIHJlZi5cbiAgaWYgKHN0YXRlUmVzdWx0LnZhbHVlLnNoYSAhPT0gbnVsbCAmJiB1bnB1c2hlZENvdW50ID09PSAwKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiAwIH07XG4gIH1cblxuICAvLyBVc2UgLXUgc28gdGhlIGZpcnN0IHB1c2ggc2V0cyB0aGUgdXBzdHJlYW0gdHJhY2tpbmcgcmVmLiBUaGlzIGlzIGFcbiAgLy8gbm8tb3Agd2hlbiB0aGUgcmVmIGlzIGFscmVhZHkgY29uZmlndXJlZCwgc28gaXQgaXMgc2FmZSBmb3IgYm90aCB0aGVcbiAgLy8gZmlyc3QtdGltZSBwdXNoIGFuZCBzdWJzZXF1ZW50IHB1c2hlcy4gVGhlIGJyYW5jaCBpcyByb3V0ZWQgdGhyb3VnaFxuICAvLyBgYnVpbGRQdXNoQXJnc2AgKElzc3VlICMxNDgpLCB3aGljaCByZWplY3RzIGEgZGFzaC1sZWFkaW5nIG5hbWUgYW5kXG4gIC8vIGluc2VydHMgYC0tZW5kLW9mLW9wdGlvbnNgIHNvIGdpdCBjYW4gb25seSByZWFkIGl0IGFzIGEgcmVmc3BlYyDigJQgdGhpc1xuICAvLyBpcyB0aGUgcHVzaCBldmVyeSBhdXRvbWF0ZWQgY29tbWl0IHVzZXMsIFdJUCBwcmVzZXJ2YXRpb24gaW5jbHVkZWQuXG4gIGxldCBwdXNoQXJnczogc3RyaW5nW107XG4gIHRyeSB7XG4gICAgcHVzaEFyZ3MgPSBidWlsZFB1c2hBcmdzKFwib3JpZ2luXCIsIGJyYW5jaE5hbWUsIHsgc2V0VXBzdHJlYW06IHRydWUgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIEEgcmVmdXNlZCByZWYgaXMgYSBsb3VkIGZhaWx1cmUgUmVzdWx0LCBuZXZlciBhIHNpbGVudCBza2lwOiB0aGVcbiAgICAvLyBjYWxsZXIgcmVwb3J0cyBpdCBleGFjdGx5IGFzIGl0IHJlcG9ydHMgYW55IG90aGVyIHB1c2ggZmFpbHVyZS5cbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyIDogbmV3IEVycm9yKFN0cmluZyhlcnIpKSxcbiAgICB9O1xuICB9XG4gIGNvbnN0IHB1c2hSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKHB1c2hBcmdzLCBvcHRpb25zKTtcblxuICBpZiAoIXB1c2hSZXN1bHQub2spIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBwdXNoUmVzdWx0LmVycm9yIH07XG4gIH1cblxuICBpZiAocHVzaFJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgY29uc3QgcHVzaE91dHB1dCA9IHB1c2hSZXN1bHQudmFsdWUuc3RkZXJyICsgcHVzaFJlc3VsdC52YWx1ZS5zdGRvdXQ7XG5cbiAgICAvLyBTZWxmLWhlYWxpbmc6IGF0dGVtcHQgcmVjb3ZlcnkgZnJvbSBub24tZmFzdC1mb3J3YXJkIHJlamVjdGlvbiAoSXNzdWUgIzE4NilcbiAgICBpZiAoZGV0ZWN0UHVzaFJlamVjdGlvbihwdXNoT3V0cHV0KSkge1xuICAgICAgY29uc3QgcmVjb3ZlcnlSZXN1bHQgPSBhd2FpdCByZWNvdmVyRnJvbVB1c2hSZWplY3Rpb24oXG4gICAgICAgIGJyYW5jaE5hbWUsXG4gICAgICAgIG9wdGlvbnMsXG4gICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgYmVmb3JlUHVzaCxcbiAgICAgICk7XG4gICAgICBpZiAocmVjb3ZlcnlSZXN1bHQub2spIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bnB1c2hlZENvdW50IH07XG4gICAgICB9XG4gICAgICAvLyBJc3N1ZSAjMjExOiB0aGUgcmVjb3ZlcnkgZXJyb3IgbmFtZXMgdGhlIHN0ZXAgdGhhdCBmYWlsZWQg4oCUIGZldGNoLFxuICAgICAgLy8gbWVyZ2UgKGNvbmZsaWN0KSwgb3IgdGhlIHBsYWluIHJldHJ5IHB1c2ggKElzc3VlICMyODA4KSDigJQgYW5kIGNhcnJpZXNcbiAgICAgIC8vIGdpdCdzIHN0ZGVyci4gRHJvcHBpbmcgaXQgbGVmdCBjYWxsZXJzIGxvZ2dpbmcgYSBiYXJlXG4gICAgICAvLyBcInB1c2ggZmFpbGVkXCIgd2l0aCBub3RoaW5nIHRvIGFjdCBvbi5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgICBgRmFpbGVkIHRvIHB1c2ggdW5wdXNoZWQgY29tbWl0czogJHtwdXNoT3V0cHV0fVxcbmAgK1xuICAgICAgICAgICAgYFJlY292ZXJ5IGZyb20gdGhlIHJlamVjdGlvbiBhbHNvIGZhaWxlZDogJHtyZWNvdmVyeVJlc3VsdC5lcnJvci5tZXNzYWdlfWAsXG4gICAgICAgICksXG4gICAgICB9O1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKGBGYWlsZWQgdG8gcHVzaCB1bnB1c2hlZCBjb21taXRzOiAke3B1c2hPdXRwdXR9YCksXG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5wdXNoZWRDb3VudCB9O1xufVxuXG4vKipcbiAqIE1lcmdlIGBiYXNlQnJhbmNoYCBpbnRvIHRoZSBjaGVja2VkLW91dCBQUiBicmFuY2gganVzdCBiZWZvcmUgaXRzIGZpeCBpc1xuICogcHVzaGVkLCBzbyB0aGUgZml4IGFuZCB0aGUgYnJhbmNoIHVwZGF0ZSBnbyBvdXQgdG9nZXRoZXIgKG93bmVyIHJ1bGVcbiAqIDIwMjYtMTEtMDMpLlxuICpcbiAqIEFjdHMgb25seSB3aGVuIHRoZXJlIGlzIHNvbWV0aGluZyB0byBwdXNoIHRvIGEgYnJhbmNoIHRoYXQgYWxyZWFkeSBleGlzdHNcbiAqIG9uIG9yaWdpbjogYSBwYXNzIHdpdGggbm8gZml4IHB1c2hlcyBub3RoaW5nLCBhcyBiZWZvcmUsIGFuZCBhIGJyYW5kLW5ld1xuICogYnJhbmNoIGlzIGJyb3VnaHQgdXAgdG8gZGF0ZSBieSB0aGUgUFItcmFpc2Ugc3luYyBpbnN0ZWFkLiBUaGUgbWVyZ2UgaXMgdGhlXG4gKiBQUi1yYWlzZSBzeW5jJ3Mgb3duIChgZW5zdXJlQnJhbmNoQ3VycmVudGAgd2l0aCBgbWVyZ2VPbnRvQmFzZWApOiBhIHBsYWluXG4gKiBtZXJnZSBjb21taXQsIG5ldmVyIGEgcmViYXNlIG9yIGZvcmNlLXB1c2gsIHJlZnVzZWQgb24gYSBkaXJ0eSB0cmVlLCBhbmRcbiAqIGFib3J0ZWQgb24gYSBjb25mbGljdCBzbyB0aGUgZml4IGlzIHB1c2hlZCBhcyBiZWZvcmUgYW5kIHRoZSBjb25mbGljdCBsYW5lXG4gKiB0YWtlcyBvdmVyLiBOZXZlciBmYWlscyB0aGUgcHVzaC5cbiAqXG4gKiBAcmV0dXJucyBXaGF0IHRoZSBzeW5jIGRpZCwgb3IgYHVuZGVmaW5lZGAgd2hlbiBpdCBoYWQgbm90aGluZyB0byBkby5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1lcmdlQmFzZUJlZm9yZVB1c2goXG4gIGJyYW5jaE5hbWU6IHN0cmluZyxcbiAgYmFzZUJyYW5jaDogc3RyaW5nLFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxCcmFuY2hDdXJyZW5jeU91dGNvbWUgfCB1bmRlZmluZWQ+IHtcbiAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXNjcmliZVVucHVzaGVkQ29tbWl0cyhicmFuY2hOYW1lLCBvcHRpb25zKTtcbiAgaWYgKCFzdGF0ZS5vayB8fCBzdGF0ZS52YWx1ZS5zaGEgPT09IG51bGwgfHwgc3RhdGUudmFsdWUuY291bnQgPT09IDApIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGNvbnN0IG91dGNvbWUgPSBhd2FpdCBlbnN1cmVCcmFuY2hDdXJyZW50KHtcbiAgICBicmFuY2g6IGJyYW5jaE5hbWUsXG4gICAgYmFzZUJyYW5jaCxcbiAgICBydW5HaXQ6IHJ1bkdpdENvbW1hbmQsXG4gICAgY3dkOiBvcHRpb25zLmN3ZCxcbiAgICByZWJhc2U6IG1lcmdlT250b0Jhc2UsXG4gICAgbG9nOiAobWVzc2FnZSkgPT4gY29uc29sZS5sb2cobWVzc2FnZSksXG4gIH0pO1xuICBpZiAob3V0Y29tZS5raW5kID09PSBcImRlY2xpbmVkXCIgfHwgb3V0Y29tZS5raW5kID09PSBcInVua25vd25cIikge1xuICAgIGNvbnNvbGUud2FybihcbiAgICAgIGBQdXNoaW5nICcke2JyYW5jaE5hbWV9JyB3aXRob3V0ICcke2Jhc2VCcmFuY2h9JyBtZXJnZWQgaW4sIHNvIENJIG1heSBgICtcbiAgICAgICAgYHJ1biBhZ2FpbiB3aGVuIHRoZSBicmFuY2ggaXMgdXBkYXRlZDogJHtvdXRjb21lLmRldGFpbH1gLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG91dGNvbWU7XG59XG5cbi8qKlxuICogVGhlIFBSJ3MgYmFzZSBicmFuY2g6IHRoZSBvbmUgdGhlIGNhbGxlciBhbHJlYWR5IGtub3dzLCBvdGhlcndpc2UgcmVhZCBmcm9tXG4gKiBHaXRIdWIuIGB1bmRlZmluZWRgIHdoZW4gaXQgY2Fubm90IGJlIHJlYWQsIHNvIHRoZSBmaXggaXMgcHVzaGVkIGFzIGJlZm9yZVxuICogcmF0aGVyIHRoYW4gZmFpbGluZyB0aGUgcGFzcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHByQmFzZUZvclN5bmMoXG4gIGtub3duOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIHJlcG86IHN0cmluZyxcbiAgcHJOdW1iZXI6IG51bWJlcixcbiAgZ2g6IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+LFxuICB3YXJuOiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkID0gKG1lc3NhZ2UpID0+IGNvbnNvbGUud2FybihtZXNzYWdlKSxcbik6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPiB7XG4gIGlmIChrbm93biAhPT0gdW5kZWZpbmVkICYmIGtub3duLnRyaW0oKSAhPT0gXCJcIikgcmV0dXJuIGtub3duLnRyaW0oKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBiYXNlID0gKGF3YWl0IGdoKFtcbiAgICAgIFwicHJcIixcbiAgICAgIFwidmlld1wiLFxuICAgICAgU3RyaW5nKHByTnVtYmVyKSxcbiAgICAgIFwiLS1yZXBvXCIsXG4gICAgICByZXBvLFxuICAgICAgXCItLWpzb25cIixcbiAgICAgIFwiYmFzZVJlZk5hbWVcIixcbiAgICAgIFwiLS1qcVwiLFxuICAgICAgXCIuYmFzZVJlZk5hbWVcIixcbiAgICBdKSkudHJpbSgpO1xuICAgIGlmIChiYXNlICE9PSBcIlwiKSByZXR1cm4gYmFzZTtcbiAgICB3YXJuKGBQUiAjJHtwck51bWJlcn0gcmVwb3J0ZWQgbm8gYmFzZSBicmFuY2g7IGZpeCBwdXNoZWQgd2l0aG91dCBpdGApO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHdhcm4oXG4gICAgICBgQ291bGQgbm90IHJlYWQgdGhlIGJhc2UgYnJhbmNoIG9mIFBSICMke3ByTnVtYmVyfTsgZml4IHB1c2hlZCB3aXRob3V0IGl0OiAke1xuICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgIH1gLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBXaGF0IHtAbGluayBDb21taXRBbmRQdXNoUGVuZGluZ1Jlc3VsdC5maW5hbFVucHVzaGVkQ291bnR9IHdhcyBtZWFzdXJlZFxuICogYWdhaW5zdCAoSXNzdWUgIzIxMSkuXG4gKlxuICogQSBjb3VudCBpcyBvbmx5IHByb29mIHRoYXQgdGhlIHdvcmsgbGFuZGVkIHdoZW4gaXQgd2FzIHRha2VuIGFnYWluc3QgdGhlXG4gKiBicmFuY2gncyBvd24gaGVhZCBvbiB0aGUgcmVtb3RlLCBzbyB0aGUgcmVmZXJlbmNlIHBvaW50IGlzIHJlcG9ydGVkXG4gKiBhbG9uZ3NpZGUgdGhlIG51bWJlciByYXRoZXIgdGhhbiBsZWZ0IGZvciB0aGUgcmVhZGVyIHRvIGFzc3VtZS5cbiAqL1xuZXhwb3J0IHR5cGUgRmluYWxVbnB1c2hlZFNvdXJjZSA9XG4gIC8qKiBDb3VudGVkIGFnYWluc3QgdGhlIGJyYW5jaCdzIGhlYWQgb24gb3JpZ2luIOKAlCBhbiBhdXRob3JpdGF0aXZlIGFuc3dlci4gKi9cbiAgfCBcInJlbW90ZS1oZWFkXCJcbiAgLyoqIE9yaWdpbiBoYXMgbm8gc3VjaCBicmFuY2ggeWV0LCBzbyBldmVyeSBsb2NhbCBjb21taXQgaXMgdW5wdXNoZWQuICovXG4gIHwgXCJyZW1vdGUtYWJzZW50XCI7XG5cbi8qKlxuICogUmVzdWx0IG9mIHtAbGluayBjb21taXRBbmRQdXNoUGVuZGluZ30uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29tbWl0QW5kUHVzaFBlbmRpbmdSZXN1bHQge1xuICAvKiogV2hldGhlciB0aGUgaGVscGVyIGNyZWF0ZWQgYSBuZXcgY29tbWl0IGZyb20gcHJldmlvdXNseSB1bmNvbW1pdHRlZCBjaGFuZ2VzLiAqL1xuICBjb21taXR0ZWROZXdDaGFuZ2VzOiBib29sZWFuO1xuICAvKiogTnVtYmVyIG9mIGNvbW1pdHMgYWN0dWFsbHkgcHVzaGVkIHRvIG9yaWdpbi4gKi9cbiAgY29tbWl0c1B1c2hlZDogbnVtYmVyO1xuICAvKiogTnVtYmVyIG9mIGNvbW1pdHMgc3RpbGwgdW5wdXNoZWQgYWZ0ZXIgdGhlIHB1c2ggYXR0ZW1wdCAoMCA9IGNsZWFuKS4gKi9cbiAgZmluYWxVbnB1c2hlZENvdW50OiBudW1iZXI7XG4gIC8qKiBXaGF0IHtAbGluayBmaW5hbFVucHVzaGVkQ291bnR9IHdhcyBtZWFzdXJlZCBhZ2FpbnN0LiAqL1xuICBmaW5hbFVucHVzaGVkU291cmNlOiBGaW5hbFVucHVzaGVkU291cmNlO1xufVxuXG4vKipcbiAqIFJlc3VsdCBvZiB7QGxpbmsgdW5zdGFnZVdvcmtlclN0YXRlRmlsZXN9LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFVuc3RhZ2VXb3JrZXJTdGF0ZVJlc3VsdCB7XG4gIC8qKiBIb3cgbWFueSBzdGFnZWQgcGF0aHMgcmVtYWluIOKAlCAwIG1lYW5zIHRoZXJlIGlzIG5vdGhpbmcgcmVhbCB0byBjb21taXQuICovXG4gIHJlbWFpbmluZ1N0YWdlZDogbnVtYmVyO1xufVxuXG4vKipcbiAqIFN0YWdlIHdpdGggaW50ZW50IOKAlCBkcm9wIHRoZSB3b3JrZXIncyBvd24gc3RhdGUgZmlsZXMgZnJvbSB0aGUgaW5kZXhcbiAqIChJc3N1ZSAjMTY2MSwgcGFydCBvZiAjMTY0NDsgSXNzdWUgIzE3MTEpLlxuICpcbiAqIFRoZSB3b3JrZXIgd3JpdGVzIGAuaGVhcnRiZWF0Xzxvd25lcj5fPHJlcG8+XzxuPmAgYW5kXG4gKiBgLmhlYXJ0YmVhdC1tYXJrZXJfPG93bmVyPl88cmVwbz5fPG4+YCBpbnRvIHRoZSBkaXJlY3RvcnkgaXQgcnVucyBmcm9tXG4gKiAoYW5kLCBiZWZvcmUgSXNzdWUgIzE2NTIsIGAudmliZV9kZWZhdWx0X2JyYW5jaGAg4oCUIG9sZGVyIGNsb25lcyBtYXkgc3RpbGxcbiAqIGNhcnJ5IG9uZSksIGFuZCBpdHMgcHJvbXB0cyBhc2sgdGhlIGFnZW50IHRvIHdyaXRlIGl0cyBQUiByZXBseVxuICogaW50byBgLnByX3Jlc3BvbnNlX21lc3NhZ2VgIHRoZXJlIChJc3N1ZSAjMTcxMSkuIFdoZW4gdGhhdCBpcyBhIHJlcG9zaXRvcnlcbiAqIGNsb25lLCBgZ2l0IGFkZCAtQWAgc3RhZ2VzIHRoZW0gYW5kIHRoZSBwcmUtY29tbWl0IHNhZmV0eSBnYXRlIChJc3N1ZSAjMTc1OClcbiAqIHJlZnVzZXMgdGhlIGVudGlyZSBjb21taXQg4oCUIGEgbWVyZ2UtY29uZmxpY3QgcmVzb2x1dGlvbiBvciBhIENJIGZpeCBpcyBsb3N0XG4gKiBvdmVyIGEgZmlsZSB0aGUgd29ya2VyIGl0c2VsZiBwdXQgdGhlcmUuXG4gKlxuICogU28gdGhpcyBydW5zIEJFVFdFRU4gYGdpdCBhZGQgLUFgIGFuZCB0aGUgZ2F0ZTogdGhlIGdhdGUgbmV2ZXIgc2VlcyB0aGVtIGFuZFxuICogaXMgbGVmdCBjb21wbGV0ZWx5IHVuY2hhbmdlZCwgYW5kIGEgZ2VudWluZWx5IGhpZGRlbiBvciBzZWNyZXQtYmVhcmluZyBmaWxlXG4gKiBpcyBzdGlsbCByZWZ1c2VkIGV4YWN0bHkgYXMgYmVmb3JlLiBFYWNoIHVuc3RhZ2VkIHBhdGggaXMgd2FybmVkIGFib3V0XG4gKiByYXRoZXIgdGhhbiBzd2FsbG93ZWQg4oCUIGEgaGVhcnRiZWF0IG9yIGNhY2hlIGZpbGUgaW4gdGhlIHRyZWUgaXMgYSBidWcgd29ydGhcbiAqIHNlZWluZyDigJQgYnV0IGl0IGlzIG5vdCBhIHJlYXNvbiB0byBmYWlsIHRoZSBjb21taXQuIFRoZSBmaWxlIGl0c2VsZiBpc1xuICogdW50b3VjaGVkIG9uIGRpc2s7IG9ubHkgdGhlIGluZGV4IGVudHJ5IGdvZXMuIFRoYXQgbWF0dGVycyBmb3IgdGhlIHJlcGx5OlxuICogYHJlYWRQclJlc3BvbnNlTWVzc2FnZWAgY29uc3VtZXMgaXQgKmFmdGVyKiB0aGUgcHVzaC5cbiAqXG4gKiBBIGZhaWxpbmcgYGdpdCByZXNldGAgaXMgcmV0dXJuZWQgYXMgYW4gZXJyb3IsIG5ldmVyIGlnbm9yZWQ6IGNhcnJ5aW5nXG4gKiB3b3JrZXIgc3RhdGUgaW50byB0aGUgZ2F0ZSBpcyBwcmVjaXNlbHkgd2hhdCB0aGlzIGV4aXN0cyB0byBwcmV2ZW50LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdW5zdGFnZVdvcmtlclN0YXRlRmlsZXMoXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zLFxuKTogUHJvbWlzZTxSZXN1bHQ8VW5zdGFnZVdvcmtlclN0YXRlUmVzdWx0Pj4ge1xuICBjb25zdCBpbnNwZWN0aW9uID0gYXdhaXQgaW5zcGVjdFN0YWdlZEZpbGVzKG9wdGlvbnMpO1xuICBpZiAoIWluc3BlY3Rpb24ub2spIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBpbnNwZWN0aW9uLmVycm9yIH07XG4gIH1cblxuICBjb25zdCBzdGFnZWQgPSBbLi4uaW5zcGVjdGlvbi52YWx1ZS52aW9sYXRpb25zLCAuLi5pbnNwZWN0aW9uLnZhbHVlLnNhZmVdO1xuICBjb25zdCB3b3JrZXJTdGF0ZSA9IHN0YWdlZC5maWx0ZXIoaXNXb3JrZXJTdGF0ZVBhdGgpO1xuICBjb25zdCByZW1haW5pbmdTdGFnZWQgPSBzdGFnZWQubGVuZ3RoIC0gd29ya2VyU3RhdGUubGVuZ3RoO1xuXG4gIGlmICh3b3JrZXJTdGF0ZS5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHsgcmVtYWluaW5nU3RhZ2VkIH0gfTtcbiAgfVxuXG4gIC8vIGAtLWAgZ3VhcmRzIHRoZSBwYXRoIGxpc3Q7IGBnaXQgcmVzZXQgLS0gPHBhdGhzPmAgYWxzbyBiZWhhdmVzIG9uIGFuXG4gIC8vIHVuYm9ybiBIRUFELCB3aGVyZSBpdCByZXNldHMgdGhlIG5hbWVkIHBhdGhzIGFnYWluc3QgdGhlIGVtcHR5IHRyZWUuXG4gIGNvbnN0IHJlc2V0UmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJyZXNldFwiLCBcIi0tXCIsIC4uLndvcmtlclN0YXRlXSxcbiAgICBvcHRpb25zLFxuICApO1xuICBpZiAoIXJlc2V0UmVzdWx0Lm9rKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogcmVzZXRSZXN1bHQuZXJyb3IgfTtcbiAgfVxuICBpZiAocmVzZXRSZXN1bHQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBcIkZhaWxlZCB0byB1bnN0YWdlIHdvcmtlci1vd25lZCBzdGF0ZSBmaWxlcyAoSXNzdWUgIzE2NjEpOiBcIiArXG4gICAgICAgICAgYCR7cmVzZXRSZXN1bHQudmFsdWUuc3RkZXJyLnRyaW0oKX1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgY29uc29sZS53YXJuKFxuICAgIFwiW2dpdC1wdXNoXSBVbnN0YWdlZCB3b3JrZXItb3duZWQgc3RhdGUgZmlsZShzKSBiZWZvcmUgdGhlIHByZS1jb21taXQgXCIgK1xuICAgICAgXCJzYWZldHkgZ2F0ZSAoSXNzdWUgIzE2NjEpIOKAlCB0aGUgd29ya2VyIHdyb3RlIHRoZXNlIGludG8gdGhlIGNsb25lLCBcIiArXG4gICAgICBcIndoaWNoIGlzIGl0c2VsZiBhIGJ1ZyB3b3J0aCBmaXhpbmc6XFxuXCIgK1xuICAgICAgd29ya2VyU3RhdGUubWFwKChwKSA9PiBgICAtICR7cH1gKS5qb2luKFwiXFxuXCIpLFxuICApO1xuXG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogeyByZW1haW5pbmdTdGFnZWQgfSB9O1xufVxuXG4vKipcbiAqIFVuc3RhZ2UgdGhlIHdvcmtlcidzIG93biBzdGF0ZSBmaWxlcywgdGhlbiBydW4gdGhlIHByZS1jb21taXQgc2FmZXR5IGdhdGVcbiAqIHdoZW4gYW55dGhpbmcgcmVhbCByZW1haW5zIHN0YWdlZCAoSXNzdWUgIzQzOTQpLlxuICpcbiAqIFdoZW4gbm90aGluZyByZW1haW5zIHN0YWdlZCB0aGVyZSBpcyBub3RoaW5nIHRvIGdhdGUsIHNvIHRoZSBnYXRlIGlzIHNraXBwZWRcbiAqIGFuZCB0aGUgY2FsbGVyIHNlZXMgYHJlbWFpbmluZ1N0YWdlZCA9PT0gMGAuIEEgZmFpbHVyZSBmcm9tIGVpdGhlciBzdGVwIGlzXG4gKiByZXR1cm5lZCBhcyBhbiBlcnJvci5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHVuc3RhZ2VTdGF0ZUFuZEFzc2VydFNhZmUoXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zLFxuKTogUHJvbWlzZTxSZXN1bHQ8VW5zdGFnZVdvcmtlclN0YXRlUmVzdWx0Pj4ge1xuICBjb25zdCB1bnN0YWdlZCA9IGF3YWl0IHVuc3RhZ2VXb3JrZXJTdGF0ZUZpbGVzKG9wdGlvbnMpO1xuICBpZiAoIXVuc3RhZ2VkLm9rKSByZXR1cm4gdW5zdGFnZWQ7XG4gIGlmICh1bnN0YWdlZC52YWx1ZS5yZW1haW5pbmdTdGFnZWQgPT09IDApIHJldHVybiB1bnN0YWdlZDtcblxuICBjb25zdCBzYWZlID0gYXdhaXQgYXNzZXJ0U2FmZVRvQ29tbWl0KG9wdGlvbnMpO1xuICByZXR1cm4gc2FmZS5vayA/IHVuc3RhZ2VkIDogeyBvazogZmFsc2UsIGVycm9yOiBzYWZlLmVycm9yIH07XG59XG5cbi8qKlxuICogSGVhZCBhbmQgdGFpbCBidWRnZXRzIGZvciB0aGUgZ2F0ZSBvdXRwdXQgY2FycmllZCBpbiBhIHJldHVybmVkIGVycm9yIChQUlxuICogIzM3MTYgcmV2aWV3KS4gVGhlIGhlYWQgaG9sZHMgdGhlIGxpbmUgdGhhdCBuYW1lcyB0aGUgZmFpbGluZyBjb21tYW5kOyB0aGVcbiAqIHRhaWwgaG9sZHMgdGhlIGVuZCBvZiBpdHMgb3V0cHV0LiBUaGUgZXJyb3IgcmVhY2hlcyBhIFBSIGNvbW1lbnQgKHRoZVxuICogUFItcHJvY2Vzc29yIFwiZml4ZWQgbG9jYWxseSBidXQgZmFpbGVkIHRvIHB1c2hcIiByZXBseSksIGFuZCBHaXRIdWIgcmVmdXNlcyBhXG4gKiBjb21tZW50IGJvZHkgb3ZlciA2NSw1MzYgY2hhcmFjdGVyczsgYSBmZXcgS0Igc3RheXMgZmFyIHVuZGVyIGl0LlxuICovXG5leHBvcnQgY29uc3QgUFJFX1BVU0hfR0FURV9SRUFTT05fSEVBRF9DSEFSUyA9IDIwMDA7XG5leHBvcnQgY29uc3QgUFJFX1BVU0hfR0FURV9SRUFTT05fVEFJTF9DSEFSUyA9IDIwMDA7XG5cbi8qKiBSZWRhY3QgYSBnYXRlJ3Mgb3V0cHV0LCB0aGVuIGtlZXAgb25seSBpdHMgaGVhZCBhbmQgdGFpbC4gKi9cbmZ1bmN0aW9uIGNhcEdhdGVUZXh0KHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiByZWRhY3RlZEhlYWRUYWlsKFxuICAgIHRleHQsXG4gICAgUFJFX1BVU0hfR0FURV9SRUFTT05fSEVBRF9DSEFSUyxcbiAgICBQUkVfUFVTSF9HQVRFX1JFQVNPTl9UQUlMX0NIQVJTLFxuICApO1xufVxuXG4vKipcbiAqIFRoZSBwcmUtcHVzaCBnYXRlIGdhdmUgYSB2ZXJkaWN0IG9uIHRoZSBicmFuY2gncyBjb250ZW50IChQUiAjMzcxNiByZXZpZXcpOlxuICogYSBjaGFuZ2VkLWZpbGUgb3IgcHJlLWZsaWdodCBjb21tYW5kIGZhaWxlZCwgb3IgYSBwbGFuIGNvdWxkIG5vdCBiZSBidWlsdC5cbiAqIHtAbGluayBnYXRlVW5wdXNoZWRDb21taXRzfSByZXR1cm5zXG4gKiBhbnkgb3RoZXIgZXJyb3IgKGEgZ2l0IG9yIHJlbW90ZSBsb29rdXAgdGhhdCBmYWlsZWQgb3IgdGltZWQgb3V0KSBhcyBhblxuICogaW5mcmFzdHJ1Y3R1cmUgZXJyb3IsXG4gKiBzbyBhIGNhbGxlciB0aGF0IGJsYW1lcyB0aGUgYnJhbmNoIGZvciBhIGZhaWxlZCBnYXRlIGNhbiB0ZWxsIHRoZSB0d28gYXBhcnQuXG4gKi9cbmV4cG9ydCBjbGFzcyBQcmVQdXNoR2F0ZUJsb2NrZWRFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkga2luZCA9IFwidmVyZGljdFwiIGFzIGNvbnN0O1xuXG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZywgb3B0aW9ucz86IHsgY2F1c2U/OiB1bmtub3duIH0pIHtcbiAgICBzdXBlcihtZXNzYWdlLCBvcHRpb25zKTtcbiAgICB0aGlzLm5hbWUgPSBcIlByZVB1c2hHYXRlQmxvY2tlZEVycm9yXCI7XG4gIH1cbn1cblxuLyoqXG4gKiBXaGF0IHtAbGluayBnYXRlVW5wdXNoZWRDb21taXRzfSBmb3VuZCwgc28gYSBjYWxsZXIgY2FuIGxvZyBpdCAoSXNzdWVcbiAqICMzNzcwKTogYG5vb3BgIHJhbiBubyBjaGVjayBiZWNhdXNlIG5vdGhpbmcgbmVlZGVkIGdhdGluZyDigJQgbm8gdW5wdXNoZWRcbiAqIGNvbW1pdCwgb3Igbm8gY29tbWl0IG9mIHRoZSBicmFuY2gncyBvd24gYWhlYWQgb2YgYGJhc2VSZWZgIOKAlCBhbmQgYHBhc3NlZGBcbiAqIHJhbiBhbmQgbmFtZXMgdGhlIGNoYW5nZWQtZmlsZSBjaGVja3MgdGhhdCBwYXNzZWQgKHRoZSByZXBvJ3MgcHJlLWZsaWdodFxuICogY29tbWFuZHMsIHdoZW4gY29uZmlndXJlZCwgcnVuIHRvbyBhbmQgYXJlIG5vdCBsaXN0ZWQpLlxuICovXG5leHBvcnQgdHlwZSBQcmVQdXNoR2F0ZU91dGNvbWUgPVxuICB8IHsga2luZDogXCJub29wXCIgfVxuICB8IHsga2luZDogXCJwYXNzZWRcIjsgY2hlY2tzUnVuOiBzdHJpbmdbXSB9O1xuXG4vKipcbiAqIFJ1biB0aGUgcHJlLXB1c2ggZ2F0ZSBvdmVyIHRoZSBjb21taXRzIGFib3V0IHRvIGJlIHB1c2hlZCAoSXNzdWUgIzM2ODkpLlxuICpcbiAqIEEgbm8tb3Agd2hlbiBub3RoaW5nIGlzIHVucHVzaGVkLiBTeW50aGVzaXNlcyB0aGUgc3RkaW4gZ2l0IHdvdWxkIGhhbmQgYVxuICogcHJlLXB1c2ggaG9vayAoYDxsb2NhbCByZWY+IDxsb2NhbCBzaGE+IDxyZW1vdGUgcmVmPiA8cmVtb3RlIHNoYT5gKSwgdXNpbmdcbiAqIGZvcnR5IHplcm9zIHdoZW4gdGhlIGJyYW5jaCBoYXMgbm8gbG9jYWwgdHJhY2tpbmcgcmVmLiBQcmUtZmxpZ2h0IGNvbW1hbmRzXG4gKiBhcmUgc2tpcHBlZCB3aGVuIFN0ZXAgMSBhbHJlYWR5IHJhbiB0aGVtIHRoaXMgY2FsbC4gQW55IGZhaWx1cmUg4oCUIGluY2x1ZGluZ1xuICogYmVpbmcgdW5hYmxlIHRvIGRldGVybWluZSB0aGUgc3RhdGUg4oCUIGlzIHJldHVybmVkIGFzIGFuIGVycm9yIHNvIHRoZSBjYWxsZXJcbiAqIHJlZnVzZXMgdG8gcHVzaCAoZmFpbCBjbG9zZWQpLiBPbmx5IGEgdmVyZGljdCBvbiB0aGUgYnJhbmNoJ3MgY29udGVudCBpcyBhXG4gKiB7QGxpbmsgUHJlUHVzaEdhdGVCbG9ja2VkRXJyb3J9OyBhIGZhaWxlZCBnaXQgb3IgcmVtb3RlIGxvb2t1cCBpcyBhXG4gKiBgUHJlUHVzaEdhdGVJbmZyYXN0cnVjdHVyZUVycm9yYCB3aXRoIG5vIGBbUFJFX1BVU0hfQkxPQ0tFRF1gXG4gKiBwcmVmaXgsIHNvIGl0IGlzIG5vdCByZXBvcnRlZCBhcyB0aGUgYnJhbmNoIGZhaWxpbmcgaXRzIGNoZWNrcy5cbiAqXG4gKiBXaXRoIGBiYXNlUmVmYCB0aGUgZ2F0ZSBjb3ZlcnMgZXZlcnkgbm9uLW1lcmdlIGNvbW1pdCB0aGUgYnJhbmNoIGhhcyBhaGVhZFxuICogb2YgdGhhdCByZWYsIHB1c2hlZCBvciBub3QgKElzc3VlICMzNjg5KTogdGhlIGV4ZWN1dGUgcGhhc2UncyBXSVBcbiAqIGNoZWNrcG9pbnRzIHB1c2ggdGhlIGFnZW50J3MgY29tbWl0cyB1bmdhdGVkLCBzbyB0aGUgY29tcGxldGlvbiBwaGFzZVxuICogY2hlY2tzIHRoZSB3aG9sZSBicmFuY2ggYmVmb3JlIGl0IHJhaXNlcyB0aGUgUFIuIEl0IGlzIGEgbm8tb3Agb25seSB3aGVuXG4gKiB0aGUgYnJhbmNoIGhhcyBubyBjb21taXQgb2YgaXRzIG93biBhaGVhZCBvZiBgYmFzZVJlZmAuIFRoYXQgbW9kZSBuZXZlclxuICogcmVhZHMgdGhlIHJlbW90ZSBoZWFkOiB0aGUgcmFuZ2UgaXMgbG9jYWwsIHNvIG5vIGBscy1yZW1vdGVgIG9yIGBmZXRjaGAgcnVucy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdhdGVVbnB1c2hlZENvbW1pdHMoXG4gIGJyYW5jaE5hbWU6IHN0cmluZyxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMsXG4gIHByZUZsaWdodDogUHJlRmxpZ2h0R2F0ZVNwZWMsXG4gIHByZUZsaWdodEFscmVhZHlSYW4gPSBmYWxzZSxcbiAgYmFzZVJlZj86IHN0cmluZyxcbik6IFByb21pc2U8XG4gIFJlc3VsdDxcbiAgICBQcmVQdXNoR2F0ZU91dGNvbWUsXG4gICAgUHJlUHVzaEdhdGVCbG9ja2VkRXJyb3IgfCBQcmVQdXNoR2F0ZUluZnJhc3RydWN0dXJlRXJyb3JcbiAgPlxuPiB7XG4gIGxldCByZW1vdGVTaGEgPSBcIjBcIi5yZXBlYXQoNDApO1xuICBpZiAoYmFzZVJlZiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXNjcmliZVVucHVzaGVkQ29tbWl0cyhicmFuY2hOYW1lLCBvcHRpb25zKTtcbiAgICBpZiAoIXN0YXRlLm9rKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgUHJlUHVzaEdhdGVJbmZyYXN0cnVjdHVyZUVycm9yKHN0YXRlLmVycm9yLm1lc3NhZ2UsIHtcbiAgICAgICAgICBjYXVzZTogc3RhdGUuZXJyb3IsXG4gICAgICAgIH0pLFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKHN0YXRlLnZhbHVlLmNvdW50ID09PSAwKSByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHsga2luZDogXCJub29wXCIgfSB9O1xuICAgIGlmIChzdGF0ZS52YWx1ZS5zb3VyY2UgPT09IFwidHJhY2tpbmctcmVmXCIgJiYgc3RhdGUudmFsdWUuc2hhKSB7XG4gICAgICByZW1vdGVTaGEgPSBzdGF0ZS52YWx1ZS5zaGE7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIC8vIFdob2xlLWJyYW5jaCBtb2RlOiBXSVAgY2hlY2twb2ludHMgbWF5IGFscmVhZHkgaGF2ZSBwdXNoZWQgdGhlIGNvbW1pdHMsXG4gICAgLy8gc28gXCJub3RoaW5nIHVucHVzaGVkXCIgc2F5cyBub3RoaW5nLiBTa2lwIG9ubHkgd2hlbiB0aGUgYnJhbmNoIGhhcyBub1xuICAgIC8vIGNvbW1pdCBvZiBpdHMgb3duIGFoZWFkIG9mIHRoZSBiYXNlLlxuICAgIHRyeSB7XG4gICAgICBhc3NlcnRTYWZlR2l0UmVmKGJhc2VSZWYsIFwiZ2F0ZSBiYXNlIHJlZlwiKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogbmV3IFByZVB1c2hHYXRlQmxvY2tlZEVycm9yKFxuICAgICAgICAgIGBbUFJFX1BVU0hfQkxPQ0tFRF0gJHtcbiAgICAgICAgICAgIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKVxuICAgICAgICAgIH1gLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9XG4gICAgY29uc3QgYWhlYWQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgICAgW1wicmV2LWxpc3RcIiwgXCItLWNvdW50XCIsIFwiLS1uby1tZXJnZXNcIiwgYCR7YmFzZVJlZn0uLkhFQURgXSxcbiAgICAgIG9wdGlvbnMsXG4gICAgKTtcbiAgICBpZiAoIWFoZWFkLm9rKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgUHJlUHVzaEdhdGVJbmZyYXN0cnVjdHVyZUVycm9yKGFoZWFkLmVycm9yLm1lc3NhZ2UsIHtcbiAgICAgICAgICBjYXVzZTogYWhlYWQuZXJyb3IsXG4gICAgICAgIH0pLFxuICAgICAgfTtcbiAgICB9XG4gICAgY29uc3QgYWhlYWRDb3VudCA9IE51bWJlci5wYXJzZUludChhaGVhZC52YWx1ZS5zdGRvdXQudHJpbSgpLCAxMCk7XG4gICAgaWYgKGFoZWFkLnZhbHVlLmNvZGUgIT09IDAgfHwgIU51bWJlci5pc0Zpbml0ZShhaGVhZENvdW50KSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogbmV3IFByZVB1c2hHYXRlSW5mcmFzdHJ1Y3R1cmVFcnJvcihcbiAgICAgICAgICBgZ2l0IHJldi1saXN0ICR7YmFzZVJlZn0uLkhFQUQgZmFpbGVkOiAke1xuICAgICAgICAgICAgYWhlYWQudmFsdWUuc3RkZXJyLnRyaW0oKSB8fCBgZXhpdCAke2FoZWFkLnZhbHVlLmNvZGV9YFxuICAgICAgICAgIH1gLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKGFoZWFkQ291bnQgPT09IDApIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogeyBraW5kOiBcIm5vb3BcIiB9IH07XG4gIH1cblxuICBjb25zdCBoZWFkID0gYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJyZXYtcGFyc2VcIiwgXCJIRUFEXCJdLCBvcHRpb25zKTtcbiAgaWYgKCFoZWFkLm9rKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgUHJlUHVzaEdhdGVJbmZyYXN0cnVjdHVyZUVycm9yKGhlYWQuZXJyb3IubWVzc2FnZSwge1xuICAgICAgICBjYXVzZTogaGVhZC5lcnJvcixcbiAgICAgIH0pLFxuICAgIH07XG4gIH1cbiAgaWYgKGhlYWQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IFByZVB1c2hHYXRlSW5mcmFzdHJ1Y3R1cmVFcnJvcihcbiAgICAgICAgYGdpdCByZXYtcGFyc2UgSEVBRCBmYWlsZWQ6ICR7aGVhZC52YWx1ZS5zdGRlcnIudHJpbSgpfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgY29uc3QgcmVmID0gYHJlZnMvaGVhZHMvJHticmFuY2hOYW1lfWA7XG4gIGNvbnN0IGdhdGUgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7XG4gICAgY3dkOiBvcHRpb25zLmN3ZCA/PyBEZW5vLmN3ZCgpLFxuICAgIHN0ZGluOiBgJHtyZWZ9ICR7aGVhZC52YWx1ZS5zdGRvdXQudHJpbSgpfSAke3JlZn0gJHtyZW1vdGVTaGF9XFxuYCxcbiAgICBwcmVGbGlnaHRDb21tYW5kczogcHJlRmxpZ2h0QWxyZWFkeVJhbiA/IFtdIDogcHJlRmxpZ2h0LmNvbW1hbmRzLFxuICAgIHNoZWxsY2hlY2tPbmx5OiBwcmVGbGlnaHQuc2hlbGxjaGVja09ubHksXG4gICAgdGltZW91dFNlY29uZHM6IHByZUZsaWdodC50aW1lb3V0U2Vjb25kcyxcbiAgICBydW5uZXI6IHByZUZsaWdodC5ydW5uZXIsXG4gICAgYmFzZVJlZixcbiAgfSk7XG4gIGlmICghZ2F0ZS5vaykge1xuICAgIC8vIEEgbG9va3VwIHRoYXQgZmFpbGVkIGlzIG5vdCBhIHZlcmRpY3Q6IHBhc3MgaXQgb24gdW5tYXJrZWQuXG4gICAgaWYgKGdhdGUuZXJyb3IgaW5zdGFuY2VvZiBQcmVQdXNoR2F0ZUluZnJhc3RydWN0dXJlRXJyb3IpIHtcbiAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGdhdGUuZXJyb3IgfTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgUHJlUHVzaEdhdGVCbG9ja2VkRXJyb3IoXG4gICAgICAgIGBbUFJFX1BVU0hfQkxPQ0tFRF0gJHtjYXBHYXRlVGV4dChnYXRlLmVycm9yLm1lc3NhZ2UpfVxcbmAgK1xuICAgICAgICAgIGBVbnB1c2hlZCBjb21taXRzIG9uICR7YnJhbmNoTmFtZX0gd2VyZSBub3QgcHVzaGVkLmAsXG4gICAgICAgIHsgY2F1c2U6IGdhdGUuZXJyb3IgfSxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIG9rOiB0cnVlLFxuICAgIHZhbHVlOiB7IGtpbmQ6IFwicGFzc2VkXCIsIGNoZWNrc1J1bjogZ2F0ZS52YWx1ZS5jaGVja3NSdW4gfSxcbiAgfTtcbn1cblxuLyoqXG4gKiBDb21taXQgYW55IHVuY29tbWl0dGVkIHdvcmtpbmctdHJlZSBjaGFuZ2VzIGFuZCBwdXNoIGV2ZXJ5IHVucHVzaGVkIGNvbW1pdFxuICogdG8gb3JpZ2luIChJc3N1ZSAjMTY0MyDigJQgXCJXaHkgd2UgZm9yZ2V0IHRvIHB1c2g/XCIpLlxuICpcbiAqIFRoZSBWaWJlIENvZGVyIHJ1bnMgdW5hdHRlbmRlZC4gUGhhc2UgcHJvY2Vzc29ycyB1c2VkIHRvIGdhdGUgdGhlIHB1c2hcbiAqIHN0ZXAgb24gQ2xhdWRlJ3Mgc3Rkb3V0IG91dHB1dCAoYGNsYXVkZU91dHB1dC5sZW5ndGggPiAwYCksIHdoaWNoIGlzIG5vdFxuICogYSByZWxpYWJsZSBzaWduYWwgb2Ygd2hldGhlciBjb21taXRzIGV4aXN0IGxvY2FsbHkuIFdoZW4gQ2xhdWRlIGNvbW1pdHRlZFxuICogc2lsZW50bHkg4oCUIG9yIGxlZnQgdW5jb21taXR0ZWQgY2hhbmdlcyDigJQgdGhlIHB1c2ggc3RlcCB3YXMgc2tpcHBlZCBhbmRcbiAqIHRoZSB3b3JrIHdhcyBsb3N0IG9uIHRoZSBsb2NhbCBtYWNoaW5lLiBUaGlzIGhlbHBlciBjbG9zZXMgdGhhdCBnYXAgYnlcbiAqIHVzaW5nIGdpdCBpdHNlbGYgYXMgdGhlIHNvdXJjZSBvZiB0cnV0aDpcbiAqXG4gKiAgIDEuIGBnaXQgc3RhdHVzIC0tcG9yY2VsYWluYCDigJQgaWYgZGlydHksIHN0YWdlIGFuZCBjb21taXQgd2l0aCB0aGVcbiAqICAgICAgcHJvdmlkZWQgbWVzc2FnZS5cbiAqICAgMWEuIFN0ZXAgMWEg4oCUIHdoZW4gYGZvcm1hdEJlZm9yZUdhdGVgIGlzIHN1cHBsaWVkLCBpdCBydW5zICh0aGUgUFJcbiAqICAgICAgcHJvY2Vzc29ycyBwYXNzIHRoZSByZXBvc2l0b3J5J3MgZm9ybWF0dGVycyBvdmVyIHRoZSB1bnB1c2hlZFxuICogICAgICBjb21taXRzLCB3aGljaCBjb21taXQgdGhlaXIgb3duIHJlc3VsdCkuIEl0IGNhbm5vdCBmYWlsIHRoZSBjYWxsOiBhXG4gKiAgICAgIHRocm93IGlzIGxvZ2dlZCBhbmQgU3RlcCAxYiBzdGlsbCBjaGVja3MgZXZlcnl0aGluZy5cbiAqICAgMWIuIFN0ZXAgMWIg4oCUIHdoZW4gYHByZUZsaWdodGAgaXMgc3VwcGxpZWQsIGBnYXRlVW5wdXNoZWRDb21taXRzYCBydW5zXG4gKiAgICAgIHRoZSBjaGFuZ2VkLWZpbGUgcHJlLXB1c2ggY2hlY2tzIChgcnVuUHJlUHVzaEdhdGVgKSBvdmVyIHRoZSB1bnB1c2hlZFxuICogICAgICBjb21taXRzLCBpbmNsdWRpbmcgYW55IHRoZSBhZ2VudCBjb21taXR0ZWQgYnV0IG5ldmVyIHB1c2hlZCAobm90aGluZ1xuICogICAgICBydW5zIHdoZW4gbm8gY29tbWl0IGlzIHVucHVzaGVkKS4gV2hlbiBTdGVwIDEgY29tbWl0dGVkIG5vdGhpbmcgaXRcbiAqICAgICAgYWxzbyByZS1ydW5zIHRoZSByZXBvJ3MgcHJlLWZsaWdodCBjb21tYW5kczsgd2hlbiBTdGVwIDEgY29tbWl0dGVkLFxuICogICAgICB0aG9zZSBjb21tYW5kcyBhbHJlYWR5IHJhbiB0aGVyZSBhbmQgYXJlIG5vdCByZXBlYXRlZC4gQSBibG9ja1xuICogICAgICByZWZ1c2VzIHRoZSBwdXNoLiBXaXRoIG5vIHByZS1mbGlnaHQgc3BlYyBTdGVwIDFiIGRvZXMgbm90IHJ1biwgc29cbiAqICAgICAgV0lQIGNoZWNrcG9pbnQgcHVzaGVzIGFyZSBuZXZlciByZWZ1c2VkLiBUaGUgZ2F0ZSBvdXRwdXQgaW4gdGhlXG4gKiAgICAgIHJldHVybmVkIGVycm9yIGlzIGN1dCB0byBhIGhlYWQgYW5kIGEgdGFpbCAoYXMgaXMgU3RlcCAxJ3MgcHJlLWZsaWdodFxuICogICAgICBibG9jayksIGJlY2F1c2UgUFIgcHJvY2Vzc29ycyBwb3N0IGl0IGluIGEgY29tbWVudC5cbiAqICAgMWMuIFN0ZXAgMWMg4oCUIHdoZW4gYG9wdGlvbnMuc3luY0Jhc2VCcmFuY2hgIGlzIHNldCBhbmQgdGhlcmUgaXMgYSBmaXggdG9cbiAqICAgICAgcHVzaCB0byBhbiBleGlzdGluZyBicmFuY2gsIHtAbGluayBtZXJnZUJhc2VCZWZvcmVQdXNofSBtZXJnZXMgdGhhdFxuICogICAgICBiYXNlIGluLCBzbyB0aGUgZml4IGFuZCB0aGUgYnJhbmNoIHVwZGF0ZSBnbyBvdXQgaW4gb25lIHB1c2guXG4gKiAgIDIuIGBwdXNoVW5wdXNoZWRDb21taXRzYCDigJQgcHVzaCBldmVyeSBjb21taXQgYWhlYWQgb2Ygb3JpZ2luIChoYW5kbGVzXG4gKiAgICAgIGZpcnN0LXRpbWUgcHVzaCBhbmQgbm9uLWZhc3QtZm9yd2FyZCByZWNvdmVyeSBpbnRlcm5hbGx5KS5cbiAqICAgMy4gUmUtY291bnQgdW5wdXNoZWQgY29tbWl0cyBhZ2FpbnN0IHRoZSBicmFuY2gncyBvd24gcmVtb3RlIGhlYWQg4oCUXG4gKiAgICAgIGBmaW5hbFVucHVzaGVkQ291bnRgIE1VU1QgYmUgMCwgYW5kIGBmaW5hbFVucHVzaGVkU291cmNlYCBuYW1lcyB3aGF0XG4gKiAgICAgIHRoYXQgY291bnQgd2FzIG1lYXN1cmVkIGFnYWluc3QsIGZvciB0aGUgY2FsbGVyIHRvIGNsYWltIHRoZSBwdXNoXG4gKiAgICAgIHN1Y2NlZWRlZCBob25lc3RseS5cbiAqXG4gKiBDYWxsZXJzIHNob3VsZCBhbHdheXMgaW52b2tlIHRoaXMgYXQgdGhlIGVuZCBvZiBhbnkgQ2xhdWRlLWRyaXZlbiBwaGFzZS5cbiAqIEl0IGlzIGlkZW1wb3RlbnQg4oCUIHdoZW4gdGhlcmUgaXMgbm90aGluZyB0byBjb21taXQgYW5kIG5vdGhpbmcgdG8gcHVzaFxuICogaXQgcmVwb3J0cyBgY29tbWl0dGVkTmV3Q2hhbmdlczogZmFsc2UsIGNvbW1pdHNQdXNoZWQ6IDBgIGFuZCBhXG4gKiBgZmluYWxVbnB1c2hlZENvdW50YCBvZiAwLlxuICpcbiAqIEBwYXJhbSBicmFuY2hOYW1lIC0gVGhlIGJyYW5jaCB0byBwdXNoXG4gKiBAcGFyYW0gY29tbWl0TWVzc2FnZSAtIENvbW1pdCBtZXNzYWdlIHVzZWQgd2hlbiBzdGFnaW5nIGRpcnR5IHdvcmtpbmctdHJlZSBjaGFuZ2VzXG4gKiBAcGFyYW0gb3B0aW9ucyAtIEdpdCBjb21tYW5kIG9wdGlvbnNcbiAqIEBwYXJhbSBhbGxvd0RlZmF1bHRCcmFuY2ggLSBPcHQtb3V0IGZvciB0aGUgcmVhZC1vbmx5IGRlZmF1bHQtYnJhbmNoIGd1YXJkXG4gKiAgIChJc3N1ZSAjMjU4NCkuIERlZmF1bHRzIHRvIGBmYWxzZWAgKGZvcmJpZCBwdXNoaW5nIHRvIHRoZSBkZWZhdWx0IGJyYW5jaCkuXG4gKiBAcGFyYW0gcHJlRmxpZ2h0IC0gT3B0aW9uYWwgbWFuZGF0b3J5IHByZS1mbGlnaHQgZ2F0ZSAoSXNzdWUgIzM1NzcpLiBXaGVuXG4gKiAgIHN1cHBsaWVkIHdpdGggYSBub24tZW1wdHkgYGNvbW1hbmRzYCBsaXN0LCB0aGUgY29tbWFuZHMgcnVuIGF0IHRoZVxuICogICBgYXNzZXJ0U2FmZVRvQ29tbWl0KClgIGNob2tlcG9pbnQgYmVmb3JlIHRoZSBhdXRvbWF0ZWQgY29tbWl0LCBhbmQgYWdhaW5cbiAqICAgaW4gU3RlcCAxYiB3aGVuIFN0ZXAgMSBjb21taXR0ZWQgbm90aGluZyBhbmQgdW5wdXNoZWQgY29tbWl0cyBleGlzdDsgdGhlXG4gKiAgIGZpcnN0IG5vbi16ZXJvIGV4aXQgKG9yIGEgY29tbWFuZCB0aGF0IGNhbm5vdCBiZSBzdGFydGVkLCBvciBhIHRpbWVvdXQpXG4gKiAgIGJsb2NrcyBCT1RIIHRoZSBjb21taXQgYW5kIHRoZSBwdXNoLiBUaGVyZSBpcyBubyBvdmVycmlkZSBmbGFnLiBTdXBwbHlpbmdcbiAqICAgYSBzcGVjLCBldmVuIG9uZSB3aXRoIGFuIGVtcHR5IGBjb21tYW5kc2AgbGlzdCwgYWxzbyB0dXJucyBvbiBTdGVwIDFiJ3NcbiAqICAgY2hhbmdlZC1maWxlIGNoZWNrcyAoSXNzdWUgIzM2ODkpLiBPbWl0IHRvIGxlYXZlIHRoZSByZXBvIHVuYWZmZWN0ZWRcbiAqICAgKHplcm8gYWRkZWQgbGF0ZW5jeSwgbm8gZ2F0ZSk7IGEgYHNoZWxsY2hlY2tPbmx5YCBzcGVjIHJ1bnMgdGhlXG4gKiAgIHJlcG9zaXRvcnkgU2hlbGxDaGVjayBwb2xpY3ksIHBsdXMgdGhlIENJIGNhcmdvLWRlbnkgY2hlY2sgd2hlbiB0aGUgcHVzaGVkXG4gKiAgIHBhdGhzIGluY2x1ZGUgYSBjYXJnbyBpbnB1dCAoSXNzdWVzICM0NjMxIGFuZCAjNDYyNikuXG4gKiBAcGFyYW0gcnVuSWQgLSBSdW4gaWQgc3RhbXBlZCBpbnRvIHRoZSBgVmliZS1Db2Rlci1SdW4tSWRgIGNvbW1pdCB0cmFpbGVyXG4gKiAgIChJc3N1ZSAjOTYzKS4gT21pdCBpbiBwcm9kdWN0aW9uOiBpdCB0aGVuIGZhbGxzIGJhY2sgdG8ge0BsaW5rIGdldFJ1bklkfSxcbiAqICAgd2hpY2ggcmVhZHMgYFZJQkVfUlVOX0lEYCBhbmQgZ2VuZXJhdGVzLWFuZC1jYWNoZXMgb25lIHdoZW4gdW5zZXQsIGV4YWN0bHlcbiAqICAgYXMgYmVmb3JlLiBTdXBwbHlpbmcgaXQgaXMgd2hhdCBsZXRzIGEgdGVzdCBwcm92ZSB0aGUgdHJhaWxlciB3aXRob3V0XG4gKiAgIHNldHRpbmcgYFZJQkVfUlVOX0lEYCBvbiB0aGUgcHJvY2VzcyDigJQgYSBtdXRhdGlvbiB0aGF0IHJhY2VzIGV2ZXJ5IG90aGVyXG4gKiAgIHRlc3QgaW4gdGhlIHJ1biAoSXNzdWUgIzg4MCkuIFRoZSB2YWx1ZSBpcyBzdGFtcGVkIHZlcmJhdGltOyB0aGUgdHJhaWxlcidzXG4gKiAgIGZvcm1hdCBpcyBgYXBwZW5kUnVuSWRUcmFpbGVyYCdzIGFuZCBpcyB1bmFmZmVjdGVkIGJ5IHdoZXJlIHRoZSBpZCBjYW1lXG4gKiAgIGZyb20uXG4gKiBAcGFyYW0gZm9ybWF0QmVmb3JlR2F0ZSAtIE9wdGlvbmFsIFN0ZXAgMWEgaG9vaywgcnVuIGFmdGVyIFN0ZXAgMSdzIGNvbW1pdFxuICogICBhbmQgYmVmb3JlIFN0ZXAgMWIncyBnYXRlIHdoZXRoZXIgb3Igbm90IGBwcmVGbGlnaHRgIGlzIHN1cHBsaWVkLiBOZXZlclxuICogICBmYXRhbC5cbiAqIEByZXR1cm5zIFJlc3VsdCB3aXRoIGRldGFpbHMgb2Ygd2hhdCB3YXMgY29tbWl0dGVkIGFuZCBwdXNoZWRcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvbW1pdEFuZFB1c2hQZW5kaW5nKFxuICBicmFuY2hOYW1lOiBzdHJpbmcsXG4gIGNvbW1pdE1lc3NhZ2U6IHN0cmluZyxcbiAgb3B0aW9uczogUHVzaExpbmVhZ2VPcHRpb25zID0ge30sXG4gIGFsbG93RGVmYXVsdEJyYW5jaCA9IGZhbHNlLFxuICBwcmVGbGlnaHQ/OiBQcmVGbGlnaHRHYXRlU3BlYyxcbiAgcnVuSWQ/OiBzdHJpbmcsXG4gIGZvcm1hdEJlZm9yZUdhdGU/OiAoKSA9PiBQcm9taXNlPHZvaWQ+LFxuICBiZWZvcmVQdXNoPzogKCkgPT4gUHJvbWlzZTxSZXN1bHQ8dm9pZD4+LFxuKTogUHJvbWlzZTxSZXN1bHQ8Q29tbWl0QW5kUHVzaFBlbmRpbmdSZXN1bHQ+PiB7XG4gIC8vIFJlYWQtb25seSBkZWZhdWx0LWJyYW5jaCBndWFyZCAoSXNzdWUgIzI1ODQpIOKAlCByZWZ1c2UgdXAgZnJvbnQsIGJlZm9yZVxuICAvLyBzdGFnaW5nIG9yIGNvbW1pdHRpbmcgYW55dGhpbmcsIHdoZW4gdGhlIHRhcmdldCBpcyB0aGUgZGVmYXVsdCBicmFuY2guXG4gIGNvbnN0IGd1YXJkID0gYXdhaXQgYXNzZXJ0UHVzaFRhcmdldEFsbG93ZWQoXG4gICAgYnJhbmNoTmFtZSxcbiAgICBvcHRpb25zLFxuICAgIGFsbG93RGVmYXVsdEJyYW5jaCxcbiAgKTtcbiAgaWYgKCFndWFyZC5vaykge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGd1YXJkLmVycm9yIH07XG4gIH1cblxuICAvLyBJc3N1ZSAjNDE2NTogcmVmdXNlIGJlZm9yZSBzdGFnaW5nIG9yIGNvbW1pdHRpbmcgd2hlbiB0aGUgY2hlY2tvdXQgaXNcbiAgLy8gbm90IHRoZSBwYXNzJ3Mgb3duIGhpc3RvcnkuIENvbW1pdHRpbmcgb250byBpdCB3b3VsZCBvbmx5IGFkZCB0byB0aGVcbiAgLy8gaGlzdG9yeSB0aGUgcHVzaCBiZWxvdyBpcyBhYm91dCB0byByZWZ1c2UuXG4gIGNvbnN0IGxpbmVhZ2UgPSBhd2FpdCByZWZ1c2VVbmxlc3NIZWFkRXh0ZW5kcyhvcHRpb25zKTtcbiAgaWYgKCFsaW5lYWdlLm9rKSByZXR1cm4gbGluZWFnZTtcblxuICAvLyBTdGVwIDEg4oCUIGRldGVjdCB1bmNvbW1pdHRlZCBjaGFuZ2VzLlxuICBjb25zdCBzdGF0dXNSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFtcInN0YXR1c1wiLCBcIi0tcG9yY2VsYWluXCJdLCBvcHRpb25zKTtcbiAgaWYgKCFzdGF0dXNSZXN1bHQub2spIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBzdGF0dXNSZXN1bHQuZXJyb3IgfTtcbiAgfVxuICBpZiAoc3RhdHVzUmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYGdpdCBzdGF0dXMgZmFpbGVkOiAke3N0YXR1c1Jlc3VsdC52YWx1ZS5zdGRlcnIudHJpbSgpfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICBsZXQgY29tbWl0dGVkTmV3Q2hhbmdlcyA9IGZhbHNlO1xuICBpZiAoc3RhdHVzUmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKCkubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGFkZFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoW1wiYWRkXCIsIFwiLUFcIl0sIG9wdGlvbnMpO1xuICAgIGlmICghYWRkUmVzdWx0Lm9rKSB7XG4gICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBhZGRSZXN1bHQuZXJyb3IgfTtcbiAgICB9XG4gICAgaWYgKGFkZFJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgRXJyb3IoYGdpdCBhZGQgZmFpbGVkOiAke2FkZFJlc3VsdC52YWx1ZS5zdGRlcnIudHJpbSgpfWApLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBTdGFnZSB3aXRoIGludGVudCAoSXNzdWVzICMxNjYxLCAjMTcxMSkg4oCUIHJlbW92ZSB0aGUgd29ya2VyJ3Mgb3duXG4gICAgLy8gc3RhdGUgZmlsZXMgZnJvbSB0aGUgaW5kZXggYmVmb3JlIHRoZSBzYWZldHkgZ2F0ZSBzZWVzIHRoZW0sIHNvIGFcbiAgICAvLyBzdHJheSBgLmhlYXJ0YmVhdF8qYCwgYC52aWJlX2RlZmF1bHRfYnJhbmNoYCBvciB0aGUgYWdlbnQnc1xuICAgIC8vIGAucHJfcmVzcG9uc2VfbWVzc2FnZWAgaW4gdGhlIGNsb25lIGNhbiBubyBsb25nZXIgY29zdCB0aGUgd2hvbGVcbiAgICAvLyBjb21taXQuXG4gICAgY29uc3QgdW5zdGFnZVJlc3VsdCA9IGF3YWl0IHVuc3RhZ2VXb3JrZXJTdGF0ZUZpbGVzKG9wdGlvbnMpO1xuICAgIGlmICghdW5zdGFnZVJlc3VsdC5vaykge1xuICAgICAgYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJyZXNldFwiLCBcIi0tXCJdLCBvcHRpb25zKTtcbiAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IHVuc3RhZ2VSZXN1bHQuZXJyb3IgfTtcbiAgICB9XG5cbiAgICAvLyBDb21taXQgb25seSB3aGVuIHNvbWV0aGluZyByZWFsIHN1cnZpdmVkIHRoZSB1bnN0YWdpbmcuIFdoZW5cbiAgICAvLyBldmVyeXRoaW5nIHBlbmRpbmcgd2FzIHdvcmtlciBzdGF0ZSB0aGUgaW5kZXggaXMgbm93IGVtcHR5LCBzbyB0aGVcbiAgICAvLyBnYXRlcyBhbmQgdGhlIGNvbW1pdCBhcmUgc2tpcHBlZCBhbmQgdGhlIHJlc3VsdCByZXBvcnRzIFwibm90aGluZ1xuICAgIC8vIGNvbW1pdHRlZFwiIGhvbmVzdGx5IOKAlCByYXRoZXIgdGhhbiBpbnZlbnRpbmcgYW4gZW1wdHkgY29tbWl0IG9yIGZhaWxpbmdcbiAgICAvLyBvbiBnaXQncyBcIm5vdGhpbmcgYWRkZWQgdG8gY29tbWl0XCIuXG4gICAgaWYgKHVuc3RhZ2VSZXN1bHQudmFsdWUucmVtYWluaW5nU3RhZ2VkID4gMCkge1xuICAgICAgLy8gUHJlLWNvbW1pdCBzYWZldHkgZ2F0ZSAoSXNzdWUgIzE3NTgpIOKAlCByZWZ1c2UgdG8gY29tbWl0IGFueVxuICAgICAgLy8gaGlkZGVuIG9yIHNlY3JldC1iZWFyaW5nIGZpbGUuIE9uIHZpb2xhdGlvbiwgdW5zdGFnZSBldmVyeXRoaW5nXG4gICAgICAvLyBzbyB0aGUgd29ya2VyIGRvZXMgbm90IHNpbGVudGx5IGNhcnJ5IHNlY3JldHMgaW4gdGhlIGluZGV4LlxuICAgICAgY29uc3Qgc2FmZXR5UmVzdWx0ID0gYXdhaXQgYXNzZXJ0U2FmZVRvQ29tbWl0KG9wdGlvbnMpO1xuICAgICAgaWYgKCFzYWZldHlSZXN1bHQub2spIHtcbiAgICAgICAgYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJyZXNldFwiLCBcIi0tXCJdLCBvcHRpb25zKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogc2FmZXR5UmVzdWx0LmVycm9yIH07XG4gICAgICB9XG5cbiAgICAgIC8vIFByZS1mbGlnaHQgZW5mb3JjZW1lbnQgZ2F0ZSAoSXNzdWUgIzM1NzcpIOKAlCBydW4gdGhlIHJlcG8ncyBjb25maWd1cmVkXG4gICAgICAvLyBtYW5kYXRvcnkgcHJlLWZsaWdodCBjb21tYW5kcyBhdCB0aGlzIHNhbWUgY2hva2Vwb2ludC4gQSBub24temVybyBleGl0LFxuICAgICAgLy8gYSBjb21tYW5kIHRoYXQgY2Fubm90IGJlIHN0YXJ0ZWQsIG9yIGEgdGltZW91dCBpcyBhIGhhcmQgQkxPQ0s6IHJldHVyblxuICAgICAgLy8gYmVmb3JlIHRoZSBjb21taXQgc28gQk9USCB0aGUgY29tbWl0IGFuZCB0aGUgcHVzaCBhcmUgcmVmdXNlZC4gVGhlcmUgaXNcbiAgICAgIC8vIG5vIG92ZXJyaWRlLiBPbiBibG9jaywgdW5zdGFnZSBzbyB0aGUgd29ya2VyIGRvZXMgbm90IHNpbGVudGx5IGNhcnJ5IHRoZVxuICAgICAgLy8gYnJva2VuIGNoYW5nZSBpbiB0aGUgaW5kZXguIFRoZSBjYXB0dXJlZCBjb21tYW5kIG91dHB1dCByaWRlcyBvbiB0aGVcbiAgICAgIC8vIHJldHVybmVkIGVycm9yIHNvIHRoZSBmaXhlciBzZWVzIHRoZSByZWFsIGZhaWx1cmUsIG5vdCBhIGJhcmVcbiAgICAgIC8vIFwicHJlLWZsaWdodCBmYWlsZWRcIi5cbiAgICAgIGlmIChwcmVGbGlnaHQgJiYgcHJlRmxpZ2h0LmNvbW1hbmRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgY29uc3QgZ2F0ZVJlc3VsdCA9IGF3YWl0IHJ1blByZUZsaWdodEdhdGUocHJlRmxpZ2h0LmNvbW1hbmRzLCB7XG4gICAgICAgICAgY3dkOiBvcHRpb25zLmN3ZCxcbiAgICAgICAgICBlbnY6IG9wdGlvbnMuZW52LFxuICAgICAgICAgIHRpbWVvdXRTZWNvbmRzOiBwcmVGbGlnaHQudGltZW91dFNlY29uZHMsXG4gICAgICAgICAgcnVubmVyOiBwcmVGbGlnaHQucnVubmVyLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKCFnYXRlUmVzdWx0Lm9rKSB7XG4gICAgICAgICAgYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJyZXNldFwiLCBcIi0tXCJdLCBvcHRpb25zKTtcbiAgICAgICAgICAvLyBDYXBwZWQgbGlrZSBTdGVwIDFiJ3M6IHRoZSBtZXNzYWdlIHJlYWNoZXMgYSBQUiBjb21tZW50LlxuICAgICAgICAgIGNvbnN0IGNhcHBlZCA9IGNhcEdhdGVUZXh0KGdhdGVSZXN1bHQuZXJyb3IubWVzc2FnZSk7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgIGVycm9yOiBjYXBwZWQgPT09IGdhdGVSZXN1bHQuZXJyb3IubWVzc2FnZVxuICAgICAgICAgICAgICA/IGdhdGVSZXN1bHQuZXJyb3JcbiAgICAgICAgICAgICAgOiBuZXcgRXJyb3IoY2FwcGVkLCB7IGNhdXNlOiBnYXRlUmVzdWx0LmVycm9yIH0pLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gUnVuLWlkIHRyYWNlYWJpbGl0eSAoSXNzdWUgIzIzODEpIOKAlCBzdGFtcCB0aGUgY29tbWl0IHdpdGggdGhlXG4gICAgICAvLyBjYW5vbmljYWwgcnVuIGlkIHNvIHRoZSBwdXNoIGlzIGF0dHJpYnV0YWJsZSB0byBhIHNwZWNpZmljIHdvcmtlclxuICAgICAgLy8gcnVuLiBhc3NlcnRSdW5JZFRyYWlsZXIgaXMgdGhlIHByZS1jb21taXQgZ2F0ZTsgYXBwZW5kUnVuSWRUcmFpbGVyXG4gICAgICAvLyBndWFyYW50ZWVzIGl0IHBhc3NlcyBmb3Igd29ya2VyLWF1dGhvcmVkIGNvbW1pdHMuXG4gICAgICBjb25zdCBmaW5hbE1lc3NhZ2UgPSBhcHBlbmRSdW5JZFRyYWlsZXIoXG4gICAgICAgIGNvbW1pdE1lc3NhZ2UsXG4gICAgICAgIHJ1bklkID8/IGdldFJ1bklkKCksXG4gICAgICApO1xuICAgICAgY29uc3QgdHJhaWxlckdhdGUgPSBhc3NlcnRSdW5JZFRyYWlsZXIoZmluYWxNZXNzYWdlKTtcbiAgICAgIGlmICghdHJhaWxlckdhdGUub2spIHtcbiAgICAgICAgYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJyZXNldFwiLCBcIi0tXCJdLCBvcHRpb25zKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogdHJhaWxlckdhdGUuZXJyb3IgfTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgY29tbWl0UmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICAgICAgW1wiY29tbWl0XCIsIFwiLW1cIiwgZmluYWxNZXNzYWdlXSxcbiAgICAgICAgb3B0aW9ucyxcbiAgICAgICk7XG4gICAgICBpZiAoIWNvbW1pdFJlc3VsdC5vaykge1xuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBjb21taXRSZXN1bHQuZXJyb3IgfTtcbiAgICAgIH1cbiAgICAgIC8vIGBnaXQgY29tbWl0YCBleGl0cyBub24temVybyB3aGVuIHRoZXJlIGlzIG5vdGhpbmcgdG8gY29tbWl0LiBUaGVcbiAgICAgIC8vIHN0YXR1cyBjaGVjayBhYm92ZSBtZWFucyB0aGlzIHNob3VsZCBub3QgaGFwcGVuLCBidXQgYmUgZGVmZW5zaXZlLlxuICAgICAgaWYgKGNvbW1pdFJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgICAgIGNvbnN0IGNvbWJpbmVkID1cbiAgICAgICAgICBgJHtjb21taXRSZXN1bHQudmFsdWUuc3Rkb3V0fVxcbiR7Y29tbWl0UmVzdWx0LnZhbHVlLnN0ZGVycn1gLnRyaW0oKTtcbiAgICAgICAgLy8gVG9sZXJhdGUgXCJub3RoaW5nIHRvIGNvbW1pdFwiIOKAlCB0cmVhdCBhcyBubyBuZXcgY29tbWl0LlxuICAgICAgICBpZiAoIS9ub3RoaW5nIHRvIGNvbW1pdC9pLnRlc3QoY29tYmluZWQpKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgIGVycm9yOiBuZXcgRXJyb3IoYGdpdCBjb21taXQgZmFpbGVkOiAke2NvbWJpbmVkfWApLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbW1pdHRlZE5ld0NoYW5nZXMgPSB0cnVlO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIFN0ZXAgMWEg4oCUIHRoZSByZXBvc2l0b3J5J3MgZm9ybWF0dGVycyBvdmVyIHRoZSB1bnB1c2hlZCBjb21taXRzLCBub3dcbiAgLy8gaW5jbHVkaW5nIFN0ZXAgMSdzIChmb2xsb3ctdXAgdG8gIzM4MDYpLiBBIGZvcm1hdHRpbmctb25seSBtaXNzIGlzIGZpeGVkXG4gIC8vIGFuZCBjb21taXR0ZWQgaGVyZSByYXRoZXIgdGhhbiBmYWlsaW5nIFN0ZXAgMWIsIG9yIOKAlCB3aXRoIG5vIHByZS1mbGlnaHRcbiAgLy8gY29uZmlndXJlZCDigJQgcmVhY2hpbmcgQ0kuIE5ldmVyIGZhdGFsOiBhIGhvb2sgdGhhdCB0aHJvd3MgaXMgbG9nZ2VkIGFuZFxuICAvLyBTdGVwIDFiIHN0aWxsIGNoZWNrcyBldmVyeXRoaW5nLlxuICBpZiAoZm9ybWF0QmVmb3JlR2F0ZSkge1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBmb3JtYXRCZWZvcmVHYXRlKCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgYHJlcG8gZm9ybWF0dGVyczogc2tpcHBlZCBiZWZvcmUgdGhlIHB1c2ggZ2F0ZTogJHtcbiAgICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgICAgfWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIC8vIFN0ZXAgMWIg4oCUIGdhdGUgY29tbWl0cyB0aGUgYWdlbnQgbWFkZSBidXQgbmV2ZXIgcHVzaGVkIGl0c2VsZiAoSXNzdWVcbiAgLy8gIzM2ODkpLiBUaGUgYWdlbnQncyBwZXItcnVuIHByZS1wdXNoIGhvb2sgb25seSBjb3ZlcnMgdGhlIGFnZW50J3Mgb3duXG4gIC8vIGBnaXQgcHVzaGA7IHRoZXNlIGNvbW1pdHMgd291bGQgb3RoZXJ3aXNlIGxlYXZlIHVuZ2F0ZWQgYnkgdGhlXG4gIC8vIGNoYW5nZWQtZmlsZSBjaGVja3MuIEZpbmFsLW1pbGUgY2FsbGVycyAodGhvc2UgcGFzc2luZyBgcHJlRmxpZ2h0YCkgb25seS5cbiAgaWYgKHByZUZsaWdodCkge1xuICAgIGNvbnN0IGdhdGUgPSBhd2FpdCBnYXRlVW5wdXNoZWRDb21taXRzKFxuICAgICAgYnJhbmNoTmFtZSxcbiAgICAgIG9wdGlvbnMsXG4gICAgICBwcmVGbGlnaHQsXG4gICAgICBjb21taXR0ZWROZXdDaGFuZ2VzLFxuICAgICk7XG4gICAgaWYgKCFnYXRlLm9rKSB7XG4gICAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBnYXRlLmVycm9yIH07XG4gICAgfVxuICB9XG5cbiAgLy8gSXNzdWUgIzM3ODQ6IGluc3BlY3QgdGhlIGNvbW1pdHRlZCwgZm9ybWF0dGVkIGhlYWQgYmVmb3JlIGl0IGxlYXZlcyB0aGUgaG9zdC5cbiAgLy8gVW5saWtlIGZvcm1hdHRpbmcsIHRoaXMgY2FsbGJhY2sgaXMgYSBnYXRlOiBhbiBlcnJvciBwcmV2ZW50cyB0aGUgcHVzaC5cbiAgaWYgKGJlZm9yZVB1c2gpIHtcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IGJlZm9yZVB1c2goKTtcbiAgICBpZiAoIXZlcmlmaWVkLm9rKSByZXR1cm4gdmVyaWZpZWQ7XG4gIH1cblxuICAvLyBTdGVwIDFjIOKAlCBicmluZyBhbiBvcGVuIFBSJ3MgYnJhbmNoIHVwIHRvIGRhdGUgd2l0aCBpdHMgYmFzZSBpbiB0aGlzXG4gIC8vIHNhbWUgcHVzaCAob3duZXIgcnVsZSAyMDI2LTExLTAzKS4gRXZlcnkgcHVzaCB0byBhbiBvcGVuIFBSIHJ1bnMgdGhlIGZ1bGxcbiAgLy8gQ0k7IGEgZml4IHB1c2hlZCBvbnRvIGEgYnJhbmNoIHRoYXQgaXMgYmVoaW5kIGxlYXZlcyB0aGUgUFIgQkVISU5ELCBhbmRcbiAgLy8gdGhlIGxhdGVyIGJyYW5jaCB1cGRhdGUgcnVucyBDSSBhIHNlY29uZCB0aW1lIGZvciB0aGUgc2FtZSBmaXguIFBsYWNlZFxuICAvLyBhZnRlciB0aGUgZ2F0ZXMsIHNvIHRoZXkganVkZ2Ugb25seSB0aGlzIHBhc3MncyBvd24gY29tbWl0cy5cbiAgaWYgKG9wdGlvbnMuc3luY0Jhc2VCcmFuY2gpIHtcbiAgICBhd2FpdCBtZXJnZUJhc2VCZWZvcmVQdXNoKGJyYW5jaE5hbWUsIG9wdGlvbnMuc3luY0Jhc2VCcmFuY2gsIG9wdGlvbnMpO1xuICB9XG5cbiAgLy8gU3RlcCAyIOKAlCBwdXNoIGFueSB1bnB1c2hlZCBjb21taXRzLiBwdXNoVW5wdXNoZWRDb21taXRzIGhhbmRsZXNcbiAgLy8gZmlyc3QtdGltZSBwdXNoIGFuZCBub24tZmFzdC1mb3J3YXJkIHJlY292ZXJ5IGludGVybmFsbHkuIFRoZVxuICAvLyBkZWZhdWx0LWJyYW5jaCBndWFyZCBhbHJlYWR5IHJhbiBhYm92ZSwgc28gc2tpcCB0aGUgcmVkdW5kYW50IHJlLWNoZWNrXG4gIC8vIChJc3N1ZSAjMjU4NCkuXG4gIGNvbnN0IHB1c2hSZXN1bHQgPSBhd2FpdCBwdXNoVW5wdXNoZWRDb21taXRzKFxuICAgIGJyYW5jaE5hbWUsXG4gICAgb3B0aW9ucyxcbiAgICB0cnVlLFxuICAgIGJlZm9yZVB1c2gsXG4gICk7XG4gIGlmICghcHVzaFJlc3VsdC5vaykge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IHB1c2hSZXN1bHQuZXJyb3IgfTtcbiAgfVxuXG4gIC8vIFN0ZXAgMyDigJQgdmVyaWZ5IHRoZSBicmFuY2ggaXMgaW4gc3luYyB3aXRoIG9yaWdpbi4gVGhpcyBpcyB0aGUgaG9uZXN0XG4gIC8vIHBvc3QtY29uZGl0aW9uIHRoZSBjYWxsZXIgbmVlZHM6IDAgbWVhbnMgd2UgZGlkIG91ciBqb2I7ID4wIG1lYW5zIHdlXG4gIC8vIHN0aWxsIGhhdmUgbG9jYWwgd29yayB0aGF0IHRoZSB1c2VyIGlzIGJlaW5nIGxpZWQgdG8gYWJvdXQuXG4gIC8vXG4gIC8vIElzc3VlICMyMTE6IGNvdW50ZWQgYWdhaW5zdCB0aGlzIGJyYW5jaCdzIG93biByZW1vdGUgaGVhZC4gVGhlIHByZXZpb3VzXG4gIC8vIGBIRUFEIC0tbm90IC0tcmVtb3Rlcz1vcmlnaW5gIGNvdW50ZWQgY29tbWl0cyBhaGVhZCBvZiB0aGUgZGVmYXVsdCBicmFuY2hcbiAgLy8gd2hlbmV2ZXIgbm8gcmVtb3RlLXRyYWNraW5nIHJlZiBleGlzdGVkIGZvciB0aGUgYnJhbmNoLCBzbyBhIHN1Y2Nlc3NmdWxcbiAgLy8gcHVzaCByZXBvcnRlZCBgY29tbWl0c1B1c2hlZD00IGZpbmFsVW5wdXNoZWRDb3VudD00YCDigJQgc2VsZi1jb250cmFkaWN0b3J5LFxuICAvLyBhbmQgZW5vdWdoIHRvIHRyaWdnZXIgYSBib2d1cyByZWNvdmVyeSBhbmQgYSBcInBsZWFzZSBjaGVjayB0aGUgYnJhbmNoXG4gIC8vIHN0YXR1c1wiIGNvbW1lbnQgdG8gYSBodW1hbi4gQSBjb3VudCB0aGF0IGNhbm5vdCBiZSBkZXRlcm1pbmVkIGlzIGFuIGVycm9yLFxuICAvLyBuZXZlciBhIHNpbGVudCAwLlxuICBjb25zdCByZW1haW5pbmdSZXN1bHQgPSBhd2FpdCBkZXNjcmliZVVucHVzaGVkQ29tbWl0cyhicmFuY2hOYW1lLCBvcHRpb25zKTtcbiAgaWYgKCFyZW1haW5pbmdSZXN1bHQub2spIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiByZW1haW5pbmdSZXN1bHQuZXJyb3IgfTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgdmFsdWU6IHtcbiAgICAgIGNvbW1pdHRlZE5ld0NoYW5nZXMsXG4gICAgICBjb21taXRzUHVzaGVkOiBwdXNoUmVzdWx0LnZhbHVlLFxuICAgICAgZmluYWxVbnB1c2hlZENvdW50OiByZW1haW5pbmdSZXN1bHQudmFsdWUuY291bnQsXG4gICAgICBmaW5hbFVucHVzaGVkU291cmNlOiByZW1haW5pbmdSZXN1bHQudmFsdWUuc2hhID09PSBudWxsXG4gICAgICAgID8gXCJyZW1vdGUtYWJzZW50XCJcbiAgICAgICAgOiBcInJlbW90ZS1oZWFkXCIsXG4gICAgfSxcbiAgfTtcbn1cblxuLyoqIERlZmF1bHQgZ2ggY29tbWFuZCBydW5uZXIg4oCUIHJvdXRlZCB0aHJvdWdoIHRoZSBzaGFyZWQgY2hva2Vwb2ludC4gKi9cbmFzeW5jIGZ1bmN0aW9uIGRlZmF1bHRHaENvbW1hbmQoYXJnczogc3RyaW5nW10pOiBQcm9taXNlPHN0cmluZz4ge1xuICByZXR1cm4gYXdhaXQgcnVuR2hPclRocm93KGFyZ3MpO1xufVxuXG4vKipcbiAqIEVuc3VyZSB0aGUgbG9jYWwgZGVmYXVsdCBicmFuY2ggaXMgY3VycmVudCB3aXRoIHRoZSByZW1vdGUgKElzc3VlICMyMzApLlxuICpcbiAqIEBwYXJhbSBkZWZhdWx0QnJhbmNoIC0gVGhlIG5hbWUgb2YgdGhlIGRlZmF1bHQgYnJhbmNoXG4gKiBAcGFyYW0gb3B0aW9ucyAtIEdpdCBjb21tYW5kIG9wdGlvbnNcbiAqIEByZXR1cm5zIFJlc3VsdCBpbmRpY2F0aW5nIHN1Y2Nlc3NcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGVuc3VyZURlZmF1bHRCcmFuY2hDdXJyZW50KFxuICBkZWZhdWx0QnJhbmNoOiBzdHJpbmcsXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPFJlc3VsdDxzdHJpbmc+PiB7XG4gIC8vIFRoZSBkZWZhdWx0IGJyYW5jaCAob25jZSByZWFkIGZyb20gYC52aWJlX2RlZmF1bHRfYnJhbmNoYCBpbnNpZGUgdGhlXG4gIC8vIGNsb25lLCBJc3N1ZSAjMTI2OTsgbm93IGZyb20gYC5naXQvdmliZS9kZWZhdWx0X2JyYW5jaGAsIElzc3VlICMxNjUyKVxuICAvLyByZWFjaGVzIGdpdCBhcyBhIHBvc2l0aW9uYWwgaGVyZSBhbmQgaW4gdGhlIGBnaXQgYnJhbmNoIC1mYCBiZWxvdywgYW5kIGlzXG4gIC8vIGludGVycG9sYXRlZFxuICAvLyBpbnRvIGBvcmlnaW4vPGJyYW5jaD5gIOKAlCBzbyBpdCBpcyB2YWxpZGF0ZWQgYXMgYSByZWYgKmNvbXBvbmVudCosIG5vdFxuICAvLyBtZXJlbHkgY2hlY2tlZCBmb3IgYSBsZWFkaW5nIGRhc2guXG4gIHRyeSB7XG4gICAgYXNzZXJ0U2FmZVJlZkNvbXBvbmVudChkZWZhdWx0QnJhbmNoLCBcImRlZmF1bHQgYnJhbmNoIG5hbWVcIik7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoU3RyaW5nKGVycm9yKSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIEZldGNoIHRoZSBsYXRlc3QgY2hhbmdlc1xuICBjb25zdCBmZXRjaFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmRDaGVja2VkKFxuICAgIGJ1aWxkRmV0Y2hBcmdzKFwib3JpZ2luXCIsIGRlZmF1bHRCcmFuY2gpLFxuICAgIG9wdGlvbnMsXG4gICk7XG5cbiAgLy8gSXNzdWUgIzQzNTg6IGdpdCdzIHN0ZGVyciwgYSB0aW1lb3V0LCBvciBhIHNwYXduIGVycm9yLiBTYW1lIHdvcmRpbmcgYXNcbiAgLy8gdGhlIGZldGNoIGZhaWx1cmUgaW4gZ2l0X2JyYW5jaF9zeW5jLnRzIOKAlCBkcm9wcGluZyB0aGUgZGV0YWlsIGxlZnQgdGhlXG4gIC8vIG1pbGVzdG9uZSB0aXAgbG9nIHdpdGggbm8gcmVhc29uLlxuICBpZiAoIWZldGNoUmVzdWx0Lm9rKSB7XG4gICAgY29uc3QgZGV0YWlsID0gZmV0Y2hSZXN1bHQuZXJyb3IubWVzc2FnZS50cmltKCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBGYWlsZWQgdG8gZmV0Y2ggb3JpZ2luLyR7ZGVmYXVsdEJyYW5jaH06ICR7XG4gICAgICAgICAgZGV0YWlsIHx8IFwiZ2l0IHJlcG9ydGVkIG5vIG91dHB1dFwiXG4gICAgICAgIH1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgLy8gQ2hlY2sgY3VycmVudCBicmFuY2hcbiAgY29uc3QgY3VycmVudEJyYW5jaFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wicmV2LXBhcnNlXCIsIFwiLS1hYmJyZXYtcmVmXCIsIFwiSEVBRFwiXSxcbiAgICBvcHRpb25zLFxuICApO1xuXG4gIGNvbnN0IGN1cnJlbnRCcmFuY2ggPSBjdXJyZW50QnJhbmNoUmVzdWx0Lm9rXG4gICAgPyBjdXJyZW50QnJhbmNoUmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKClcbiAgICA6IFwiXCI7XG5cbiAgaWYgKGN1cnJlbnRCcmFuY2ggPT09IGRlZmF1bHRCcmFuY2gpIHtcbiAgICAvLyBJZiBvbiB0aGUgZGVmYXVsdCBicmFuY2gsIHJlc2V0IHRvIHJlbW90ZVxuICAgIGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgICBbXCJyZXNldFwiLCBcIi0taGFyZFwiLCBgb3JpZ2luLyR7ZGVmYXVsdEJyYW5jaH1gXSxcbiAgICAgIG9wdGlvbnMsXG4gICAgKTtcbiAgfSBlbHNlIHtcbiAgICAvLyBVcGRhdGUgdGhlIGxvY2FsIHJlZiB3aXRob3V0IGNoZWNraW5nIG91dFxuICAgIGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgICBbXCJicmFuY2hcIiwgXCItZlwiLCBkZWZhdWx0QnJhbmNoLCBgb3JpZ2luLyR7ZGVmYXVsdEJyYW5jaH1gXSxcbiAgICAgIG9wdGlvbnMsXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgdmFsdWU6IGBMb2NhbCAke2RlZmF1bHRCcmFuY2h9IGlzIG5vdyBjdXJyZW50IHdpdGggb3JpZ2luYCxcbiAgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7O0NBU0MsR0FHRCxTQUFTLGFBQWEsRUFBRSxvQkFBb0IsUUFBUSxtQkFBbUI7QUFFdkUsU0FDRSx3QkFBd0IsRUFDeEIsdUJBQXVCLFFBQ2xCLHlCQUF5QjtBQUVoQyxTQUFTLHVCQUF1QixRQUFRLHVCQUF1QjtBQUMvRCxTQUVFLG1CQUFtQixRQUNkLHVCQUF1QjtBQUM5QixTQUFTLGFBQWEsUUFBUSxxQkFBcUI7QUFDbkQsU0FDRSxnQkFBZ0IsRUFDaEIsc0JBQXNCLEVBQ3RCLGNBQWMsRUFDZCxhQUFhLFFBQ1Isb0JBQW9CO0FBQzNCLFNBQVMsa0JBQWtCLEVBQUUsa0JBQWtCLFFBQVEseUJBQXlCO0FBQ2hGLFNBQVMsaUJBQWlCLFFBQVEsMEJBQTBCO0FBQzVELFNBQVMsZ0JBQWdCLFFBQVEsdUJBQXVCO0FB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
// denoCacheMetadata=3051121763122878392,9143501192278679778