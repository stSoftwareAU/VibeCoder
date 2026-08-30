/**
 * Rebuilding a branch's history so a range-scoped finding exists in no commit
 * (Issue #630).
 *
 * Secret scanners run with `fetch-depth: 0` and judge every commit in the
 * branch, not the working tree. Correcting the file and committing the
 * correction leaves the original commit — and the secret in its diff —
 * untouched, so the check fails again, identically, naming a commit that has
 * already been superseded:
 *
 *     Finding: 'export AWS_SECRET_ACCESS_KEY="REDACTED"'
 *     Commit:  429b706…        ← already fixed by a later commit, still fails
 *
 * A fix loop that does not know this commits, pushes, re-checks and repeats
 * until the attempt cap, then labels `needs-human` — a wedge that needed a
 * person only because the automation had the wrong model of the check.
 *
 * The correct move is to correct the content AND collapse the branch to a
 * single commit built on the base, so the finding is in no commit's diff.
 * This module does the collapse, behind guards, because rewriting history is
 * safe only on a branch this run owns.
 *
 * Australian English spelling throughout (behaviour, recognise).
 */

import type { Result } from "../types.ts";

/** Git access — injected so the guards can be tested without a repository. */
export interface HistoryRewriteDeps {
  runGitCommand: (
    args: string[],
    options?: { cwd?: string },
  ) => Promise<Result<{ code: number; stdout: string; stderr: string }>>;
  /** Structured log. Never receives the finding's value, only its shape. */
  logger?: {
    info: (message: string, fields?: Record<string, unknown>) => void;
    warn: (message: string, fields?: Record<string, unknown>) => void;
  };
}

/** What a rebuild needs to know. */
export interface HistoryRewriteRequest {
  /** The branch to collapse. Never the default branch — see `assertOwned`. */
  branchName: string;
  /** The branch it was cut from, e.g. "main". */
  baseBranch: string;
  /** Message for the single rebuilt commit. */
  commitMessage: string;
  /** Repository working directory. */
  cwd?: string;
  /**
   * Author emails this run is allowed to rewrite. A branch carrying a commit
   * from anyone else is somebody's work in progress, and collapsing it would
   * destroy authorship that is not ours to touch.
   */
  ownedAuthorEmails?: ReadonlyArray<string>;
}

/** Why a rebuild was refused, or what it did. */
export interface HistoryRewriteOutcome {
  /** Commits collapsed into one. */
  collapsedCommits: number;
  /** The merge base the branch was rebuilt onto. */
  baseSha: string;
}

/**
 * Branch-name prefixes a run creates for itself. A branch outside these is
 * not this automation's to rewrite, whatever else is true of it.
 */
const OWNED_BRANCH_PREFIXES: ReadonlyArray<string> = [
  "fix/",
  "issue/",
  "chore/",
  "milestone/",
];

/**
 * Branch names that must never be rewritten regardless of prefix.
 *
 * `milestone/**` is an owned prefix above — a milestone branch is created and
 * driven by the fleet — but the default branch never is, and neither is
 * anything a ruleset protects. The check below is by name because that is
 * what a run knows locally without a network call.
 */
const NEVER_REWRITE: ReadonlyArray<string> = [
  "main",
  "master",
  "develop",
  "trunk",
];

/**
 * Is this branch one the run may rewrite?
 *
 * Two conditions, both required: a name this automation creates, and not a
 * name that is protected. Deliberately conservative — the cost of refusing a
 * legitimate rewrite is one escalation, and the cost of allowing an
 * illegitimate one is somebody's lost commits.
 */
export function isOwnedBranch(
  branchName: string,
  baseBranch: string,
): boolean {
  if (branchName === baseBranch) return false;
  if (NEVER_REWRITE.includes(branchName)) return false;
  return OWNED_BRANCH_PREFIXES.some((prefix) => branchName.startsWith(prefix));
}

/**
 * Collapse `branchName` to one commit on top of its merge base with
 * `baseBranch`, then force-push it.
 *
 * The working tree is left exactly as it is — the caller has already
 * corrected the content. `git reset --soft` moves the branch pointer and
 * nothing else, so the rebuilt commit carries precisely the tree that was
 * about to be pushed.
 *
 * The push is `--force-with-lease`, never a bare `--force`: if another writer
 * has moved the branch since this run last saw it, the push is refused rather
 * than silently dropping their commit. That failure mode is not theoretical —
 * Issue #534 was a force-push that dropped a commit and wedged a duplicate PR.
 */
export async function rebuildBranchHistory(
  request: HistoryRewriteRequest,
  deps: HistoryRewriteDeps,
): Promise<Result<HistoryRewriteOutcome>> {
  const { branchName, baseBranch, cwd } = request;
  const options = cwd !== undefined ? { cwd } : undefined;

  if (!isOwnedBranch(branchName, baseBranch)) {
    return {
      ok: false,
      error: new Error(
        `refusing to rewrite '${branchName}': not a branch this run owns ` +
          `(base '${baseBranch}')`,
      ),
    };
  }

  // The merge base, not the base branch tip: rebuilding onto a tip that has
  // moved would silently drag in everything merged since the branch was cut,
  // turning a history rewrite into an unreviewed rebase.
  const mergeBase = await deps.runGitCommand(
    ["merge-base", `origin/${baseBranch}`, "HEAD"],
    options,
  );
  if (!mergeBase.ok || mergeBase.value.code !== 0) {
    const detail = mergeBase.ok
      ? mergeBase.value.stderr.trim()
      : mergeBase.error.message;
    return {
      ok: false,
      error: new Error(
        `could not find the merge base of '${branchName}' and ` +
          `'origin/${baseBranch}': ${detail}`,
      ),
    };
  }
  const baseSha = mergeBase.value.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/.test(baseSha)) {
    return {
      ok: false,
      error: new Error(`merge-base returned no usable sha: '${baseSha}'`),
    };
  }

  // Every commit about to be collapsed must be ours. A branch carrying
  // someone else's commit is their work, and squashing it would erase an
  // authorship record we have no standing to touch.
  const owned = request.ownedAuthorEmails ?? [];
  if (owned.length > 0) {
    const authors = await deps.runGitCommand(
      ["log", "--format=%ae", `${baseSha}..HEAD`],
      options,
    );
    if (!authors.ok || authors.value.code !== 0) {
      return {
        ok: false,
        error: new Error(
          `could not read the authors of '${branchName}' before rewriting it`,
        ),
      };
    }
    const foreign = authors.value.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((email) => !owned.includes(email));
    if (foreign.length > 0) {
      return {
        ok: false,
        error: new Error(
          `refusing to rewrite '${branchName}': it carries commits by ` +
            `${[...new Set(foreign)].join(", ")}, which this run did not write`,
        ),
      };
    }
  }

  const countResult = await deps.runGitCommand(
    ["rev-list", "--count", `${baseSha}..HEAD`],
    options,
  );
  const collapsedCommits = countResult.ok && countResult.value.code === 0
    ? Number.parseInt(countResult.value.stdout.trim(), 10) || 0
    : 0;
  if (collapsedCommits === 0) {
    return {
      ok: false,
      error: new Error(
        `'${branchName}' has no commits above its merge base — there is no ` +
          `history to rewrite, so the finding is in '${baseBranch}' itself`,
      ),
    };
  }

  deps.logger?.info("Rebuilding branch history to clear a range-scoped find", {
    branchName,
    baseBranch,
    baseSha,
    collapsedCommits,
  });

  // --soft: move the branch pointer, keep the index and working tree. The
  // corrected content the caller staged becomes the rebuilt commit verbatim.
  const reset = await deps.runGitCommand(
    ["reset", "--soft", baseSha],
    options,
  );
  if (!reset.ok || reset.value.code !== 0) {
    const detail = reset.ok ? reset.value.stderr.trim() : reset.error.message;
    return {
      ok: false,
      error: new Error(
        `could not reset '${branchName}' to ${baseSha}: ${detail}`,
      ),
    };
  }

  const commit = await deps.runGitCommand(
    ["commit", "--no-verify", "-m", request.commitMessage],
    options,
  );
  if (!commit.ok || commit.value.code !== 0) {
    const detail = commit.ok
      ? commit.value.stderr.trim()
      : commit.error.message;
    return {
      ok: false,
      error: new Error(
        `reset '${branchName}' to ${baseSha} but could not commit the ` +
          `rebuilt tree: ${detail}`,
      ),
    };
  }

  const push = await deps.runGitCommand(
    ["push", "--force-with-lease", "origin", branchName],
    options,
  );
  if (!push.ok || push.value.code !== 0) {
    const detail = push.ok ? push.value.stderr.trim() : push.error.message;
    return {
      ok: false,
      error: new Error(
        `rebuilt '${branchName}' locally but the force-with-lease push was ` +
          `refused — another writer has moved the branch: ${detail}`,
      ),
    };
  }

  deps.logger?.info("Branch history rebuilt and force-pushed", {
    branchName,
    baseSha,
    collapsedCommits,
  });

  return { ok: true, value: { collapsedCommits, baseSha } };
}

/**
 * The commit message for a rebuilt branch.
 *
 * It says what happened and why, because a reader finding a squashed branch
 * with no explanation will reasonably assume something went wrong. It names
 * the check, never the finding's value — the whole point is that the value
 * stops existing.
 */
export function buildRewriteCommitMessage(
  checkName: string,
  prNumber: number,
): string {
  return [
    `Fix ${checkName} and rebuild the branch history (Issue #630)`,
    "",
    `The ${checkName} check scans every commit in the branch, not the working`,
    "tree, so correcting the content in a further commit would leave the",
    "finding in the original commit's diff and the check would fail again,",
    "identically. The branch is collapsed to this single commit so the finding",
    "exists in no commit.",
    "",
    `Automated history rebuild for PR #${prNumber}.`,
  ].join("\n");
}
