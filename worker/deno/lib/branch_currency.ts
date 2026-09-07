/**
 * Bring a feature branch up to date with its base BEFORE the PR is raised.
 *
 * A branch that is behind its base costs a full CI run twice: once on the
 * stale head, then again after something updates the branch. With the four
 * `validate (tests N/4)` shards required on `milestone/**` as well as on the
 * default branch, that is the most expensive avoidable thing the fleet does —
 * every behind branch doubles its own gate.
 *
 * The waste is silent because both runs pass. Nothing reports "this PR was
 * tested twice"; the cycle simply takes longer, and the second run's result is
 * the only one that ever mattered.
 *
 * This module answers one question — is the branch behind its base, and can it
 * be brought forward safely — and leaves the rebase itself to
 * {@link rebaseOntoBase}, which already refuses on a dirty tree or a genuine
 * content conflict and restores the previous tip before returning.
 *
 * It is deliberately NOT a merge-conflict resolver. A branch whose content has
 * diverged is left exactly as it is, for the conflict ladder to handle: a
 * silent rebase that picks a side is the one outcome worse than an extra CI
 * run.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
// The house git seam, not a second one: `stale_branch_lineage.ts` and the
// rebase this delegates to already speak it, so a caller hands one runner to
// both.
import type { GitRunner } from "./git_base_ref.ts";

export type { GitRunner };

/** How far a branch has drifted from its base. */
export interface BranchDrift {
  /** Commits on the base that the branch does not have. */
  behind: number;
  /** Commits on the branch that the base does not have. */
  ahead: number;
}

/** What {@link ensureBranchCurrent} did, or declined to do. */
export type BranchCurrencyOutcome =
  /** Already current: nothing was run, nothing changed. */
  | { kind: "already-current"; detail: string }
  /** Brought forward onto the base; the caller must push. */
  | { kind: "updated"; detail: string; behind: number }
  /**
   * Behind, but not safely updatable — a dirty tree or a content conflict.
   * The branch is untouched and the PR proceeds as before; the conflict
   * ladder owns it from here.
   */
  | { kind: "declined"; detail: string }
  /** The comparison itself could not be read; the caller proceeds unchanged. */
  | { kind: "unknown"; detail: string };

/**
 * Count how far `branch` is behind and ahead of `baseRef`.
 *
 * `--left-right --count` gives both in one call, so the ordinary
 * already-current case costs a single `rev-list`.
 *
 * @param branch - The feature branch.
 * @param baseRef - The ref it would merge into, remote-qualified.
 * @param runGit - Git runner.
 * @param cwd - Working directory for the git calls.
 * @returns The drift, or an error when the refs cannot be compared.
 */
export async function measureBranchDrift(
  branch: string,
  baseRef: string,
  runGit: GitRunner,
  cwd?: string,
): Promise<Result<BranchDrift>> {
  const counted = await runGit(
    ["rev-list", "--left-right", "--count", `${baseRef}...${branch}`],
    cwd === undefined ? undefined : { cwd },
  );
  if (!counted.ok) return { ok: false, error: counted.error };

  const [left, right] = counted.value.stdout.trim().split(/\s+/);
  const behind = Number(left);
  const ahead = Number(right);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
    return {
      ok: false,
      error: new Error(
        `could not parse rev-list output: ${
          JSON.stringify(counted.value.stdout)
        }`,
      ),
    };
  }
  return { ok: true, value: { behind, ahead } };
}

/** Injection points for {@link ensureBranchCurrent}. */
export interface EnsureBranchCurrentOptions {
  branch: string;
  /** The base the PR will target, e.g. `main` or `milestone/foo`. */
  baseBranch: string;
  runGit: GitRunner;
  cwd?: string;
  /**
   * Rebase seam — production passes `rebaseOntoBase` from
   * `stale_branch_lineage.ts`, which already refuses safely on a dirty tree
   * or a cherry-pick conflict and restores the branch tip before returning.
   */
  rebase: (
    options: {
      branch: string;
      baseRef: string;
      runGit: GitRunner;
      cwd?: string;
    },
  ) => Promise<Result<unknown>>;
  /** Sink for the one line this emits when it acts. */
  log?: (message: string) => void;
}

/**
 * Bring `branch` up to date with `baseBranch` when it is behind, so the PR's
 * first CI run is also its last.
 *
 * Fetches the base first: a stale remote-tracking ref would report the branch
 * as current and defeat the whole point.
 *
 * Never fails the caller. Every unhappy path — an unreadable comparison, a
 * dirty tree, a real content conflict — returns a verdict the caller proceeds
 * past, because an extra CI run is a cost and a wrongly-rebased branch is a
 * defect.
 *
 * @param options - Branch, base, git runner and the rebase seam.
 * @returns What happened; `updated` means the caller must push before opening
 *   the PR.
 */
export async function ensureBranchCurrent(
  options: EnsureBranchCurrentOptions,
): Promise<BranchCurrencyOutcome> {
  const { branch, baseBranch, runGit, cwd } = options;
  const log = options.log ?? (() => {});
  const gitOptions = cwd === undefined ? undefined : { cwd };

  // Without this the comparison is against whatever the last fetch saw, which
  // is exactly the stale answer this exists to avoid.
  const fetched = await runGit(["fetch", "origin", baseBranch], gitOptions);
  if (!fetched.ok) {
    return {
      kind: "unknown",
      detail: `could not fetch '${baseBranch}': ${fetched.error.message}`,
    };
  }

  const baseRef = `origin/${baseBranch}`;
  const drift = await measureBranchDrift(branch, baseRef, runGit, cwd);
  if (!drift.ok) {
    return {
      kind: "unknown",
      detail: `could not compare '${branch}' with '${baseRef}': ` +
        drift.error.message,
    };
  }

  if (drift.value.behind === 0) {
    return {
      kind: "already-current",
      detail: `'${branch}' is current with '${baseRef}'`,
    };
  }

  const rebased = await options.rebase({
    branch,
    baseRef,
    runGit,
    cwd,
  });
  if (!rebased.ok) {
    // A conflict here is content that genuinely diverged. Picking a side is
    // the conflict ladder's job, under its own rungs and its own audit trail.
    return {
      kind: "declined",
      detail: `'${branch}' is ${drift.value.behind} commit(s) behind ` +
        `'${baseRef}' and could not be brought forward safely: ` +
        rebased.error.message,
    };
  }

  log(
    `'${branch}' was ${drift.value.behind} commit(s) behind '${baseRef}' and ` +
      `has been brought forward before the PR — so its CI runs once, on the ` +
      `state that will merge`,
  );
  return {
    kind: "updated",
    detail: `'${branch}' brought forward onto '${baseRef}'`,
    behind: drift.value.behind,
  };
}
