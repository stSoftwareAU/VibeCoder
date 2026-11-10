/**
 * Disarm auto-merge on a pull request (Issue #3433).
 *
 * Shared by the orphan-bound hold and the milestone-fix sweep so a PR that must
 * not merge never keeps a live auto-merge.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */ import { logAt } from "./log_sink.ts";
/**
 * Run `gh pr merge <N> --repo <repo> --disable-auto`.
 *
 * Never throws and is never silent: a failure (GitHub errors when auto-merge
 * was never enabled) is logged as a warning.
 *
 * @returns true when auto-merge was disarmed, false when the call failed.
 */ export async function disarmAutoMerge(repo, prNumber, ghCommandFn, log) {
  try {
    await ghCommandFn([
      "pr",
      "merge",
      String(prNumber),
      "--repo",
      repo,
      "--disable-auto"
    ]);
    return true;
  } catch (err) {
    logAt(log, "warn", `could not disarm auto-merge on ${repo}#${prNumber}: ${err instanceof Error ? err.message : String(err)} (Issue #3433)`);
    return false;
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9hdXRvX21lcmdlX2Rpc2FybS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIERpc2FybSBhdXRvLW1lcmdlIG9uIGEgcHVsbCByZXF1ZXN0IChJc3N1ZSAjMzQzMykuXG4gKlxuICogU2hhcmVkIGJ5IHRoZSBvcnBoYW4tYm91bmQgaG9sZCBhbmQgdGhlIG1pbGVzdG9uZS1maXggc3dlZXAgc28gYSBQUiB0aGF0IG11c3RcbiAqIG5vdCBtZXJnZSBuZXZlciBrZWVwcyBhIGxpdmUgYXV0by1tZXJnZS5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB7IGxvZ0F0IH0gZnJvbSBcIi4vbG9nX3NpbmsudHNcIjtcblxuLyoqXG4gKiBSdW4gYGdoIHByIG1lcmdlIDxOPiAtLXJlcG8gPHJlcG8+IC0tZGlzYWJsZS1hdXRvYC5cbiAqXG4gKiBOZXZlciB0aHJvd3MgYW5kIGlzIG5ldmVyIHNpbGVudDogYSBmYWlsdXJlIChHaXRIdWIgZXJyb3JzIHdoZW4gYXV0by1tZXJnZVxuICogd2FzIG5ldmVyIGVuYWJsZWQpIGlzIGxvZ2dlZCBhcyBhIHdhcm5pbmcuXG4gKlxuICogQHJldHVybnMgdHJ1ZSB3aGVuIGF1dG8tbWVyZ2Ugd2FzIGRpc2FybWVkLCBmYWxzZSB3aGVuIHRoZSBjYWxsIGZhaWxlZC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRpc2FybUF1dG9NZXJnZShcbiAgcmVwbzogc3RyaW5nLFxuICBwck51bWJlcjogbnVtYmVyLFxuICBnaENvbW1hbmRGbjogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4sXG4gIGxvZzogKG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZCxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICB0cnkge1xuICAgIGF3YWl0IGdoQ29tbWFuZEZuKFtcbiAgICAgIFwicHJcIixcbiAgICAgIFwibWVyZ2VcIixcbiAgICAgIFN0cmluZyhwck51bWJlciksXG4gICAgICBcIi0tcmVwb1wiLFxuICAgICAgcmVwbyxcbiAgICAgIFwiLS1kaXNhYmxlLWF1dG9cIixcbiAgICBdKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nQXQoXG4gICAgICBsb2csXG4gICAgICBcIndhcm5cIixcbiAgICAgIGBjb3VsZCBub3QgZGlzYXJtIGF1dG8tbWVyZ2Ugb24gJHtyZXBvfSMke3ByTnVtYmVyfTogJHtcbiAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICB9IChJc3N1ZSAjMzQzMylgLFxuICAgICk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Q0FPQyxHQUVELFNBQVMsS0FBSyxRQUFRLGdCQUFnQjtBQUV0Qzs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxlQUFlLGdCQUNwQixJQUFZLEVBQ1osUUFBZ0IsRUFDaEIsV0FBZ0QsRUFDaEQsR0FBOEI7RUFFOUIsSUFBSTtJQUNGLE1BQU0sWUFBWTtNQUNoQjtNQUNBO01BQ0EsT0FBTztNQUNQO01BQ0E7TUFDQTtLQUNEO0lBQ0QsT0FBTztFQUNULEVBQUUsT0FBTyxLQUFLO0lBQ1osTUFDRSxLQUNBLFFBQ0EsQ0FBQywrQkFBK0IsRUFBRSxLQUFLLENBQUMsRUFBRSxTQUFTLEVBQUUsRUFDbkQsZUFBZSxRQUFRLElBQUksT0FBTyxHQUFHLE9BQU8sS0FDN0MsY0FBYyxDQUFDO0lBRWxCLE9BQU87RUFDVDtBQUNGIn0=
// denoCacheMetadata=18272539888871850739,1718682573766218122