/**
 * Repository state validation (Issue #621, #912).
 *
 * Validates the repository is in a safe state before invoking Claude.
 * Catches issues like uncommitted changes, detached HEAD, or diverged
 * branches early — avoiding 15+ minutes of wasted compute time.
 *
 * Migrated from worker/shared/git_operations.sh (validate_repo_state).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { runGitCommand } from "./git_timeout.ts";
import { cleanWorkingTree } from "./ignored_path_clean.ts";
/**
 * Pre-Claude repository state validation (Issue #621).
 *
 * @param featureBranch - The expected feature branch name
 * @param baseBranch - The target base branch
 * @param attemptRecovery - Whether to attempt automatic recovery
 * @param options - Git command options
 * @returns Result with validation details
 */ export async function validateRepoState(featureBranch, baseBranch, attemptRecovery = false, options = {}) {
  const actions = [];
  const warnings = [];
  // 1. Check for uncommitted changes
  const statusResult = await runGitCommand([
    "status",
    "--porcelain"
  ], options);
  if (!statusResult.ok || statusResult.value.code !== 0) {
    return {
      ok: true,
      value: {
        valid: false,
        actions,
        warnings,
        errorCode: 1
      }
    };
  }
  const porcelainStatus = statusResult.value.stdout.trim();
  if (porcelainStatus) {
    if (attemptRecovery) {
      actions.push("SELF-HEALING: Resetting uncommitted changes to restore clean state (Issue #621)");
      await runGitCommand([
        "reset",
        "--hard",
        "HEAD"
      ], options);
      // Ignored executable paths go with it (Issue #1443); a clean that
      // could not reach them is a warning on the validation result, never a
      // silent pass.
      const cleaned = await cleanWorkingTree(options);
      if (!cleaned.ok) warnings.push(cleaned.error.message);
      // Re-check
      const recheckResult = await runGitCommand([
        "status",
        "--porcelain"
      ], options);
      if (recheckResult.ok && recheckResult.value.stdout.trim()) {
        return {
          ok: true,
          value: {
            valid: false,
            actions,
            warnings,
            errorCode: 1
          }
        };
      }
      actions.push("SELF-HEALING: Uncommitted changes cleared successfully (Issue #621)");
    } else {
      return {
        ok: true,
        value: {
          valid: false,
          actions,
          warnings,
          errorCode: 1
        }
      };
    }
  }
  // 2. Verify current branch is the feature branch
  const headResult = await runGitCommand([
    "rev-parse",
    "--abbrev-ref",
    "HEAD"
  ], options);
  let currentBranch = headResult.ok ? headResult.value.stdout.trim() : "";
  if (currentBranch === "HEAD") {
    if (attemptRecovery) {
      actions.push(`SELF-HEALING: Recovering from detached HEAD — checking out '${featureBranch}' (Issue #621)`);
      const checkoutResult = await runGitCommand([
        "checkout",
        featureBranch
      ], options);
      if (!checkoutResult.ok || checkoutResult.value.code !== 0) {
        return {
          ok: true,
          value: {
            valid: false,
            actions,
            warnings,
            errorCode: 2
          }
        };
      }
      const newHead = await runGitCommand([
        "rev-parse",
        "--abbrev-ref",
        "HEAD"
      ], options);
      currentBranch = newHead.ok ? newHead.value.stdout.trim() : "";
    } else {
      return {
        ok: true,
        value: {
          valid: false,
          actions,
          warnings,
          errorCode: 2
        }
      };
    }
  }
  if (currentBranch !== featureBranch) {
    if (attemptRecovery) {
      actions.push(`SELF-HEALING: Checking out expected feature branch '${featureBranch}' (Issue #621)`);
      const checkoutResult = await runGitCommand([
        "checkout",
        featureBranch
      ], options);
      if (!checkoutResult.ok || checkoutResult.value.code !== 0) {
        return {
          ok: true,
          value: {
            valid: false,
            actions,
            warnings,
            errorCode: 2
          }
        };
      }
    } else {
      return {
        ok: true,
        value: {
          valid: false,
          actions,
          warnings,
          errorCode: 2
        }
      };
    }
  }
  // 3. Check divergence from base branch (warning only)
  const behindBaseResult = await runGitCommand([
    "rev-list",
    "--count",
    `HEAD..${baseBranch}`
  ], options);
  const behindBaseCount = behindBaseResult.ok && behindBaseResult.value.code === 0 ? parseInt(behindBaseResult.value.stdout.trim(), 10) || 0 : 0;
  if (behindBaseCount > 0) {
    warnings.push(`Feature branch '${featureBranch}' is ${behindBaseCount} commit(s) behind '${baseBranch}'`);
    if (behindBaseCount > 50) {
      warnings.push(`Significant divergence from '${baseBranch}' (${behindBaseCount} commits behind)`);
    }
  }
  // 4. Check remote tracking branch
  await runGitCommand([
    "fetch",
    "origin",
    featureBranch
  ], options);
  const showRefResult = await runGitCommand([
    "show-ref",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${featureBranch}`
  ], options);
  if (showRefResult.ok && showRefResult.value.code === 0) {
    const localShaResult = await runGitCommand([
      "rev-parse",
      "HEAD"
    ], options);
    const remoteShaResult = await runGitCommand([
      "rev-parse",
      `origin/${featureBranch}`
    ], options);
    const localSha = localShaResult.ok ? localShaResult.value.stdout.trim() : "";
    const remoteSha = remoteShaResult.ok ? remoteShaResult.value.stdout.trim() : "";
    if (localSha && remoteSha && localSha !== remoteSha) {
      const behindResult = await runGitCommand([
        "rev-list",
        "--count",
        `HEAD..origin/${featureBranch}`
      ], options);
      const behindCount = behindResult.ok && behindResult.value.code === 0 ? parseInt(behindResult.value.stdout.trim(), 10) || 0 : 0;
      if (behindCount > 0) {
        if (attemptRecovery) {
          actions.push("SELF-HEALING: Pulling remote changes to resolve upstream divergence (Issue #621)");
          const pullResult = await runGitCommand([
            "pull",
            "--rebase",
            "origin",
            featureBranch
          ], options);
          if (!pullResult.ok || pullResult.value.code !== 0) {
            await runGitCommand([
              "rebase",
              "--abort"
            ], options);
            actions.push("SELF-HEALING: Resetting to remote version to resolve divergence (Issue #621)");
            await runGitCommand([
              "reset",
              "--hard",
              `origin/${featureBranch}`
            ], options);
          }
        } else {
          return {
            ok: true,
            value: {
              valid: false,
              actions,
              warnings,
              errorCode: 4
            }
          };
        }
      }
    }
  }
  return {
    ok: true,
    value: {
      valid: true,
      actions,
      warnings
    }
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfcmVwb192YWxpZGF0aW9uLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUmVwb3NpdG9yeSBzdGF0ZSB2YWxpZGF0aW9uIChJc3N1ZSAjNjIxLCAjOTEyKS5cbiAqXG4gKiBWYWxpZGF0ZXMgdGhlIHJlcG9zaXRvcnkgaXMgaW4gYSBzYWZlIHN0YXRlIGJlZm9yZSBpbnZva2luZyBDbGF1ZGUuXG4gKiBDYXRjaGVzIGlzc3VlcyBsaWtlIHVuY29tbWl0dGVkIGNoYW5nZXMsIGRldGFjaGVkIEhFQUQsIG9yIGRpdmVyZ2VkXG4gKiBicmFuY2hlcyBlYXJseSDigJQgYXZvaWRpbmcgMTUrIG1pbnV0ZXMgb2Ygd2FzdGVkIGNvbXB1dGUgdGltZS5cbiAqXG4gKiBNaWdyYXRlZCBmcm9tIHdvcmtlci9zaGFyZWQvZ2l0X29wZXJhdGlvbnMuc2ggKHZhbGlkYXRlX3JlcG9fc3RhdGUpLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyBydW5HaXRDb21tYW5kIH0gZnJvbSBcIi4vZ2l0X3RpbWVvdXQudHNcIjtcbmltcG9ydCB7IGNsZWFuV29ya2luZ1RyZWUgfSBmcm9tIFwiLi9pZ25vcmVkX3BhdGhfY2xlYW4udHNcIjtcbmltcG9ydCB0eXBlIHsgR2l0Q29tbWFuZE9wdGlvbnMgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuXG4vKipcbiAqIFZhbGlkYXRpb24gZXJyb3IgY29kZXMuXG4gKiAgIDAgLSBSZXBvc2l0b3J5IHN0YXRlIGlzIHZhbGlkIChvciB3YXMgc3VjY2Vzc2Z1bGx5IHJlY292ZXJlZClcbiAqICAgMSAtIFVuY29tbWl0dGVkIGNoYW5nZXMgcmVtYWluIGZyb20gcHJldmlvdXMgc2Vzc2lvblxuICogICAyIC0gSEVBRCBpcyBkZXRhY2hlZCBvciBub3Qgb24gdGhlIGV4cGVjdGVkIGZlYXR1cmUgYnJhbmNoXG4gKiAgIDMgLSBGZWF0dXJlIGJyYW5jaCBoYXMgZGl2ZXJnZWQgZnJvbSB0YXJnZXQgYmFzZSBicmFuY2ggKHdhcm5pbmcgb25seSlcbiAqICAgNCAtIExvY2FsIGJyYW5jaCBoYXMgZGl2ZXJnZWQgZnJvbSByZW1vdGUgdHJhY2tpbmcgYnJhbmNoXG4gKi9cblxuLyoqIFJlc3VsdCBvZiByZXBvc2l0b3J5IHZhbGlkYXRpb24uICovXG5leHBvcnQgaW50ZXJmYWNlIFZhbGlkYXRpb25SZXN1bHQge1xuICAvKiogV2hldGhlciB2YWxpZGF0aW9uIHBhc3NlZC4gKi9cbiAgdmFsaWQ6IGJvb2xlYW47XG4gIC8qKiBBY3Rpb25zIHRha2VuIGR1cmluZyByZWNvdmVyeSAoaWYgYXR0ZW1wdGVkKS4gKi9cbiAgYWN0aW9uczogc3RyaW5nW107XG4gIC8qKiBXYXJuaW5ncyB0aGF0IGRvbid0IGJsb2NrIHZhbGlkYXRpb24uICovXG4gIHdhcm5pbmdzOiBzdHJpbmdbXTtcbiAgLyoqIEVycm9yIGNvZGUgaWYgdmFsaWRhdGlvbiBmYWlsZWQuICovXG4gIGVycm9yQ29kZT86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBQcmUtQ2xhdWRlIHJlcG9zaXRvcnkgc3RhdGUgdmFsaWRhdGlvbiAoSXNzdWUgIzYyMSkuXG4gKlxuICogQHBhcmFtIGZlYXR1cmVCcmFuY2ggLSBUaGUgZXhwZWN0ZWQgZmVhdHVyZSBicmFuY2ggbmFtZVxuICogQHBhcmFtIGJhc2VCcmFuY2ggLSBUaGUgdGFyZ2V0IGJhc2UgYnJhbmNoXG4gKiBAcGFyYW0gYXR0ZW1wdFJlY292ZXJ5IC0gV2hldGhlciB0byBhdHRlbXB0IGF1dG9tYXRpYyByZWNvdmVyeVxuICogQHBhcmFtIG9wdGlvbnMgLSBHaXQgY29tbWFuZCBvcHRpb25zXG4gKiBAcmV0dXJucyBSZXN1bHQgd2l0aCB2YWxpZGF0aW9uIGRldGFpbHNcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHZhbGlkYXRlUmVwb1N0YXRlKFxuICBmZWF0dXJlQnJhbmNoOiBzdHJpbmcsXG4gIGJhc2VCcmFuY2g6IHN0cmluZyxcbiAgYXR0ZW1wdFJlY292ZXJ5OiBib29sZWFuID0gZmFsc2UsXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPFJlc3VsdDxWYWxpZGF0aW9uUmVzdWx0Pj4ge1xuICBjb25zdCBhY3Rpb25zOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCB3YXJuaW5nczogc3RyaW5nW10gPSBbXTtcblxuICAvLyAxLiBDaGVjayBmb3IgdW5jb21taXR0ZWQgY2hhbmdlc1xuICBjb25zdCBzdGF0dXNSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFtcInN0YXR1c1wiLCBcIi0tcG9yY2VsYWluXCJdLCBvcHRpb25zKTtcbiAgaWYgKCFzdGF0dXNSZXN1bHQub2sgfHwgc3RhdHVzUmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZTogeyB2YWxpZDogZmFsc2UsIGFjdGlvbnMsIHdhcm5pbmdzLCBlcnJvckNvZGU6IDEgfSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgcG9yY2VsYWluU3RhdHVzID0gc3RhdHVzUmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKCk7XG4gIGlmIChwb3JjZWxhaW5TdGF0dXMpIHtcbiAgICBpZiAoYXR0ZW1wdFJlY292ZXJ5KSB7XG4gICAgICBhY3Rpb25zLnB1c2goXG4gICAgICAgIFwiU0VMRi1IRUFMSU5HOiBSZXNldHRpbmcgdW5jb21taXR0ZWQgY2hhbmdlcyB0byByZXN0b3JlIGNsZWFuIHN0YXRlIChJc3N1ZSAjNjIxKVwiLFxuICAgICAgKTtcbiAgICAgIGF3YWl0IHJ1bkdpdENvbW1hbmQoW1wicmVzZXRcIiwgXCItLWhhcmRcIiwgXCJIRUFEXCJdLCBvcHRpb25zKTtcbiAgICAgIC8vIElnbm9yZWQgZXhlY3V0YWJsZSBwYXRocyBnbyB3aXRoIGl0IChJc3N1ZSAjMTQ0Myk7IGEgY2xlYW4gdGhhdFxuICAgICAgLy8gY291bGQgbm90IHJlYWNoIHRoZW0gaXMgYSB3YXJuaW5nIG9uIHRoZSB2YWxpZGF0aW9uIHJlc3VsdCwgbmV2ZXIgYVxuICAgICAgLy8gc2lsZW50IHBhc3MuXG4gICAgICBjb25zdCBjbGVhbmVkID0gYXdhaXQgY2xlYW5Xb3JraW5nVHJlZShvcHRpb25zKTtcbiAgICAgIGlmICghY2xlYW5lZC5vaykgd2FybmluZ3MucHVzaChjbGVhbmVkLmVycm9yLm1lc3NhZ2UpO1xuXG4gICAgICAvLyBSZS1jaGVja1xuICAgICAgY29uc3QgcmVjaGVja1Jlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgICAgIFtcInN0YXR1c1wiLCBcIi0tcG9yY2VsYWluXCJdLFxuICAgICAgICBvcHRpb25zLFxuICAgICAgKTtcbiAgICAgIGlmIChyZWNoZWNrUmVzdWx0Lm9rICYmIHJlY2hlY2tSZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgIHZhbHVlOiB7IHZhbGlkOiBmYWxzZSwgYWN0aW9ucywgd2FybmluZ3MsIGVycm9yQ29kZTogMSB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgYWN0aW9ucy5wdXNoKFxuICAgICAgICBcIlNFTEYtSEVBTElORzogVW5jb21taXR0ZWQgY2hhbmdlcyBjbGVhcmVkIHN1Y2Nlc3NmdWxseSAoSXNzdWUgIzYyMSlcIixcbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICB2YWx1ZTogeyB2YWxpZDogZmFsc2UsIGFjdGlvbnMsIHdhcm5pbmdzLCBlcnJvckNvZGU6IDEgfSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgLy8gMi4gVmVyaWZ5IGN1cnJlbnQgYnJhbmNoIGlzIHRoZSBmZWF0dXJlIGJyYW5jaFxuICBjb25zdCBoZWFkUmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJyZXYtcGFyc2VcIiwgXCItLWFiYnJldi1yZWZcIiwgXCJIRUFEXCJdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGxldCBjdXJyZW50QnJhbmNoID0gaGVhZFJlc3VsdC5vayA/IGhlYWRSZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKSA6IFwiXCI7XG5cbiAgaWYgKGN1cnJlbnRCcmFuY2ggPT09IFwiSEVBRFwiKSB7XG4gICAgaWYgKGF0dGVtcHRSZWNvdmVyeSkge1xuICAgICAgYWN0aW9ucy5wdXNoKFxuICAgICAgICBgU0VMRi1IRUFMSU5HOiBSZWNvdmVyaW5nIGZyb20gZGV0YWNoZWQgSEVBRCDigJQgY2hlY2tpbmcgb3V0ICcke2ZlYXR1cmVCcmFuY2h9JyAoSXNzdWUgIzYyMSlgLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGNoZWNrb3V0UmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICAgICAgW1wiY2hlY2tvdXRcIiwgZmVhdHVyZUJyYW5jaF0sXG4gICAgICAgIG9wdGlvbnMsXG4gICAgICApO1xuICAgICAgaWYgKCFjaGVja291dFJlc3VsdC5vayB8fCBjaGVja291dFJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgdmFsdWU6IHsgdmFsaWQ6IGZhbHNlLCBhY3Rpb25zLCB3YXJuaW5ncywgZXJyb3JDb2RlOiAyIH0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjb25zdCBuZXdIZWFkID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICAgICAgW1wicmV2LXBhcnNlXCIsIFwiLS1hYmJyZXYtcmVmXCIsIFwiSEVBRFwiXSxcbiAgICAgICAgb3B0aW9ucyxcbiAgICAgICk7XG4gICAgICBjdXJyZW50QnJhbmNoID0gbmV3SGVhZC5vayA/IG5ld0hlYWQudmFsdWUuc3Rkb3V0LnRyaW0oKSA6IFwiXCI7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICB2YWx1ZTogeyB2YWxpZDogZmFsc2UsIGFjdGlvbnMsIHdhcm5pbmdzLCBlcnJvckNvZGU6IDIgfSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKGN1cnJlbnRCcmFuY2ggIT09IGZlYXR1cmVCcmFuY2gpIHtcbiAgICBpZiAoYXR0ZW1wdFJlY292ZXJ5KSB7XG4gICAgICBhY3Rpb25zLnB1c2goXG4gICAgICAgIGBTRUxGLUhFQUxJTkc6IENoZWNraW5nIG91dCBleHBlY3RlZCBmZWF0dXJlIGJyYW5jaCAnJHtmZWF0dXJlQnJhbmNofScgKElzc3VlICM2MjEpYCxcbiAgICAgICk7XG4gICAgICBjb25zdCBjaGVja291dFJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgICAgIFtcImNoZWNrb3V0XCIsIGZlYXR1cmVCcmFuY2hdLFxuICAgICAgICBvcHRpb25zLFxuICAgICAgKTtcbiAgICAgIGlmICghY2hlY2tvdXRSZXN1bHQub2sgfHwgY2hlY2tvdXRSZXN1bHQudmFsdWUuY29kZSAhPT0gMCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgIHZhbHVlOiB7IHZhbGlkOiBmYWxzZSwgYWN0aW9ucywgd2FybmluZ3MsIGVycm9yQ29kZTogMiB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgdmFsdWU6IHsgdmFsaWQ6IGZhbHNlLCBhY3Rpb25zLCB3YXJuaW5ncywgZXJyb3JDb2RlOiAyIH0sXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIC8vIDMuIENoZWNrIGRpdmVyZ2VuY2UgZnJvbSBiYXNlIGJyYW5jaCAod2FybmluZyBvbmx5KVxuICBjb25zdCBiZWhpbmRCYXNlUmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJyZXYtbGlzdFwiLCBcIi0tY291bnRcIiwgYEhFQUQuLiR7YmFzZUJyYW5jaH1gXSxcbiAgICBvcHRpb25zLFxuICApO1xuICBjb25zdCBiZWhpbmRCYXNlQ291bnQgPVxuICAgIGJlaGluZEJhc2VSZXN1bHQub2sgJiYgYmVoaW5kQmFzZVJlc3VsdC52YWx1ZS5jb2RlID09PSAwXG4gICAgICA/IHBhcnNlSW50KGJlaGluZEJhc2VSZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKSwgMTApIHx8IDBcbiAgICAgIDogMDtcblxuICBpZiAoYmVoaW5kQmFzZUNvdW50ID4gMCkge1xuICAgIHdhcm5pbmdzLnB1c2goXG4gICAgICBgRmVhdHVyZSBicmFuY2ggJyR7ZmVhdHVyZUJyYW5jaH0nIGlzICR7YmVoaW5kQmFzZUNvdW50fSBjb21taXQocykgYmVoaW5kICcke2Jhc2VCcmFuY2h9J2AsXG4gICAgKTtcbiAgICBpZiAoYmVoaW5kQmFzZUNvdW50ID4gNTApIHtcbiAgICAgIHdhcm5pbmdzLnB1c2goXG4gICAgICAgIGBTaWduaWZpY2FudCBkaXZlcmdlbmNlIGZyb20gJyR7YmFzZUJyYW5jaH0nICgke2JlaGluZEJhc2VDb3VudH0gY29tbWl0cyBiZWhpbmQpYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLy8gNC4gQ2hlY2sgcmVtb3RlIHRyYWNraW5nIGJyYW5jaFxuICBhd2FpdCBydW5HaXRDb21tYW5kKFtcImZldGNoXCIsIFwib3JpZ2luXCIsIGZlYXR1cmVCcmFuY2hdLCBvcHRpb25zKTtcblxuICBjb25zdCBzaG93UmVmUmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJzaG93LXJlZlwiLCBcIi0tdmVyaWZ5XCIsIFwiLS1xdWlldFwiLCBgcmVmcy9yZW1vdGVzL29yaWdpbi8ke2ZlYXR1cmVCcmFuY2h9YF0sXG4gICAgb3B0aW9ucyxcbiAgKTtcblxuICBpZiAoc2hvd1JlZlJlc3VsdC5vayAmJiBzaG93UmVmUmVzdWx0LnZhbHVlLmNvZGUgPT09IDApIHtcbiAgICBjb25zdCBsb2NhbFNoYVJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoW1wicmV2LXBhcnNlXCIsIFwiSEVBRFwiXSwgb3B0aW9ucyk7XG4gICAgY29uc3QgcmVtb3RlU2hhUmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICAgIFtcInJldi1wYXJzZVwiLCBgb3JpZ2luLyR7ZmVhdHVyZUJyYW5jaH1gXSxcbiAgICAgIG9wdGlvbnMsXG4gICAgKTtcblxuICAgIGNvbnN0IGxvY2FsU2hhID0gbG9jYWxTaGFSZXN1bHQub2tcbiAgICAgID8gbG9jYWxTaGFSZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKVxuICAgICAgOiBcIlwiO1xuICAgIGNvbnN0IHJlbW90ZVNoYSA9IHJlbW90ZVNoYVJlc3VsdC5va1xuICAgICAgPyByZW1vdGVTaGFSZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKVxuICAgICAgOiBcIlwiO1xuXG4gICAgaWYgKGxvY2FsU2hhICYmIHJlbW90ZVNoYSAmJiBsb2NhbFNoYSAhPT0gcmVtb3RlU2hhKSB7XG4gICAgICBjb25zdCBiZWhpbmRSZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgICAgICBbXCJyZXYtbGlzdFwiLCBcIi0tY291bnRcIiwgYEhFQUQuLm9yaWdpbi8ke2ZlYXR1cmVCcmFuY2h9YF0sXG4gICAgICAgIG9wdGlvbnMsXG4gICAgICApO1xuICAgICAgY29uc3QgYmVoaW5kQ291bnQgPSBiZWhpbmRSZXN1bHQub2sgJiYgYmVoaW5kUmVzdWx0LnZhbHVlLmNvZGUgPT09IDBcbiAgICAgICAgPyBwYXJzZUludChiZWhpbmRSZXN1bHQudmFsdWUuc3Rkb3V0LnRyaW0oKSwgMTApIHx8IDBcbiAgICAgICAgOiAwO1xuXG4gICAgICBpZiAoYmVoaW5kQ291bnQgPiAwKSB7XG4gICAgICAgIGlmIChhdHRlbXB0UmVjb3ZlcnkpIHtcbiAgICAgICAgICBhY3Rpb25zLnB1c2goXG4gICAgICAgICAgICBcIlNFTEYtSEVBTElORzogUHVsbGluZyByZW1vdGUgY2hhbmdlcyB0byByZXNvbHZlIHVwc3RyZWFtIGRpdmVyZ2VuY2UgKElzc3VlICM2MjEpXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBjb25zdCBwdWxsUmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICAgICAgICAgIFtcInB1bGxcIiwgXCItLXJlYmFzZVwiLCBcIm9yaWdpblwiLCBmZWF0dXJlQnJhbmNoXSxcbiAgICAgICAgICAgIG9wdGlvbnMsXG4gICAgICAgICAgKTtcblxuICAgICAgICAgIGlmICghcHVsbFJlc3VsdC5vayB8fCBwdWxsUmVzdWx0LnZhbHVlLmNvZGUgIT09IDApIHtcbiAgICAgICAgICAgIGF3YWl0IHJ1bkdpdENvbW1hbmQoW1wicmViYXNlXCIsIFwiLS1hYm9ydFwiXSwgb3B0aW9ucyk7XG4gICAgICAgICAgICBhY3Rpb25zLnB1c2goXG4gICAgICAgICAgICAgIFwiU0VMRi1IRUFMSU5HOiBSZXNldHRpbmcgdG8gcmVtb3RlIHZlcnNpb24gdG8gcmVzb2x2ZSBkaXZlcmdlbmNlIChJc3N1ZSAjNjIxKVwiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgICAgICAgICAgIFtcInJlc2V0XCIsIFwiLS1oYXJkXCIsIGBvcmlnaW4vJHtmZWF0dXJlQnJhbmNofWBdLFxuICAgICAgICAgICAgICBvcHRpb25zLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgICAgdmFsdWU6IHsgdmFsaWQ6IGZhbHNlLCBhY3Rpb25zLCB3YXJuaW5ncywgZXJyb3JDb2RlOiA0IH0sXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgdmFsdWU6IHsgdmFsaWQ6IHRydWUsIGFjdGlvbnMsIHdhcm5pbmdzIH0sXG4gIH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Q0FVQyxHQUdELFNBQVMsYUFBYSxRQUFRLG1CQUFtQjtBQUNqRCxTQUFTLGdCQUFnQixRQUFRLDBCQUEwQjtBQXdCM0Q7Ozs7Ozs7O0NBUUMsR0FDRCxPQUFPLGVBQWUsa0JBQ3BCLGFBQXFCLEVBQ3JCLFVBQWtCLEVBQ2xCLGtCQUEyQixLQUFLLEVBQ2hDLFVBQTZCLENBQUMsQ0FBQztFQUUvQixNQUFNLFVBQW9CLEVBQUU7RUFDNUIsTUFBTSxXQUFxQixFQUFFO0VBRTdCLG1DQUFtQztFQUNuQyxNQUFNLGVBQWUsTUFBTSxjQUFjO0lBQUM7SUFBVTtHQUFjLEVBQUU7RUFDcEUsSUFBSSxDQUFDLGFBQWEsRUFBRSxJQUFJLGFBQWEsS0FBSyxDQUFDLElBQUksS0FBSyxHQUFHO0lBQ3JELE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTztRQUFFLE9BQU87UUFBTztRQUFTO1FBQVUsV0FBVztNQUFFO0lBQ3pEO0VBQ0Y7RUFFQSxNQUFNLGtCQUFrQixhQUFhLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSTtFQUN0RCxJQUFJLGlCQUFpQjtJQUNuQixJQUFJLGlCQUFpQjtNQUNuQixRQUFRLElBQUksQ0FDVjtNQUVGLE1BQU0sY0FBYztRQUFDO1FBQVM7UUFBVTtPQUFPLEVBQUU7TUFDakQsa0VBQWtFO01BQ2xFLHNFQUFzRTtNQUN0RSxlQUFlO01BQ2YsTUFBTSxVQUFVLE1BQU0saUJBQWlCO01BQ3ZDLElBQUksQ0FBQyxRQUFRLEVBQUUsRUFBRSxTQUFTLElBQUksQ0FBQyxRQUFRLEtBQUssQ0FBQyxPQUFPO01BRXBELFdBQVc7TUFDWCxNQUFNLGdCQUFnQixNQUFNLGNBQzFCO1FBQUM7UUFBVTtPQUFjLEVBQ3pCO01BRUYsSUFBSSxjQUFjLEVBQUUsSUFBSSxjQUFjLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxJQUFJO1FBQ3pELE9BQU87VUFDTCxJQUFJO1VBQ0osT0FBTztZQUFFLE9BQU87WUFBTztZQUFTO1lBQVUsV0FBVztVQUFFO1FBQ3pEO01BQ0Y7TUFDQSxRQUFRLElBQUksQ0FDVjtJQUVKLE9BQU87TUFDTCxPQUFPO1FBQ0wsSUFBSTtRQUNKLE9BQU87VUFBRSxPQUFPO1VBQU87VUFBUztVQUFVLFdBQVc7UUFBRTtNQUN6RDtJQUNGO0VBQ0Y7RUFFQSxpREFBaUQ7RUFDakQsTUFBTSxhQUFhLE1BQU0sY0FDdkI7SUFBQztJQUFhO0lBQWdCO0dBQU8sRUFDckM7RUFFRixJQUFJLGdCQUFnQixXQUFXLEVBQUUsR0FBRyxXQUFXLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxLQUFLO0VBRXJFLElBQUksa0JBQWtCLFFBQVE7SUFDNUIsSUFBSSxpQkFBaUI7TUFDbkIsUUFBUSxJQUFJLENBQ1YsQ0FBQyw0REFBNEQsRUFBRSxjQUFjLGNBQWMsQ0FBQztNQUU5RixNQUFNLGlCQUFpQixNQUFNLGNBQzNCO1FBQUM7UUFBWTtPQUFjLEVBQzNCO01BRUYsSUFBSSxDQUFDLGVBQWUsRUFBRSxJQUFJLGVBQWUsS0FBSyxDQUFDLElBQUksS0FBSyxHQUFHO1FBQ3pELE9BQU87VUFDTCxJQUFJO1VBQ0osT0FBTztZQUFFLE9BQU87WUFBTztZQUFTO1lBQVUsV0FBVztVQUFFO1FBQ3pEO01BQ0Y7TUFDQSxNQUFNLFVBQVUsTUFBTSxjQUNwQjtRQUFDO1FBQWE7UUFBZ0I7T0FBTyxFQUNyQztNQUVGLGdCQUFnQixRQUFRLEVBQUUsR0FBRyxRQUFRLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxLQUFLO0lBQzdELE9BQU87TUFDTCxPQUFPO1FBQ0wsSUFBSTtRQUNKLE9BQU87VUFBRSxPQUFPO1VBQU87VUFBUztVQUFVLFdBQVc7UUFBRTtNQUN6RDtJQUNGO0VBQ0Y7RUFFQSxJQUFJLGtCQUFrQixlQUFlO0lBQ25DLElBQUksaUJBQWlCO01BQ25CLFFBQVEsSUFBSSxDQUNWLENBQUMsb0RBQW9ELEVBQUUsY0FBYyxjQUFjLENBQUM7TUFFdEYsTUFBTSxpQkFBaUIsTUFBTSxjQUMzQjtRQUFDO1FBQVk7T0FBYyxFQUMzQjtNQUVGLElBQUksQ0FBQyxlQUFlLEVBQUUsSUFBSSxlQUFlLEtBQUssQ0FBQyxJQUFJLEtBQUssR0FBRztRQUN6RCxPQUFPO1VBQ0wsSUFBSTtVQUNKLE9BQU87WUFBRSxPQUFPO1lBQU87WUFBUztZQUFVLFdBQVc7VUFBRTtRQUN6RDtNQUNGO0lBQ0YsT0FBTztNQUNMLE9BQU87UUFDTCxJQUFJO1FBQ0osT0FBTztVQUFFLE9BQU87VUFBTztVQUFTO1VBQVUsV0FBVztRQUFFO01BQ3pEO0lBQ0Y7RUFDRjtFQUVBLHNEQUFzRDtFQUN0RCxNQUFNLG1CQUFtQixNQUFNLGNBQzdCO0lBQUM7SUFBWTtJQUFXLENBQUMsTUFBTSxFQUFFLFlBQVk7R0FBQyxFQUM5QztFQUVGLE1BQU0sa0JBQ0osaUJBQWlCLEVBQUUsSUFBSSxpQkFBaUIsS0FBSyxDQUFDLElBQUksS0FBSyxJQUNuRCxTQUFTLGlCQUFpQixLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksSUFBSSxPQUFPLElBQ3REO0VBRU4sSUFBSSxrQkFBa0IsR0FBRztJQUN2QixTQUFTLElBQUksQ0FDWCxDQUFDLGdCQUFnQixFQUFFLGNBQWMsS0FBSyxFQUFFLGdCQUFnQixtQkFBbUIsRUFBRSxXQUFXLENBQUMsQ0FBQztJQUU1RixJQUFJLGtCQUFrQixJQUFJO01BQ3hCLFNBQVMsSUFBSSxDQUNYLENBQUMsNkJBQTZCLEVBQUUsV0FBVyxHQUFHLEVBQUUsZ0JBQWdCLGdCQUFnQixDQUFDO0lBRXJGO0VBQ0Y7RUFFQSxrQ0FBa0M7RUFDbEMsTUFBTSxjQUFjO0lBQUM7SUFBUztJQUFVO0dBQWMsRUFBRTtFQUV4RCxNQUFNLGdCQUFnQixNQUFNLGNBQzFCO0lBQUM7SUFBWTtJQUFZO0lBQVcsQ0FBQyxvQkFBb0IsRUFBRSxlQUFlO0dBQUMsRUFDM0U7RUFHRixJQUFJLGNBQWMsRUFBRSxJQUFJLGNBQWMsS0FBSyxDQUFDLElBQUksS0FBSyxHQUFHO0lBQ3RELE1BQU0saUJBQWlCLE1BQU0sY0FBYztNQUFDO01BQWE7S0FBTyxFQUFFO0lBQ2xFLE1BQU0sa0JBQWtCLE1BQU0sY0FDNUI7TUFBQztNQUFhLENBQUMsT0FBTyxFQUFFLGVBQWU7S0FBQyxFQUN4QztJQUdGLE1BQU0sV0FBVyxlQUFlLEVBQUUsR0FDOUIsZUFBZSxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksS0FDaEM7SUFDSixNQUFNLFlBQVksZ0JBQWdCLEVBQUUsR0FDaEMsZ0JBQWdCLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxLQUNqQztJQUVKLElBQUksWUFBWSxhQUFhLGFBQWEsV0FBVztNQUNuRCxNQUFNLGVBQWUsTUFBTSxjQUN6QjtRQUFDO1FBQVk7UUFBVyxDQUFDLGFBQWEsRUFBRSxlQUFlO09BQUMsRUFDeEQ7TUFFRixNQUFNLGNBQWMsYUFBYSxFQUFFLElBQUksYUFBYSxLQUFLLENBQUMsSUFBSSxLQUFLLElBQy9ELFNBQVMsYUFBYSxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksSUFBSSxPQUFPLElBQ2xEO01BRUosSUFBSSxjQUFjLEdBQUc7UUFDbkIsSUFBSSxpQkFBaUI7VUFDbkIsUUFBUSxJQUFJLENBQ1Y7VUFFRixNQUFNLGFBQWEsTUFBTSxjQUN2QjtZQUFDO1lBQVE7WUFBWTtZQUFVO1dBQWMsRUFDN0M7VUFHRixJQUFJLENBQUMsV0FBVyxFQUFFLElBQUksV0FBVyxLQUFLLENBQUMsSUFBSSxLQUFLLEdBQUc7WUFDakQsTUFBTSxjQUFjO2NBQUM7Y0FBVTthQUFVLEVBQUU7WUFDM0MsUUFBUSxJQUFJLENBQ1Y7WUFFRixNQUFNLGNBQ0o7Y0FBQztjQUFTO2NBQVUsQ0FBQyxPQUFPLEVBQUUsZUFBZTthQUFDLEVBQzlDO1VBRUo7UUFDRixPQUFPO1VBQ0wsT0FBTztZQUNMLElBQUk7WUFDSixPQUFPO2NBQUUsT0FBTztjQUFPO2NBQVM7Y0FBVSxXQUFXO1lBQUU7VUFDekQ7UUFDRjtNQUNGO0lBQ0Y7RUFDRjtFQUVBLE9BQU87SUFDTCxJQUFJO0lBQ0osT0FBTztNQUFFLE9BQU87TUFBTTtNQUFTO0lBQVM7RUFDMUM7QUFDRiJ9
// denoCacheMetadata=15204464941490633203,10015080011845810905