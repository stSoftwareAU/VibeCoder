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
 */ /**
 * Throw unless `ref` is safe to pass to git as a positional.
 *
 * @param ref - The candidate ref, remote name, or start point.
 * @param context - Short description of the argument slot, used in the error
 *   message (e.g. "fetch ref", "rebase upstream").
 * @throws Error when the ref is empty or begins with `-`.
 */ export function assertSafeGitRef(ref, context) {
  if (ref === "") {
    throw new Error(`Refusing to run git: ${context} must not be empty`);
  }
  if (ref.startsWith("-")) {
    throw new Error(`Refusing to run git: ${context} must not begin with '-' (got '${ref}') — ` + `git would parse it as an option, not a ref`);
  }
}
/**
 * Build the argv for `git fetch <remote> [<ref>]`.
 *
 * @param remote - The remote to fetch from (usually "origin").
 * @param ref - Optional refspec to fetch (untrusted positional).
 * @returns e.g. `["fetch", "--end-of-options", "origin", "feature/x"]`.
 */ export function buildFetchArgs(remote, ref) {
  assertSafeGitRef(remote, "fetch remote");
  if (ref === undefined) {
    return [
      "fetch",
      "--end-of-options",
      remote
    ];
  }
  assertSafeGitRef(ref, "fetch ref");
  return [
    "fetch",
    "--end-of-options",
    remote,
    ref
  ];
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
 */ export function buildFetchTrackingRefArgs(remote, branchName) {
  assertSafeGitRef(remote, "fetch remote");
  assertSafeRefComponent(branchName, "fetch branch name");
  return [
    "fetch",
    "--end-of-options",
    remote,
    `+refs/heads/${branchName}:refs/remotes/${remote}/${branchName}`
  ];
}
/** Characters git itself refuses in a ref component (`git check-ref-format`). */ const UNSAFE_REF_CHARS = /[\s~^:?*[\\]/;
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
 */ export function assertSafeRefComponent(ref, context) {
  assertSafeGitRef(ref, context);
  if (UNSAFE_REF_CHARS.test(ref) || ref.includes("..")) {
    throw new Error(`Refusing to run git: ${context} is not a valid ref component ` + `(got '${ref}')`);
  }
}
/**
 * Build the argv for `git pull [<flags>] <remote> <ref>`.
 *
 * @param remote - The remote to pull from (usually "origin").
 * @param ref - The branch to pull (untrusted positional).
 * @param options - Integration flags; see {@link PullArgsOptions}.
 * @returns e.g. `["pull", "--rebase", "--end-of-options", "origin", "x"]`.
 */ export function buildPullArgs(remote, ref, options = {}) {
  assertSafeGitRef(remote, "pull remote");
  assertSafeGitRef(ref, "pull ref");
  const flags = [];
  if (options.rebase) flags.push("--rebase");
  if (options.ffOnly) flags.push("--ff-only");
  return [
    "pull",
    ...flags,
    "--end-of-options",
    remote,
    ref
  ];
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
 */ export function buildPushArgs(remote, branchName, options = {}) {
  assertSafeGitRef(remote, "push remote");
  assertSafeGitRef(branchName, "push branch name");
  const flags = [];
  if (options.setUpstream) flags.push("-u");
  if (options.forceWithLease !== undefined) {
    flags.push(options.forceWithLease === true ? "--force-with-lease" : options.forceWithLease);
  }
  return [
    "push",
    ...flags,
    "--end-of-options",
    remote,
    branchName
  ];
}
/**
 * Build the argv for creating a remote branch straight from a local commit-ish
 * (Issue #1345).
 *
 * `git push origin main:refs/heads/milestone/x` creates the branch on the
 * remote without checking anything out, so a stale local branch of the same
 * name — including one another worktree holds, which refuses `checkout -B`
 * outright — cannot block the creation.
 *
 * Both halves of the refspec land inside one argument where a `:` would split
 * them into a different source/destination pair, so both are validated as ref
 * components rather than merely checked for a leading dash.
 *
 * @param remote - The remote to push to (usually "origin").
 * @param sourceRef - The commit-ish to publish (e.g. "main", "origin/main").
 * @param targetBranch - The branch name to create on the remote.
 * @returns e.g. `["push", "--end-of-options", "origin",
 *   "main:refs/heads/milestone/x"]`.
 */ export function buildPushCreateBranchArgs(remote, sourceRef, targetBranch) {
  assertSafeGitRef(remote, "push remote");
  assertSafeRefComponent(sourceRef, "push source ref");
  assertSafeRefComponent(targetBranch, "push target branch");
  return [
    "push",
    "--end-of-options",
    remote,
    `${sourceRef}:refs/heads/${targetBranch}`
  ];
}
/**
 * Build the argv for `git rebase [--no-rebase-merges] <upstream>`.
 *
 * @param upstream - The branch to rebase onto (untrusted positional).
 * @param options - Rebase flags; see {@link RebaseArgsOptions}.
 * @returns e.g. `["rebase", "--end-of-options", "Develop"]`.
 */ export function buildRebaseArgs(upstream, options = {}) {
  assertSafeGitRef(upstream, "rebase upstream");
  const flags = [];
  if (options.noRebaseMerges) flags.push("--no-rebase-merges");
  return [
    "rebase",
    ...flags,
    "--end-of-options",
    upstream
  ];
}
/**
 * Build the argv for switching to an existing branch/ref.
 *
 * @param ref - The branch or commit to switch to (untrusted positional).
 * @returns e.g. `["checkout", "--end-of-options", "issue-42-fix"]`.
 */ export function buildCheckoutArgs(ref) {
  assertSafeGitRef(ref, "checkout ref");
  return [
    "checkout",
    "--end-of-options",
    ref
  ];
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
 */ export function buildCheckoutNewBranchArgs(branchName, startPoint) {
  assertSafeGitRef(branchName, "new branch name");
  if (startPoint === undefined) {
    return [
      "checkout",
      "-b",
      branchName
    ];
  }
  assertSafeGitRef(startPoint, "checkout start point");
  return [
    "checkout",
    "-b",
    branchName,
    "--end-of-options",
    startPoint
  ];
}
/**
 * `git checkout -B <branch> [<start-point>]` — create-or-reset a branch,
 * hardened. The branch name is validated (no leading dash), and a start point
 * is separated with `--end-of-options`.
 *
 * @param branchName - Branch to create or reset (attacker-controlled).
 * @param startPoint - Optional start point.
 * @returns The argv, e.g. `["checkout", "-B", "issue-42", "--end-of-options", "main"]`.
 */ export function buildCheckoutResetBranchArgs(branchName, startPoint) {
  assertSafeGitRef(branchName, "reset branch name");
  if (startPoint === undefined) {
    return [
      "checkout",
      "-B",
      branchName
    ];
  }
  assertSafeGitRef(startPoint, "checkout start point");
  return [
    "checkout",
    "-B",
    branchName,
    "--end-of-options",
    startPoint
  ];
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfcmVmX2FyZ3MudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBIZWxwZXJzIGZvciBidWlsZGluZyBzYWZlIHJlZi10YWtpbmcgZ2l0IGFyZ3VtZW50IGFycmF5cyAoSXNzdWUgIzM3MTQpLlxuICpcbiAqIEEgYnJhbmNoL3JlZiBuYW1lIHJlYWNoaW5nIGBnaXQgZmV0Y2hgLCBgZ2l0IHB1bGxgLCBgZ2l0IHJlYmFzZWAgb3JcbiAqIGBnaXQgY2hlY2tvdXRgIGlzIGFuIHVudHJ1c3RlZCBwb3NpdGlvbmFsOiBpdCBjb21lcyBmcm9tIGEgUFIgYGhlYWRSZWZOYW1lYCxcbiAqIHRoZSBHaXRIdWIgQVBJLCBvciB0aGUgcmF3IHN0ZG91dCBvZiBhbm90aGVyIGdpdCBjb21tYW5kLiBXaXRob3V0IGFuXG4gKiBlbmQtb2Ytb3B0aW9ucyBtYXJrZXIgYSByZWYgYmVnaW5uaW5nIHdpdGggYC1gIGlzIHBhcnNlZCBieSBnaXQgYXMgYW4gb3B0aW9uXG4gKiByYXRoZXIgdGhhbiBhIHJlZiDigJQgYW5kIG9uIGEgZmV0Y2ggdGhhdCBpcyByZW1vdGUgY29tbWFuZCBleGVjdXRpb246XG4gKlxuICogYGBgdGV4dFxuICogJCBnaXQgZmV0Y2ggb3JpZ2luIC0tdXBsb2FkLXBhY2s9ZWNobyAgICAgICAgICAjIG9wdGlvbiDigJQgcnVucyBgZWNob2AgcmVtb3RlbHlcbiAqICQgZ2l0IGZldGNoIG9yaWdpbiAtLWVuZC1vZi1vcHRpb25zIC0tdXBsb2FkLXBhY2s9ZWNob1xuICogZmF0YWw6IGNvdWxkbid0IGZpbmQgcmVtb3RlIHJlZiAtLXVwbG9hZC1wYWNrPWVjaG8gICAjIHBvc2l0aW9uYWwg4oCUIHNhZmVcbiAqIGBgYFxuICpcbiAqIFRoaXMgZXh0ZW5kcyB0aGUgYGJ1aWxkQnJhbmNoRGVsZXRlQXJnc2AgKElzc3VlICMyNzk4KSBhbmQgY29uZmxpY3QtYXJnXG4gKiAoSXNzdWUgIzMyOTQpIGhhcmRlbmluZyB0byB0aGUgZm91ciByZWYtdGFraW5nIHZlcmJzLiBUaG9zZSBoZWxwZXJzIHVzZSB0aGVcbiAqIGAtLWAgc2VwYXJhdG9yLCB3aGljaCBzdWl0cyBwYXRoc3BlY3M7IGAtLWAgaXMgbm90IGFjY2VwdGVkIGFzIGFuXG4gKiBvcHRpb24gdGVybWluYXRvciBieSB0aGVzZSB2ZXJicyAoYW5kIGBnaXQgY2hlY2tvdXQgLS0gPG5hbWU+YCBtZWFuc1xuICogXCJyZXN0b3JlIHRoaXMgcGF0aHNwZWNcIiwgbm90IFwic3dpdGNoIHRvIHRoaXMgYnJhbmNoXCIpLCBzbyB0aGVcbiAqIGAtLWVuZC1vZi1vcHRpb25zYCBtYXJrZXIgaW50cm9kdWNlZCBpbiBnaXQgMi4yNCBpcyB1c2VkIGluc3RlYWQuXG4gKlxuICogVHdvIGxheWVycywgYmVjYXVzZSBvbmUgaXMgbm90IGVub3VnaDpcbiAqXG4gKiAxLiAqKmAtLWVuZC1vZi1vcHRpb25zYCBiZWZvcmUgdGhlIGZpcnN0IHVudHJ1c3RlZCBwb3NpdGlvbmFsLioqIFZlcmlmaWVkIHRvXG4gKiAgICBuZXV0cmFsaXNlIGRhc2gtbGVhZGluZyByZWZzIGZvciBgZmV0Y2hgLCBgcmViYXNlYCBhbmQgYGNoZWNrb3V0YC5cbiAqIDIuICoqQSBsb3VkIHJlamVjdCBvZiBhbnkgZGFzaC1sZWFkaW5nIG9yIGVtcHR5IHJlZi4qKiBgZ2l0IHB1bGxgIHBhcnNlc1xuICogICAgYC0tZW5kLW9mLW9wdGlvbnNgIGluIGl0cyAqb3duKiBwYXJzZXIgYW5kIGRvZXMgbm90IGZvcndhcmQgaXQgdG8gdGhlXG4gKiAgICBgZ2l0IGZldGNoYCBpdCBzcGF3bnMsIHNvIHRoZSBzZXBhcmF0b3IgYWxvbmUgY2Fubm90IHByb3RlY3QgYSBwdWxsXG4gKiAgICByZWZzcGVjLiBHaXQgaXRzZWxmIG5ldmVyIGFjY2VwdHMgYSByZWYgY29tcG9uZW50IGJlZ2lubmluZyB3aXRoIGAtYFxuICogICAgKGBnaXQgY2hlY2stcmVmLWZvcm1hdGApLCBzbyBhIGRhc2gtbGVhZGluZyByZWYgaXMgYWx3YXlzIGVpdGhlciBhIGJ1ZyBvclxuICogICAgYW4gYXR0YWNrIOKAlCBpdCBpcyB0aHJvd24gYXQgdGhlIHBvaW50IG9mIHRoZSBmYXVsdCByYXRoZXIgdGhhbiBoYW5kZWQgdG9cbiAqICAgIGdpdC5cbiAqL1xuXG4vKipcbiAqIFRocm93IHVubGVzcyBgcmVmYCBpcyBzYWZlIHRvIHBhc3MgdG8gZ2l0IGFzIGEgcG9zaXRpb25hbC5cbiAqXG4gKiBAcGFyYW0gcmVmIC0gVGhlIGNhbmRpZGF0ZSByZWYsIHJlbW90ZSBuYW1lLCBvciBzdGFydCBwb2ludC5cbiAqIEBwYXJhbSBjb250ZXh0IC0gU2hvcnQgZGVzY3JpcHRpb24gb2YgdGhlIGFyZ3VtZW50IHNsb3QsIHVzZWQgaW4gdGhlIGVycm9yXG4gKiAgIG1lc3NhZ2UgKGUuZy4gXCJmZXRjaCByZWZcIiwgXCJyZWJhc2UgdXBzdHJlYW1cIikuXG4gKiBAdGhyb3dzIEVycm9yIHdoZW4gdGhlIHJlZiBpcyBlbXB0eSBvciBiZWdpbnMgd2l0aCBgLWAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhc3NlcnRTYWZlR2l0UmVmKHJlZjogc3RyaW5nLCBjb250ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKHJlZiA9PT0gXCJcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihgUmVmdXNpbmcgdG8gcnVuIGdpdDogJHtjb250ZXh0fSBtdXN0IG5vdCBiZSBlbXB0eWApO1xuICB9XG4gIGlmIChyZWYuc3RhcnRzV2l0aChcIi1cIikpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgUmVmdXNpbmcgdG8gcnVuIGdpdDogJHtjb250ZXh0fSBtdXN0IG5vdCBiZWdpbiB3aXRoICctJyAoZ290ICcke3JlZn0nKSDigJQgYCArXG4gICAgICAgIGBnaXQgd291bGQgcGFyc2UgaXQgYXMgYW4gb3B0aW9uLCBub3QgYSByZWZgLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgYXJndiBmb3IgYGdpdCBmZXRjaCA8cmVtb3RlPiBbPHJlZj5dYC5cbiAqXG4gKiBAcGFyYW0gcmVtb3RlIC0gVGhlIHJlbW90ZSB0byBmZXRjaCBmcm9tICh1c3VhbGx5IFwib3JpZ2luXCIpLlxuICogQHBhcmFtIHJlZiAtIE9wdGlvbmFsIHJlZnNwZWMgdG8gZmV0Y2ggKHVudHJ1c3RlZCBwb3NpdGlvbmFsKS5cbiAqIEByZXR1cm5zIGUuZy4gYFtcImZldGNoXCIsIFwiLS1lbmQtb2Ytb3B0aW9uc1wiLCBcIm9yaWdpblwiLCBcImZlYXR1cmUveFwiXWAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEZldGNoQXJncyhyZW1vdGU6IHN0cmluZywgcmVmPzogc3RyaW5nKTogc3RyaW5nW10ge1xuICBhc3NlcnRTYWZlR2l0UmVmKHJlbW90ZSwgXCJmZXRjaCByZW1vdGVcIik7XG4gIGlmIChyZWYgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBbXCJmZXRjaFwiLCBcIi0tZW5kLW9mLW9wdGlvbnNcIiwgcmVtb3RlXTtcbiAgfVxuICBhc3NlcnRTYWZlR2l0UmVmKHJlZiwgXCJmZXRjaCByZWZcIik7XG4gIHJldHVybiBbXCJmZXRjaFwiLCBcIi0tZW5kLW9mLW9wdGlvbnNcIiwgcmVtb3RlLCByZWZdO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBhcmd2IGZvciBmZXRjaGluZyBvbmUgYnJhbmNoIHN0cmFpZ2h0IGludG8gaXRzIHJlbW90ZS10cmFja2luZ1xuICogcmVmIChJc3N1ZSAjMjExKS5cbiAqXG4gKiBgZ2l0IGNsb25lIC0tc2luZ2xlLWJyYW5jaGAgKGFuZCBhbnkgY2xvbmUgd2hvc2UgYHJlbW90ZS5vcmlnaW4uZmV0Y2hgXG4gKiByZWZzcGVjIGlzIG5hcnJvd2VkKSBuZXZlciBjcmVhdGVzIGByZWZzL3JlbW90ZXMvb3JpZ2luLzxmZWF0dXJlPmAsIG5vdCBldmVuXG4gKiBhZnRlciBgZ2l0IHB1c2ggLXVgIHJlcG9ydHMgdGhlIGJyYW5jaCBhcyB0cmFja2VkLiBBbiBleHBsaWNpdCByZWZzcGVjIGlzIHRoZVxuICogb25lIGZldGNoIHRoYXQgY3JlYXRlcyBpdCByZWdhcmRsZXNzIG9mIHRoZSBjbG9uZSdzIG93biByZWZzcGVjLCBzbyB0aGVcbiAqIHVucHVzaGVkIGNvdW50IGNhbiBiZSBtZWFzdXJlZCBhZ2FpbnN0IHRoZSBicmFuY2gncyByZWFsIHJlbW90ZSBoZWFkLlxuICpcbiAqIFRoZSBicmFuY2ggbmFtZSBsYW5kcyBpbnNpZGUgdGhlIHJlZnNwZWMsIHdoZXJlIGEgYDpgIHdvdWxkIHNwbGl0IGl0IGludG8gYVxuICogZGlmZmVyZW50IHNvdXJjZS9kZXN0aW5hdGlvbiBwYWlyIOKAlCBzbyBpdCBpcyB2YWxpZGF0ZWQgYXMgYSByZWYgY29tcG9uZW50LFxuICogbm90IG1lcmVseSBjaGVja2VkIGZvciBhIGxlYWRpbmcgZGFzaC5cbiAqXG4gKiBAcGFyYW0gcmVtb3RlIC0gVGhlIHJlbW90ZSB0byBmZXRjaCBmcm9tICh1c3VhbGx5IFwib3JpZ2luXCIpLlxuICogQHBhcmFtIGJyYW5jaE5hbWUgLSBUaGUgYnJhbmNoIHRvIGZldGNoICh1bnRydXN0ZWQgcG9zaXRpb25hbCkuXG4gKiBAcmV0dXJucyBlLmcuIGBbXCJmZXRjaFwiLCBcIi0tZW5kLW9mLW9wdGlvbnNcIiwgXCJvcmlnaW5cIixcbiAqICAgXCIrcmVmcy9oZWFkcy94OnJlZnMvcmVtb3Rlcy9vcmlnaW4veFwiXWAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEZldGNoVHJhY2tpbmdSZWZBcmdzKFxuICByZW1vdGU6IHN0cmluZyxcbiAgYnJhbmNoTmFtZTogc3RyaW5nLFxuKTogc3RyaW5nW10ge1xuICBhc3NlcnRTYWZlR2l0UmVmKHJlbW90ZSwgXCJmZXRjaCByZW1vdGVcIik7XG4gIGFzc2VydFNhZmVSZWZDb21wb25lbnQoYnJhbmNoTmFtZSwgXCJmZXRjaCBicmFuY2ggbmFtZVwiKTtcbiAgcmV0dXJuIFtcbiAgICBcImZldGNoXCIsXG4gICAgXCItLWVuZC1vZi1vcHRpb25zXCIsXG4gICAgcmVtb3RlLFxuICAgIGArcmVmcy9oZWFkcy8ke2JyYW5jaE5hbWV9OnJlZnMvcmVtb3Rlcy8ke3JlbW90ZX0vJHticmFuY2hOYW1lfWAsXG4gIF07XG59XG5cbi8qKiBDaGFyYWN0ZXJzIGdpdCBpdHNlbGYgcmVmdXNlcyBpbiBhIHJlZiBjb21wb25lbnQgKGBnaXQgY2hlY2stcmVmLWZvcm1hdGApLiAqL1xuY29uc3QgVU5TQUZFX1JFRl9DSEFSUyA9IC9bXFxzfl46PypbXFxcXF0vO1xuXG4vKipcbiAqIFRocm93IHVubGVzcyBgcmVmYCBpcyBzYWZlIHRvIGVtYmVkICppbnNpZGUqIGEgY29tcG9zZWQgcmVmIG9yIHJlZnNwZWMuXG4gKlxuICogU3RyaWN0ZXIgdGhhbiB7QGxpbmsgYXNzZXJ0U2FmZUdpdFJlZn06IGEgbmFtZSB0aGF0IGlzIGhhcm1sZXNzIGFzIGEgYmFyZVxuICogcG9zaXRpb25hbCBjYW4gc3RpbGwgYnJlYWsgYSByZWZzcGVjIGl0IGlzIGludGVycG9sYXRlZCBpbnRvIChgYTpiYCBiZWNvbWVzXG4gKiBhIGRpZmZlcmVudCBzb3VyY2UvZGVzdGluYXRpb24gcGFpcikuIEdpdCByZWplY3RzIGV2ZXJ5IGNoYXJhY3RlciBiZWxvdyBpbiBhXG4gKiByZWYgY29tcG9uZW50LCBzbyBhIG5hbWUgY2Fycnlpbmcgb25lIGlzIGFsd2F5cyBlaXRoZXIgYSBidWcgb3IgYW4gYXR0YWNrLlxuICpcbiAqIEBwYXJhbSByZWYgLSBUaGUgY2FuZGlkYXRlIHJlZiBjb21wb25lbnQuXG4gKiBAcGFyYW0gY29udGV4dCAtIFNob3J0IGRlc2NyaXB0aW9uIG9mIHRoZSBhcmd1bWVudCBzbG90LlxuICogQHRocm93cyBFcnJvciB3aGVuIHRoZSBjb21wb25lbnQgaXMgZW1wdHksIGRhc2gtbGVhZGluZywgb3IgbWFsZm9ybWVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0U2FmZVJlZkNvbXBvbmVudChyZWY6IHN0cmluZywgY29udGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGFzc2VydFNhZmVHaXRSZWYocmVmLCBjb250ZXh0KTtcbiAgaWYgKFVOU0FGRV9SRUZfQ0hBUlMudGVzdChyZWYpIHx8IHJlZi5pbmNsdWRlcyhcIi4uXCIpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYFJlZnVzaW5nIHRvIHJ1biBnaXQ6ICR7Y29udGV4dH0gaXMgbm90IGEgdmFsaWQgcmVmIGNvbXBvbmVudCBgICtcbiAgICAgICAgYChnb3QgJyR7cmVmfScpYCxcbiAgICApO1xuICB9XG59XG5cbi8qKiBPcHRpb25zIGZvciB7QGxpbmsgYnVpbGRQdWxsQXJnc30uICovXG5leHBvcnQgaW50ZXJmYWNlIFB1bGxBcmdzT3B0aW9ucyB7XG4gIC8qKiBBZGQgYC0tcmViYXNlYCAoaW50ZWdyYXRlIGJ5IHJlYmFzaW5nIHJhdGhlciB0aGFuIG1lcmdpbmcpLiAqL1xuICByZWJhc2U/OiBib29sZWFuO1xuICAvKiogQWRkIGAtLWZmLW9ubHlgIChyZWZ1c2UgYW55dGhpbmcgYnV0IGEgZmFzdC1mb3J3YXJkKS4gKi9cbiAgZmZPbmx5PzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgYXJndiBmb3IgYGdpdCBwdWxsIFs8ZmxhZ3M+XSA8cmVtb3RlPiA8cmVmPmAuXG4gKlxuICogQHBhcmFtIHJlbW90ZSAtIFRoZSByZW1vdGUgdG8gcHVsbCBmcm9tICh1c3VhbGx5IFwib3JpZ2luXCIpLlxuICogQHBhcmFtIHJlZiAtIFRoZSBicmFuY2ggdG8gcHVsbCAodW50cnVzdGVkIHBvc2l0aW9uYWwpLlxuICogQHBhcmFtIG9wdGlvbnMgLSBJbnRlZ3JhdGlvbiBmbGFnczsgc2VlIHtAbGluayBQdWxsQXJnc09wdGlvbnN9LlxuICogQHJldHVybnMgZS5nLiBgW1wicHVsbFwiLCBcIi0tcmViYXNlXCIsIFwiLS1lbmQtb2Ytb3B0aW9uc1wiLCBcIm9yaWdpblwiLCBcInhcIl1gLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRQdWxsQXJncyhcbiAgcmVtb3RlOiBzdHJpbmcsXG4gIHJlZjogc3RyaW5nLFxuICBvcHRpb25zOiBQdWxsQXJnc09wdGlvbnMgPSB7fSxcbik6IHN0cmluZ1tdIHtcbiAgYXNzZXJ0U2FmZUdpdFJlZihyZW1vdGUsIFwicHVsbCByZW1vdGVcIik7XG4gIGFzc2VydFNhZmVHaXRSZWYocmVmLCBcInB1bGwgcmVmXCIpO1xuICBjb25zdCBmbGFnczogc3RyaW5nW10gPSBbXTtcbiAgaWYgKG9wdGlvbnMucmViYXNlKSBmbGFncy5wdXNoKFwiLS1yZWJhc2VcIik7XG4gIGlmIChvcHRpb25zLmZmT25seSkgZmxhZ3MucHVzaChcIi0tZmYtb25seVwiKTtcbiAgcmV0dXJuIFtcInB1bGxcIiwgLi4uZmxhZ3MsIFwiLS1lbmQtb2Ytb3B0aW9uc1wiLCByZW1vdGUsIHJlZl07XG59XG5cbi8qKiBPcHRpb25zIGZvciB7QGxpbmsgYnVpbGRQdXNoQXJnc30uICovXG5leHBvcnQgaW50ZXJmYWNlIFB1c2hBcmdzT3B0aW9ucyB7XG4gIC8qKiBBZGQgYC11YCBzbyB0aGUgZmlyc3QgcHVzaCBvZiBhIGJyYW5jaCBzZXRzIGl0cyB1cHN0cmVhbS4gKi9cbiAgc2V0VXBzdHJlYW0/OiBib29sZWFuO1xuICAvKipcbiAgICogTGVhc2UgdGhlIGZvcmNlIHB1c2ggKElzc3VlICMyNzUpLiBgdHJ1ZWAgZW1pdHMgYSBiYXJlXG4gICAqIGAtLWZvcmNlLXdpdGgtbGVhc2VgOyBhIHN0cmluZyBpcyB0aGUgZnVsbCBwaW5uZWQgZm9ybSwgZS5nLlxuICAgKiBgLS1mb3JjZS13aXRoLWxlYXNlPWZlYXR1cmU6PHNoYT5gLlxuICAgKlxuICAgKiBUaGUgZmxhZyBtdXN0IHByZWNlZGUgYC0tZW5kLW9mLW9wdGlvbnNgLCBzaW5jZSBldmVyeXRoaW5nIGFmdGVyIHRoZVxuICAgKiBzZXBhcmF0b3IgaXMgYSBwb3NpdGlvbmFsIOKAlCBhIHRyYWlsaW5nIGAtLWZvcmNlLXdpdGgtbGVhc2VgIHdvdWxkIHJlYWNoXG4gICAqIGdpdCBhcyBhIHRoaXJkIHJlZnNwZWMgcmF0aGVyIHRoYW4gYXMgYSBmbGFnLlxuICAgKi9cbiAgZm9yY2VXaXRoTGVhc2U/OiB0cnVlIHwgc3RyaW5nO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBhcmd2IGZvciBgZ2l0IHB1c2ggWy11XSA8cmVtb3RlPiA8YnJhbmNoPmAgKElzc3VlICMxNDgpLlxuICpcbiAqIFRoZSBicmFuY2ggaGVyZSBpcyB0aGUgd29ya2VyJ3MgaXNzdWUgYnJhbmNoLCB3aGljaCBldmVyeSBhdXRvbWF0ZWRcbiAqIGNvbW1pdCBwYXRoIOKAlCBpbmNsdWRpbmcgdGhlIFdJUCBwcmVzZXJ2YXRpb24gYSB0aW1lZC1vdXQgZXhlY3V0ZSBwZXJmb3Jtc1xuICog4oCUIHB1c2hlcyB0aHJvdWdoLiBJdCByZWFjaGVkIGdpdCBhcyBhIGJhcmUgcG9zaXRpb25hbCwgc28gYSBkYXNoLWxlYWRpbmdcbiAqIG5hbWUgd291bGQgaGF2ZSBiZWVuIHBhcnNlZCBhcyBhbiBvcHRpb24gcmF0aGVyIHRoYW4gYSByZWZzcGVjLiBgLXVgIHRha2VzXG4gKiBubyB2YWx1ZSwgc28gdGhlIHNlcGFyYXRvciBzaXRzIGRpcmVjdGx5IGJlZm9yZSB0aGUgZmlyc3QgcG9zaXRpb25hbC5cbiAqXG4gKiBAcGFyYW0gcmVtb3RlIC0gVGhlIHJlbW90ZSB0byBwdXNoIHRvICh1c3VhbGx5IFwib3JpZ2luXCIpLlxuICogQHBhcmFtIGJyYW5jaE5hbWUgLSBUaGUgYnJhbmNoIHRvIHB1c2ggKHVudHJ1c3RlZCBwb3NpdGlvbmFsKS5cbiAqIEBwYXJhbSBvcHRpb25zIC0gUHVzaCBmbGFnczsgc2VlIHtAbGluayBQdXNoQXJnc09wdGlvbnN9LlxuICogQHJldHVybnMgZS5nLiBgW1wicHVzaFwiLCBcIi11XCIsIFwiLS1lbmQtb2Ytb3B0aW9uc1wiLCBcIm9yaWdpblwiLCBcImlzc3VlLTEteFwiXWAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFB1c2hBcmdzKFxuICByZW1vdGU6IHN0cmluZyxcbiAgYnJhbmNoTmFtZTogc3RyaW5nLFxuICBvcHRpb25zOiBQdXNoQXJnc09wdGlvbnMgPSB7fSxcbik6IHN0cmluZ1tdIHtcbiAgYXNzZXJ0U2FmZUdpdFJlZihyZW1vdGUsIFwicHVzaCByZW1vdGVcIik7XG4gIGFzc2VydFNhZmVHaXRSZWYoYnJhbmNoTmFtZSwgXCJwdXNoIGJyYW5jaCBuYW1lXCIpO1xuICBjb25zdCBmbGFnczogc3RyaW5nW10gPSBbXTtcbiAgaWYgKG9wdGlvbnMuc2V0VXBzdHJlYW0pIGZsYWdzLnB1c2goXCItdVwiKTtcbiAgaWYgKG9wdGlvbnMuZm9yY2VXaXRoTGVhc2UgIT09IHVuZGVmaW5lZCkge1xuICAgIGZsYWdzLnB1c2goXG4gICAgICBvcHRpb25zLmZvcmNlV2l0aExlYXNlID09PSB0cnVlXG4gICAgICAgID8gXCItLWZvcmNlLXdpdGgtbGVhc2VcIlxuICAgICAgICA6IG9wdGlvbnMuZm9yY2VXaXRoTGVhc2UsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gW1wicHVzaFwiLCAuLi5mbGFncywgXCItLWVuZC1vZi1vcHRpb25zXCIsIHJlbW90ZSwgYnJhbmNoTmFtZV07XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIGFyZ3YgZm9yIGNyZWF0aW5nIGEgcmVtb3RlIGJyYW5jaCBzdHJhaWdodCBmcm9tIGEgbG9jYWwgY29tbWl0LWlzaFxuICogKElzc3VlICMxMzQ1KS5cbiAqXG4gKiBgZ2l0IHB1c2ggb3JpZ2luIG1haW46cmVmcy9oZWFkcy9taWxlc3RvbmUveGAgY3JlYXRlcyB0aGUgYnJhbmNoIG9uIHRoZVxuICogcmVtb3RlIHdpdGhvdXQgY2hlY2tpbmcgYW55dGhpbmcgb3V0LCBzbyBhIHN0YWxlIGxvY2FsIGJyYW5jaCBvZiB0aGUgc2FtZVxuICogbmFtZSDigJQgaW5jbHVkaW5nIG9uZSBhbm90aGVyIHdvcmt0cmVlIGhvbGRzLCB3aGljaCByZWZ1c2VzIGBjaGVja291dCAtQmBcbiAqIG91dHJpZ2h0IOKAlCBjYW5ub3QgYmxvY2sgdGhlIGNyZWF0aW9uLlxuICpcbiAqIEJvdGggaGFsdmVzIG9mIHRoZSByZWZzcGVjIGxhbmQgaW5zaWRlIG9uZSBhcmd1bWVudCB3aGVyZSBhIGA6YCB3b3VsZCBzcGxpdFxuICogdGhlbSBpbnRvIGEgZGlmZmVyZW50IHNvdXJjZS9kZXN0aW5hdGlvbiBwYWlyLCBzbyBib3RoIGFyZSB2YWxpZGF0ZWQgYXMgcmVmXG4gKiBjb21wb25lbnRzIHJhdGhlciB0aGFuIG1lcmVseSBjaGVja2VkIGZvciBhIGxlYWRpbmcgZGFzaC5cbiAqXG4gKiBAcGFyYW0gcmVtb3RlIC0gVGhlIHJlbW90ZSB0byBwdXNoIHRvICh1c3VhbGx5IFwib3JpZ2luXCIpLlxuICogQHBhcmFtIHNvdXJjZVJlZiAtIFRoZSBjb21taXQtaXNoIHRvIHB1Ymxpc2ggKGUuZy4gXCJtYWluXCIsIFwib3JpZ2luL21haW5cIikuXG4gKiBAcGFyYW0gdGFyZ2V0QnJhbmNoIC0gVGhlIGJyYW5jaCBuYW1lIHRvIGNyZWF0ZSBvbiB0aGUgcmVtb3RlLlxuICogQHJldHVybnMgZS5nLiBgW1wicHVzaFwiLCBcIi0tZW5kLW9mLW9wdGlvbnNcIiwgXCJvcmlnaW5cIixcbiAqICAgXCJtYWluOnJlZnMvaGVhZHMvbWlsZXN0b25lL3hcIl1gLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRQdXNoQ3JlYXRlQnJhbmNoQXJncyhcbiAgcmVtb3RlOiBzdHJpbmcsXG4gIHNvdXJjZVJlZjogc3RyaW5nLFxuICB0YXJnZXRCcmFuY2g6IHN0cmluZyxcbik6IHN0cmluZ1tdIHtcbiAgYXNzZXJ0U2FmZUdpdFJlZihyZW1vdGUsIFwicHVzaCByZW1vdGVcIik7XG4gIGFzc2VydFNhZmVSZWZDb21wb25lbnQoc291cmNlUmVmLCBcInB1c2ggc291cmNlIHJlZlwiKTtcbiAgYXNzZXJ0U2FmZVJlZkNvbXBvbmVudCh0YXJnZXRCcmFuY2gsIFwicHVzaCB0YXJnZXQgYnJhbmNoXCIpO1xuICByZXR1cm4gW1xuICAgIFwicHVzaFwiLFxuICAgIFwiLS1lbmQtb2Ytb3B0aW9uc1wiLFxuICAgIHJlbW90ZSxcbiAgICBgJHtzb3VyY2VSZWZ9OnJlZnMvaGVhZHMvJHt0YXJnZXRCcmFuY2h9YCxcbiAgXTtcbn1cblxuLyoqIE9wdGlvbnMgZm9yIHtAbGluayBidWlsZFJlYmFzZUFyZ3N9LiAqL1xuZXhwb3J0IGludGVyZmFjZSBSZWJhc2VBcmdzT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBBZGQgYC0tbm8tcmViYXNlLW1lcmdlc2Agc28gbWVyZ2UgY29tbWl0cyBhcmUgZHJvcHBlZCBhbmQgdGhlIHJlcGxheWVkXG4gICAqIGhpc3RvcnkgaXMgbGluZWFyIChJc3N1ZSAjMjI3OSkuIFdyaXR0ZW4gZm9yIHRoZSBzdGFsZS12ZXJkaWN0IGxhZGRlcidzXG4gICAqIHJlYmFzZSBydW5nLCBzaW5jZSBkcm9wcGVkIChJc3N1ZSAjMjg0Mik6IGEgUFIgaGVhZCB0aGF0IGlzIGl0c2VsZiBhXG4gICAqIG1lcmdlIG9mIHRoZSBiYXNlIGlzIGV4YWN0bHkgdGhlIHNoYXBlIHRoYXQgcnVuZyBleGlzdGVkIGZvciwgYW5kXG4gICAqIHJlLWNyZWF0aW5nIHRoYXQgbWVyZ2Ugd291bGQgaGF2ZSByZXBsYXllZCB0aGUgaGVhZCByYXRoZXIgdGhhblxuICAgKiBmbGF0dGVuaW5nIGl0LlxuICAgKi9cbiAgbm9SZWJhc2VNZXJnZXM/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBhcmd2IGZvciBgZ2l0IHJlYmFzZSBbLS1uby1yZWJhc2UtbWVyZ2VzXSA8dXBzdHJlYW0+YC5cbiAqXG4gKiBAcGFyYW0gdXBzdHJlYW0gLSBUaGUgYnJhbmNoIHRvIHJlYmFzZSBvbnRvICh1bnRydXN0ZWQgcG9zaXRpb25hbCkuXG4gKiBAcGFyYW0gb3B0aW9ucyAtIFJlYmFzZSBmbGFnczsgc2VlIHtAbGluayBSZWJhc2VBcmdzT3B0aW9uc30uXG4gKiBAcmV0dXJucyBlLmcuIGBbXCJyZWJhc2VcIiwgXCItLWVuZC1vZi1vcHRpb25zXCIsIFwiRGV2ZWxvcFwiXWAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFJlYmFzZUFyZ3MoXG4gIHVwc3RyZWFtOiBzdHJpbmcsXG4gIG9wdGlvbnM6IFJlYmFzZUFyZ3NPcHRpb25zID0ge30sXG4pOiBzdHJpbmdbXSB7XG4gIGFzc2VydFNhZmVHaXRSZWYodXBzdHJlYW0sIFwicmViYXNlIHVwc3RyZWFtXCIpO1xuICBjb25zdCBmbGFnczogc3RyaW5nW10gPSBbXTtcbiAgaWYgKG9wdGlvbnMubm9SZWJhc2VNZXJnZXMpIGZsYWdzLnB1c2goXCItLW5vLXJlYmFzZS1tZXJnZXNcIik7XG4gIHJldHVybiBbXCJyZWJhc2VcIiwgLi4uZmxhZ3MsIFwiLS1lbmQtb2Ytb3B0aW9uc1wiLCB1cHN0cmVhbV07XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIGFyZ3YgZm9yIHN3aXRjaGluZyB0byBhbiBleGlzdGluZyBicmFuY2gvcmVmLlxuICpcbiAqIEBwYXJhbSByZWYgLSBUaGUgYnJhbmNoIG9yIGNvbW1pdCB0byBzd2l0Y2ggdG8gKHVudHJ1c3RlZCBwb3NpdGlvbmFsKS5cbiAqIEByZXR1cm5zIGUuZy4gYFtcImNoZWNrb3V0XCIsIFwiLS1lbmQtb2Ytb3B0aW9uc1wiLCBcImlzc3VlLTQyLWZpeFwiXWAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZENoZWNrb3V0QXJncyhyZWY6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgYXNzZXJ0U2FmZUdpdFJlZihyZWYsIFwiY2hlY2tvdXQgcmVmXCIpO1xuICByZXR1cm4gW1wiY2hlY2tvdXRcIiwgXCItLWVuZC1vZi1vcHRpb25zXCIsIHJlZl07XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIGFyZ3YgZm9yIGNyZWF0aW5nIGFuZCBzd2l0Y2hpbmcgdG8gYSBicmFuY2ggKGBnaXQgY2hlY2tvdXQgLWJgKS5cbiAqXG4gKiBgLWJgIGNvbnN1bWVzIHRoZSBpbW1lZGlhdGVseSBmb2xsb3dpbmcgYXJndiBhcyBpdHMgdmFsdWUsIHNvIHRoZSBuZXctYnJhbmNoXG4gKiBuYW1lIGlzIG5ldmVyIHJlLXBhcnNlZCBhcyBhbiBvcHRpb24gYW5kIHRoZSBzZXBhcmF0b3IgbXVzdCBzaXQgKmFmdGVyKiBpdCDigJRcbiAqIGd1YXJkaW5nIHRoZSBvcHRpb25hbCBzdGFydCBwb2ludCwgdGhlIG9uZSByZW1haW5pbmcgYmFyZSBwb3NpdGlvbmFsLlxuICpcbiAqIEBwYXJhbSBicmFuY2hOYW1lIC0gVGhlIGJyYW5jaCB0byBjcmVhdGUgKHVudHJ1c3RlZCBwb3NpdGlvbmFsKS5cbiAqIEBwYXJhbSBzdGFydFBvaW50IC0gT3B0aW9uYWwgcmVmIHRvIGJyYW5jaCBmcm9tICh1bnRydXN0ZWQgcG9zaXRpb25hbCkuXG4gKiBAcmV0dXJucyBlLmcuIGBbXCJjaGVja291dFwiLCBcIi1iXCIsIFwiZmVhdHVyZVwiLCBcIi0tZW5kLW9mLW9wdGlvbnNcIiwgXCJtYWluXCJdYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkQ2hlY2tvdXROZXdCcmFuY2hBcmdzKFxuICBicmFuY2hOYW1lOiBzdHJpbmcsXG4gIHN0YXJ0UG9pbnQ/OiBzdHJpbmcsXG4pOiBzdHJpbmdbXSB7XG4gIGFzc2VydFNhZmVHaXRSZWYoYnJhbmNoTmFtZSwgXCJuZXcgYnJhbmNoIG5hbWVcIik7XG4gIGlmIChzdGFydFBvaW50ID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gW1wiY2hlY2tvdXRcIiwgXCItYlwiLCBicmFuY2hOYW1lXTtcbiAgfVxuICBhc3NlcnRTYWZlR2l0UmVmKHN0YXJ0UG9pbnQsIFwiY2hlY2tvdXQgc3RhcnQgcG9pbnRcIik7XG4gIHJldHVybiBbXCJjaGVja291dFwiLCBcIi1iXCIsIGJyYW5jaE5hbWUsIFwiLS1lbmQtb2Ytb3B0aW9uc1wiLCBzdGFydFBvaW50XTtcbn1cblxuLyoqXG4gKiBgZ2l0IGNoZWNrb3V0IC1CIDxicmFuY2g+IFs8c3RhcnQtcG9pbnQ+XWAg4oCUIGNyZWF0ZS1vci1yZXNldCBhIGJyYW5jaCxcbiAqIGhhcmRlbmVkLiBUaGUgYnJhbmNoIG5hbWUgaXMgdmFsaWRhdGVkIChubyBsZWFkaW5nIGRhc2gpLCBhbmQgYSBzdGFydCBwb2ludFxuICogaXMgc2VwYXJhdGVkIHdpdGggYC0tZW5kLW9mLW9wdGlvbnNgLlxuICpcbiAqIEBwYXJhbSBicmFuY2hOYW1lIC0gQnJhbmNoIHRvIGNyZWF0ZSBvciByZXNldCAoYXR0YWNrZXItY29udHJvbGxlZCkuXG4gKiBAcGFyYW0gc3RhcnRQb2ludCAtIE9wdGlvbmFsIHN0YXJ0IHBvaW50LlxuICogQHJldHVybnMgVGhlIGFyZ3YsIGUuZy4gYFtcImNoZWNrb3V0XCIsIFwiLUJcIiwgXCJpc3N1ZS00MlwiLCBcIi0tZW5kLW9mLW9wdGlvbnNcIiwgXCJtYWluXCJdYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkQ2hlY2tvdXRSZXNldEJyYW5jaEFyZ3MoXG4gIGJyYW5jaE5hbWU6IHN0cmluZyxcbiAgc3RhcnRQb2ludD86IHN0cmluZyxcbik6IHN0cmluZ1tdIHtcbiAgYXNzZXJ0U2FmZUdpdFJlZihicmFuY2hOYW1lLCBcInJlc2V0IGJyYW5jaCBuYW1lXCIpO1xuICBpZiAoc3RhcnRQb2ludCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIFtcImNoZWNrb3V0XCIsIFwiLUJcIiwgYnJhbmNoTmFtZV07XG4gIH1cbiAgYXNzZXJ0U2FmZUdpdFJlZihzdGFydFBvaW50LCBcImNoZWNrb3V0IHN0YXJ0IHBvaW50XCIpO1xuICByZXR1cm4gW1wiY2hlY2tvdXRcIiwgXCItQlwiLCBicmFuY2hOYW1lLCBcIi0tZW5kLW9mLW9wdGlvbnNcIiwgc3RhcnRQb2ludF07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQWlDQyxHQUVEOzs7Ozs7O0NBT0MsR0FDRCxPQUFPLFNBQVMsaUJBQWlCLEdBQVcsRUFBRSxPQUFlO0VBQzNELElBQUksUUFBUSxJQUFJO0lBQ2QsTUFBTSxJQUFJLE1BQU0sQ0FBQyxxQkFBcUIsRUFBRSxRQUFRLGtCQUFrQixDQUFDO0VBQ3JF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
// denoCacheMetadata=4036272390615613252,17270081374315531258