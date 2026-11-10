/**
 * The PR-raise sync point (Issues #2788, #2809).
 *
 * Before a PR is raised, the branch it targets is made current first, then the
 * feature branch catches up with that target — both by merge and plain push,
 * never a rebase or a force-push:
 *
 * 1. A milestone branch is merged up to the default branch
 *    (`presyncMilestoneBranchForIssueRun`), so the feature branch does not
 *    catch up with a stale milestone and go behind again moments later.
 * 2. The feature branch merges `origin/<base>` in ({@link mergeOntoBase}),
 *    through `ensureBranchCurrent`.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */ import { ensureBranchCurrent } from "./branch_currency.ts";
import { assertSafeGitRef } from "./git_ref_args.ts";
/** Run one git command and report whether it exited 0. */ async function gitSucceeds(runGit, args, cwd) {
  const result = await runGit(args, cwd === undefined ? undefined : {
    cwd
  });
  return result.ok && result.value.code === 0;
}
/** Read the working tree: clean, dirty, or unreadable (never assumed clean). */ async function treeState(runGit, cwd) {
  const status = await runGit([
    "status",
    "--porcelain"
  ], cwd === undefined ? undefined : {
    cwd
  });
  if (!status.ok || status.value.code !== 0) return "unreadable";
  return status.value.stdout.trim() === "" ? "clean" : "dirty";
}
/**
 * Merge `baseRef` into `branch` — the `ensureBranchCurrent` seam at PR raise.
 *
 * Only adds commits, so the push that follows is a plain fast-forward. Refuses
 * on a dirty tree (a merge could fold uncommitted work into its commit) and
 * aborts a conflicting merge so the branch is left exactly as it was, for the
 * one agent pass and then the conflict ladder.
 */ export async function mergeOntoBase(options) {
  const { branch, baseRef, runGit, cwd } = options;
  assertSafeGitRef(branch, "PR-raise merge branch");
  assertSafeGitRef(baseRef, "PR-raise merge base");
  const gitOptions = cwd === undefined ? undefined : {
    cwd
  };
  const tree = await treeState(runGit, cwd);
  if (tree === "unreadable") {
    return {
      ok: false,
      error: new Error("git status could not be read")
    };
  }
  if (tree === "dirty") {
    return {
      ok: false,
      error: new Error("the working tree carries uncommitted changes, so the base cannot " + "be merged in without folding them into the merge")
    };
  }
  if (!await gitSucceeds(runGit, [
    "checkout",
    "--end-of-options",
    branch
  ], cwd)) {
    return {
      ok: false,
      error: new Error(`could not check out '${branch}' to merge into it`)
    };
  }
  const merged = await runGit([
    "merge",
    "--no-edit",
    "--end-of-options",
    baseRef
  ], gitOptions);
  if (merged.ok && merged.value.code === 0) {
    return {
      ok: true,
      value: undefined
    };
  }
  // Abort only a merge git actually started, and fail loud when the abort
  // itself fails: a half-merged tree is not "left exactly as it was".
  const merging = await gitSucceeds(runGit, [
    "rev-parse",
    "--verify",
    "--quiet",
    "MERGE_HEAD"
  ], cwd);
  if (merging && !await gitSucceeds(runGit, [
    "merge",
    "--abort"
  ], cwd)) {
    return {
      ok: false,
      error: new Error(`merging '${baseRef}' into '${branch}' failed and 'git merge --abort' ` + `failed too — the working tree needs a human`)
    };
  }
  const why = merged.ok ? (merged.value.stderr || merged.value.stdout).trim().split("\n")[0] : merged.error.message;
  return {
    ok: false,
    error: new Error(`merging '${baseRef}' into '${branch}' failed: ${why}`)
  };
}
/**
 * Sync the milestone branch with the default branch, then the feature branch
 * with its base — in that order (Issue #2809).
 *
 * The milestone sync is never fatal: a deferred or failed sync is logged and
 * the feature branch still catches up with the milestone as it stands. When
 * the feature branch lives in the shared clone itself (no lane), the sync
 * would reset that clone, so a dirty tree skips it, and the feature branch is
 * checked out again afterwards — failing loud if it cannot be.
 */ export async function syncBranchesForPrRaise(options) {
  const { branch, baseBranch, milestoneBranch, runGit, cwd, log, warn } = options;
  let milestone;
  if (milestoneBranch !== undefined) {
    const shared = options.sharedClonePath === cwd;
    // An unreadable shared tree counts as dirty: never reset what we cannot see.
    if (shared && await treeState(runGit, cwd) !== "clean") {
      milestone = {
        status: "skipped",
        detail: `'${milestoneBranch}' was not synced with the default branch ` + `before the PR: the shared clone carries uncommitted work the sync ` + `would reset`
      };
      warn(milestone.detail);
    } else {
      try {
        milestone = await options.syncMilestone();
        const line = `PR-raise milestone sync of '${milestoneBranch}': ` + `${milestone.status} — ${milestone.detail}`;
        if (milestone.status === "deferred") warn(line);
        else log(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        milestone = {
          status: "deferred",
          detail: `the milestone sync threw: ${message}`
        };
        warn(`PR-raise milestone sync of '${milestoneBranch}' failed: ${message}`);
      }
      if (shared && !await gitSucceeds(runGit, [
        "checkout",
        "--end-of-options",
        branch
      ], cwd)) {
        return {
          kind: "refused",
          detail: `could not check out '${branch}' again after syncing ` + `'${milestoneBranch}' in the shared clone`
        };
      }
    }
  }
  const currency = await ensureBranchCurrent({
    branch,
    baseBranch,
    runGit,
    cwd,
    rebase: mergeOntoBase,
    log
  });
  return {
    kind: "ok",
    ...milestone !== undefined ? {
      milestone
    } : {},
    currency
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9wcl9yYWlzZV9zeW5jLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVGhlIFBSLXJhaXNlIHN5bmMgcG9pbnQgKElzc3VlcyAjMjc4OCwgIzI4MDkpLlxuICpcbiAqIEJlZm9yZSBhIFBSIGlzIHJhaXNlZCwgdGhlIGJyYW5jaCBpdCB0YXJnZXRzIGlzIG1hZGUgY3VycmVudCBmaXJzdCwgdGhlbiB0aGVcbiAqIGZlYXR1cmUgYnJhbmNoIGNhdGNoZXMgdXAgd2l0aCB0aGF0IHRhcmdldCDigJQgYm90aCBieSBtZXJnZSBhbmQgcGxhaW4gcHVzaCxcbiAqIG5ldmVyIGEgcmViYXNlIG9yIGEgZm9yY2UtcHVzaDpcbiAqXG4gKiAxLiBBIG1pbGVzdG9uZSBicmFuY2ggaXMgbWVyZ2VkIHVwIHRvIHRoZSBkZWZhdWx0IGJyYW5jaFxuICogICAgKGBwcmVzeW5jTWlsZXN0b25lQnJhbmNoRm9ySXNzdWVSdW5gKSwgc28gdGhlIGZlYXR1cmUgYnJhbmNoIGRvZXMgbm90XG4gKiAgICBjYXRjaCB1cCB3aXRoIGEgc3RhbGUgbWlsZXN0b25lIGFuZCBnbyBiZWhpbmQgYWdhaW4gbW9tZW50cyBsYXRlci5cbiAqIDIuIFRoZSBmZWF0dXJlIGJyYW5jaCBtZXJnZXMgYG9yaWdpbi88YmFzZT5gIGluICh7QGxpbmsgbWVyZ2VPbnRvQmFzZX0pLFxuICogICAgdGhyb3VnaCBgZW5zdXJlQnJhbmNoQ3VycmVudGAuXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQge1xuICB0eXBlIEJyYW5jaEN1cnJlbmN5T3V0Y29tZSxcbiAgZW5zdXJlQnJhbmNoQ3VycmVudCxcbiAgdHlwZSBHaXRSdW5uZXIsXG59IGZyb20gXCIuL2JyYW5jaF9jdXJyZW5jeS50c1wiO1xuaW1wb3J0IHsgYXNzZXJ0U2FmZUdpdFJlZiB9IGZyb20gXCIuL2dpdF9yZWZfYXJncy50c1wiO1xuaW1wb3J0IHR5cGUgeyBNaWxlc3RvbmVQcmVzeW5jUmVzdWx0IH0gZnJvbSBcIi4vbWlsZXN0b25lX3ByZXN5bmMudHNcIjtcblxuLyoqIFJ1biBvbmUgZ2l0IGNvbW1hbmQgYW5kIHJlcG9ydCB3aGV0aGVyIGl0IGV4aXRlZCAwLiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2l0U3VjY2VlZHMoXG4gIHJ1bkdpdDogR2l0UnVubmVyLFxuICBhcmdzOiBzdHJpbmdbXSxcbiAgY3dkPzogc3RyaW5nLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkdpdChhcmdzLCBjd2QgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHsgY3dkIH0pO1xuICByZXR1cm4gcmVzdWx0Lm9rICYmIHJlc3VsdC52YWx1ZS5jb2RlID09PSAwO1xufVxuXG4vKiogUmVhZCB0aGUgd29ya2luZyB0cmVlOiBjbGVhbiwgZGlydHksIG9yIHVucmVhZGFibGUgKG5ldmVyIGFzc3VtZWQgY2xlYW4pLiAqL1xuYXN5bmMgZnVuY3Rpb24gdHJlZVN0YXRlKFxuICBydW5HaXQ6IEdpdFJ1bm5lcixcbiAgY3dkPzogc3RyaW5nLFxuKTogUHJvbWlzZTxcImNsZWFuXCIgfCBcImRpcnR5XCIgfCBcInVucmVhZGFibGVcIj4ge1xuICBjb25zdCBzdGF0dXMgPSBhd2FpdCBydW5HaXQoXG4gICAgW1wic3RhdHVzXCIsIFwiLS1wb3JjZWxhaW5cIl0sXG4gICAgY3dkID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiB7IGN3ZCB9LFxuICApO1xuICBpZiAoIXN0YXR1cy5vayB8fCBzdGF0dXMudmFsdWUuY29kZSAhPT0gMCkgcmV0dXJuIFwidW5yZWFkYWJsZVwiO1xuICByZXR1cm4gc3RhdHVzLnZhbHVlLnN0ZG91dC50cmltKCkgPT09IFwiXCIgPyBcImNsZWFuXCIgOiBcImRpcnR5XCI7XG59XG5cbi8qKlxuICogTWVyZ2UgYGJhc2VSZWZgIGludG8gYGJyYW5jaGAg4oCUIHRoZSBgZW5zdXJlQnJhbmNoQ3VycmVudGAgc2VhbSBhdCBQUiByYWlzZS5cbiAqXG4gKiBPbmx5IGFkZHMgY29tbWl0cywgc28gdGhlIHB1c2ggdGhhdCBmb2xsb3dzIGlzIGEgcGxhaW4gZmFzdC1mb3J3YXJkLiBSZWZ1c2VzXG4gKiBvbiBhIGRpcnR5IHRyZWUgKGEgbWVyZ2UgY291bGQgZm9sZCB1bmNvbW1pdHRlZCB3b3JrIGludG8gaXRzIGNvbW1pdCkgYW5kXG4gKiBhYm9ydHMgYSBjb25mbGljdGluZyBtZXJnZSBzbyB0aGUgYnJhbmNoIGlzIGxlZnQgZXhhY3RseSBhcyBpdCB3YXMsIGZvciB0aGVcbiAqIG9uZSBhZ2VudCBwYXNzIGFuZCB0aGVuIHRoZSBjb25mbGljdCBsYWRkZXIuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtZXJnZU9udG9CYXNlKFxuICBvcHRpb25zOiB7XG4gICAgYnJhbmNoOiBzdHJpbmc7XG4gICAgYmFzZVJlZjogc3RyaW5nO1xuICAgIHJ1bkdpdDogR2l0UnVubmVyO1xuICAgIGN3ZD86IHN0cmluZztcbiAgfSxcbik6IFByb21pc2U8UmVzdWx0PHZvaWQ+PiB7XG4gIGNvbnN0IHsgYnJhbmNoLCBiYXNlUmVmLCBydW5HaXQsIGN3ZCB9ID0gb3B0aW9ucztcbiAgYXNzZXJ0U2FmZUdpdFJlZihicmFuY2gsIFwiUFItcmFpc2UgbWVyZ2UgYnJhbmNoXCIpO1xuICBhc3NlcnRTYWZlR2l0UmVmKGJhc2VSZWYsIFwiUFItcmFpc2UgbWVyZ2UgYmFzZVwiKTtcbiAgY29uc3QgZ2l0T3B0aW9ucyA9IGN3ZCA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogeyBjd2QgfTtcblxuICBjb25zdCB0cmVlID0gYXdhaXQgdHJlZVN0YXRlKHJ1bkdpdCwgY3dkKTtcbiAgaWYgKHRyZWUgPT09IFwidW5yZWFkYWJsZVwiKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogbmV3IEVycm9yKFwiZ2l0IHN0YXR1cyBjb3VsZCBub3QgYmUgcmVhZFwiKSB9O1xuICB9XG4gIGlmICh0cmVlID09PSBcImRpcnR5XCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgXCJ0aGUgd29ya2luZyB0cmVlIGNhcnJpZXMgdW5jb21taXR0ZWQgY2hhbmdlcywgc28gdGhlIGJhc2UgY2Fubm90IFwiICtcbiAgICAgICAgICBcImJlIG1lcmdlZCBpbiB3aXRob3V0IGZvbGRpbmcgdGhlbSBpbnRvIHRoZSBtZXJnZVwiLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKFxuICAgICFhd2FpdCBnaXRTdWNjZWVkcyhydW5HaXQsIFtcImNoZWNrb3V0XCIsIFwiLS1lbmQtb2Ytb3B0aW9uc1wiLCBicmFuY2hdLCBjd2QpXG4gICkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKGBjb3VsZCBub3QgY2hlY2sgb3V0ICcke2JyYW5jaH0nIHRvIG1lcmdlIGludG8gaXRgKSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgbWVyZ2VkID0gYXdhaXQgcnVuR2l0KFxuICAgIFtcIm1lcmdlXCIsIFwiLS1uby1lZGl0XCIsIFwiLS1lbmQtb2Ytb3B0aW9uc1wiLCBiYXNlUmVmXSxcbiAgICBnaXRPcHRpb25zLFxuICApO1xuICBpZiAobWVyZ2VkLm9rICYmIG1lcmdlZC52YWx1ZS5jb2RlID09PSAwKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfVxuXG4gIC8vIEFib3J0IG9ubHkgYSBtZXJnZSBnaXQgYWN0dWFsbHkgc3RhcnRlZCwgYW5kIGZhaWwgbG91ZCB3aGVuIHRoZSBhYm9ydFxuICAvLyBpdHNlbGYgZmFpbHM6IGEgaGFsZi1tZXJnZWQgdHJlZSBpcyBub3QgXCJsZWZ0IGV4YWN0bHkgYXMgaXQgd2FzXCIuXG4gIGNvbnN0IG1lcmdpbmcgPSBhd2FpdCBnaXRTdWNjZWVkcyhcbiAgICBydW5HaXQsXG4gICAgW1wicmV2LXBhcnNlXCIsIFwiLS12ZXJpZnlcIiwgXCItLXF1aWV0XCIsIFwiTUVSR0VfSEVBRFwiXSxcbiAgICBjd2QsXG4gICk7XG4gIGlmIChtZXJnaW5nICYmICFhd2FpdCBnaXRTdWNjZWVkcyhydW5HaXQsIFtcIm1lcmdlXCIsIFwiLS1hYm9ydFwiXSwgY3dkKSkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgbWVyZ2luZyAnJHtiYXNlUmVmfScgaW50byAnJHticmFuY2h9JyBmYWlsZWQgYW5kICdnaXQgbWVyZ2UgLS1hYm9ydCcgYCArXG4gICAgICAgICAgYGZhaWxlZCB0b28g4oCUIHRoZSB3b3JraW5nIHRyZWUgbmVlZHMgYSBodW1hbmAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgY29uc3Qgd2h5ID0gbWVyZ2VkLm9rXG4gICAgPyAobWVyZ2VkLnZhbHVlLnN0ZGVyciB8fCBtZXJnZWQudmFsdWUuc3Rkb3V0KS50cmltKCkuc3BsaXQoXCJcXG5cIilbMF1cbiAgICA6IG1lcmdlZC5lcnJvci5tZXNzYWdlO1xuICByZXR1cm4ge1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjogbmV3IEVycm9yKGBtZXJnaW5nICcke2Jhc2VSZWZ9JyBpbnRvICcke2JyYW5jaH0nIGZhaWxlZDogJHt3aHl9YCksXG4gIH07XG59XG5cbi8qKiBJbmplY3Rpb24gcG9pbnRzIGZvciB7QGxpbmsgc3luY0JyYW5jaGVzRm9yUHJSYWlzZX0uICovXG5leHBvcnQgaW50ZXJmYWNlIFByUmFpc2VTeW5jT3B0aW9ucyB7XG4gIGJyYW5jaDogc3RyaW5nO1xuICAvKiogVGhlIFBSJ3MgYmFzZTogdGhlIG1pbGVzdG9uZSBicmFuY2gsIG9yIHRoZSBkZWZhdWx0IGJyYW5jaC4gKi9cbiAgYmFzZUJyYW5jaDogc3RyaW5nO1xuICAvKiogU2V0IHdoZW4gdGhlIGJhc2UgaXMgYSBtaWxlc3RvbmUgYnJhbmNoIHRoYXQgbXVzdCBiZSBzeW5jZWQgZmlyc3QuICovXG4gIG1pbGVzdG9uZUJyYW5jaD86IHN0cmluZztcbiAgcnVuR2l0OiBHaXRSdW5uZXI7XG4gIC8qKiBUaGUgZmVhdHVyZSBicmFuY2gncyBjaGVja291dC4gKi9cbiAgY3dkOiBzdHJpbmc7XG4gIC8qKiBUaGUgc2hhcmVkIGNsb25lIHRoZSBtaWxlc3RvbmUgc3luYyByZXNldHMgYW5kIGNoZWNrcyBvdXQuICovXG4gIHNoYXJlZENsb25lUGF0aDogc3RyaW5nO1xuICAvKiogTWVyZ2UgdGhlIG1pbGVzdG9uZSBicmFuY2ggdXAgdG8gdGhlIGRlZmF1bHQgYnJhbmNoIGFuZCBwdXNoIGl0LiAqL1xuICBzeW5jTWlsZXN0b25lOiAoKSA9PiBQcm9taXNlPE1pbGVzdG9uZVByZXN5bmNSZXN1bHQ+O1xuICBsb2c6IChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQ7XG4gIHdhcm46IChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQ7XG59XG5cbi8qKiBXaGF0IHRoZSBQUi1yYWlzZSBzeW5jIGRpZC4gKi9cbmV4cG9ydCB0eXBlIFByUmFpc2VTeW5jT3V0Y29tZSA9XG4gIHwge1xuICAgIGtpbmQ6IFwib2tcIjtcbiAgICAvKiogVGhlIG1pbGVzdG9uZSBzeW5jJ3MgdmVyZGljdDsgYWJzZW50IHdoZW4gdGhlcmUgd2FzIG5vbmUgdG8gcnVuLiAqL1xuICAgIG1pbGVzdG9uZT86IE1pbGVzdG9uZVByZXN5bmNSZXN1bHQgfCB7IHN0YXR1czogXCJza2lwcGVkXCI7IGRldGFpbDogc3RyaW5nIH07XG4gICAgY3VycmVuY3k6IEJyYW5jaEN1cnJlbmN5T3V0Y29tZTtcbiAgfVxuICAvKiogVGhlIGZlYXR1cmUgYnJhbmNoIGNvdWxkIG5vdCBiZSBjaGVja2VkIG91dCBhZ2FpbjsgdGhlIFBSIG11c3Qgbm90IGdvLiAqL1xuICB8IHsga2luZDogXCJyZWZ1c2VkXCI7IGRldGFpbDogc3RyaW5nIH07XG5cbi8qKlxuICogU3luYyB0aGUgbWlsZXN0b25lIGJyYW5jaCB3aXRoIHRoZSBkZWZhdWx0IGJyYW5jaCwgdGhlbiB0aGUgZmVhdHVyZSBicmFuY2hcbiAqIHdpdGggaXRzIGJhc2Ug4oCUIGluIHRoYXQgb3JkZXIgKElzc3VlICMyODA5KS5cbiAqXG4gKiBUaGUgbWlsZXN0b25lIHN5bmMgaXMgbmV2ZXIgZmF0YWw6IGEgZGVmZXJyZWQgb3IgZmFpbGVkIHN5bmMgaXMgbG9nZ2VkIGFuZFxuICogdGhlIGZlYXR1cmUgYnJhbmNoIHN0aWxsIGNhdGNoZXMgdXAgd2l0aCB0aGUgbWlsZXN0b25lIGFzIGl0IHN0YW5kcy4gV2hlblxuICogdGhlIGZlYXR1cmUgYnJhbmNoIGxpdmVzIGluIHRoZSBzaGFyZWQgY2xvbmUgaXRzZWxmIChubyBsYW5lKSwgdGhlIHN5bmNcbiAqIHdvdWxkIHJlc2V0IHRoYXQgY2xvbmUsIHNvIGEgZGlydHkgdHJlZSBza2lwcyBpdCwgYW5kIHRoZSBmZWF0dXJlIGJyYW5jaCBpc1xuICogY2hlY2tlZCBvdXQgYWdhaW4gYWZ0ZXJ3YXJkcyDigJQgZmFpbGluZyBsb3VkIGlmIGl0IGNhbm5vdCBiZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN5bmNCcmFuY2hlc0ZvclByUmFpc2UoXG4gIG9wdGlvbnM6IFByUmFpc2VTeW5jT3B0aW9ucyxcbik6IFByb21pc2U8UHJSYWlzZVN5bmNPdXRjb21lPiB7XG4gIGNvbnN0IHsgYnJhbmNoLCBiYXNlQnJhbmNoLCBtaWxlc3RvbmVCcmFuY2gsIHJ1bkdpdCwgY3dkLCBsb2csIHdhcm4gfSA9XG4gICAgb3B0aW9ucztcbiAgbGV0IG1pbGVzdG9uZTpcbiAgICB8IE1pbGVzdG9uZVByZXN5bmNSZXN1bHRcbiAgICB8IHsgc3RhdHVzOiBcInNraXBwZWRcIjsgZGV0YWlsOiBzdHJpbmcgfVxuICAgIHwgdW5kZWZpbmVkO1xuXG4gIGlmIChtaWxlc3RvbmVCcmFuY2ggIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHNoYXJlZCA9IG9wdGlvbnMuc2hhcmVkQ2xvbmVQYXRoID09PSBjd2Q7XG4gICAgLy8gQW4gdW5yZWFkYWJsZSBzaGFyZWQgdHJlZSBjb3VudHMgYXMgZGlydHk6IG5ldmVyIHJlc2V0IHdoYXQgd2UgY2Fubm90IHNlZS5cbiAgICBpZiAoc2hhcmVkICYmIGF3YWl0IHRyZWVTdGF0ZShydW5HaXQsIGN3ZCkgIT09IFwiY2xlYW5cIikge1xuICAgICAgbWlsZXN0b25lID0ge1xuICAgICAgICBzdGF0dXM6IFwic2tpcHBlZFwiLFxuICAgICAgICBkZXRhaWw6IGAnJHttaWxlc3RvbmVCcmFuY2h9JyB3YXMgbm90IHN5bmNlZCB3aXRoIHRoZSBkZWZhdWx0IGJyYW5jaCBgICtcbiAgICAgICAgICBgYmVmb3JlIHRoZSBQUjogdGhlIHNoYXJlZCBjbG9uZSBjYXJyaWVzIHVuY29tbWl0dGVkIHdvcmsgdGhlIHN5bmMgYCArXG4gICAgICAgICAgYHdvdWxkIHJlc2V0YCxcbiAgICAgIH07XG4gICAgICB3YXJuKG1pbGVzdG9uZS5kZXRhaWwpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0cnkge1xuICAgICAgICBtaWxlc3RvbmUgPSBhd2FpdCBvcHRpb25zLnN5bmNNaWxlc3RvbmUoKTtcbiAgICAgICAgY29uc3QgbGluZSA9IGBQUi1yYWlzZSBtaWxlc3RvbmUgc3luYyBvZiAnJHttaWxlc3RvbmVCcmFuY2h9JzogYCArXG4gICAgICAgICAgYCR7bWlsZXN0b25lLnN0YXR1c30g4oCUICR7bWlsZXN0b25lLmRldGFpbH1gO1xuICAgICAgICBpZiAobWlsZXN0b25lLnN0YXR1cyA9PT0gXCJkZWZlcnJlZFwiKSB3YXJuKGxpbmUpO1xuICAgICAgICBlbHNlIGxvZyhsaW5lKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gICAgICAgIG1pbGVzdG9uZSA9IHtcbiAgICAgICAgICBzdGF0dXM6IFwiZGVmZXJyZWRcIixcbiAgICAgICAgICBkZXRhaWw6IGB0aGUgbWlsZXN0b25lIHN5bmMgdGhyZXc6ICR7bWVzc2FnZX1gLFxuICAgICAgICB9O1xuICAgICAgICB3YXJuKFxuICAgICAgICAgIGBQUi1yYWlzZSBtaWxlc3RvbmUgc3luYyBvZiAnJHttaWxlc3RvbmVCcmFuY2h9JyBmYWlsZWQ6ICR7bWVzc2FnZX1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKFxuICAgICAgICBzaGFyZWQgJiZcbiAgICAgICAgIWF3YWl0IGdpdFN1Y2NlZWRzKFxuICAgICAgICAgIHJ1bkdpdCxcbiAgICAgICAgICBbXCJjaGVja291dFwiLCBcIi0tZW5kLW9mLW9wdGlvbnNcIiwgYnJhbmNoXSxcbiAgICAgICAgICBjd2QsXG4gICAgICAgIClcbiAgICAgICkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGtpbmQ6IFwicmVmdXNlZFwiLFxuICAgICAgICAgIGRldGFpbDogYGNvdWxkIG5vdCBjaGVjayBvdXQgJyR7YnJhbmNofScgYWdhaW4gYWZ0ZXIgc3luY2luZyBgICtcbiAgICAgICAgICAgIGAnJHttaWxlc3RvbmVCcmFuY2h9JyBpbiB0aGUgc2hhcmVkIGNsb25lYCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBjb25zdCBjdXJyZW5jeSA9IGF3YWl0IGVuc3VyZUJyYW5jaEN1cnJlbnQoe1xuICAgIGJyYW5jaCxcbiAgICBiYXNlQnJhbmNoLFxuICAgIHJ1bkdpdCxcbiAgICBjd2QsXG4gICAgcmViYXNlOiBtZXJnZU9udG9CYXNlLFxuICAgIGxvZyxcbiAgfSk7XG4gIHJldHVybiB7XG4gICAga2luZDogXCJva1wiLFxuICAgIC4uLihtaWxlc3RvbmUgIT09IHVuZGVmaW5lZCA/IHsg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
// denoCacheMetadata=6689521806945074876,3936534880219517324