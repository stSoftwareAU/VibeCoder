/**
 * Fetch-refspec repair for legacy single-branch clones (Issue #211).
 *
 * `setupRepo` clones with `--depth=1 --no-single-branch` so that every branch
 * keeps a `refs/remotes/origin/<branch>` tracking ref. Clones made before that
 * flag existed — and any clone made with a bare `--depth=1`, which implies
 * `--single-branch` — carry a restricted fetch refspec forever:
 *
 * ```
 * remote.origin.fetch = +refs/heads/Develop:refs/remotes/origin/Develop
 * ```
 *
 * A clone in that state never gains a tracking ref for a feature branch, not
 * even from `git fetch origin <branch>` or a successful push. Every local
 * question about the branch ("is it pushed?", "does it conflict with its
 * base?") then silently answers about the default branch instead — the
 * NEAT-AI-core #557 false "push failed" and its spurious `merge-conflict`
 * label. `setupRepo` reuses an existing clone indefinitely, so the restricted
 * refspec has to be repaired in place rather than waited out.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { runGitCommand } from "./git_timeout.ts";
/** The refspec that keeps a tracking ref for every branch on origin. */ export const ALL_BRANCHES_FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";
/**
 * Ensure `remote.origin.fetch` covers every branch, repairing a clone that
 * only tracks one (Issue #211).
 *
 * The all-branches refspec is *added*, never substituted for what is there:
 * any extra refspec a clone legitimately carries keeps working, and the call
 * is idempotent because an existing all-branches entry is left alone.
 *
 * @param options - Git command options (cwd selects the clone)
 * @returns Whether a repair was applied, or the git failure that blocked it
 */ export async function ensureAllBranchesFetchRefspec(options = {}) {
  // Issue #2825: outside a usable repository `config --get-all` exits 1 just
  // like "no such key" and `--add` says only "not in a git directory". Ask
  // `rev-parse` first — it names the real reason (not a repository, dubious
  // ownership) and trips the safe.directory self-repair in `runGitCommand`.
  const probe = await runGitCommand([
    "rev-parse",
    "--git-dir"
  ], options);
  if (!probe.ok) {
    return {
      ok: false,
      error: probe.error
    };
  }
  if (probe.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`${options.cwd ?? "the working directory"} is not a usable git ` + `repository: ${probe.value.stderr.trim() || `git rev-parse exit ${probe.value.code}`}`)
    };
  }
  const existing = await runGitCommand([
    "config",
    "--get-all",
    "remote.origin.fetch"
  ], options);
  if (!existing.ok) {
    return {
      ok: false,
      error: existing.error
    };
  }
  // Exit 1 means "no such key" — a clone with no fetch refspec at all still
  // needs one, so only a harder failure is an error.
  if (existing.value.code > 1) {
    return {
      ok: false,
      error: new Error(`Failed to read remote.origin.fetch: ${existing.value.stderr.trim() || `git config exit ${existing.value.code}`}`)
    };
  }
  const before = existing.value.stdout.split("\n").map((line)=>line.trim()).filter((line)=>line.length > 0);
  if (before.includes(ALL_BRANCHES_FETCH_REFSPEC)) {
    return {
      ok: true,
      value: {
        repaired: false,
        before
      }
    };
  }
  const added = await runGitCommand([
    "config",
    "--add",
    "remote.origin.fetch",
    ALL_BRANCHES_FETCH_REFSPEC
  ], options);
  if (!added.ok) {
    return {
      ok: false,
      error: added.error
    };
  }
  if (added.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`Failed to add the all-branches fetch refspec: ${added.value.stderr.trim() || `git config exit ${added.value.code}`}`)
    };
  }
  return {
    ok: true,
    value: {
      repaired: true,
      before
    }
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfZmV0Y2hfcmVmc3BlYy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEZldGNoLXJlZnNwZWMgcmVwYWlyIGZvciBsZWdhY3kgc2luZ2xlLWJyYW5jaCBjbG9uZXMgKElzc3VlICMyMTEpLlxuICpcbiAqIGBzZXR1cFJlcG9gIGNsb25lcyB3aXRoIGAtLWRlcHRoPTEgLS1uby1zaW5nbGUtYnJhbmNoYCBzbyB0aGF0IGV2ZXJ5IGJyYW5jaFxuICoga2VlcHMgYSBgcmVmcy9yZW1vdGVzL29yaWdpbi88YnJhbmNoPmAgdHJhY2tpbmcgcmVmLiBDbG9uZXMgbWFkZSBiZWZvcmUgdGhhdFxuICogZmxhZyBleGlzdGVkIOKAlCBhbmQgYW55IGNsb25lIG1hZGUgd2l0aCBhIGJhcmUgYC0tZGVwdGg9MWAsIHdoaWNoIGltcGxpZXNcbiAqIGAtLXNpbmdsZS1icmFuY2hgIOKAlCBjYXJyeSBhIHJlc3RyaWN0ZWQgZmV0Y2ggcmVmc3BlYyBmb3JldmVyOlxuICpcbiAqIGBgYFxuICogcmVtb3RlLm9yaWdpbi5mZXRjaCA9ICtyZWZzL2hlYWRzL0RldmVsb3A6cmVmcy9yZW1vdGVzL29yaWdpbi9EZXZlbG9wXG4gKiBgYGBcbiAqXG4gKiBBIGNsb25lIGluIHRoYXQgc3RhdGUgbmV2ZXIgZ2FpbnMgYSB0cmFja2luZyByZWYgZm9yIGEgZmVhdHVyZSBicmFuY2gsIG5vdFxuICogZXZlbiBmcm9tIGBnaXQgZmV0Y2ggb3JpZ2luIDxicmFuY2g+YCBvciBhIHN1Y2Nlc3NmdWwgcHVzaC4gRXZlcnkgbG9jYWxcbiAqIHF1ZXN0aW9uIGFib3V0IHRoZSBicmFuY2ggKFwiaXMgaXQgcHVzaGVkP1wiLCBcImRvZXMgaXQgY29uZmxpY3Qgd2l0aCBpdHNcbiAqIGJhc2U/XCIpIHRoZW4gc2lsZW50bHkgYW5zd2VycyBhYm91dCB0aGUgZGVmYXVsdCBicmFuY2ggaW5zdGVhZCDigJQgdGhlXG4gKiBORUFULUFJLWNvcmUgIzU1NyBmYWxzZSBcInB1c2ggZmFpbGVkXCIgYW5kIGl0cyBzcHVyaW91cyBgbWVyZ2UtY29uZmxpY3RgXG4gKiBsYWJlbC4gYHNldHVwUmVwb2AgcmV1c2VzIGFuIGV4aXN0aW5nIGNsb25lIGluZGVmaW5pdGVseSwgc28gdGhlIHJlc3RyaWN0ZWRcbiAqIHJlZnNwZWMgaGFzIHRvIGJlIHJlcGFpcmVkIGluIHBsYWNlIHJhdGhlciB0aGFuIHdhaXRlZCBvdXQuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7IHJ1bkdpdENvbW1hbmQgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuaW1wb3J0IHR5cGUgeyBHaXRDb21tYW5kT3B0aW9ucyB9IGZyb20gXCIuL2dpdF90aW1lb3V0LnRzXCI7XG5cbi8qKiBUaGUgcmVmc3BlYyB0aGF0IGtlZXBzIGEgdHJhY2tpbmcgcmVmIGZvciBldmVyeSBicmFuY2ggb24gb3JpZ2luLiAqL1xuZXhwb3J0IGNvbnN0IEFMTF9CUkFOQ0hFU19GRVRDSF9SRUZTUEVDID0gXCIrcmVmcy9oZWFkcy8qOnJlZnMvcmVtb3Rlcy9vcmlnaW4vKlwiO1xuXG4vKiogT3V0Y29tZSBvZiB7QGxpbmsgZW5zdXJlQWxsQnJhbmNoZXNGZXRjaFJlZnNwZWN9LiAqL1xuZXhwb3J0IGludGVyZmFjZSBGZXRjaFJlZnNwZWNSZXBhaXIge1xuICAvKiogVHJ1ZSB3aGVuIHRoZSBhbGwtYnJhbmNoZXMgcmVmc3BlYyBoYWQgdG8gYmUgYWRkZWQgdG8gdGhpcyBjbG9uZS4gKi9cbiAgcmVwYWlyZWQ6IGJvb2xlYW47XG4gIC8qKiBUaGUgcmVmc3BlY3MgY29uZmlndXJlZCBiZWZvcmUgYW55IHJlcGFpciAoZm9yIGxvZ2dpbmcpLiAqL1xuICBiZWZvcmU6IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIEVuc3VyZSBgcmVtb3RlLm9yaWdpbi5mZXRjaGAgY292ZXJzIGV2ZXJ5IGJyYW5jaCwgcmVwYWlyaW5nIGEgY2xvbmUgdGhhdFxuICogb25seSB0cmFja3Mgb25lIChJc3N1ZSAjMjExKS5cbiAqXG4gKiBUaGUgYWxsLWJyYW5jaGVzIHJlZnNwZWMgaXMgKmFkZGVkKiwgbmV2ZXIgc3Vic3RpdHV0ZWQgZm9yIHdoYXQgaXMgdGhlcmU6XG4gKiBhbnkgZXh0cmEgcmVmc3BlYyBhIGNsb25lIGxlZ2l0aW1hdGVseSBjYXJyaWVzIGtlZXBzIHdvcmtpbmcsIGFuZCB0aGUgY2FsbFxuICogaXMgaWRlbXBvdGVudCBiZWNhdXNlIGFuIGV4aXN0aW5nIGFsbC1icmFuY2hlcyBlbnRyeSBpcyBsZWZ0IGFsb25lLlxuICpcbiAqIEBwYXJhbSBvcHRpb25zIC0gR2l0IGNvbW1hbmQgb3B0aW9ucyAoY3dkIHNlbGVjdHMgdGhlIGNsb25lKVxuICogQHJldHVybnMgV2hldGhlciBhIHJlcGFpciB3YXMgYXBwbGllZCwgb3IgdGhlIGdpdCBmYWlsdXJlIHRoYXQgYmxvY2tlZCBpdFxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZW5zdXJlQWxsQnJhbmNoZXNGZXRjaFJlZnNwZWMoXG4gIG9wdGlvbnM6IEdpdENvbW1hbmRPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPFJlc3VsdDxGZXRjaFJlZnNwZWNSZXBhaXI+PiB7XG4gIC8vIElzc3VlICMyODI1OiBvdXRzaWRlIGEgdXNhYmxlIHJlcG9zaXRvcnkgYGNvbmZpZyAtLWdldC1hbGxgIGV4aXRzIDEganVzdFxuICAvLyBsaWtlIFwibm8gc3VjaCBrZXlcIiBhbmQgYC0tYWRkYCBzYXlzIG9ubHkgXCJub3QgaW4gYSBnaXQgZGlyZWN0b3J5XCIuIEFza1xuICAvLyBgcmV2LXBhcnNlYCBmaXJzdCDigJQgaXQgbmFtZXMgdGhlIHJlYWwgcmVhc29uIChub3QgYSByZXBvc2l0b3J5LCBkdWJpb3VzXG4gIC8vIG93bmVyc2hpcCkgYW5kIHRyaXBzIHRoZSBzYWZlLmRpcmVjdG9yeSBzZWxmLXJlcGFpciBpbiBgcnVuR2l0Q29tbWFuZGAuXG4gIGNvbnN0IHByb2JlID0gYXdhaXQgcnVuR2l0Q29tbWFuZChbXCJyZXYtcGFyc2VcIiwgXCItLWdpdC1kaXJcIl0sIG9wdGlvbnMpO1xuICBpZiAoIXByb2JlLm9rKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogcHJvYmUuZXJyb3IgfTtcbiAgfVxuICBpZiAocHJvYmUudmFsdWUuY29kZSAhPT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgJHtvcHRpb25zLmN3ZCA/PyBcInRoZSB3b3JraW5nIGRpcmVjdG9yeVwifSBpcyBub3QgYSB1c2FibGUgZ2l0IGAgK1xuICAgICAgICAgIGByZXBvc2l0b3J5OiAke1xuICAgICAgICAgICAgcHJvYmUudmFsdWUuc3RkZXJyLnRyaW0oKSB8fFxuICAgICAgICAgICAgYGdpdCByZXYtcGFyc2UgZXhpdCAke3Byb2JlLnZhbHVlLmNvZGV9YFxuICAgICAgICAgIH1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcImNvbmZpZ1wiLCBcIi0tZ2V0LWFsbFwiLCBcInJlbW90ZS5vcmlnaW4uZmV0Y2hcIl0sXG4gICAgb3B0aW9ucyxcbiAgKTtcbiAgaWYgKCFleGlzdGluZy5vaykge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGV4aXN0aW5nLmVycm9yIH07XG4gIH1cbiAgLy8gRXhpdCAxIG1lYW5zIFwibm8gc3VjaCBrZXlcIiDigJQgYSBjbG9uZSB3aXRoIG5vIGZldGNoIHJlZnNwZWMgYXQgYWxsIHN0aWxsXG4gIC8vIG5lZWRzIG9uZSwgc28gb25seSBhIGhhcmRlciBmYWlsdXJlIGlzIGFuIGVycm9yLlxuICBpZiAoZXhpc3RpbmcudmFsdWUuY29kZSA+IDEpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYEZhaWxlZCB0byByZWFkIHJlbW90ZS5vcmlnaW4uZmV0Y2g6ICR7XG4gICAgICAgICAgZXhpc3RpbmcudmFsdWUuc3RkZXJyLnRyaW0oKSB8fFxuICAgICAgICAgIGBnaXQgY29uZmlnIGV4aXQgJHtleGlzdGluZy52YWx1ZS5jb2RlfWBcbiAgICAgICAgfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBiZWZvcmUgPSBleGlzdGluZy52YWx1ZS5zdGRvdXRcbiAgICAuc3BsaXQoXCJcXG5cIilcbiAgICAubWFwKChsaW5lKSA9PiBsaW5lLnRyaW0oKSlcbiAgICAuZmlsdGVyKChsaW5lKSA9PiBsaW5lLmxlbmd0aCA+IDApO1xuXG4gIGlmIChiZWZvcmUuaW5jbHVkZXMoQUxMX0JSQU5DSEVTX0ZFVENIX1JFRlNQRUMpKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IHJlcGFpcmVkOiBmYWxzZSwgYmVmb3JlIH0gfTtcbiAgfVxuXG4gIGNvbnN0IGFkZGVkID0gYXdhaXQgcnVuR2l0Q29tbWFuZChcbiAgICBbXCJjb25maWdcIiwgXCItLWFkZFwiLCBcInJlbW90ZS5vcmlnaW4uZmV0Y2hcIiwgQUxMX0JSQU5DSEVTX0ZFVENIX1JFRlNQRUNdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghYWRkZWQub2spIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBhZGRlZC5lcnJvciB9O1xuICB9XG4gIGlmIChhZGRlZC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBGYWlsZWQgdG8gYWRkIHRoZSBhbGwtYnJhbmNoZXMgZmV0Y2ggcmVmc3BlYzogJHtcbiAgICAgICAgICBhZGRlZC52YWx1ZS5zdGRlcnIudHJpbSgpIHx8IGBnaXQgY29uZmlnIGV4aXQgJHthZGRlZC52YWx1ZS5jb2RlfWBcbiAgICAgICAgfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHsgcmVwYWlyZWQ6IHRydWUsIGJlZm9yZSB9IH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXFCQyxHQUdELFNBQVMsYUFBYSxRQUFRLG1CQUFtQjtBQUdqRCxzRUFBc0UsR0FDdEUsT0FBTyxNQUFNLDZCQUE2QixzQ0FBc0M7QUFVaEY7Ozs7Ozs7Ozs7Q0FVQyxHQUNELE9BQU8sZUFBZSw4QkFDcEIsVUFBNkIsQ0FBQyxDQUFDO0VBRS9CLDJFQUEyRTtFQUMzRSx5RUFBeUU7RUFDekUsMEVBQTBFO0VBQzFFLDBFQUEwRTtFQUMxRSxNQUFNLFFBQVEsTUFBTSxjQUFjO0lBQUM7SUFBYTtHQUFZLEVBQUU7RUFDOUQsSUFBSSxDQUFDLE1BQU0sRUFBRSxFQUFFO0lBQ2IsT0FBTztNQUFFLElBQUk7TUFBTyxPQUFPLE1BQU0sS0FBSztJQUFDO0VBQ3pDO0VBQ0EsSUFBSSxNQUFNLEtBQUssQ0FBQyxJQUFJLEtBQUssR0FBRztJQUMxQixPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sSUFBSSxNQUNULEdBQUcsUUFBUSxHQUFHLElBQUksd0JBQXdCLHFCQUFxQixDQUFDLEdBQzlELENBQUMsWUFBWSxFQUNYLE1BQU0sS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJLE1BQ3ZCLENBQUMsbUJBQW1CLEVBQUUsTUFBTSxLQUFLLENBQUMsSUFBSSxFQUFFLEVBQ3hDO0lBRVI7RUFDRjtFQUVBLE1BQU0sV0FBVyxNQUFNLGNBQ3JCO0lBQUM7SUFBVTtJQUFhO0dBQXNCLEVBQzlDO0VBRUYsSUFBSSxDQUFDLFNBQVMsRUFBRSxFQUFFO0lBQ2hCLE9BQU87TUFBRSxJQUFJO01BQU8sT0FBTyxTQUFTLEtBQUs7SUFBQztFQUM1QztFQUNBLDBFQUEwRTtFQUMxRSxtREFBbUQ7RUFDbkQsSUFBSSxTQUFTLEtBQUssQ0FBQyxJQUFJLEdBQUcsR0FBRztJQUMzQixPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sSUFBSSxNQUNULENBQUMsb0NBQW9DLEVBQ25DLFNBQVMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJLE1BQzFCLENBQUMsZ0JBQWdCLEVBQUUsU0FBUyxLQUFLLENBQUMsSUFBSSxFQUFFLEVBQ3hDO0lBRU47RUFDRjtFQUVBLE1BQU0sU0FBUyxTQUFTLEtBQUssQ0FBQyxNQUFNLENBQ2pDLEtBQUssQ0FBQyxNQUNOLEdBQUcsQ0FBQyxDQUFDLE9BQVMsS0FBSyxJQUFJLElBQ3ZCLE1BQU0sQ0FBQyxDQUFDLE9BQVMsS0FBSyxNQUFNLEdBQUc7RUFFbEMsSUFBSSxPQUFPLFFBQVEsQ0FBQyw2QkFBNkI7SUFDL0MsT0FBTztNQUFFLElBQUk7TUFBTSxPQUFPO1FBQUUsVUFBVTtRQUFPO01BQU87SUFBRTtFQUN4RDtFQUVBLE1BQU0sUUFBUSxNQUFNLGNBQ2xCO0lBQUM7SUFBVTtJQUFTO0lBQXVCO0dBQTJCLEVBQ3RFO0VBRUYsSUFBSSxDQUFDLE1BQU0sRUFBRSxFQUFFO0lBQ2IsT0FBTztNQUFFLElBQUk7TUFBTyxPQUFPLE1BQU0sS0FBSztJQUFDO0VBQ3pDO0VBQ0EsSUFBSSxNQUFNLEtBQUssQ0FBQyxJQUFJLEtBQUssR0FBRztJQUMxQixPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sSUFBSSxNQUNULENBQUMsOENBQThDLEVBQzdDLE1BQU0sS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJLE1BQU0sQ0FBQyxnQkFBZ0IsRUFBRSxNQUFNLEtBQUssQ0FBQyxJQUFJLEVBQUUsRUFDbEU7SUFFTjtFQUNGO0VBRUEsT0FBTztJQUFFLElBQUk7SUFBTSxPQUFPO01BQUUsVUFBVTtNQUFNO0lBQU87RUFBRTtBQUN2RCJ9
// denoCacheMetadata=223245887904989484,3474529564919045006