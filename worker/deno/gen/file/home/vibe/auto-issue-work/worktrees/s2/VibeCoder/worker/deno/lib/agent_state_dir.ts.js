/**
 * Where the coding agent's own state lives (Issue #1407).
 *
 * The agent's configuration, session stores and memories used to sit *inside*
 * the work directory, beside every repository clone, the audit journal and
 * the caches. That single shared volume is what made bounding the work volume
 * expensive: any grant tightened there risked locking the agent out of its own
 * state, so every proposal escalated to per-slot accounts and groups.
 *
 * The two concerns are separable, and separating them is the whole change:
 *
 * - **The agent must be able to write its own state.** Its configuration, the
 *   transcripts `--resume` replays, and the per-repository session stores.
 *   Containment that stops the agent doing its job is not containment, it is
 *   a broken worker — see the containment goal in `docs/THREAT-MODEL.md`.
 * - **The agent should not need to write anything else.** With its state
 *   elsewhere, the work volume can be tightened on its own merits without
 *   that tightening ever reaching the agent's own store.
 *
 * So the store is a **sibling** of `workDir`, never a child, on its own named
 * volume — exactly the shape `content_approval_state_dir.ts` already uses for
 * the approval baseline, and for a closely related reason: a directory inside
 * the work tree is one that `nukeWorkDir()` deletes wholesale under disk
 * pressure, and one an agent-driven `rm` inside the work tree can reach.
 *
 * Deriving it from `workDir` rather than from `HOME` keeps each worker
 * identity isolated — fleet members have separate `HOME`s and so separate work
 * directories — without depending on `HOME` being set at all.
 *
 * ## Session isolation is unchanged
 *
 * Session stores were already keyed per owner, per repository and per work
 * stream (`session_manager.ts`), so runs on different repositories could not
 * confuse each other before this change and cannot now. Only the root moves.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */ /** Suffix appended to `workDir` to name the agent-state root. */ const AGENT_STATE_DIR_SUFFIX = "-agent-state";
/**
 * Resolve the root holding the coding agent's own state.
 *
 * `""` is the explicit *unconfigured* sentinel, matching
 * `resolveContentApprovalStateDir`: `workDir` names no directory the store
 * can sit beside. Callers fall back to their previous behaviour on it rather
 * than inventing a relative directory.
 *
 * @param workDir - The agent-writable work directory (`config.workDir`).
 * @returns The agent-state root, or `""` when `workDir` names no directory
 *   (unset, whitespace-only, or `/`).
 */ export function resolveAgentStateDir(workDir) {
  const trimmed = workDir.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return `${trimmed}${AGENT_STATE_DIR_SUFFIX}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9hZ2VudF9zdGF0ZV9kaXIudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBXaGVyZSB0aGUgY29kaW5nIGFnZW50J3Mgb3duIHN0YXRlIGxpdmVzIChJc3N1ZSAjMTQwNykuXG4gKlxuICogVGhlIGFnZW50J3MgY29uZmlndXJhdGlvbiwgc2Vzc2lvbiBzdG9yZXMgYW5kIG1lbW9yaWVzIHVzZWQgdG8gc2l0ICppbnNpZGUqXG4gKiB0aGUgd29yayBkaXJlY3RvcnksIGJlc2lkZSBldmVyeSByZXBvc2l0b3J5IGNsb25lLCB0aGUgYXVkaXQgam91cm5hbCBhbmRcbiAqIHRoZSBjYWNoZXMuIFRoYXQgc2luZ2xlIHNoYXJlZCB2b2x1bWUgaXMgd2hhdCBtYWRlIGJvdW5kaW5nIHRoZSB3b3JrIHZvbHVtZVxuICogZXhwZW5zaXZlOiBhbnkgZ3JhbnQgdGlnaHRlbmVkIHRoZXJlIHJpc2tlZCBsb2NraW5nIHRoZSBhZ2VudCBvdXQgb2YgaXRzIG93blxuICogc3RhdGUsIHNvIGV2ZXJ5IHByb3Bvc2FsIGVzY2FsYXRlZCB0byBwZXItc2xvdCBhY2NvdW50cyBhbmQgZ3JvdXBzLlxuICpcbiAqIFRoZSB0d28gY29uY2VybnMgYXJlIHNlcGFyYWJsZSwgYW5kIHNlcGFyYXRpbmcgdGhlbSBpcyB0aGUgd2hvbGUgY2hhbmdlOlxuICpcbiAqIC0gKipUaGUgYWdlbnQgbXVzdCBiZSBhYmxlIHRvIHdyaXRlIGl0cyBvd24gc3RhdGUuKiogSXRzIGNvbmZpZ3VyYXRpb24sIHRoZVxuICogICB0cmFuc2NyaXB0cyBgLS1yZXN1bWVgIHJlcGxheXMsIGFuZCB0aGUgcGVyLXJlcG9zaXRvcnkgc2Vzc2lvbiBzdG9yZXMuXG4gKiAgIENvbnRhaW5tZW50IHRoYXQgc3RvcHMgdGhlIGFnZW50IGRvaW5nIGl0cyBqb2IgaXMgbm90IGNvbnRhaW5tZW50LCBpdCBpc1xuICogICBhIGJyb2tlbiB3b3JrZXIg4oCUIHNlZSB0aGUgY29udGFpbm1lbnQgZ29hbCBpbiBgZG9jcy9USFJFQVQtTU9ERUwubWRgLlxuICogLSAqKlRoZSBhZ2VudCBzaG91bGQgbm90IG5lZWQgdG8gd3JpdGUgYW55dGhpbmcgZWxzZS4qKiBXaXRoIGl0cyBzdGF0ZVxuICogICBlbHNld2hlcmUsIHRoZSB3b3JrIHZvbHVtZSBjYW4gYmUgdGlnaHRlbmVkIG9uIGl0cyBvd24gbWVyaXRzIHdpdGhvdXRcbiAqICAgdGhhdCB0aWdodGVuaW5nIGV2ZXIgcmVhY2hpbmcgdGhlIGFnZW50J3Mgb3duIHN0b3JlLlxuICpcbiAqIFNvIHRoZSBzdG9yZSBpcyBhICoqc2libGluZyoqIG9mIGB3b3JrRGlyYCwgbmV2ZXIgYSBjaGlsZCwgb24gaXRzIG93biBuYW1lZFxuICogdm9sdW1lIOKAlCBleGFjdGx5IHRoZSBzaGFwZSBgY29udGVudF9hcHByb3ZhbF9zdGF0ZV9kaXIudHNgIGFscmVhZHkgdXNlcyBmb3JcbiAqIHRoZSBhcHByb3ZhbCBiYXNlbGluZSwgYW5kIGZvciBhIGNsb3NlbHkgcmVsYXRlZCByZWFzb246IGEgZGlyZWN0b3J5IGluc2lkZVxuICogdGhlIHdvcmsgdHJlZSBpcyBvbmUgdGhhdCBgbnVrZVdvcmtEaXIoKWAgZGVsZXRlcyB3aG9sZXNhbGUgdW5kZXIgZGlza1xuICogcHJlc3N1cmUsIGFuZCBvbmUgYW4gYWdlbnQtZHJpdmVuIGBybWAgaW5zaWRlIHRoZSB3b3JrIHRyZWUgY2FuIHJlYWNoLlxuICpcbiAqIERlcml2aW5nIGl0IGZyb20gYHdvcmtEaXJgIHJhdGhlciB0aGFuIGZyb20gYEhPTUVgIGtlZXBzIGVhY2ggd29ya2VyXG4gKiBpZGVudGl0eSBpc29sYXRlZCDigJQgZmxlZXQgbWVtYmVycyBoYXZlIHNlcGFyYXRlIGBIT01FYHMgYW5kIHNvIHNlcGFyYXRlIHdvcmtcbiAqIGRpcmVjdG9yaWVzIOKAlCB3aXRob3V0IGRlcGVuZGluZyBvbiBgSE9NRWAgYmVpbmcgc2V0IGF0IGFsbC5cbiAqXG4gKiAjIyBTZXNzaW9uIGlzb2xhdGlvbiBpcyB1bmNoYW5nZWRcbiAqXG4gKiBTZXNzaW9uIHN0b3JlcyB3ZXJlIGFscmVhZHkga2V5ZWQgcGVyIG93bmVyLCBwZXIgcmVwb3NpdG9yeSBhbmQgcGVyIHdvcmtcbiAqIHN0cmVhbSAoYHNlc3Npb25fbWFuYWdlci50c2ApLCBzbyBydW5zIG9uIGRpZmZlcmVudCByZXBvc2l0b3JpZXMgY291bGQgbm90XG4gKiBjb25mdXNlIGVhY2ggb3RoZXIgYmVmb3JlIHRoaXMgY2hhbmdlIGFuZCBjYW5ub3Qgbm93LiBPbmx5IHRoZSByb290IG1vdmVzLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uKS5cbiAqL1xuXG4vKiogU3VmZml4IGFwcGVuZGVkIHRvIGB3b3JrRGlyYCB0byBuYW1lIHRoZSBhZ2VudC1zdGF0ZSByb290LiAqL1xuY29uc3QgQUdFTlRfU1RBVEVfRElSX1NVRkZJWCA9IFwiLWFnZW50LXN0YXRlXCI7XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgcm9vdCBob2xkaW5nIHRoZSBjb2RpbmcgYWdlbnQncyBvd24gc3RhdGUuXG4gKlxuICogYFwiXCJgIGlzIHRoZSBleHBsaWNpdCAqdW5jb25maWd1cmVkKiBzZW50aW5lbCwgbWF0Y2hpbmdcbiAqIGByZXNvbHZlQ29udGVudEFwcHJvdmFsU3RhdGVEaXJgOiBgd29ya0RpcmAgbmFtZXMgbm8gZGlyZWN0b3J5IHRoZSBzdG9yZVxuICogY2FuIHNpdCBiZXNpZGUuIENhbGxlcnMgZmFsbCBiYWNrIHRvIHRoZWlyIHByZXZpb3VzIGJlaGF2aW91ciBvbiBpdCByYXRoZXJcbiAqIHRoYW4gaW52ZW50aW5nIGEgcmVsYXRpdmUgZGlyZWN0b3J5LlxuICpcbiAqIEBwYXJhbSB3b3JrRGlyIC0gVGhlIGFnZW50LXdyaXRhYmxlIHdvcmsgZGlyZWN0b3J5IChgY29uZmlnLndvcmtEaXJgKS5cbiAqIEByZXR1cm5zIFRoZSBhZ2VudC1zdGF0ZSByb290LCBvciBgXCJcImAgd2hlbiBgd29ya0RpcmAgbmFtZXMgbm8gZGlyZWN0b3J5XG4gKiAgICh1bnNldCwgd2hpdGVzcGFjZS1vbmx5LCBvciBgL2ApLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUFnZW50U3RhdGVEaXIod29ya0Rpcjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IHdvcmtEaXIudHJpbSgpLnJlcGxhY2UoL1xcLyskLywgXCJcIik7XG4gIGlmICghdHJpbW1lZCkgcmV0dXJuIFwiXCI7XG4gIHJldHVybiBgJHt0cmltbWVkfSR7QUdFTlRfU1RBVEVfRElSX1NVRkZJWH1gO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FvQ0MsR0FFRCwrREFBK0QsR0FDL0QsTUFBTSx5QkFBeUI7QUFFL0I7Ozs7Ozs7Ozs7O0NBV0MsR0FDRCxPQUFPLFNBQVMscUJBQXFCLE9BQWU7RUFDbEQsTUFBTSxVQUFVLFFBQVEsSUFBSSxHQUFHLE9BQU8sQ0FBQyxRQUFRO0VBQy9DLElBQUksQ0FBQyxTQUFTLE9BQU87RUFDckIsT0FBTyxHQUFHLFVBQVUsd0JBQXdCO0FBQzlDIn0=
// denoCacheMetadata=11107344153002744112,8021195938594975799