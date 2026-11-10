/**
 * Worker-owned state file shapes (Issue #1661, part of #1644; Issue #1711).
 *
 * The worker writes a handful of its own state files into the directory it
 * runs from. When that directory happens to be a repository clone, `git add
 * -A` at the final-mile chokepoint stages them and the pre-commit safety gate
 * (Issue #1758) refuses the whole commit — losing genuine work over a file the
 * worker itself dropped there.
 *
 * The agent's PR reply belongs to the same family (Issue #1711): the worker's
 * own CI-fix, PR-feedback and spelling prompts ask the agent to write its reply
 * into `.pr_response_message` at the clone root, and the worker reads and
 * removes it only *after* the push. On a repo with no `.*` ignore rule the
 * final-mile commit staged it in between, and the gate refused the fix it
 * was there to describe.
 *
 * This module is the single source of truth for what those files look like, so
 * the writers (`heartbeat_storage.ts`), the reader (`pr_branch_preparation.ts`)
 * and the chokepoint that unstages them (`git_push.ts`) cannot drift apart.
 *
 * The matcher is deliberately strict: only an exact top-level name counts, so
 * a nested path or a looser shape is never silently dropped from a commit.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ /** Filename prefix of the per-issue heartbeat file. */ export const HEARTBEAT_FILE_PREFIX = ".heartbeat_";
/** Filename prefix of the per-issue heartbeat marker-state file (Issue #1454). */ export const HEARTBEAT_MARKER_FILE_PREFIX = ".heartbeat-marker_";
/** Exact filename of the cached default-branch name (Issue #1269). */ export const DEFAULT_BRANCH_CACHE_FILE = ".vibe_default_branch";
// ^ No longer written by the worker: `setupRepo` keeps the cache in
// `.git/vibe/default_branch` since Issue #1652. Kept in the matcher so a copy
// an older worker left in a clone is still unstaged rather than committed.
/**
 * Exact filename of the agent's PR reply (Issue #1711). Written by the agent
 * at the prompts' request; read and consumed by `readPrResponseMessage` after
 * the push.
 */ export const PR_RESPONSE_MESSAGE_FILE = ".pr_response_message";
/**
 * The `<owner>_<repo>_<issue>` tail both heartbeat prefixes carry — the repo
 * with its slash replaced by an underscore, then the issue number.
 */ const REPO_AND_ISSUE_PATTERN = /^[A-Za-z0-9._-]+_\d+$/;
/**
 * Is `path` a worker-owned state file that must never reach a commit?
 *
 * @param path Repository-relative path, exactly as `git diff --cached
 *   --name-only` reports it.
 * @returns `true` only for an exact top-level worker state filename —
 *   `.heartbeat_<owner>_<repo>_<n>`, `.heartbeat-marker_<owner>_<repo>_<n>`,
 *   `.vibe_default_branch` or `.pr_response_message`. Nested paths
 *   (`.heartbeat_a_1/x`, `foo/.pr_response_message`), truncated or extended
 *   shapes (`.heartbeat_a`, `.pr_response_message.bak`) and everything else
 *   are `false`.
 */ export function isWorkerStatePath(path) {
  if (path === DEFAULT_BRANCH_CACHE_FILE) return true;
  if (path === PR_RESPONSE_MESSAGE_FILE) return true;
  for (const prefix of [
    HEARTBEAT_FILE_PREFIX,
    HEARTBEAT_MARKER_FILE_PREFIX
  ]){
    if (path.startsWith(prefix)) {
      return REPO_AND_ISSUE_PATTERN.test(path.slice(prefix.length));
    }
  }
  return false;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi93b3JrZXJfc3RhdGVfcGF0aHMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBXb3JrZXItb3duZWQgc3RhdGUgZmlsZSBzaGFwZXMgKElzc3VlICMxNjYxLCBwYXJ0IG9mICMxNjQ0OyBJc3N1ZSAjMTcxMSkuXG4gKlxuICogVGhlIHdvcmtlciB3cml0ZXMgYSBoYW5kZnVsIG9mIGl0cyBvd24gc3RhdGUgZmlsZXMgaW50byB0aGUgZGlyZWN0b3J5IGl0XG4gKiBydW5zIGZyb20uIFdoZW4gdGhhdCBkaXJlY3RvcnkgaGFwcGVucyB0byBiZSBhIHJlcG9zaXRvcnkgY2xvbmUsIGBnaXQgYWRkXG4gKiAtQWAgYXQgdGhlIGZpbmFsLW1pbGUgY2hva2Vwb2ludCBzdGFnZXMgdGhlbSBhbmQgdGhlIHByZS1jb21taXQgc2FmZXR5IGdhdGVcbiAqIChJc3N1ZSAjMTc1OCkgcmVmdXNlcyB0aGUgd2hvbGUgY29tbWl0IOKAlCBsb3NpbmcgZ2VudWluZSB3b3JrIG92ZXIgYSBmaWxlIHRoZVxuICogd29ya2VyIGl0c2VsZiBkcm9wcGVkIHRoZXJlLlxuICpcbiAqIFRoZSBhZ2VudCdzIFBSIHJlcGx5IGJlbG9uZ3MgdG8gdGhlIHNhbWUgZmFtaWx5IChJc3N1ZSAjMTcxMSk6IHRoZSB3b3JrZXInc1xuICogb3duIENJLWZpeCwgUFItZmVlZGJhY2sgYW5kIHNwZWxsaW5nIHByb21wdHMgYXNrIHRoZSBhZ2VudCB0byB3cml0ZSBpdHMgcmVwbHlcbiAqIGludG8gYC5wcl9yZXNwb25zZV9tZXNzYWdlYCBhdCB0aGUgY2xvbmUgcm9vdCwgYW5kIHRoZSB3b3JrZXIgcmVhZHMgYW5kXG4gKiByZW1vdmVzIGl0IG9ubHkgKmFmdGVyKiB0aGUgcHVzaC4gT24gYSByZXBvIHdpdGggbm8gYC4qYCBpZ25vcmUgcnVsZSB0aGVcbiAqIGZpbmFsLW1pbGUgY29tbWl0IHN0YWdlZCBpdCBpbiBiZXR3ZWVuLCBhbmQgdGhlIGdhdGUgcmVmdXNlZCB0aGUgZml4IGl0XG4gKiB3YXMgdGhlcmUgdG8gZGVzY3JpYmUuXG4gKlxuICogVGhpcyBtb2R1bGUgaXMgdGhlIHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGggZm9yIHdoYXQgdGhvc2UgZmlsZXMgbG9vayBsaWtlLCBzb1xuICogdGhlIHdyaXRlcnMgKGBoZWFydGJlYXRfc3RvcmFnZS50c2ApLCB0aGUgcmVhZGVyIChgcHJfYnJhbmNoX3ByZXBhcmF0aW9uLnRzYClcbiAqIGFuZCB0aGUgY2hva2Vwb2ludCB0aGF0IHVuc3RhZ2VzIHRoZW0gKGBnaXRfcHVzaC50c2ApIGNhbm5vdCBkcmlmdCBhcGFydC5cbiAqXG4gKiBUaGUgbWF0Y2hlciBpcyBkZWxpYmVyYXRlbHkgc3RyaWN0OiBvbmx5IGFuIGV4YWN0IHRvcC1sZXZlbCBuYW1lIGNvdW50cywgc29cbiAqIGEgbmVzdGVkIHBhdGggb3IgYSBsb29zZXIgc2hhcGUgaXMgbmV2ZXIgc2lsZW50bHkgZHJvcHBlZCBmcm9tIGEgY29tbWl0LlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbi8qKiBGaWxlbmFtZSBwcmVmaXggb2YgdGhlIHBlci1pc3N1ZSBoZWFydGJlYXQgZmlsZS4gKi9cbmV4cG9ydCBjb25zdCBIRUFSVEJFQVRfRklMRV9QUkVGSVggPSBcIi5oZWFydGJlYXRfXCI7XG5cbi8qKiBGaWxlbmFtZSBwcmVmaXggb2YgdGhlIHBlci1pc3N1ZSBoZWFydGJlYXQgbWFya2VyLXN0YXRlIGZpbGUgKElzc3VlICMxNDU0KS4gKi9cbmV4cG9ydCBjb25zdCBIRUFSVEJFQVRfTUFSS0VSX0ZJTEVfUFJFRklYID0gXCIuaGVhcnRiZWF0LW1hcmtlcl9cIjtcblxuLyoqIEV4YWN0IGZpbGVuYW1lIG9mIHRoZSBjYWNoZWQgZGVmYXVsdC1icmFuY2ggbmFtZSAoSXNzdWUgIzEyNjkpLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfQlJBTkNIX0NBQ0hFX0ZJTEUgPSBcIi52aWJlX2RlZmF1bHRfYnJhbmNoXCI7XG4vLyBeIE5vIGxvbmdlciB3cml0dGVuIGJ5IHRoZSB3b3JrZXI6IGBzZXR1cFJlcG9gIGtlZXBzIHRoZSBjYWNoZSBpblxuLy8gYC5naXQvdmliZS9kZWZhdWx0X2JyYW5jaGAgc2luY2UgSXNzdWUgIzE2NTIuIEtlcHQgaW4gdGhlIG1hdGNoZXIgc28gYSBjb3B5XG4vLyBhbiBvbGRlciB3b3JrZXIgbGVmdCBpbiBhIGNsb25lIGlzIHN0aWxsIHVuc3RhZ2VkIHJhdGhlciB0aGFuIGNvbW1pdHRlZC5cblxuLyoqXG4gKiBFeGFjdCBmaWxlbmFtZSBvZiB0aGUgYWdlbnQncyBQUiByZXBseSAoSXNzdWUgIzE3MTEpLiBXcml0dGVuIGJ5IHRoZSBhZ2VudFxuICogYXQgdGhlIHByb21wdHMnIHJlcXVlc3Q7IHJlYWQgYW5kIGNvbnN1bWVkIGJ5IGByZWFkUHJSZXNwb25zZU1lc3NhZ2VgIGFmdGVyXG4gKiB0aGUgcHVzaC5cbiAqL1xuZXhwb3J0IGNvbnN0IFBSX1JFU1BPTlNFX01FU1NBR0VfRklMRSA9IFwiLnByX3Jlc3BvbnNlX21lc3NhZ2VcIjtcblxuLyoqXG4gKiBUaGUgYDxvd25lcj5fPHJlcG8+Xzxpc3N1ZT5gIHRhaWwgYm90aCBoZWFydGJlYXQgcHJlZml4ZXMgY2Fycnkg4oCUIHRoZSByZXBvXG4gKiB3aXRoIGl0cyBzbGFzaCByZXBsYWNlZCBieSBhbiB1bmRlcnNjb3JlLCB0aGVuIHRoZSBpc3N1ZSBudW1iZXIuXG4gKi9cbmNvbnN0IFJFUE9fQU5EX0lTU1VFX1BBVFRFUk4gPSAvXltBLVphLXowLTkuXy1dK19cXGQrJC87XG5cbi8qKlxuICogSXMgYHBhdGhgIGEgd29ya2VyLW93bmVkIHN0YXRlIGZpbGUgdGhhdCBtdXN0IG5ldmVyIHJlYWNoIGEgY29tbWl0P1xuICpcbiAqIEBwYXJhbSBwYXRoIFJlcG9zaXRvcnktcmVsYXRpdmUgcGF0aCwgZXhhY3RseSBhcyBgZ2l0IGRpZmYgLS1jYWNoZWRcbiAqICAgLS1uYW1lLW9ubHlgIHJlcG9ydHMgaXQuXG4gKiBAcmV0dXJucyBgdHJ1ZWAgb25seSBmb3IgYW4gZXhhY3QgdG9wLWxldmVsIHdvcmtlciBzdGF0ZSBmaWxlbmFtZSDigJRcbiAqICAgYC5oZWFydGJlYXRfPG93bmVyPl88cmVwbz5fPG4+YCwgYC5oZWFydGJlYXQtbWFya2VyXzxvd25lcj5fPHJlcG8+XzxuPmAsXG4gKiAgIGAudmliZV9kZWZhdWx0X2JyYW5jaGAgb3IgYC5wcl9yZXNwb25zZV9tZXNzYWdlYC4gTmVzdGVkIHBhdGhzXG4gKiAgIChgLmhlYXJ0YmVhdF9hXzEveGAsIGBmb28vLnByX3Jlc3BvbnNlX21lc3NhZ2VgKSwgdHJ1bmNhdGVkIG9yIGV4dGVuZGVkXG4gKiAgIHNoYXBlcyAoYC5oZWFydGJlYXRfYWAsIGAucHJfcmVzcG9uc2VfbWVzc2FnZS5iYWtgKSBhbmQgZXZlcnl0aGluZyBlbHNlXG4gKiAgIGFyZSBgZmFsc2VgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNXb3JrZXJTdGF0ZVBhdGgocGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmIChwYXRoID09PSBERUZBVUxUX0JSQU5DSF9DQUNIRV9GSUxFKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKHBhdGggPT09IFBSX1JFU1BPTlNFX01FU1NBR0VfRklMRSkgcmV0dXJuIHRydWU7XG5cbiAgZm9yIChcbiAgICBjb25zdCBwcmVmaXggb2YgW0hFQVJUQkVBVF9GSUxFX1BSRUZJWCwgSEVBUlRCRUFUX01BUktFUl9GSUxFX1BSRUZJWF1cbiAgKSB7XG4gICAgaWYgKHBhdGguc3RhcnRzV2l0aChwcmVmaXgpKSB7XG4gICAgICByZXR1cm4gUkVQT19BTkRfSVNTVUVfUEFUVEVSTi50ZXN0KHBhdGguc2xpY2UocHJlZml4Lmxlbmd0aCkpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBd0JDLEdBRUQscURBQXFELEdBQ3JELE9BQU8sTUFBTSx3QkFBd0IsY0FBYztBQUVuRCxnRkFBZ0YsR0FDaEYsT0FBTyxNQUFNLCtCQUErQixxQkFBcUI7QUFFakUsb0VBQW9FLEdBQ3BFLE9BQU8sTUFBTSw0QkFBNEIsdUJBQXVCO0FBQ2hFLG9FQUFvRTtBQUNwRSw4RUFBOEU7QUFDOUUsMkVBQTJFO0FBRTNFOzs7O0NBSUMsR0FDRCxPQUFPLE1BQU0sMkJBQTJCLHVCQUF1QjtBQUUvRDs7O0NBR0MsR0FDRCxNQUFNLHlCQUF5QjtBQUUvQjs7Ozs7Ozs7Ozs7Q0FXQyxHQUNELE9BQU8sU0FBUyxrQkFBa0IsSUFBWTtFQUM1QyxJQUFJLFNBQVMsMkJBQTJCLE9BQU87RUFDL0MsSUFBSSxTQUFTLDBCQUEwQixPQUFPO0VBRTlDLEtBQ0UsTUFBTSxVQUFVO0lBQUM7SUFBdUI7R0FBNkIsQ0FDckU7SUFDQSxJQUFJLEtBQUssVUFBVSxDQUFDLFNBQVM7TUFDM0IsT0FBTyx1QkFBdUIsSUFBSSxDQUFDLEtBQUssS0FBSyxDQUFDLE9BQU8sTUFBTTtJQUM3RDtFQUNGO0VBRUEsT0FBTztBQUNUIn0=
// denoCacheMetadata=6468258929958398861,4479665231471932571