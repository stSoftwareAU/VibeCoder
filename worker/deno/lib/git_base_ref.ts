/**
 * Resolve a base branch to a ref this clone can actually compare against
 * (Issue #106).
 *
 * A worker clone is made for the issue's own branch. When the base is a
 * milestone branch, the clone frequently holds it only as the remote-tracking
 * ref `origin/<base>`, never as a local branch. A bare `git log <base>..HEAD`
 * then fails with "unknown revision" (exit 128) — and because the change
 * detector only inspected whether the command *ran*, not its exit code, the
 * failure was silently read as "no commits". A run that had in fact produced a
 * merged PR was then misclassified as analysis-only and escalated to a human.
 *
 * This resolves the base the safe way: prefer the remote-tracking ref
 * `origin/<base>` when it exists, fall back to the local branch, then to a
 * fetch of the base, and surface an error when none can be produced — never a
 * silent empty result that reads as "no changes".
 *
 * Issue #2147: the remote-tracking ref comes first because a run never
 * updates the clone's *local* base — the bring-forward fetches and merges
 * `origin/<base>`, and every `git fetch` refreshes it — so the local branch
 * can lag origin by weeks. Diffing against that stale ref made a 12-file Rust
 * change read as 62 files including `web/*.tsx` (GRQ-AutoTrader#463), and the
 * screenshot gate failed the run.
 *
 * Factored out of `execute_phase.ts` so the completion phase's ahead-of-base
 * guard (#68) can reuse the same resolution.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { assertSafeGitRef } from "./git_ref_args.ts";

/** Output shape of a git command run (matches `runGitCommand`). */
interface GitRunOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** A git runner matching `deps.git.runGitCommand`. */
export type GitRunner = (
  args: string[],
  options?: { cwd?: string },
) => Promise<Result<GitRunOutput>>;

/** Options for {@link resolveComparableBaseRef}. */
export interface ResolveBaseRefOptions {
  /** Working directory of the clone. */
  cwd?: string;
  /** Remote name (default `origin`). */
  remote?: string;
}

/**
 * Resolve `baseBranch` to a ref usable in `git log <ref>..HEAD` on this clone.
 *
 * @returns `origin/<base>` when the remote-tracking ref resolves; otherwise
 *   the local branch; otherwise `origin/<base>` after a fetch. `ok: false`
 *   when the base cannot be produced at all — the caller must surface that,
 *   not treat it as "no changes".
 */
export async function resolveComparableBaseRef(
  runGit: GitRunner,
  baseBranch: string,
  options: ResolveBaseRefOptions = {},
): Promise<Result<string, Error>> {
  // baseBranch is an internal, trusted ref, but keep the guard so a malformed
  // value can never be parsed by git as an option (mirrors git_ref_args.ts).
  assertSafeGitRef(baseBranch, "resolveComparableBaseRef base branch");

  const cwd = options.cwd;
  const remote = options.remote ?? "origin";

  const resolves = async (ref: string): Promise<boolean> => {
    // `git rev-parse --verify --quiet <ref>^{commit}` exits 0 iff the ref
    // resolves to a commit and non-zero (printing nothing) when it does not,
    // so the exit code alone is the signal — never the presence of stdout.
    const r = await runGit(
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      { cwd },
    );
    return r.ok && r.value.code === 0;
  };

  // 1. Remote-tracking ref present — the base as the repository has it
  //    (Issue #2147); the local branch is what the clone was made with and
  //    nothing in a run moves it.
  const remoteRef = `${remote}/${baseBranch}`;
  if (await resolves(remoteRef)) return { ok: true, value: remoteRef };

  // 2. Local branch present — a base the remote does not carry (a local-only
  //    clone, or an offline run).
  if (await resolves(baseBranch)) return { ok: true, value: baseBranch };

  // 3. Fetch the base from the remote, then retry the remote-tracking ref.
  const fetched = await runGit(["fetch", remote, baseBranch], { cwd });
  if (fetched.ok && fetched.value.code === 0 && await resolves(remoteRef)) {
    return { ok: true, value: remoteRef };
  }

  const detail = fetched.ok
    ? `fetch exited ${fetched.value.code}`
    : `fetch failed: ${fetched.error.message}`;
  return {
    ok: false,
    error: new Error(
      `base ref '${baseBranch}' is not resolvable in this clone — tried ` +
        `'${baseBranch}', '${remoteRef}', and a fetch of ${remote} ` +
        `(${detail})`,
    ),
  };
}
