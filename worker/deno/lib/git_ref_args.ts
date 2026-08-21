/**
 * Helpers for building safe ref-taking git argument arrays (Issue #3714).
 *
 * A branch/ref name reaching `git fetch`, `git pull`, `git rebase` or
 * `git checkout` is an untrusted positional: it comes from a PR `headRefName`,
 * the GitHub API, or the raw stdout of another git command. Without an
 * end-of-options marker a ref beginning with `-` is parsed by git as an option
 * rather than a ref — and on a fetch that is remote command execution:
 *
 * ```text
 * $ git fetch origin --upload-pack=echo          # option — runs `echo` remotely
 * $ git fetch origin --end-of-options --upload-pack=echo
 * fatal: couldn't find remote ref --upload-pack=echo   # positional — safe
 * ```
 *
 * This extends the `buildBranchDeleteArgs` (Issue #2798) and conflict-arg
 * (Issue #3294) hardening to the four ref-taking verbs. Those helpers use the
 * `--` separator, which suits pathspecs; `--` is not accepted as an
 * option terminator by these verbs (and `git checkout -- <name>` means
 * "restore this pathspec", not "switch to this branch"), so the
 * `--end-of-options` marker introduced in git 2.24 is used instead.
 *
 * Two layers, because one is not enough:
 *
 * 1. **`--end-of-options` before the first untrusted positional.** Verified to
 *    neutralise dash-leading refs for `fetch`, `rebase` and `checkout`.
 * 2. **A loud reject of any dash-leading or empty ref.** `git pull` parses
 *    `--end-of-options` in its *own* parser and does not forward it to the
 *    `git fetch` it spawns, so the separator alone cannot protect a pull
 *    refspec. Git itself never accepts a ref component beginning with `-`
 *    (`git check-ref-format`), so a dash-leading ref is always either a bug or
 *    an attack — it is thrown at the point of the fault rather than handed to
 *    git.
 */

/**
 * Throw unless `ref` is safe to pass to git as a positional.
 *
 * @param ref - The candidate ref, remote name, or start point.
 * @param context - Short description of the argument slot, used in the error
 *   message (e.g. "fetch ref", "rebase upstream").
 * @throws Error when the ref is empty or begins with `-`.
 */
export function assertSafeGitRef(ref: string, context: string): void {
  if (ref === "") {
    throw new Error(`Refusing to run git: ${context} must not be empty`);
  }
  if (ref.startsWith("-")) {
    throw new Error(
      `Refusing to run git: ${context} must not begin with '-' (got '${ref}') — ` +
        `git would parse it as an option, not a ref`,
    );
  }
}

/**
 * Build the argv for `git fetch <remote> [<ref>]`.
 *
 * @param remote - The remote to fetch from (usually "origin").
 * @param ref - Optional refspec to fetch (untrusted positional).
 * @returns e.g. `["fetch", "--end-of-options", "origin", "feature/x"]`.
 */
export function buildFetchArgs(remote: string, ref?: string): string[] {
  assertSafeGitRef(remote, "fetch remote");
  if (ref === undefined) {
    return ["fetch", "--end-of-options", remote];
  }
  assertSafeGitRef(ref, "fetch ref");
  return ["fetch", "--end-of-options", remote, ref];
}

/**
 * Build the argv for fetching one branch straight into its remote-tracking
 * ref (Issue #211).
 *
 * `git clone --single-branch` (and any clone whose `remote.origin.fetch`
 * refspec is narrowed) never creates `refs/remotes/origin/<feature>`, not even
 * after `git push -u` reports the branch as tracked. An explicit refspec is the
 * one fetch that creates it regardless of the clone's own refspec, so the
 * unpushed count can be measured against the branch's real remote head.
 *
 * The branch name lands inside the refspec, where a `:` would split it into a
 * different source/destination pair — so it is validated as a ref component,
 * not merely checked for a leading dash.
 *
 * @param remote - The remote to fetch from (usually "origin").
 * @param branchName - The branch to fetch (untrusted positional).
 * @returns e.g. `["fetch", "--end-of-options", "origin",
 *   "+refs/heads/x:refs/remotes/origin/x"]`.
 */
export function buildFetchTrackingRefArgs(
  remote: string,
  branchName: string,
): string[] {
  assertSafeGitRef(remote, "fetch remote");
  assertSafeRefComponent(branchName, "fetch branch name");
  return [
    "fetch",
    "--end-of-options",
    remote,
    `+refs/heads/${branchName}:refs/remotes/${remote}/${branchName}`,
  ];
}

/** Characters git itself refuses in a ref component (`git check-ref-format`). */
const UNSAFE_REF_CHARS = /[\s~^:?*[\\]/;

/**
 * Throw unless `ref` is safe to embed *inside* a composed ref or refspec.
 *
 * Stricter than {@link assertSafeGitRef}: a name that is harmless as a bare
 * positional can still break a refspec it is interpolated into (`a:b` becomes
 * a different source/destination pair). Git rejects every character below in a
 * ref component, so a name carrying one is always either a bug or an attack.
 *
 * @param ref - The candidate ref component.
 * @param context - Short description of the argument slot.
 * @throws Error when the component is empty, dash-leading, or malformed.
 */
export function assertSafeRefComponent(ref: string, context: string): void {
  assertSafeGitRef(ref, context);
  if (UNSAFE_REF_CHARS.test(ref) || ref.includes("..")) {
    throw new Error(
      `Refusing to run git: ${context} is not a valid ref component ` +
        `(got '${ref}')`,
    );
  }
}

/** Options for {@link buildPullArgs}. */
export interface PullArgsOptions {
  /** Add `--rebase` (integrate by rebasing rather than merging). */
  rebase?: boolean;
  /** Add `--ff-only` (refuse anything but a fast-forward). */
  ffOnly?: boolean;
}

/**
 * Build the argv for `git pull [<flags>] <remote> <ref>`.
 *
 * @param remote - The remote to pull from (usually "origin").
 * @param ref - The branch to pull (untrusted positional).
 * @param options - Integration flags; see {@link PullArgsOptions}.
 * @returns e.g. `["pull", "--rebase", "--end-of-options", "origin", "x"]`.
 */
export function buildPullArgs(
  remote: string,
  ref: string,
  options: PullArgsOptions = {},
): string[] {
  assertSafeGitRef(remote, "pull remote");
  assertSafeGitRef(ref, "pull ref");
  const flags: string[] = [];
  if (options.rebase) flags.push("--rebase");
  if (options.ffOnly) flags.push("--ff-only");
  return ["pull", ...flags, "--end-of-options", remote, ref];
}

/** Options for {@link buildPushArgs}. */
export interface PushArgsOptions {
  /** Add `-u` so the first push of a branch sets its upstream. */
  setUpstream?: boolean;
}

/**
 * Build the argv for `git push [-u] <remote> <branch>` (Issue #148).
 *
 * The branch here is the worker's issue branch, which every automated
 * commit path — including the WIP preservation a timed-out execute performs
 * — pushes through. It reached git as a bare positional, so a dash-leading
 * name would have been parsed as an option rather than a refspec. `-u` takes
 * no value, so the separator sits directly before the first positional.
 *
 * @param remote - The remote to push to (usually "origin").
 * @param branchName - The branch to push (untrusted positional).
 * @param options - Push flags; see {@link PushArgsOptions}.
 * @returns e.g. `["push", "-u", "--end-of-options", "origin", "issue-1-x"]`.
 */
export function buildPushArgs(
  remote: string,
  branchName: string,
  options: PushArgsOptions = {},
): string[] {
  assertSafeGitRef(remote, "push remote");
  assertSafeGitRef(branchName, "push branch name");
  const flags = options.setUpstream ? ["-u"] : [];
  return ["push", ...flags, "--end-of-options", remote, branchName];
}

/**
 * Build the argv for `git rebase <upstream>`.
 *
 * @param upstream - The branch to rebase onto (untrusted positional).
 * @returns e.g. `["rebase", "--end-of-options", "Develop"]`.
 */
export function buildRebaseArgs(upstream: string): string[] {
  assertSafeGitRef(upstream, "rebase upstream");
  return ["rebase", "--end-of-options", upstream];
}

/**
 * Build the argv for switching to an existing branch/ref.
 *
 * @param ref - The branch or commit to switch to (untrusted positional).
 * @returns e.g. `["checkout", "--end-of-options", "issue-42-fix"]`.
 */
export function buildCheckoutArgs(ref: string): string[] {
  assertSafeGitRef(ref, "checkout ref");
  return ["checkout", "--end-of-options", ref];
}

/**
 * Build the argv for creating and switching to a branch (`git checkout -b`).
 *
 * `-b` consumes the immediately following argv as its value, so the new-branch
 * name is never re-parsed as an option and the separator must sit *after* it —
 * guarding the optional start point, the one remaining bare positional.
 *
 * @param branchName - The branch to create (untrusted positional).
 * @param startPoint - Optional ref to branch from (untrusted positional).
 * @returns e.g. `["checkout", "-b", "feature", "--end-of-options", "main"]`.
 */
export function buildCheckoutNewBranchArgs(
  branchName: string,
  startPoint?: string,
): string[] {
  assertSafeGitRef(branchName, "new branch name");
  if (startPoint === undefined) {
    return ["checkout", "-b", branchName];
  }
  assertSafeGitRef(startPoint, "checkout start point");
  return ["checkout", "-b", branchName, "--end-of-options", startPoint];
}

/**
 * `git checkout -B <branch> [<start-point>]` — create-or-reset a branch,
 * hardened. The branch name is validated (no leading dash), and a start point
 * is separated with `--end-of-options`.
 *
 * @param branchName - Branch to create or reset (attacker-controlled).
 * @param startPoint - Optional start point.
 * @returns The argv, e.g. `["checkout", "-B", "issue-42", "--end-of-options", "main"]`.
 */
export function buildCheckoutResetBranchArgs(
  branchName: string,
  startPoint?: string,
): string[] {
  assertSafeGitRef(branchName, "reset branch name");
  if (startPoint === undefined) {
    return ["checkout", "-B", branchName];
  }
  assertSafeGitRef(startPoint, "checkout start point");
  return ["checkout", "-B", branchName, "--end-of-options", startPoint];
}
