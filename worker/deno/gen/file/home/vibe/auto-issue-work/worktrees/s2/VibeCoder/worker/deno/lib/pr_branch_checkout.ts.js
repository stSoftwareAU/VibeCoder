/**
 * Check a PR branch out at its *remote* head before maintenance (Issue #211).
 *
 * The branch-update pass shares its clone with every other pass. `git checkout
 * <branch>` therefore lands on whatever that clone's local branch happens to
 * hold — in NEAT-AI-core PR #557 that was the pre-sibling-push state, so the
 * test-merge of the base ran against a stale branch, reported a conflict the
 * remote PR did not have, and got the PR labelled `merge-conflict` while it
 * was perfectly mergeable.
 *
 * The remote head is the PR. This module makes the local branch match it
 * before anything is evaluated, and refuses loudly rather than silently
 * evaluating (or force-pushing) a local branch that carries commits the remote
 * has never seen.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { runGitCommand } from "./git_timeout.ts";
import { assertSafeRefComponent, buildCheckoutResetBranchArgs, buildFetchTrackingRefArgs } from "./git_ref_args.ts";
import { LOCAL_AHEAD_OF_REMOTE_ERROR } from "./git_branch_sync.ts";
import { detachLaneWorktreeHead, laneWorktreeHoldingBranch } from "./lane_worktree.ts";
/** Read a ref's SHA, or null when the ref does not exist. */ async function readSha(ref, options) {
  const result = await runGitCommand([
    "rev-parse",
    "--verify",
    "--quiet",
    ref
  ], options);
  if (!result.ok || result.value.code !== 0) return null;
  return result.value.stdout.trim() || null;
}
/**
 * Check out `branchName` positioned exactly at `origin/<branchName>`.
 *
 * Fetches the branch into its remote-tracking ref first — an explicit refspec,
 * so a single-branch clone gets the ref too — then:
 *
 * - no local branch → create it from the remote head;
 * - local branch holds nothing the remote lacks → hard-reset it onto the
 *   remote head (discards only work the remote already has);
 * - local branch holds commits the remote lacks → refuse, naming the count.
 *   Those commits are somebody's unpushed work: evaluating a merge against
 *   them invents conflicts, and force-pushing the result would publish them.
 *
 * @param branchName - The PR head branch
 * @param options - Git command options (cwd selects the repo)
 * @returns How the branch was aligned, or an error explaining the refusal
 */ export async function checkoutPrBranchAtRemoteHead(branchName, options = {}) {
  try {
    assertSafeRefComponent(branchName, "PR head branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err))
    };
  }
  const trackingRef = `refs/remotes/origin/${branchName}`;
  await runGitCommand(buildFetchTrackingRefArgs("origin", branchName), options);
  const remoteSha = await readSha(trackingRef, options);
  if (remoteSha === null) {
    return {
      ok: false,
      error: new Error(`Branch '${branchName}' does not exist on origin — refusing to ` + `evaluate a PR branch that is only local (Issue #211)`)
    };
  }
  const localSha = await readSha(`refs/heads/${branchName}`, options);
  // What the local branch is, before anything is moved. The ahead-check has
  // to happen here — before the branch is touched — because it is the only
  // thing standing between somebody's unpushed work and a hard reset.
  let alignment;
  if (localSha === null) {
    alignment = "created-from-remote";
  } else if (localSha === remoteSha) {
    alignment = "already-at-remote";
  } else if (!await isReadableCommit(localSha, options)) {
    // The ref resolves but names an object this clone does not have — the
    // `fatal: bad object` / `unable to read tree` shape (Issue #411). There
    // is no reachable work to protect, and the ref cannot be read, only
    // replaced. The remote head is the PR, so take it.
    alignment = "reset-to-remote";
  } else {
    const aheadResult = await runGitCommand([
      "rev-list",
      "--count",
      `${trackingRef}..refs/heads/${branchName}`
    ], options);
    if (!aheadResult.ok || aheadResult.value.code !== 0) {
      const stderr = aheadResult.ok ? aheadResult.value.stderr.trim() : "";
      return {
        ok: false,
        error: new Error(`Could not compare '${branchName}' with its remote head: ` + `${stderr || (aheadResult.ok ? `exit ${aheadResult.value.code}` : aheadResult.error.message)}`)
      };
    }
    const ahead = Number.parseInt(aheadResult.value.stdout.trim(), 10);
    if (!Number.isFinite(ahead)) {
      return {
        ok: false,
        error: new Error(`Could not compare '${branchName}' with its remote head: git printed ` + `'${aheadResult.value.stdout.trim()}'`)
      };
    }
    if (ahead > 0) {
      // Named (Issue #394) so callers can tell this apart from a PR fault:
      // the commits belong to another lane sharing this clone, and the PR is
      // retried next cycle rather than counted as failed.
      const error = new Error(`Local branch '${branchName}' holds ${ahead} commit(s) that ` + `origin/${branchName} does not — refusing to evaluate or update a ` + `PR from a stale local branch (Issue #211). Push or discard them ` + `first.`);
      error.name = LOCAL_AHEAD_OF_REMOTE_ERROR;
      return {
        ok: false,
        error
      };
    }
    alignment = "reset-to-remote";
  }
  // One mutating command for every case (Issue #411). `checkout -B` creates
  // the branch when it is absent, resets it when it is stale, and overwrites
  // it when it is corrupt — so the local ref is never *read* to get there.
  //
  // The old shape read the ref with `rev-parse` and then ran a separate
  // `git checkout <branch>`, which failed permanently on a ref that resolved
  // but could not be checked out, and left a window in which another lane
  // sharing the clone could delete the branch between the two commands:
  //
  //   Failed to checkout branch 'issue-387-side-data-…': error: pathspec
  //   'issue-387-side-data-…' did not match any file(s) known to git
  //
  // — while the branch sat healthy on origin the whole time. PR #408 failed
  // that way on three consecutive cycles.
  let aligned = await runGitCommand(buildCheckoutResetBranchArgs(branchName, trackingRef), options);
  if (aligned.ok && aligned.value.code !== 0) {
    // Issue #1677: the branch is checked out in one of this host's own lane
    // worktrees — typically the issue lane that raised the PR and then sat
    // parked on its branch. Detach that worktree and try once more, the
    // repair `createFeatureBranchFromBase` already makes (Issue #1564). A
    // holder that is not a lane worktree of this host is left alone and the
    // refusal is reported below in git's own words.
    const heldBy = laneWorktreeHoldingBranch(aligned.value.stderr);
    if (heldBy !== undefined && await detachLaneWorktreeHead(heldBy)) {
      aligned = await runGitCommand(buildCheckoutResetBranchArgs(branchName, trackingRef), options);
    }
  }
  if (!aligned.ok || aligned.value.code !== 0) {
    const stderr = aligned.ok ? aligned.value.stderr.trim() : "";
    return {
      ok: false,
      error: new Error(`Failed to position '${branchName}' on its remote head: ` + `${stderr || (aligned.ok ? `exit ${aligned.value.code}` : aligned.error.message)}`)
    };
  }
  return {
    ok: true,
    value: alignment
  };
}
/**
 * Is `sha` a commit this clone can actually read?
 *
 * A ref can resolve while the object it names is missing — the shape behind
 * `fatal: bad object` and `unable to read tree`. Such a branch has no
 * reachable work on it, so it is safe to overwrite; a readable one must go
 * through the ahead-check first.
 */ async function isReadableCommit(sha, options) {
  const result = await runGitCommand([
    "cat-file",
    "-e",
    `${sha}^{commit}`
  ], options);
  return result.ok && result.value.code === 0;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9wcl9icmFuY2hfY2hlY2tvdXQudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDaGVjayBhIFBSIGJyYW5jaCBvdXQgYXQgaXRzICpyZW1vdGUqIGhlYWQgYmVmb3JlIG1haW50ZW5hbmNlIChJc3N1ZSAjMjExKS5cbiAqXG4gKiBUaGUgYnJhbmNoLXVwZGF0ZSBwYXNzIHNoYXJlcyBpdHMgY2xvbmUgd2l0aCBldmVyeSBvdGhlciBwYXNzLiBgZ2l0IGNoZWNrb3V0XG4gKiA8YnJhbmNoPmAgdGhlcmVmb3JlIGxhbmRzIG9uIHdoYXRldmVyIHRoYXQgY2xvbmUncyBsb2NhbCBicmFuY2ggaGFwcGVucyB0b1xuICogaG9sZCDigJQgaW4gTkVBVC1BSS1jb3JlIFBSICM1NTcgdGhhdCB3YXMgdGhlIHByZS1zaWJsaW5nLXB1c2ggc3RhdGUsIHNvIHRoZVxuICogdGVzdC1tZXJnZSBvZiB0aGUgYmFzZSByYW4gYWdhaW5zdCBhIHN0YWxlIGJyYW5jaCwgcmVwb3J0ZWQgYSBjb25mbGljdCB0aGVcbiAqIHJlbW90ZSBQUiBkaWQgbm90IGhhdmUsIGFuZCBnb3QgdGhlIFBSIGxhYmVsbGVkIGBtZXJnZS1jb25mbGljdGAgd2hpbGUgaXRcbiAqIHdhcyBwZXJmZWN0bHkgbWVyZ2VhYmxlLlxuICpcbiAqIFRoZSByZW1vdGUgaGVhZCBpcyB0aGUgUFIuIFRoaXMgbW9kdWxlIG1ha2VzIHRoZSBsb2NhbCBicmFuY2ggbWF0Y2ggaXRcbiAqIGJlZm9yZSBhbnl0aGluZyBpcyBldmFsdWF0ZWQsIGFuZCByZWZ1c2VzIGxvdWRseSByYXRoZXIgdGhhbiBzaWxlbnRseVxuICogZXZhbHVhdGluZyAob3IgZm9yY2UtcHVzaGluZykgYSBsb2NhbCBicmFuY2ggdGhhdCBjYXJyaWVzIGNvbW1pdHMgdGhlIHJlbW90ZVxuICogaGFzIG5ldmVyIHNlZW4uXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7IHJ1bkdpdENvbW1hbmQgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuaW1wb3J0IHR5cGUgeyBHaXRDb21tYW5kT3B0aW9ucyB9IGZyb20gXCIuL2dpdF90aW1lb3V0LnRzXCI7XG5pbXBvcnQge1xuICBhc3NlcnRTYWZlUmVmQ29tcG9uZW50LFxuICBidWlsZENoZWNrb3V0UmVzZXRCcmFuY2hBcmdzLFxuICBidWlsZEZldGNoVHJhY2tpbmdSZWZBcmdzLFxufSBmcm9tIFwiLi9naXRfcmVmX2FyZ3MudHNcIjtcbmltcG9ydCB7IExPQ0FMX0FIRUFEX09GX1JFTU9URV9FUlJPUiB9IGZyb20gXCIuL2dpdF9icmFuY2hfc3luYy50c1wiO1xuaW1wb3J0IHtcbiAgZGV0YWNoTGFuZVdvcmt0cmVlSGVhZCxcbiAgbGFuZVdvcmt0cmVlSG9sZGluZ0JyYW5jaCxcbn0gZnJvbSBcIi4vbGFuZV93b3JrdHJlZS50c1wiO1xuXG4vKiogV2hhdCB0aGUgY2hlY2tvdXQgaGFkIHRvIGRvIHRvIHB1dCB0aGUgbG9jYWwgYnJhbmNoIG9uIHRoZSByZW1vdGUgaGVhZC4gKi9cbmV4cG9ydCB0eXBlIEJyYW5jaEFsaWdubWVudCA9XG4gIC8qKiBUaGUgbG9jYWwgYnJhbmNoIGFscmVhZHkgcG9pbnRlZCBhdCB0aGUgcmVtb3RlIGhlYWQuICovXG4gIHwgXCJhbHJlYWR5LWF0LXJlbW90ZVwiXG4gIC8qKiBBIHN0YWxlIGxvY2FsIGJyYW5jaCB3YXMgcmVzZXQgb250byB0aGUgcmVtb3RlIGhlYWQuICovXG4gIHwgXCJyZXNldC10by1yZW1vdGVcIlxuICAvKiogTm8gbG9jYWwgYnJhbmNoIGV4aXN0ZWQ7IGl0IHdhcyBjcmVhdGVkIGZyb20gdGhlIHJlbW90ZSBoZWFkLiAqL1xuICB8IFwiY3JlYXRlZC1mcm9tLXJlbW90ZVwiO1xuXG4vKiogUmVhZCBhIHJlZidzIFNIQSwgb3IgbnVsbCB3aGVuIHRoZSByZWYgZG9lcyBub3QgZXhpc3QuICovXG5hc3luYyBmdW5jdGlvbiByZWFkU2hhKFxuICByZWY6IHN0cmluZyxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMsXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJyZXYtcGFyc2VcIiwgXCItLXZlcmlmeVwiLCBcIi0tcXVpZXRcIiwgcmVmXSxcbiAgICBvcHRpb25zLFxuICApO1xuICBpZiAoIXJlc3VsdC5vayB8fCByZXN1bHQudmFsdWUuY29kZSAhPT0gMCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiByZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKSB8fCBudWxsO1xufVxuXG4vKipcbiAqIENoZWNrIG91dCBgYnJhbmNoTmFtZWAgcG9zaXRpb25lZCBleGFjdGx5IGF0IGBvcmlnaW4vPGJyYW5jaE5hbWU+YC5cbiAqXG4gKiBGZXRjaGVzIHRoZSBicmFuY2ggaW50byBpdHMgcmVtb3RlLXRyYWNraW5nIHJlZiBmaXJzdCDigJQgYW4gZXhwbGljaXQgcmVmc3BlYyxcbiAqIHNvIGEgc2luZ2xlLWJyYW5jaCBjbG9uZSBnZXRzIHRoZSByZWYgdG9vIOKAlCB0aGVuOlxuICpcbiAqIC0gbm8gbG9jYWwgYnJhbmNoIOKGkiBjcmVhdGUgaXQgZnJvbSB0aGUgcmVtb3RlIGhlYWQ7XG4gKiAtIGxvY2FsIGJyYW5jaCBob2xkcyBub3RoaW5nIHRoZSByZW1vdGUgbGFja3Mg4oaSIGhhcmQtcmVzZXQgaXQgb250byB0aGVcbiAqICAgcmVtb3RlIGhlYWQgKGRpc2NhcmRzIG9ubHkgd29yayB0aGUgcmVtb3RlIGFscmVhZHkgaGFzKTtcbiAqIC0gbG9jYWwgYnJhbmNoIGhvbGRzIGNvbW1pdHMgdGhlIHJlbW90ZSBsYWNrcyDihpIgcmVmdXNlLCBuYW1pbmcgdGhlIGNvdW50LlxuICogICBUaG9zZSBjb21taXRzIGFyZSBzb21lYm9keSdzIHVucHVzaGVkIHdvcms6IGV2YWx1YXRpbmcgYSBtZXJnZSBhZ2FpbnN0XG4gKiAgIHRoZW0gaW52ZW50cyBjb25mbGljdHMsIGFuZCBmb3JjZS1wdXNoaW5nIHRoZSByZXN1bHQgd291bGQgcHVibGlzaCB0aGVtLlxuICpcbiAqIEBwYXJhbSBicmFuY2hOYW1lIC0gVGhlIFBSIGhlYWQgYnJhbmNoXG4gKiBAcGFyYW0gb3B0aW9ucyAtIEdpdCBjb21tYW5kIG9wdGlvbnMgKGN3ZCBzZWxlY3RzIHRoZSByZXBvKVxuICogQHJldHVybnMgSG93IHRoZSBicmFuY2ggd2FzIGFsaWduZWQsIG9yIGFuIGVycm9yIGV4cGxhaW5pbmcgdGhlIHJlZnVzYWxcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNoZWNrb3V0UHJCcmFuY2hBdFJlbW90ZUhlYWQoXG4gIGJyYW5jaE5hbWU6IHN0cmluZyxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8UmVzdWx0PEJyYW5jaEFsaWdubWVudD4+IHtcbiAgdHJ5IHtcbiAgICBhc3NlcnRTYWZlUmVmQ29tcG9uZW50KGJyYW5jaE5hbWUsIFwiUFIgaGVhZCBicmFuY2ggbmFtZVwiKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyKSksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHRyYWNraW5nUmVmID0gYHJlZnMvcmVtb3Rlcy9vcmlnaW4vJHticmFuY2hOYW1lfWA7XG4gIGF3YWl0IHJ1bkdpdENvbW1hbmQoYnVpbGRGZXRjaFRyYWNraW5nUmVmQXJncyhcIm9yaWdpblwiLCBicmFuY2hOYW1lKSwgb3B0aW9ucyk7XG5cbiAgY29uc3QgcmVtb3RlU2hhID0gYXdhaXQgcmVhZFNoYSh0cmFja2luZ1JlZiwgb3B0aW9ucyk7XG4gIGlmIChyZW1vdGVTaGEgPT09IG51bGwpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYEJyYW5jaCAnJHticmFuY2hOYW1lfScgZG9lcyBub3QgZXhpc3Qgb24gb3JpZ2luIOKAlCByZWZ1c2luZyB0byBgICtcbiAgICAgICAgICBgZXZhbHVhdGUgYSBQUiBicmFuY2ggdGhhdCBpcyBvbmx5IGxvY2FsIChJc3N1ZSAjMjExKWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBsb2NhbFNoYSA9IGF3YWl0IHJlYWRTaGEoYHJlZnMvaGVhZHMvJHticmFuY2hOYW1lfWAsIG9wdGlvbnMpO1xuXG4gIC8vIFdoYXQgdGhlIGxvY2FsIGJyYW5jaCBpcywgYmVmb3JlIGFueXRoaW5nIGlzIG1vdmVkLiBUaGUgYWhlYWQtY2hlY2sgaGFzXG4gIC8vIHRvIGhhcHBlbiBoZXJlIOKAlCBiZWZvcmUgdGhlIGJyYW5jaCBpcyB0b3VjaGVkIOKAlCBiZWNhdXNlIGl0IGlzIHRoZSBvbmx5XG4gIC8vIHRoaW5nIHN0YW5kaW5nIGJldHdlZW4gc29tZWJvZHkncyB1bnB1c2hlZCB3b3JrIGFuZCBhIGhhcmQgcmVzZXQuXG4gIGxldCBhbGlnbm1lbnQ6IEJyYW5jaEFsaWdubWVudDtcbiAgaWYgKGxvY2FsU2hhID09PSBudWxsKSB7XG4gICAgYWxpZ25tZW50ID0gXCJjcmVhdGVkLWZyb20tcmVtb3RlXCI7XG4gIH0gZWxzZSBpZiAobG9jYWxTaGEgPT09IHJlbW90ZVNoYSkge1xuICAgIGFsaWdubWVudCA9IFwiYWxyZWFkeS1hdC1yZW1vdGVcIjtcbiAgfSBlbHNlIGlmICghKGF3YWl0IGlzUmVhZGFibGVDb21taXQobG9jYWxTaGEsIG9wdGlvbnMpKSkge1xuICAgIC8vIFRoZSByZWYgcmVzb2x2ZXMgYnV0IG5hbWVzIGFuIG9iamVjdCB0aGlzIGNsb25lIGRvZXMgbm90IGhhdmUg4oCUIHRoZVxuICAgIC8vIGBmYXRhbDogYmFkIG9iamVjdGAgLyBgdW5hYmxlIHRvIHJlYWQgdHJlZWAgc2hhcGUgKElzc3VlICM0MTEpLiBUaGVyZVxuICAgIC8vIGlzIG5vIHJlYWNoYWJsZSB3b3JrIHRvIHByb3RlY3QsIGFuZCB0aGUgcmVmIGNhbm5vdCBiZSByZWFkLCBvbmx5XG4gICAgLy8gcmVwbGFjZWQuIFRoZSByZW1vdGUgaGVhZCBpcyB0aGUgUFIsIHNvIHRha2UgaXQuXG4gICAgYWxpZ25tZW50ID0gXCJyZXNldC10by1yZW1vdGVcIjtcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBhaGVhZFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgICBbXCJyZXYtbGlzdFwiLCBcIi0tY291bnRcIiwgYCR7dHJhY2tpbmdSZWZ9Li5yZWZzL2hlYWRzLyR7YnJhbmNoTmFtZX1gXSxcbiAgICAgIG9wdGlvbnMsXG4gICAgKTtcbiAgICBpZiAoIWFoZWFkUmVzdWx0Lm9rIHx8IGFoZWFkUmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICAgIGNvbnN0IHN0ZGVyciA9IGFoZWFkUmVzdWx0Lm9rID8gYWhlYWRSZXN1bHQudmFsdWUuc3RkZXJyLnRyaW0oKSA6IFwiXCI7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgICAgYENvdWxkIG5vdCBjb21wYXJlICcke2JyYW5jaE5hbWV9JyB3aXRoIGl0cyByZW1vdGUgaGVhZDogYCArXG4gICAgICAgICAgICBgJHtcbiAgICAgICAgICAgICAgc3RkZXJyIHx8IChhaGVhZFJlc3VsdC5va1xuICAgICAgICAgICAgICAgID8gYGV4aXQgJHthaGVhZFJlc3VsdC52YWx1ZS5jb2RlfWBcbiAgICAgICAgICAgICAgICA6IGFoZWFkUmVzdWx0LmVycm9yLm1lc3NhZ2UpXG4gICAgICAgICAgICB9YCxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfVxuICAgIGNvbnN0IGFoZWFkID0gTnVtYmVyLnBhcnNlSW50KGFoZWFkUmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKCksIDEwKTtcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShhaGVhZCkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgICBgQ291bGQgbm90IGNvbXBhcmUgJyR7YnJhbmNoTmFtZX0nIHdpdGggaXRzIHJlbW90ZSBoZWFkOiBnaXQgcHJpbnRlZCBgICtcbiAgICAgICAgICAgIGAnJHthaGVhZFJlc3VsdC52YWx1ZS5zdGRvdXQudHJpbSgpfSdgLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKGFoZWFkID4gMCkge1xuICAgICAgLy8gTmFtZWQgKElzc3VlICMzOTQpIHNvIGNhbGxlcnMgY2FuIHRlbGwgdGhpcyBhcGFydCBmcm9tIGEgUFIgZmF1bHQ6XG4gICAgICAvLyB0aGUgY29tbWl0cyBiZWxvbmcgdG8gYW5vdGhlciBsYW5lIHNoYXJpbmcgdGhpcyBjbG9uZSwgYW5kIHRoZSBQUiBpc1xuICAgICAgLy8gcmV0cmllZCBuZXh0IGN5Y2xlIHJhdGhlciB0aGFuIGNvdW50ZWQgYXMgZmFpbGVkLlxuICAgICAgY29uc3QgZXJyb3IgPSBuZXcgRXJyb3IoXG4gICAgICAgIGBMb2NhbCBicmFuY2ggJyR7YnJhbmNoTmFtZX0nIGhvbGRzICR7YWhlYWR9IGNvbW1pdChzKSB0aGF0IGAgK1xuICAgICAgICAgIGBvcmlnaW4vJHticmFuY2hOYW1lfSBkb2VzIG5vdCDigJQgcmVmdXNpbmcgdG8gZXZhbHVhdGUgb3IgdXBkYXRlIGEgYCArXG4gICAgICAgICAgYFBSIGZyb20gYSBzdGFsZSBsb2NhbCBicmFuY2ggKElzc3VlICMyMTEpLiBQdXNoIG9yIGRpc2NhcmQgdGhlbSBgICtcbiAgICAgICAgICBgZmlyc3QuYCxcbiAgICAgICk7XG4gICAgICBlcnJvci5uYW1lID0gTE9DQUxfQUhFQURfT0ZfUkVNT1RFX0VSUk9SO1xuICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvciB9O1xuICAgIH1cbiAgICBhbGlnbm1lbnQgPSBcInJlc2V0LXRvLXJlbW90ZVwiO1xuICB9XG5cbiAgLy8gT25lIG11dGF0aW5nIGNvbW1hbmQgZm9yIGV2ZXJ5IGNhc2UgKElzc3VlICM0MTEpLiBgY2hlY2tvdXQgLUJgIGNyZWF0ZXNcbiAgLy8gdGhlIGJyYW5jaCB3aGVuIGl0IGlzIGFic2VudCwgcmVzZXRzIGl0IHdoZW4gaXQgaXMgc3RhbGUsIGFuZCBvdmVyd3JpdGVzXG4gIC8vIGl0IHdoZW4gaXQgaXMgY29ycnVwdCDigJQgc28gdGhlIGxvY2FsIHJlZiBpcyBuZXZlciAqcmVhZCogdG8gZ2V0IHRoZXJlLlxuICAvL1xuICAvLyBUaGUgb2xkIHNoYXBlIHJlYWQgdGhlIHJlZiB3aXRoIGByZXYtcGFyc2VgIGFuZCB0aGVuIHJhbiBhIHNlcGFyYXRlXG4gIC8vIGBnaXQgY2hlY2tvdXQgPGJyYW5jaD5gLCB3aGljaCBmYWlsZWQgcGVybWFuZW50bHkgb24gYSByZWYgdGhhdCByZXNvbHZlZFxuICAvLyBidXQgY291bGQgbm90IGJlIGNoZWNrZWQgb3V0LCBhbmQgbGVmdCBhIHdpbmRvdyBpbiB3aGljaCBhbm90aGVyIGxhbmVcbiAgLy8gc2hhcmluZyB0aGUgY2xvbmUgY291bGQgZGVsZXRlIHRoZSBicmFuY2ggYmV0d2VlbiB0aGUgdHdvIGNvbW1hbmRzOlxuICAvL1xuICAvLyAgIEZhaWxlZCB0byBjaGVja291dCBicmFuY2ggJ2lzc3VlLTM4Ny1zaWRlLWRhdGEt4oCmJzogZXJyb3I6IHBhdGhzcGVjXG4gIC8vICAgJ2lzc3VlLTM4Ny1zaWRlLWRhdGEt4oCmJyBkaWQgbm90IG1hdGNoIGFueSBmaWxlKHMpIGtub3duIHRvIGdpdFxuICAvL1xuICAvLyDigJQgd2hpbGUgdGhlIGJyYW5jaCBzYXQgaGVhbHRoeSBvbiBvcmlnaW4gdGhlIHdob2xlIHRpbWUuIFBSICM0MDggZmFpbGVkXG4gIC8vIHRoYXQgd2F5IG9uIHRocmVlIGNvbnNlY3V0aXZlIGN5Y2xlcy5cbiAgbGV0IGFsaWduZWQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIGJ1aWxkQ2hlY2tvdXRSZXNldEJyYW5jaEFyZ3MoYnJhbmNoTmFtZSwgdHJhY2tpbmdSZWYpLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmIChhbGlnbmVkLm9rICYmIGFsaWduZWQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIC8vIElzc3VlICMxNjc3OiB0aGUgYnJhbmNoIGlzIGNoZWNrZWQgb3V0IGluIG9uZSBvZiB0aGlzIGhvc3QncyBvd24gbGFuZVxuICAgIC8vIHdvcmt0cmVlcyDigJQgdHlwaWNhbGx5IHRoZSBpc3N1ZSBsYW5lIHRoYXQgcmFpc2VkIHRoZSBQUiBhbmQgdGhlbiBzYXRcbiAgICAvLyBwYXJrZWQgb24gaXRzIGJyYW5jaC4gRGV0YWNoIHRoYXQgd29ya3RyZWUgYW5kIHRyeSBvbmNlIG1vcmUsIHRoZVxuICAgIC8vIHJlcGFpciBgY3JlYXRlRmVhdHVyZUJyYW5jaEZyb21CYXNlYCBhbHJlYWR5IG1ha2VzIChJc3N1ZSAjMTU2NCkuIEFcbiAgICAvLyBob2xkZXIgdGhhdCBpcyBub3QgYSBsYW5lIHdvcmt0cmVlIG9mIHRoaXMgaG9zdCBpcyBsZWZ0IGFsb25lIGFuZCB0aGVcbiAgICAvLyByZWZ1c2FsIGlzIHJlcG9ydGVkIGJlbG93IGluIGdpdCdzIG93biB3b3Jkcy5cbiAgICBjb25zdCBoZWxkQnkgPSBsYW5lV29ya3RyZWVIb2xkaW5nQnJhbmNoKGFsaWduZWQudmFsdWUuc3RkZXJyKTtcbiAgICBpZiAoaGVsZEJ5ICE9PSB1bmRlZmluZWQgJiYgYXdhaXQgZGV0YWNoTGFuZVdvcmt0cmVlSGVhZChoZWxkQnkpKSB7XG4gICAgICBhbGlnbmVkID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICAgICAgYnVpbGRDaGVja291dFJlc2V0QnJhbmNoQXJncyhicmFuY2hOYW1lLCB0cmFja2luZ1JlZiksXG4gICAgICAgIG9wdGlvbnMsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICBpZiAoIWFsaWduZWQub2sgfHwgYWxpZ25lZC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgY29uc3Qgc3RkZXJyID0gYWxpZ25lZC5vayA/IGFsaWduZWQudmFsdWUuc3RkZXJyLnRyaW0oKSA6IFwiXCI7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBGYWlsZWQgdG8gcG9zaXRpb24gJyR7YnJhbmNoTmFtZX0nIG9uIGl0cyByZW1vdGUgaGVhZDogYCArXG4gICAgICAgICAgYCR7XG4gICAgICAgICAgICBzdGRlcnIgfHxcbiAgICAgICAgICAgIChhbGlnbmVkLm9rID8gYGV4aXQgJHthbGlnbmVkLnZhbHVlLmNvZGV9YCA6IGFsaWduZWQuZXJyb3IubWVzc2FnZSlcbiAgICAgICAgICB9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IGFsaWdubWVudCB9O1xufVxuXG4vKipcbiAqIElzIGBzaGFgIGEgY29tbWl0IHRoaXMgY2xvbmUgY2FuIGFjdHVhbGx5IHJlYWQ/XG4gKlxuICogQSByZWYgY2FuIHJlc29sdmUgd2hpbGUgdGhlIG9iamVjdCBpdCBuYW1lcyBpcyBtaXNzaW5nIOKAlCB0aGUgc2hhcGUgYmVoaW5kXG4gKiBgZmF0YWw6IGJhZCBvYmplY3RgIGFuZCBgdW5hYmxlIHRvIHJlYWQgdHJlZWAuIFN1Y2ggYSBicmFuY2ggaGFzIG5vXG4gKiByZWFjaGFibGUgd29yayBvbiBpdCwgc28gaXQgaXMgc2FmZSB0byBvdmVyd3JpdGU7IGEgcmVhZGFibGUgb25lIG11c3QgZ29cbiAqIHRocm91Z2ggdGhlIGFoZWFkLWNoZWNrIGZpcnN0LlxuICovXG5hc3luYyBmdW5jdGlvbiBpc1JlYWRhYmxlQ29tbWl0KFxuICBzaGE6IHN0cmluZyxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMsXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJjYXQtZmlsZVwiLCBcIi1lXCIsIGAke3NoYX1ee2NvbW1pdH1gXSxcbiAgICBvcHRpb25zLFxuICApO1xuICByZXR1cm4gcmVzdWx0Lm9rICYmIHJlc3VsdC52YWx1ZS5jb2RlID09PSAwO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7O0NBZ0JDLEdBR0QsU0FBUyxhQUFhLFFBQVEsbUJBQW1CO0FBRWpELFNBQ0Usc0JBQXNCLEVBQ3RCLDRCQUE0QixFQUM1Qix5QkFBeUIsUUFDcEIsb0JBQW9CO0FBQzNCLFNBQVMsMkJBQTJCLFFBQVEsdUJBQXVCO0FBQ25FLFNBQ0Usc0JBQXNCLEVBQ3RCLHlCQUF5QixRQUNwQixxQkFBcUI7QUFXNUIsMkRBQTJELEdBQzNELGVBQWUsUUFDYixHQUFXLEVBQ1gsT0FBMEI7RUFFMUIsTUFBTSxTQUFTLE1BQU0sY0FDbkI7SUFBQztJQUFhO0lBQVk7SUFBVztHQUFJLEVBQ3pDO0VBRUYsSUFBSSxDQUFDLE9BQU8sRUFBRSxJQUFJLE9BQU8sS0FBSyxDQUFDLElBQUksS0FBSyxHQUFHLE9BQU87RUFDbEQsT0FBTyxPQUFPLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxNQUFNO0FBQ3ZDO0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FnQkMsR0FDRCxPQUFPLGVBQWUsNkJBQ3BCLFVBQWtCLEVBQ2xCLFVBQTZCLENBQUMsQ0FBQztFQUUvQixJQUFJO0lBQ0YsdUJBQXVCLFlBQVk7RUFDckMsRUFBRSxPQUFPLEtBQUs7SUFDWixPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sZUFBZSxRQUFRLE1BQU0sSUFBSSxNQUFNLE9BQU87SUFDdkQ7RUFDRjtFQUVBLE1BQU0sY0FBYyxDQUFDLG9CQUFvQixFQUFFLFlBQVk7RUFDdkQsTUFBTSxjQUFjLDBCQUEwQixVQUFVLGFBQWE7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
// denoCacheMetadata=15413118447805310296,11137287586193320475