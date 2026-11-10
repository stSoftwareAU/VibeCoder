/**
 * Local state of a milestone branch name (Issue #1345).
 *
 * A milestone branch is created on origin by pushing the default branch ref
 * straight to the milestone ref name, so no local checkout takes part in the
 * creation and none can block it. Whatever local branch of the same name is
 * lying around is left exactly as it is — but it is not left silent: the
 * stale checkout that used to wedge the run is named in one log line so an
 * operator can find it.
 *
 * A git command that could not be RUN is reported as unknown, never as
 * "no local branch" or "not checked out": absence of a failure is not a
 * clean answer, and the reassuring answer is the one that hid this fault.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { runGitCommand } from "./git_timeout.ts";
import { parseWorktreeList } from "./worktree_cleanup.ts";
/**
 * Find the worktree that holds `branch` checked out.
 *
 * @param worktreeListOutput - Raw `git worktree list --porcelain` output.
 * @param branch - The branch name (without the `refs/heads/` prefix).
 * @returns The worktree path, or null when no worktree holds the branch.
 */ export function findWorktreeHoldingBranch(worktreeListOutput, branch) {
  const ref = `refs/heads/${branch}`;
  for (const entry of parseWorktreeList(worktreeListOutput)){
    if (entry.branch === ref) {
      return entry.path;
    }
  }
  return null;
}
/**
 * Inspect the local ref (if any) sharing the milestone branch's name.
 *
 * Read-only: nothing is deleted, reset, or checked out.
 */ export async function inspectLocalMilestoneBranch(branch, options = {}) {
  const revParseArgs = [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`
  ];
  const revParse = await runGitCommand(revParseArgs, options);
  if (!revParse.ok) {
    return {
      kind: "unknown",
      detail: revParse.error.message
    };
  }
  if (revParse.value.code !== 0) {
    // `--verify --quiet` exits 1 for a ref that does not exist; anything
    // else is git failing to answer, which is not the same thing.
    return revParse.value.code === 1 ? {
      kind: "absent"
    } : {
      kind: "unknown",
      detail: `git rev-parse exited ${revParse.value.code}: ` + (revParse.value.stderr.trim() || "(no output)")
    };
  }
  const sha = revParse.value.stdout.trim();
  if (sha === "") {
    return {
      kind: "absent"
    };
  }
  const worktrees = await runGitCommand([
    "worktree",
    "list",
    "--porcelain"
  ], options);
  if (!worktrees.ok || worktrees.value.code !== 0) {
    const detail = worktrees.ok ? worktrees.value.stderr.trim() || `exit ${worktrees.value.code}` : worktrees.error.message;
    return {
      kind: "present",
      sha,
      location: `checkout location unknown — git worktree list failed: ${detail}`
    };
  }
  const worktree = findWorktreeHoldingBranch(worktrees.value.stdout, branch);
  return {
    kind: "present",
    sha,
    location: worktree === null ? "not checked out" : `checked out at ${worktree}`
  };
}
/**
 * The one line naming local state the creation left untouched.
 *
 * @param branch - The milestone branch name.
 * @param report - What {@link inspectLocalMilestoneBranch} found.
 * @param sourceRef - The ref pushed to create the branch on origin.
 * @returns The line to log, or null when there is nothing to report.
 */ export function describeLocalMilestoneBranch(branch, report, sourceRef) {
  if (report.kind === "absent") {
    return null;
  }
  if (report.kind === "unknown") {
    return `Could not inspect the local ref '${branch}' after creating it on ` + `origin from '${sourceRef}' — nothing local was touched either way: ` + report.detail;
  }
  return `Local branch '${branch}' (${report.sha.slice(0, 8)}, ` + `${report.location}) was left untouched — '${branch}' was created on ` + `origin by pushing '${sourceRef}' directly, which needs no local ` + `checkout (Issue #1345)`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9taWxlc3RvbmVfbG9jYWxfYnJhbmNoLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogTG9jYWwgc3RhdGUgb2YgYSBtaWxlc3RvbmUgYnJhbmNoIG5hbWUgKElzc3VlICMxMzQ1KS5cbiAqXG4gKiBBIG1pbGVzdG9uZSBicmFuY2ggaXMgY3JlYXRlZCBvbiBvcmlnaW4gYnkgcHVzaGluZyB0aGUgZGVmYXVsdCBicmFuY2ggcmVmXG4gKiBzdHJhaWdodCB0byB0aGUgbWlsZXN0b25lIHJlZiBuYW1lLCBzbyBubyBsb2NhbCBjaGVja291dCB0YWtlcyBwYXJ0IGluIHRoZVxuICogY3JlYXRpb24gYW5kIG5vbmUgY2FuIGJsb2NrIGl0LiBXaGF0ZXZlciBsb2NhbCBicmFuY2ggb2YgdGhlIHNhbWUgbmFtZSBpc1xuICogbHlpbmcgYXJvdW5kIGlzIGxlZnQgZXhhY3RseSBhcyBpdCBpcyDigJQgYnV0IGl0IGlzIG5vdCBsZWZ0IHNpbGVudDogdGhlXG4gKiBzdGFsZSBjaGVja291dCB0aGF0IHVzZWQgdG8gd2VkZ2UgdGhlIHJ1biBpcyBuYW1lZCBpbiBvbmUgbG9nIGxpbmUgc28gYW5cbiAqIG9wZXJhdG9yIGNhbiBmaW5kIGl0LlxuICpcbiAqIEEgZ2l0IGNvbW1hbmQgdGhhdCBjb3VsZCBub3QgYmUgUlVOIGlzIHJlcG9ydGVkIGFzIHVua25vd24sIG5ldmVyIGFzXG4gKiBcIm5vIGxvY2FsIGJyYW5jaFwiIG9yIFwibm90IGNoZWNrZWQgb3V0XCI6IGFic2VuY2Ugb2YgYSBmYWlsdXJlIGlzIG5vdCBhXG4gKiBjbGVhbiBhbnN3ZXIsIGFuZCB0aGUgcmVhc3N1cmluZyBhbnN3ZXIgaXMgdGhlIG9uZSB0aGF0IGhpZCB0aGlzIGZhdWx0LlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7IHJ1bkdpdENvbW1hbmQgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuaW1wb3J0IHR5cGUgeyBHaXRDb21tYW5kT3B0aW9ucyB9IGZyb20gXCIuL2dpdF90aW1lb3V0LnRzXCI7XG5pbXBvcnQgeyBwYXJzZVdvcmt0cmVlTGlzdCB9IGZyb20gXCIuL3dvcmt0cmVlX2NsZWFudXAudHNcIjtcblxuLyoqIFdoYXQgdGhlIGxvY2FsIHJlZiBzdG9yZSBzYXlzIGFib3V0IHRoZSBtaWxlc3RvbmUgYnJhbmNoJ3MgbmFtZS4gKi9cbmV4cG9ydCB0eXBlIExvY2FsTWlsZXN0b25lQnJhbmNoUmVwb3J0ID1cbiAgLyoqIE5vIGxvY2FsIGJyYW5jaCBvZiB0aGF0IG5hbWUg4oCUIGdpdCBzYWlkIHNvLiAqL1xuICB8IHsga2luZDogXCJhYnNlbnRcIiB9XG4gIC8qKiBBIGxvY2FsIGJyYW5jaCBleGlzdHM7IGBsb2NhdGlvbmAgZGVzY3JpYmVzIHdoZXJlIGl0IGlzIGNoZWNrZWQgb3V0LiAqL1xuICB8IHsga2luZDogXCJwcmVzZW50XCI7IHNoYTogc3RyaW5nOyBsb2NhdGlvbjogc3RyaW5nIH1cbiAgLyoqIEdpdCBjb3VsZCBub3QgYmUgYXNrZWQg4oCUIHNheSBzbyByYXRoZXIgdGhhbiBhc3N1bWUgXCJhYnNlbnRcIi4gKi9cbiAgfCB7IGtpbmQ6IFwidW5rbm93blwiOyBkZXRhaWw6IHN0cmluZyB9O1xuXG4vKipcbiAqIEZpbmQgdGhlIHdvcmt0cmVlIHRoYXQgaG9sZHMgYGJyYW5jaGAgY2hlY2tlZCBvdXQuXG4gKlxuICogQHBhcmFtIHdvcmt0cmVlTGlzdE91dHB1dCAtIFJhdyBgZ2l0IHdvcmt0cmVlIGxpc3QgLS1wb3JjZWxhaW5gIG91dHB1dC5cbiAqIEBwYXJhbSBicmFuY2ggLSBUaGUgYnJhbmNoIG5hbWUgKHdpdGhvdXQgdGhlIGByZWZzL2hlYWRzL2AgcHJlZml4KS5cbiAqIEByZXR1cm5zIFRoZSB3b3JrdHJlZSBwYXRoLCBvciBudWxsIHdoZW4gbm8gd29ya3RyZWUgaG9sZHMgdGhlIGJyYW5jaC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmRXb3JrdHJlZUhvbGRpbmdCcmFuY2goXG4gIHdvcmt0cmVlTGlzdE91dHB1dDogc3RyaW5nLFxuICBicmFuY2g6IHN0cmluZyxcbik6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCByZWYgPSBgcmVmcy9oZWFkcy8ke2JyYW5jaH1gO1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIHBhcnNlV29ya3RyZWVMaXN0KHdvcmt0cmVlTGlzdE91dHB1dCkpIHtcbiAgICBpZiAoZW50cnkuYnJhbmNoID09PSByZWYpIHtcbiAgICAgIHJldHVybiBlbnRyeS5wYXRoO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBJbnNwZWN0IHRoZSBsb2NhbCByZWYgKGlmIGFueSkgc2hhcmluZyB0aGUgbWlsZXN0b25lIGJyYW5jaCdzIG5hbWUuXG4gKlxuICogUmVhZC1vbmx5OiBub3RoaW5nIGlzIGRlbGV0ZWQsIHJlc2V0LCBvciBjaGVja2VkIG91dC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGluc3BlY3RMb2NhbE1pbGVzdG9uZUJyYW5jaChcbiAgYnJhbmNoOiBzdHJpbmcsXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPExvY2FsTWlsZXN0b25lQnJhbmNoUmVwb3J0PiB7XG4gIGNvbnN0IHJldlBhcnNlQXJncyA9IFtcbiAgICBcInJldi1wYXJzZVwiLFxuICAgIFwiLS12ZXJpZnlcIixcbiAgICBcIi0tcXVpZXRcIixcbiAgICBgcmVmcy9oZWFkcy8ke2JyYW5jaH1gLFxuICBdO1xuICBjb25zdCByZXZQYXJzZSA9IGF3YWl0IHJ1bkdpdENvbW1hbmQocmV2UGFyc2VBcmdzLCBvcHRpb25zKTtcbiAgaWYgKCFyZXZQYXJzZS5vaykge1xuICAgIHJldHVybiB7IGtpbmQ6IFwidW5rbm93blwiLCBkZXRhaWw6IHJldlBhcnNlLmVycm9yLm1lc3NhZ2UgfTtcbiAgfVxuICBpZiAocmV2UGFyc2UudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIC8vIGAtLXZlcmlmeSAtLXF1aWV0YCBleGl0cyAxIGZvciBhIHJlZiB0aGF0IGRvZXMgbm90IGV4aXN0OyBhbnl0aGluZ1xuICAgIC8vIGVsc2UgaXMgZ2l0IGZhaWxpbmcgdG8gYW5zd2VyLCB3aGljaCBpcyBub3QgdGhlIHNhbWUgdGhpbmcuXG4gICAgcmV0dXJuIHJldlBhcnNlLnZhbHVlLmNvZGUgPT09IDEgPyB7IGtpbmQ6IFwiYWJzZW50XCIgfSA6IHtcbiAgICAgIGtpbmQ6IFwidW5rbm93blwiLFxuICAgICAgZGV0YWlsOiBgZ2l0IHJldi1wYXJzZSBleGl0ZWQgJHtyZXZQYXJzZS52YWx1ZS5jb2RlfTogYCArXG4gICAgICAgIChyZXZQYXJzZS52YWx1ZS5zdGRlcnIudHJpbSgpIHx8IFwiKG5vIG91dHB1dClcIiksXG4gICAgfTtcbiAgfVxuICBjb25zdCBzaGEgPSByZXZQYXJzZS52YWx1ZS5zdGRvdXQudHJpbSgpO1xuICBpZiAoc2hhID09PSBcIlwiKSB7XG4gICAgcmV0dXJuIHsga2luZDogXCJhYnNlbnRcIiB9O1xuICB9XG5cbiAgY29uc3Qgd29ya3RyZWVzID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJ3b3JrdHJlZVwiLCBcImxpc3RcIiwgXCItLXBvcmNlbGFpblwiXSxcbiAgICBvcHRpb25zLFxuICApO1xuICBpZiAoIXdvcmt0cmVlcy5vayB8fCB3b3JrdHJlZXMudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIGNvbnN0IGRldGFpbCA9IHdvcmt0cmVlcy5va1xuICAgICAgPyB3b3JrdHJlZXMudmFsdWUuc3RkZXJyLnRyaW0oKSB8fCBgZXhpdCAke3dvcmt0cmVlcy52YWx1ZS5jb2RlfWBcbiAgICAgIDogd29ya3RyZWVzLmVycm9yLm1lc3NhZ2U7XG4gICAgcmV0dXJuIHtcbiAgICAgIGtpbmQ6IFwicHJlc2VudFwiLFxuICAgICAgc2hhLFxuICAgICAgbG9jYXRpb246XG4gICAgICAgIGBjaGVja291dCBsb2NhdGlvbiB1bmtub3duIOKAlCBnaXQgd29ya3RyZWUgbGlzdCBmYWlsZWQ6ICR7ZGV0YWlsfWAsXG4gICAgfTtcbiAgfVxuICBjb25zdCB3b3JrdHJlZSA9IGZpbmRXb3JrdHJlZUhvbGRpbmdCcmFuY2god29ya3RyZWVzLnZhbHVlLnN0ZG91dCwgYnJhbmNoKTtcbiAgcmV0dXJuIHtcbiAgICBraW5kOiBcInByZXNlbnRcIixcbiAgICBzaGEsXG4gICAgbG9jYXRpb246IHdvcmt0cmVlID09PSBudWxsXG4gICAgICA/IFwibm90IGNoZWNrZWQgb3V0XCJcbiAgICAgIDogYGNoZWNrZWQgb3V0IGF0ICR7d29ya3RyZWV9YCxcbiAgfTtcbn1cblxuLyoqXG4gKiBUaGUgb25lIGxpbmUgbmFtaW5nIGxvY2FsIHN0YXRlIHRoZSBjcmVhdGlvbiBsZWZ0IHVudG91Y2hlZC5cbiAqXG4gKiBAcGFyYW0gYnJhbmNoIC0gVGhlIG1pbGVzdG9uZSBicmFuY2ggbmFtZS5cbiAqIEBwYXJhbSByZXBvcnQgLSBXaGF0IHtAbGluayBpbnNwZWN0TG9jYWxNaWxlc3RvbmVCcmFuY2h9IGZvdW5kLlxuICogQHBhcmFtIHNvdXJjZVJlZiAtIFRoZSByZWYgcHVzaGVkIHRvIGNyZWF0ZSB0aGUgYnJhbmNoIG9uIG9yaWdpbi5cbiAqIEByZXR1cm5zIFRoZSBsaW5lIHRvIGxvZywgb3IgbnVsbCB3aGVuIHRoZXJlIGlzIG5vdGhpbmcgdG8gcmVwb3J0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVzY3JpYmVMb2NhbE1pbGVzdG9uZUJyYW5jaChcbiAgYnJhbmNoOiBzdHJpbmcsXG4gIHJlcG9ydDogTG9jYWxNaWxlc3RvbmVCcmFuY2hSZXBvcnQsXG4gIHNvdXJjZVJlZjogc3RyaW5nLFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChyZXBvcnQua2luZCA9PT0gXCJhYnNlbnRcIikge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGlmIChyZXBvcnQua2luZCA9PT0gXCJ1bmtub3duXCIpIHtcbiAgICByZXR1cm4gYENvdWxkIG5vdCBpbnNwZWN0IHRoZSBsb2NhbCByZWYgJyR7YnJhbmNofScgYWZ0ZXIgY3JlYXRpbmcgaXQgb24gYCArXG4gICAgICBgb3JpZ2luIGZyb20gJyR7c291cmNlUmVmfScg4oCUIG5vdGhpbmcgbG9jYWwgd2FzIHRvdWNoZWQgZWl0aGVyIHdheTogYCArXG4gICAgICByZXBvcnQuZGV0YWlsO1xuICB9XG4gIHJldHVybiBgTG9jYWwgYnJhbmNoICcke2JyYW5jaH0nICgke3JlcG9ydC5zaGEuc2xpY2UoMCwgOCl9LCBgICtcbiAgICBgJHtyZXBvcnQubG9jYXRpb259KSB3YXMgbGVmdCB1bnRvdWNoZWQg4oCUICcke2JyYW5jaH0nIHdhcyBjcmVhdGVkIG9uIGAgK1xuICAgIGBvcmlnaW4gYnkgcHVzaGluZyAnJHtzb3VyY2VSZWZ9JyBkaXJlY3RseSwgd2hpY2ggbmVlZHMgbm8gbG9jYWwgYCArXG4gICAgYGNoZWNrb3V0IChJc3N1ZSAjMTM0NSlgO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Q0FlQyxHQUVELFNBQVMsYUFBYSxRQUFRLG1CQUFtQjtBQUVqRCxTQUFTLGlCQUFpQixRQUFRLHdCQUF3QjtBQVcxRDs7Ozs7O0NBTUMsR0FDRCxPQUFPLFNBQVMsMEJBQ2Qsa0JBQTBCLEVBQzFCLE1BQWM7RUFFZCxNQUFNLE1BQU0sQ0FBQyxXQUFXLEVBQUUsUUFBUTtFQUNsQyxLQUFLLE1BQU0sU0FBUyxrQkFBa0Isb0JBQXFCO0lBQ3pELElBQUksTUFBTSxNQUFNLEtBQUssS0FBSztNQUN4QixPQUFPLE1BQU0sSUFBSTtJQUNuQjtFQUNGO0VBQ0EsT0FBTztBQUNUO0FBRUE7Ozs7Q0FJQyxHQUNELE9BQU8sZUFBZSw0QkFDcEIsTUFBYyxFQUNkLFVBQTZCLENBQUMsQ0FBQztFQUUvQixNQUFNLGVBQWU7SUFDbkI7SUFDQTtJQUNBO0lBQ0EsQ0FBQyxXQUFXLEVBQUUsUUFBUTtHQUN2QjtFQUNELE1BQU0sV0FBVyxNQUFNLGNBQWMsY0FBYztFQUNuRCxJQUFJLENBQUMsU0FBUyxFQUFFLEVBQUU7SUFDaEIsT0FBTztNQUFFLE1BQU07TUFBVyxRQUFRLFNBQVMsS0FBSyxDQUFDLE9BQU87SUFBQztFQUMzRDtFQUNBLElBQUksU0FBUyxLQUFLLENBQUMsSUFBSSxLQUFLLEdBQUc7SUFDN0IscUVBQXFFO0lBQ3JFLDhEQUE4RDtJQUM5RCxPQUFPLFNBQVMsS0FBSyxDQUFDLElBQUksS0FBSyxJQUFJO01BQUUsTUFBTTtJQUFTLElBQUk7TUFDdEQsTUFBTTtNQUNOLFFBQVEsQ0FBQyxxQkFBcUIsRUFBRSxTQUFTLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLEdBQ3JELENBQUMsU0FBUyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksTUFBTSxhQUFhO0lBQ2xEO0VBQ0Y7RUFDQSxNQUFNLE1BQU0sU0FBUyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUk7RUFDdEMsSUFBSSxRQUFRLElBQUk7SUFDZCxPQUFPO01BQUUsTUFBTTtJQUFTO0VBQzFCO0VBRUEsTUFBTSxZQUFZLE1BQU0sY0FDdEI7SUFBQztJQUFZO0lBQVE7R0FBYyxFQUNuQztFQUVGLElBQUksQ0FBQyxVQUFVLEVBQUUsSUFBSSxVQUFVLEtBQUssQ0FBQyxJQUFJLEtBQUssR0FBRztJQUMvQyxNQUFNLFNBQVMsVUFBVSxFQUFFLEdBQ3ZCLFVBQVUsS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJLE1BQU0sQ0FBQyxLQUFLLEVBQUUsVUFBVSxLQUFLLENBQUMsSUFBSSxFQUFFLEdBQy9ELFVBQVUsS0FBSyxDQUFDLE9BQU87SUFDM0IsT0FBTztNQUNMLE1BQU07TUFDTjtNQUNBLFVBQ0UsQ0FBQyxzREFBc0QsRUFBRSxRQUFRO0lBQ3JFO0VBQ0Y7RUFDQSxNQUFNLFdBQVcsMEJBQTBCLFVBQVUsS0FBSyxDQUFDLE1BQU0sRUFBRTtFQUNuRSxPQUFPO0lBQ0wsTUFBTTtJQUNOO0lBQ0EsVUFBVSxhQUFhLE9BQ25CLG9CQUNBLENBQUMsZUFBZSxFQUFFLFVBQVU7RUFDbEM7QUFDRjtBQUVBOzs7Ozs7O0NBT0MsR0FDRCxPQUFPLFNBQVMsNkJBQ2QsTUFBYyxFQUNkLE1BQWtDLEVBQ2xDLFNBQWlCO0VBRWpCLElBQUksT0FBTyxJQUFJLEtBQUssVUFBVTtJQUM1QixPQUFPO0VBQ1Q7RUFDQSxJQUFJLE9BQU8sSUFBSSxLQUFLLFdBQVc7SUFDN0IsT0FBTyxDQUFDLGlDQUFpQyxFQUFFLE9BQU8sdUJBQXVCLENBQUMsR0FDeEUsQ0FBQyxhQUFhLEVBQUUsVUFBVSwwQ0FBMEMsQ0FBQyxHQUNyRSxPQUFPLE1BQU07RUFDakI7RUFDQSxPQUFPLENBQUMsY0FBYyxFQUFFLE9BQU8sR0FBRyxFQUFFLE9BQU8sR0FBRyxDQUFDLEtBQUssQ0FBQyxHQUFHLEdBQUcsRUFBRSxDQUFDLEdBQzVELEdBQUcsT0FBTyxRQUFRLENBQUMsd0JBQXdCLEVBQUUsT0FBTyxpQkFBaUIsQ0FBQyxHQUN0RSxDQUFDLG1CQUFtQixFQUFFLFVBQVUsaUNBQWlDLENBQUMsR0FDbEUsQ0FBQyxzQkFBc0IsQ0FBQztBQUM1QiJ9
// denoCacheMetadata=12397265031339116152,1437862491580879233