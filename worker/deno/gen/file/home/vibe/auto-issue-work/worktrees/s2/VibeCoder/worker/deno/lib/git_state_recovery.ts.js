/**
 * Git state recovery after failures (Issue #467, #912).
 *
 * Detects and recovers from broken git states left by previous crashed runs:
 *   1. In-progress cherry-pick (CHERRY_PICK_HEAD exists)
 *   2. In-progress merge (MERGE_HEAD exists)
 *   3. In-progress rebase (rebase-merge/ or rebase-apply/ directory exists)
 *   4. Detached HEAD (git rev-parse --abbrev-ref HEAD returns "HEAD")
 *
 * Migrated from worker/shared/git_operations.sh (recover_git_state).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { runGitCommand } from "./git_timeout.ts";
import { emitSelfHealEventAuto } from "./self_heal_events.ts";
import { assertSafeRefComponent, buildCheckoutArgs } from "./git_ref_args.ts";
/**
 * Recover from broken git states left by previous crashed runs (Issue #467).
 *
 * All recovery actions are logged with the SELF-HEALING prefix for debugging.
 * This function should be called before git reset --hard in setup_repo().
 *
 * @param defaultBranch - The default branch to check out if HEAD is detached
 * @param options - Git command options (cwd, etc.)
 * @returns Result with details about recovery actions taken
 */ export async function recoverGitState(defaultBranch, options = {}) {
  // The caller's default branch was once repo-derived (setupRepo read it
  // from `.vibe_default_branch` inside the clone, Issue #1269; it now lives
  // in `.git/vibe/default_branch`, Issue #1652), so a dash-leading name would
  // reach the detached-HEAD `git checkout` as an option slot. Refuse it
  // loudly before any git command runs — defence in depth, whatever the
  // cache's provenance.
  try {
    assertSafeRefComponent(defaultBranch, "recovery default branch");
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
  const actions = [];
  // Get the git directory path
  const gitDirResult = await runGitCommand([
    "rev-parse",
    "--git-dir"
  ], options);
  if (!gitDirResult.ok || gitDirResult.value.code !== 0) {
    return {
      ok: true,
      value: {
        actions: [],
        recovered: true
      }
    };
  }
  const gitDir = gitDirResult.value.stdout.trim();
  const cwd = options.cwd ?? Deno.cwd();
  const resolvedGitDir = gitDir.startsWith("/") ? gitDir : `${cwd}/${gitDir}`;
  // 1. Abort in-progress cherry-pick (Issue #467)
  try {
    const stat = await Deno.stat(`${resolvedGitDir}/CHERRY_PICK_HEAD`);
    if (stat.isFile) {
      actions.push("SELF-HEALING: Detected in-progress cherry-pick — aborting (Issue #467)");
      await runGitCommand([
        "cherry-pick",
        "--abort"
      ], options);
      await emitSelfHealEventAuto({
        module: "git_state_recovery",
        action: "abort_cherry_pick",
        reason: "in-progress cherry-pick detected",
        result: "ok"
      });
    }
  } catch  {
  // File doesn't exist — no cherry-pick in progress
  }
  // 2. Abort in-progress merge (Issue #467)
  try {
    const stat = await Deno.stat(`${resolvedGitDir}/MERGE_HEAD`);
    if (stat.isFile) {
      actions.push("SELF-HEALING: Detected in-progress merge — aborting (Issue #467)");
      await runGitCommand([
        "merge",
        "--abort"
      ], options);
      await emitSelfHealEventAuto({
        module: "git_state_recovery",
        action: "abort_merge",
        reason: "in-progress merge detected",
        result: "ok"
      });
    }
  } catch  {
  // File doesn't exist — no merge in progress
  }
  // 3. Abort in-progress rebase (Issue #467)
  let rebaseDetected = false;
  try {
    const stat = await Deno.stat(`${resolvedGitDir}/rebase-merge`);
    if (stat.isDirectory) rebaseDetected = true;
  } catch  {
  // Directory doesn't exist
  }
  if (!rebaseDetected) {
    try {
      const stat = await Deno.stat(`${resolvedGitDir}/rebase-apply`);
      if (stat.isDirectory) rebaseDetected = true;
    } catch  {
    // Directory doesn't exist
    }
  }
  if (rebaseDetected) {
    actions.push("SELF-HEALING: Detected in-progress rebase — aborting (Issue #467)");
    await runGitCommand([
      "rebase",
      "--abort"
    ], options);
    await emitSelfHealEventAuto({
      module: "git_state_recovery",
      action: "abort_rebase",
      reason: "in-progress rebase detected",
      result: "ok"
    });
  }
  // 4. Recover from detached HEAD (Issue #467)
  const headRefResult = await runGitCommand([
    "rev-parse",
    "--abbrev-ref",
    "HEAD"
  ], options);
  if (headRefResult.ok && headRefResult.value.code === 0) {
    const headRef = headRefResult.value.stdout.trim();
    if (headRef === "HEAD") {
      actions.push(`SELF-HEALING: Detached HEAD detected — checking out '${defaultBranch}' (Issue #467)`);
      await runGitCommand(buildCheckoutArgs(defaultBranch), options);
      await emitSelfHealEventAuto({
        module: "git_state_recovery",
        action: "detached_head_checkout",
        reason: `checked out ${defaultBranch}`,
        result: "ok"
      });
    }
  }
  return {
    ok: true,
    value: {
      actions,
      recovered: true
    }
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfc3RhdGVfcmVjb3ZlcnkudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBHaXQgc3RhdGUgcmVjb3ZlcnkgYWZ0ZXIgZmFpbHVyZXMgKElzc3VlICM0NjcsICM5MTIpLlxuICpcbiAqIERldGVjdHMgYW5kIHJlY292ZXJzIGZyb20gYnJva2VuIGdpdCBzdGF0ZXMgbGVmdCBieSBwcmV2aW91cyBjcmFzaGVkIHJ1bnM6XG4gKiAgIDEuIEluLXByb2dyZXNzIGNoZXJyeS1waWNrIChDSEVSUllfUElDS19IRUFEIGV4aXN0cylcbiAqICAgMi4gSW4tcHJvZ3Jlc3MgbWVyZ2UgKE1FUkdFX0hFQUQgZXhpc3RzKVxuICogICAzLiBJbi1wcm9ncmVzcyByZWJhc2UgKHJlYmFzZS1tZXJnZS8gb3IgcmViYXNlLWFwcGx5LyBkaXJlY3RvcnkgZXhpc3RzKVxuICogICA0LiBEZXRhY2hlZCBIRUFEIChnaXQgcmV2LXBhcnNlIC0tYWJicmV2LXJlZiBIRUFEIHJldHVybnMgXCJIRUFEXCIpXG4gKlxuICogTWlncmF0ZWQgZnJvbSB3b3JrZXIvc2hhcmVkL2dpdF9vcGVyYXRpb25zLnNoIChyZWNvdmVyX2dpdF9zdGF0ZSkuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7IHJ1bkdpdENvbW1hbmQgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuaW1wb3J0IHR5cGUgeyBHaXRDb21tYW5kT3B0aW9ucyB9IGZyb20gXCIuL2dpdF90aW1lb3V0LnRzXCI7XG5pbXBvcnQgeyBlbWl0U2VsZkhlYWxFdmVudEF1dG8gfSBmcm9tIFwiLi9zZWxmX2hlYWxfZXZlbnRzLnRzXCI7XG5pbXBvcnQgeyBhc3NlcnRTYWZlUmVmQ29tcG9uZW50LCBidWlsZENoZWNrb3V0QXJncyB9IGZyb20gXCIuL2dpdF9yZWZfYXJncy50c1wiO1xuXG4vKiogRGV0YWlscyBhYm91dCB3aGF0IHdhcyByZWNvdmVyZWQuICovXG5leHBvcnQgaW50ZXJmYWNlIFJlY292ZXJ5RGV0YWlscyB7XG4gIC8qKiBBY3Rpb25zIHRha2VuIGR1cmluZyByZWNvdmVyeS4gKi9cbiAgYWN0aW9uczogc3RyaW5nW107XG4gIC8qKiBXaGV0aGVyIHRoZSByZWNvdmVyeSB3YXMgc3VjY2Vzc2Z1bC4gKi9cbiAgcmVjb3ZlcmVkOiBib29sZWFuO1xufVxuXG4vKipcbiAqIFJlY292ZXIgZnJvbSBicm9rZW4gZ2l0IHN0YXRlcyBsZWZ0IGJ5IHByZXZpb3VzIGNyYXNoZWQgcnVucyAoSXNzdWUgIzQ2NykuXG4gKlxuICogQWxsIHJlY292ZXJ5IGFjdGlvbnMgYXJlIGxvZ2dlZCB3aXRoIHRoZSBTRUxGLUhFQUxJTkcgcHJlZml4IGZvciBkZWJ1Z2dpbmcuXG4gKiBUaGlzIGZ1bmN0aW9uIHNob3VsZCBiZSBjYWxsZWQgYmVmb3JlIGdpdCByZXNldCAtLWhhcmQgaW4gc2V0dXBfcmVwbygpLlxuICpcbiAqIEBwYXJhbSBkZWZhdWx0QnJhbmNoIC0gVGhlIGRlZmF1bHQgYnJhbmNoIHRvIGNoZWNrIG91dCBpZiBIRUFEIGlzIGRldGFjaGVkXG4gKiBAcGFyYW0gb3B0aW9ucyAtIEdpdCBjb21tYW5kIG9wdGlvbnMgKGN3ZCwgZXRjLilcbiAqIEByZXR1cm5zIFJlc3VsdCB3aXRoIGRldGFpbHMgYWJvdXQgcmVjb3ZlcnkgYWN0aW9ucyB0YWtlblxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVjb3ZlckdpdFN0YXRlKFxuICBkZWZhdWx0QnJhbmNoOiBzdHJpbmcsXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPFJlc3VsdDxSZWNvdmVyeURldGFpbHM+PiB7XG4gIC8vIFRoZSBjYWxsZXIncyBkZWZhdWx0IGJyYW5jaCB3YXMgb25jZSByZXBvLWRlcml2ZWQgKHNldHVwUmVwbyByZWFkIGl0XG4gIC8vIGZyb20gYC52aWJlX2RlZmF1bHRfYnJhbmNoYCBpbnNpZGUgdGhlIGNsb25lLCBJc3N1ZSAjMTI2OTsgaXQgbm93IGxpdmVzXG4gIC8vIGluIGAuZ2l0L3ZpYmUvZGVmYXVsdF9icmFuY2hgLCBJc3N1ZSAjMTY1MiksIHNvIGEgZGFzaC1sZWFkaW5nIG5hbWUgd291bGRcbiAgLy8gcmVhY2ggdGhlIGRldGFjaGVkLUhFQUQgYGdpdCBjaGVja291dGAgYXMgYW4gb3B0aW9uIHNsb3QuIFJlZnVzZSBpdFxuICAvLyBsb3VkbHkgYmVmb3JlIGFueSBnaXQgY29tbWFuZCBydW5zIOKAlCBkZWZlbmNlIGluIGRlcHRoLCB3aGF0ZXZlciB0aGVcbiAgLy8gY2FjaGUncyBwcm92ZW5hbmNlLlxuICB0cnkge1xuICAgIGFzc2VydFNhZmVSZWZDb21wb25lbnQoZGVmYXVsdEJyYW5jaCwgXCJyZWNvdmVyeSBkZWZhdWx0IGJyYW5jaFwiKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgYWN0aW9uczogc3RyaW5nW10gPSBbXTtcblxuICAvLyBHZXQgdGhlIGdpdCBkaXJlY3RvcnkgcGF0aFxuICBjb25zdCBnaXREaXJSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcInJldi1wYXJzZVwiLCBcIi0tZ2l0LWRpclwiXSxcbiAgICBvcHRpb25zLFxuICApO1xuXG4gIGlmICghZ2l0RGlyUmVzdWx0Lm9rIHx8IGdpdERpclJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IGFjdGlvbnM6IFtdLCByZWNvdmVyZWQ6IHRydWUgfSB9O1xuICB9XG5cbiAgY29uc3QgZ2l0RGlyID0gZ2l0RGlyUmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKCk7XG4gIGNvbnN0IGN3ZCA9IG9wdGlvbnMuY3dkID8/IERlbm8uY3dkKCk7XG4gIGNvbnN0IHJlc29sdmVkR2l0RGlyID0gZ2l0RGlyLnN0YXJ0c1dpdGgoXCIvXCIpID8gZ2l0RGlyIDogYCR7Y3dkfS8ke2dpdERpcn1gO1xuXG4gIC8vIDEuIEFib3J0IGluLXByb2dyZXNzIGNoZXJyeS1waWNrIChJc3N1ZSAjNDY3KVxuICB0cnkge1xuICAgIGNvbnN0IHN0YXQgPSBhd2FpdCBEZW5vLnN0YXQoYCR7cmVzb2x2ZWRHaXREaXJ9L0NIRVJSWV9QSUNLX0hFQURgKTtcbiAgICBpZiAoc3RhdC5pc0ZpbGUpIHtcbiAgICAgIGFjdGlvbnMucHVzaChcbiAgICAgICAgXCJTRUxGLUhFQUxJTkc6IERldGVjdGVkIGluLXByb2dyZXNzIGNoZXJyeS1waWNrIOKAlCBhYm9ydGluZyAoSXNzdWUgIzQ2NylcIixcbiAgICAgICk7XG4gICAgICBhd2FpdCBydW5HaXRDb21tYW5kKFtcImNoZXJyeS1waWNrXCIsIFwiLS1hYm9ydFwiXSwgb3B0aW9ucyk7XG4gICAgICBhd2FpdCBlbWl0U2VsZkhlYWxFdmVudEF1dG8oe1xuICAgICAgICBtb2R1bGU6IFwiZ2l0X3N0YXRlX3JlY292ZXJ5XCIsXG4gICAgICAgIGFjdGlvbjogXCJhYm9ydF9jaGVycnlfcGlja1wiLFxuICAgICAgICByZWFzb246IFwiaW4tcHJvZ3Jlc3MgY2hlcnJ5LXBpY2sgZGV0ZWN0ZWRcIixcbiAgICAgICAgcmVzdWx0OiBcIm9rXCIsXG4gICAgICB9KTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIEZpbGUgZG9lc24ndCBleGlzdCDigJQgbm8gY2hlcnJ5LXBpY2sgaW4gcHJvZ3Jlc3NcbiAgfVxuXG4gIC8vIDIuIEFib3J0IGluLXByb2dyZXNzIG1lcmdlIChJc3N1ZSAjNDY3KVxuICB0cnkge1xuICAgIGNvbnN0IHN0YXQgPSBhd2FpdCBEZW5vLnN0YXQoYCR7cmVzb2x2ZWRHaXREaXJ9L01FUkdFX0hFQURgKTtcbiAgICBpZiAoc3RhdC5pc0ZpbGUpIHtcbiAgICAgIGFjdGlvbnMucHVzaChcbiAgICAgICAgXCJTRUxGLUhFQUxJTkc6IERldGVjdGVkIGluLXByb2dyZXNzIG1lcmdlIOKAlCBhYm9ydGluZyAoSXNzdWUgIzQ2NylcIixcbiAgICAgICk7XG4gICAgICBhd2FpdCBydW5HaXRDb21tYW5kKFtcIm1lcmdlXCIsIFwiLS1hYm9ydFwiXSwgb3B0aW9ucyk7XG4gICAgICBhd2FpdCBlbWl0U2VsZkhlYWxFdmVudEF1dG8oe1xuICAgICAgICBtb2R1bGU6IFwiZ2l0X3N0YXRlX3JlY292ZXJ5XCIsXG4gICAgICAgIGFjdGlvbjogXCJhYm9ydF9tZXJnZVwiLFxuICAgICAgICByZWFzb246IFwiaW4tcHJvZ3Jlc3MgbWVyZ2UgZGV0ZWN0ZWRcIixcbiAgICAgICAgcmVzdWx0OiBcIm9rXCIsXG4gICAgICB9KTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIEZpbGUgZG9lc24ndCBleGlzdCDigJQgbm8gbWVyZ2UgaW4gcHJvZ3Jlc3NcbiAgfVxuXG4gIC8vIDMuIEFib3J0IGluLXByb2dyZXNzIHJlYmFzZSAoSXNzdWUgIzQ2NylcbiAgbGV0IHJlYmFzZURldGVjdGVkID0gZmFsc2U7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdCA9IGF3YWl0IERlbm8uc3RhdChgJHtyZXNvbHZlZEdpdERpcn0vcmViYXNlLW1lcmdlYCk7XG4gICAgaWYgKHN0YXQuaXNEaXJlY3RvcnkpIHJlYmFzZURldGVjdGVkID0gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gRGlyZWN0b3J5IGRvZXNuJ3QgZXhpc3RcbiAgfVxuICBpZiAoIXJlYmFzZURldGVjdGVkKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHN0YXQgPSBhd2FpdCBEZW5vLnN0YXQoYCR7cmVzb2x2ZWRHaXREaXJ9L3JlYmFzZS1hcHBseWApO1xuICAgICAgaWYgKHN0YXQuaXNEaXJlY3RvcnkpIHJlYmFzZURldGVjdGVkID0gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIERpcmVjdG9yeSBkb2Vzbid0IGV4aXN0XG4gICAgfVxuICB9XG4gIGlmIChyZWJhc2VEZXRlY3RlZCkge1xuICAgIGFjdGlvbnMucHVzaChcbiAgICAgIFwiU0VMRi1IRUFMSU5HOiBEZXRlY3RlZCBpbi1wcm9ncmVzcyByZWJhc2Ug4oCUIGFib3J0aW5nIChJc3N1ZSAjNDY3KVwiLFxuICAgICk7XG4gICAgYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJyZWJhc2VcIiwgXCItLWFib3J0XCJdLCBvcHRpb25zKTtcbiAgICBhd2FpdCBlbWl0U2VsZkhlYWxFdmVudEF1dG8oe1xuICAgICAgbW9kdWxlOiBcImdpdF9zdGF0ZV9yZWNvdmVyeVwiLFxuICAgICAgYWN0aW9uOiBcImFib3J0X3JlYmFzZVwiLFxuICAgICAgcmVhc29uOiBcImluLXByb2dyZXNzIHJlYmFzZSBkZXRlY3RlZFwiLFxuICAgICAgcmVzdWx0OiBcIm9rXCIsXG4gICAgfSk7XG4gIH1cblxuICAvLyA0LiBSZWNvdmVyIGZyb20gZGV0YWNoZWQgSEVBRCAoSXNzdWUgIzQ2NylcbiAgY29uc3QgaGVhZFJlZlJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wicmV2LXBhcnNlXCIsIFwiLS1hYmJyZXYtcmVmXCIsIFwiSEVBRFwiXSxcbiAgICBvcHRpb25zLFxuICApO1xuXG4gIGlmIChoZWFkUmVmUmVzdWx0Lm9rICYmIGhlYWRSZWZSZXN1bHQudmFsdWUuY29kZSA9PT0gMCkge1xuICAgIGNvbnN0IGhlYWRSZWYgPSBoZWFkUmVmUmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKCk7XG4gICAgaWYgKGhlYWRSZWYgPT09IFwiSEVBRFwiKSB7XG4gICAgICBhY3Rpb25zLnB1c2goXG4gICAgICAgIGBTRUxGLUhFQUxJTkc6IERldGFjaGVkIEhFQUQgZGV0ZWN0ZWQg4oCUIGNoZWNraW5nIG91dCAnJHtkZWZhdWx0QnJhbmNofScgKElzc3VlICM0NjcpYCxcbiAgICAgICk7XG4gICAgICBhd2FpdCBydW5HaXRDb21tYW5kKGJ1aWxkQ2hlY2tvdXRBcmdzKGRlZmF1bHRCcmFuY2gpLCBvcHRpb25zKTtcbiAgICAgIGF3YWl0IGVtaXRTZWxmSGVhbEV2ZW50QXV0byh7XG4gICAgICAgIG1vZHVsZTogXCJnaXRfc3RhdGVfcmVjb3ZlcnlcIixcbiAgICAgICAgYWN0aW9uOiBcImRldGFjaGVkX2hlYWRfY2hlY2tvdXRcIixcbiAgICAgICAgcmVhc29uOiBgY2hlY2tlZCBvdXQgJHtkZWZhdWx0QnJhbmNofWAsXG4gICAgICAgIHJlc3VsdDogXCJva1wiLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBvazogdHJ1ZSxcbiAgICB2YWx1ZTogeyBhY3Rpb25zLCByZWNvdmVyZWQ6IHRydWUgfSxcbiAgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7O0NBWUMsR0FHRCxTQUFTLGFBQWEsUUFBUSxtQkFBbUI7QUFFakQsU0FBUyxxQkFBcUIsUUFBUSx3QkFBd0I7QUFDOUQsU0FBUyxzQkFBc0IsRUFBRSxpQkFBaUIsUUFBUSxvQkFBb0I7QUFVOUU7Ozs7Ozs7OztDQVNDLEdBQ0QsT0FBTyxlQUFlLGdCQUNwQixhQUFxQixFQUNyQixVQUE2QixDQUFDLENBQUM7RUFFL0IsdUVBQXVFO0VBQ3ZFLDBFQUEwRTtFQUMxRSw0RUFBNEU7RUFDNUUsc0VBQXNFO0VBQ3RFLHNFQUFzRTtFQUN0RSxzQkFBc0I7RUFDdEIsSUFBSTtJQUNGLHVCQUF1QixlQUFlO0VBQ3hDLEVBQUUsT0FBTyxPQUFPO0lBQ2QsT0FBTztNQUNMLElBQUk7TUFDSixPQUFPLGlCQUFpQixRQUFRLFFBQVEsSUFBSSxNQUFNLE9BQU87SUFDM0Q7RUFDRjtFQUVBLE1BQU0sVUFBb0IsRUFBRTtFQUU1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
// denoCacheMetadata=1672187487500279654,4694279440465432975