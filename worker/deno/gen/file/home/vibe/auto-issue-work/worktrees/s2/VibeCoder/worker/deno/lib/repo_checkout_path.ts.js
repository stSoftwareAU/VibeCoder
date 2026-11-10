/**
 * Derive the local checkout path of a target repo from the parent work
 * directory and its `owner/repo` slug.
 *
 * The worker clones each target repo into `${workDir}/${repoName}` (see
 * `setupRepo` in `commands/git_operations.ts`). Callers that need to read
 * the checked-out tree directly — e.g. the best-practices linter-in-CI
 * pre-check (Issue #2880) — must derive this path rather than using the
 * parent `workDir`, which holds only the clones, not the repo files.
 *
 * Single source of truth for the derivation so the linter pre-check never
 * drifts from where `setupRepo` actually places the clone.
 *
 * @param workDir Parent directory containing the local clones (the
 *   worker's `config.workDir`, e.g. `~/auto-issue-work`).
 * @param repo Repository slug in `owner/repo` form.
 * @returns Absolute-or-relative path to the repo's checked-out root.
 */ export function repoCheckoutPath(workDir, repo) {
  const repoName = repo.split("/").pop() ?? repo;
  return `${workDir}/${repoName}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9yZXBvX2NoZWNrb3V0X3BhdGgudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBEZXJpdmUgdGhlIGxvY2FsIGNoZWNrb3V0IHBhdGggb2YgYSB0YXJnZXQgcmVwbyBmcm9tIHRoZSBwYXJlbnQgd29ya1xuICogZGlyZWN0b3J5IGFuZCBpdHMgYG93bmVyL3JlcG9gIHNsdWcuXG4gKlxuICogVGhlIHdvcmtlciBjbG9uZXMgZWFjaCB0YXJnZXQgcmVwbyBpbnRvIGAke3dvcmtEaXJ9LyR7cmVwb05hbWV9YCAoc2VlXG4gKiBgc2V0dXBSZXBvYCBpbiBgY29tbWFuZHMvZ2l0X29wZXJhdGlvbnMudHNgKS4gQ2FsbGVycyB0aGF0IG5lZWQgdG8gcmVhZFxuICogdGhlIGNoZWNrZWQtb3V0IHRyZWUgZGlyZWN0bHkg4oCUIGUuZy4gdGhlIGJlc3QtcHJhY3RpY2VzIGxpbnRlci1pbi1DSVxuICogcHJlLWNoZWNrIChJc3N1ZSAjMjg4MCkg4oCUIG11c3QgZGVyaXZlIHRoaXMgcGF0aCByYXRoZXIgdGhhbiB1c2luZyB0aGVcbiAqIHBhcmVudCBgd29ya0RpcmAsIHdoaWNoIGhvbGRzIG9ubHkgdGhlIGNsb25lcywgbm90IHRoZSByZXBvIGZpbGVzLlxuICpcbiAqIFNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGggZm9yIHRoZSBkZXJpdmF0aW9uIHNvIHRoZSBsaW50ZXIgcHJlLWNoZWNrIG5ldmVyXG4gKiBkcmlmdHMgZnJvbSB3aGVyZSBgc2V0dXBSZXBvYCBhY3R1YWxseSBwbGFjZXMgdGhlIGNsb25lLlxuICpcbiAqIEBwYXJhbSB3b3JrRGlyIFBhcmVudCBkaXJlY3RvcnkgY29udGFpbmluZyB0aGUgbG9jYWwgY2xvbmVzICh0aGVcbiAqICAgd29ya2VyJ3MgYGNvbmZpZy53b3JrRGlyYCwgZS5nLiBgfi9hdXRvLWlzc3VlLXdvcmtgKS5cbiAqIEBwYXJhbSByZXBvIFJlcG9zaXRvcnkgc2x1ZyBpbiBgb3duZXIvcmVwb2AgZm9ybS5cbiAqIEByZXR1cm5zIEFic29sdXRlLW9yLXJlbGF0aXZlIHBhdGggdG8gdGhlIHJlcG8ncyBjaGVja2VkLW91dCByb290LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVwb0NoZWNrb3V0UGF0aCh3b3JrRGlyOiBzdHJpbmcsIHJlcG86IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHJlcG9OYW1lID0gcmVwby5zcGxpdChcIi9cIikucG9wKCkgPz8gcmVwbztcbiAgcmV0dXJuIGAke3dvcmtEaXJ9LyR7cmVwb05hbWV9YDtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FpQkMsR0FDRCxPQUFPLFNBQVMsaUJBQWlCLE9BQWUsRUFBRSxJQUFZO0VBQzVELE1BQU0sV0FBVyxLQUFLLEtBQUssQ0FBQyxLQUFLLEdBQUcsTUFBTTtFQUMxQyxPQUFPLEdBQUcsUUFBUSxDQUFDLEVBQUUsVUFBVTtBQUNqQyJ9
// denoCacheMetadata=15428877515133898168,8262416595929519453