/**
 * Which side of a conflicted file still exists, and what that means for a
 * resolution that takes the incoming branch (Issue #1048).
 *
 * The milestone sync resolves conflicts by taking the default branch's side.
 * For a *content* conflict `git checkout --theirs <file>` does that. For a
 * **modify/delete** conflict — the branch edited a file the default branch
 * deleted — there is no incoming side to check out: the command fails, the
 * working-tree copy (the branch's own edit) is staged instead, and the file
 * the default branch deliberately removed comes back. That is how 1984 lines
 * of a deleted subsystem returned to `milestone/863`.
 *
 * Taking the incoming side of a modify/delete therefore means **deleting the
 * file**, and this module is the one place the milestone sync makes that
 * decision. (The rebase resolver in `git_conflict_resolution.ts` picks a side
 * too, but stages nothing when `checkout --<side>` fails, so it stalls the
 * rebase rather than reviving a file — a different, already-loud outcome.)
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */ /** Which merge stages `git ls-files -u` reports for a conflicted path. */ /**
 * Parse `git ls-files -u -- <path>` output into the stages it reports.
 *
 * Each line is `<mode> <sha> <stage>\t<path>`, one per stage present.
 */ export function parseUnmergedStages(output) {
  const stages = {
    base: false,
    ours: false,
    theirs: false
  };
  for (const line of output.split("\n")){
    const fields = line.split("\t")[0]?.trim().split(/\s+/) ?? [];
    switch(fields[2]){
      case "1":
        stages.base = true;
        break;
      case "2":
        stages.ours = true;
        break;
      case "3":
        stages.theirs = true;
        break;
    }
  }
  return stages;
}
/** Whether any stage at all was reported — none means the read failed. */ export function hasAnyStage(stages) {
  return stages.base || stages.ours || stages.theirs;
}
/**
 * Decide how to resolve a conflicted path in favour of the incoming branch.
 *
 * No incoming stage means the incoming branch deleted the file, so the
 * resolution is a delete. Keeping it would revive a file the incoming branch
 * decided to remove — the wrong default, and a silent one.
 */ export function resolveTowardsIncoming(stages) {
  return stages.theirs ? "take-incoming" : "delete";
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9tZXJnZV9jb25mbGljdF9zdGFnZXMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBXaGljaCBzaWRlIG9mIGEgY29uZmxpY3RlZCBmaWxlIHN0aWxsIGV4aXN0cywgYW5kIHdoYXQgdGhhdCBtZWFucyBmb3IgYVxuICogcmVzb2x1dGlvbiB0aGF0IHRha2VzIHRoZSBpbmNvbWluZyBicmFuY2ggKElzc3VlICMxMDQ4KS5cbiAqXG4gKiBUaGUgbWlsZXN0b25lIHN5bmMgcmVzb2x2ZXMgY29uZmxpY3RzIGJ5IHRha2luZyB0aGUgZGVmYXVsdCBicmFuY2gncyBzaWRlLlxuICogRm9yIGEgKmNvbnRlbnQqIGNvbmZsaWN0IGBnaXQgY2hlY2tvdXQgLS10aGVpcnMgPGZpbGU+YCBkb2VzIHRoYXQuIEZvciBhXG4gKiAqKm1vZGlmeS9kZWxldGUqKiBjb25mbGljdCDigJQgdGhlIGJyYW5jaCBlZGl0ZWQgYSBmaWxlIHRoZSBkZWZhdWx0IGJyYW5jaFxuICogZGVsZXRlZCDigJQgdGhlcmUgaXMgbm8gaW5jb21pbmcgc2lkZSB0byBjaGVjayBvdXQ6IHRoZSBjb21tYW5kIGZhaWxzLCB0aGVcbiAqIHdvcmtpbmctdHJlZSBjb3B5ICh0aGUgYnJhbmNoJ3Mgb3duIGVkaXQpIGlzIHN0YWdlZCBpbnN0ZWFkLCBhbmQgdGhlIGZpbGVcbiAqIHRoZSBkZWZhdWx0IGJyYW5jaCBkZWxpYmVyYXRlbHkgcmVtb3ZlZCBjb21lcyBiYWNrLiBUaGF0IGlzIGhvdyAxOTg0IGxpbmVzXG4gKiBvZiBhIGRlbGV0ZWQgc3Vic3lzdGVtIHJldHVybmVkIHRvIGBtaWxlc3RvbmUvODYzYC5cbiAqXG4gKiBUYWtpbmcgdGhlIGluY29taW5nIHNpZGUgb2YgYSBtb2RpZnkvZGVsZXRlIHRoZXJlZm9yZSBtZWFucyAqKmRlbGV0aW5nIHRoZVxuICogZmlsZSoqLCBhbmQgdGhpcyBtb2R1bGUgaXMgdGhlIG9uZSBwbGFjZSB0aGUgbWlsZXN0b25lIHN5bmMgbWFrZXMgdGhhdFxuICogZGVjaXNpb24uIChUaGUgcmViYXNlIHJlc29sdmVyIGluIGBnaXRfY29uZmxpY3RfcmVzb2x1dGlvbi50c2AgcGlja3MgYSBzaWRlXG4gKiB0b28sIGJ1dCBzdGFnZXMgbm90aGluZyB3aGVuIGBjaGVja291dCAtLTxzaWRlPmAgZmFpbHMsIHNvIGl0IHN0YWxscyB0aGVcbiAqIHJlYmFzZSByYXRoZXIgdGhhbiByZXZpdmluZyBhIGZpbGUg4oCUIGEgZGlmZmVyZW50LCBhbHJlYWR5LWxvdWQgb3V0Y29tZS4pXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbikuXG4gKi9cblxuLyoqIFdoaWNoIG1lcmdlIHN0YWdlcyBgZ2l0IGxzLWZpbGVzIC11YCByZXBvcnRzIGZvciBhIGNvbmZsaWN0ZWQgcGF0aC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgVW5tZXJnZWRTdGFnZXMge1xuICAvKiogU3RhZ2UgMSDigJQgdGhlIG1lcmdlIGJhc2UuICovXG4gIGJhc2U6IGJvb2xlYW47XG4gIC8qKiBTdGFnZSAyIOKAlCBcIm91cnNcIiwgdGhlIGJyYW5jaCBiZWluZyBtZXJnZWQgaW50by4gKi9cbiAgb3VyczogYm9vbGVhbjtcbiAgLyoqIFN0YWdlIDMg4oCUIFwidGhlaXJzXCIsIHRoZSBpbmNvbWluZyBicmFuY2guICovXG4gIHRoZWlyczogYm9vbGVhbjtcbn1cblxuLyoqIEhvdyB0byByZXNvbHZlIG9uZSBjb25mbGljdGVkIHBhdGggaW4gZmF2b3VyIG9mIHRoZSBpbmNvbWluZyBicmFuY2guICovXG5leHBvcnQgdHlwZSBJbmNvbWluZ1Jlc29sdXRpb24gPVxuICAvKiogVGhlIGluY29taW5nIGJyYW5jaCBkZWxldGVkIGl0IOKAlCBkZWxldGUgaXQgaGVyZSB0b28uICovXG4gIHwgXCJkZWxldGVcIlxuICAvKiogVGhlIGluY29taW5nIGJyYW5jaCBoYXMgYSB2ZXJzaW9uIOKAlCBjaGVjayB0aGF0IHZlcnNpb24gb3V0LiAqL1xuICB8IFwidGFrZS1pbmNvbWluZ1wiO1xuXG4vKipcbiAqIFBhcnNlIGBnaXQgbHMtZmlsZXMgLXUgLS0gPHBhdGg+YCBvdXRwdXQgaW50byB0aGUgc3RhZ2VzIGl0IHJlcG9ydHMuXG4gKlxuICogRWFjaCBsaW5lIGlzIGA8bW9kZT4gPHNoYT4gPHN0YWdlPlxcdDxwYXRoPmAsIG9uZSBwZXIgc3RhZ2UgcHJlc2VudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlVW5tZXJnZWRTdGFnZXMob3V0cHV0OiBzdHJpbmcpOiBVbm1lcmdlZFN0YWdlcyB7XG4gIGNvbnN0IHN0YWdlczogVW5tZXJnZWRTdGFnZXMgPSB7IGJhc2U6IGZhbHNlLCBvdXJzOiBmYWxzZSwgdGhlaXJzOiBmYWxzZSB9O1xuICBmb3IgKGNvbnN0IGxpbmUgb2Ygb3V0cHV0LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgY29uc3QgZmllbGRzID0gbGluZS5zcGxpdChcIlxcdFwiKVswXT8udHJpbSgpLnNwbGl0KC9cXHMrLykgPz8gW107XG4gICAgc3dpdGNoIChmaWVsZHNbMl0pIHtcbiAgICAgIGNhc2UgXCIxXCI6XG4gICAgICAgIHN0YWdlcy5iYXNlID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiMlwiOlxuICAgICAgICBzdGFnZXMub3VycyA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIjNcIjpcbiAgICAgICAgc3RhZ2VzLnRoZWlycyA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuICByZXR1cm4gc3RhZ2VzO1xufVxuXG4vKiogV2hldGhlciBhbnkgc3RhZ2UgYXQgYWxsIHdhcyByZXBvcnRlZCDigJQgbm9uZSBtZWFucyB0aGUgcmVhZCBmYWlsZWQuICovXG5leHBvcnQgZnVuY3Rpb24gaGFzQW55U3RhZ2Uoc3RhZ2VzOiBVbm1lcmdlZFN0YWdlcyk6IGJvb2xlYW4ge1xuICByZXR1cm4gc3RhZ2VzLmJhc2UgfHwgc3RhZ2VzLm91cnMgfHwgc3RhZ2VzLnRoZWlycztcbn1cblxuLyoqXG4gKiBEZWNpZGUgaG93IHRvIHJlc29sdmUgYSBjb25mbGljdGVkIHBhdGggaW4gZmF2b3VyIG9mIHRoZSBpbmNvbWluZyBicmFuY2guXG4gKlxuICogTm8gaW5jb21pbmcgc3RhZ2UgbWVhbnMgdGhlIGluY29taW5nIGJyYW5jaCBkZWxldGVkIHRoZSBmaWxlLCBzbyB0aGVcbiAqIHJlc29sdXRpb24gaXMgYSBkZWxldGUuIEtlZXBpbmcgaXQgd291bGQgcmV2aXZlIGEgZmlsZSB0aGUgaW5jb21pbmcgYnJhbmNoXG4gKiBkZWNpZGVkIHRvIHJlbW92ZSDigJQgdGhlIHdyb25nIGRlZmF1bHQsIGFuZCBhIHNpbGVudCBvbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlVG93YXJkc0luY29taW5nKFxuICBzdGFnZXM6IFVubWVyZ2VkU3RhZ2VzLFxuKTogSW5jb21pbmdSZXNvbHV0aW9uIHtcbiAgcmV0dXJuIHN0YWdlcy50aGVpcnMgPyBcInRha2UtaW5jb21pbmdcIiA6IFwiZGVsZXRlXCI7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FtQkMsR0FFRCx3RUFBd0UsR0FpQnhFOzs7O0NBSUMsR0FDRCxPQUFPLFNBQVMsb0JBQW9CLE1BQWM7RUFDaEQsTUFBTSxTQUF5QjtJQUFFLE1BQU07SUFBTyxNQUFNO0lBQU8sUUFBUTtFQUFNO0VBQ3pFLEtBQUssTUFBTSxRQUFRLE9BQU8sS0FBSyxDQUFDLE1BQU87SUFDckMsTUFBTSxTQUFTLEtBQUssS0FBSyxDQUFDLEtBQUssQ0FBQyxFQUFFLEVBQUUsT0FBTyxNQUFNLFVBQVUsRUFBRTtJQUM3RCxPQUFRLE1BQU0sQ0FBQyxFQUFFO01BQ2YsS0FBSztRQUNILE9BQU8sSUFBSSxHQUFHO1FBQ2Q7TUFDRixLQUFLO1FBQ0gsT0FBTyxJQUFJLEdBQUc7UUFDZDtNQUNGLEtBQUs7UUFDSCxPQUFPLE1BQU0sR0FBRztRQUNoQjtJQUNKO0VBQ0Y7RUFDQSxPQUFPO0FBQ1Q7QUFFQSx3RUFBd0UsR0FDeEUsT0FBTyxTQUFTLFlBQVksTUFBc0I7RUFDaEQsT0FBTyxPQUFPLElBQUksSUFBSSxPQUFPLElBQUksSUFBSSxPQUFPLE1BQU07QUFDcEQ7QUFFQTs7Ozs7O0NBTUMsR0FDRCxPQUFPLFNBQVMsdUJBQ2QsTUFBc0I7RUFFdEIsT0FBTyxPQUFPLE1BQU0sR0FBRyxrQkFBa0I7QUFDM0MifQ==
// denoCacheMetadata=8262562098072443176,930095942056440495