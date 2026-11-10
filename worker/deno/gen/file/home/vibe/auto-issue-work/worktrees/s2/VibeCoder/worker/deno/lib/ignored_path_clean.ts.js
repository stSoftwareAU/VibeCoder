/**
 * Erase the ignored paths a previous run could have left executable content in
 * (Issue #1443).
 *
 * ## The gap this closes
 *
 * Every reused clone and worktree is re-asserted before work starts with
 * `git reset --hard` followed by `git clean -fd`. That pair restores tracked
 * files and removes untracked ones, so tampering with source under version
 * control is transient — the next run discards it.
 *
 * Ignored paths are the exception: `-fd` leaves everything `.gitignore`
 * matches, which is precisely where a repository keeps the content a later
 * run **executes** — `node_modules/.bin` shims a gate invokes, a `.venv`
 * whose interpreter and site-packages are imported, a `target/` or `dist/`
 * holding compiled output a benchmark runs. So a modification there outlives
 * the cleanup meant to erase it and is picked up by the next, entirely
 * legitimate run of that repository. That is persistence, not access: the
 * mount bounds (#1407, #1442) say who can reach what *now*; this says what
 * survives the reset.
 *
 * ## Why not plain `-fdx`
 *
 * `git clean -fdx` would discard **everything** ignored on every run,
 * including the pure download caches warm clones exist to keep — the cost
 * `work_volume_tiers.ts` already works to avoid on large data repositories.
 * So the clean is **pathspec-scoped** to the directory names that carry
 * executable content, and everything else ignored (download caches, coverage
 * output, logs, the worker's own dot-state) stays warm. What is discarded is
 * rebuilt from tracked sources plus caches that live *outside* the clone
 * (`DENO_DIR`, `~/.npm`, `~/.cargo`, the pip cache), so the cost is an
 * install from a warm cache, not a cold download.
 *
 * The residual — an ignored path that carries executable content under some
 * *other* name — is recorded in `docs/THREAT-MODEL.md` (R12) rather than
 * assumed away.
 *
 * ## Why `-ff`
 *
 * A single `-f` makes git **skip** an untracked directory that contains a
 * nested `.git` ("Skipping repository node_modules/dep"), which is exactly
 * where a git-installed dependency lives — and exactly the content that must
 * not survive. `-ff` removes it. The scope is the pathspec, so no path
 * outside the executable-bearing set can be reached by the extra force.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */ import { runGitCommand } from "./git_timeout.ts";
/**
 * Ignored directory names that can carry executable content into a later run.
 *
 * Deliberately a short, named set rather than "everything ignored": each entry
 * is a place a tool *runs* something from, and each is rebuildable from
 * tracked sources plus an out-of-clone cache.
 */ export const EXECUTABLE_IGNORED_DIRS = [
  "node_modules",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
  "target",
  "build",
  "dist",
  "out",
  "vendor"
];
/**
 * The `git clean` invocation that erases {@link EXECUTABLE_IGNORED_DIRS} at
 * any depth, and nothing else.
 *
 * Two pathspec forms per name, because one alone leaves a hole:
 *
 * - `:(glob)**\/<name>/**` matches the *contents* of a real directory, and
 *   git removes the directory with them. A bare `<name>` would match only at
 *   the repository root, so a monorepo's `packages/*\/node_modules` survived.
 * - `:(glob)**\/<name>` matches the entry itself, which is what catches a
 *   **symlinked** dependency directory (`node_modules -> store/real`). Git
 *   does not descend a symlink, so the contents form matches nothing there —
 *   and `ln -s` would otherwise be a one-command evasion of this control.
 */ export function ignoredExecutableCleanArgs() {
  return [
    "clean",
    "-ffdx",
    "--",
    ...EXECUTABLE_IGNORED_DIRS.flatMap((dir)=>[
        `:(glob)**/${dir}`,
        `:(glob)**/${dir}/**`
      ])
  ];
}
/**
 * Erase the untracked files and then the ignored executable paths in
 * `options.cwd`.
 *
 * The untracked `clean -fd` keeps the best-effort semantics every caller has
 * relied on since it was written — but its failure is now reported rather than
 * dropped. The **ignored** clean is a security control, so its failure is
 * returned: a run that could not erase the previous run's executable content
 * must not be able to continue as though it had.
 *
 * @param options - Git command options; `cwd` is the tree to clean.
 * @returns `ok` once the ignored executable paths are gone; a fail-loud error
 * naming the path and git's own message when they may still be present.
 */ export async function cleanWorkingTree(options = {}) {
  const where = options.cwd ?? Deno.cwd();
  const untracked = await runGitCommand([
    "clean",
    "-fd"
  ], options);
  if (!untracked.ok) {
    console.warn(`[clean] could not remove untracked files in ${where} — ` + `${untracked.error.message}`);
  } else if (untracked.value.code !== 0) {
    console.warn(`[clean] could not remove untracked files in ${where} — git exited ` + `${untracked.value.code}: ${untracked.value.stderr.trim()}`);
  }
  const ignored = await runGitCommand(ignoredExecutableCleanArgs(), options);
  const detail = !ignored.ok ? ignored.error.message : ignored.value.code !== 0 ? `git exited ${ignored.value.code}: ${ignored.value.stderr.trim()}` : null;
  if (detail !== null) {
    return {
      ok: false,
      error: new Error(`SECURITY (Issue #1443): could not erase ignored executable paths ` + `in ${where} — ${detail}. Content a previous run left in ` + `${EXECUTABLE_IGNORED_DIRS.join(", ")} may still be present.`)
    };
  }
  return {
    ok: true,
    value: undefined
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9pZ25vcmVkX3BhdGhfY2xlYW4udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBFcmFzZSB0aGUgaWdub3JlZCBwYXRocyBhIHByZXZpb3VzIHJ1biBjb3VsZCBoYXZlIGxlZnQgZXhlY3V0YWJsZSBjb250ZW50IGluXG4gKiAoSXNzdWUgIzE0NDMpLlxuICpcbiAqICMjIFRoZSBnYXAgdGhpcyBjbG9zZXNcbiAqXG4gKiBFdmVyeSByZXVzZWQgY2xvbmUgYW5kIHdvcmt0cmVlIGlzIHJlLWFzc2VydGVkIGJlZm9yZSB3b3JrIHN0YXJ0cyB3aXRoXG4gKiBgZ2l0IHJlc2V0IC0taGFyZGAgZm9sbG93ZWQgYnkgYGdpdCBjbGVhbiAtZmRgLiBUaGF0IHBhaXIgcmVzdG9yZXMgdHJhY2tlZFxuICogZmlsZXMgYW5kIHJlbW92ZXMgdW50cmFja2VkIG9uZXMsIHNvIHRhbXBlcmluZyB3aXRoIHNvdXJjZSB1bmRlciB2ZXJzaW9uXG4gKiBjb250cm9sIGlzIHRyYW5zaWVudCDigJQgdGhlIG5leHQgcnVuIGRpc2NhcmRzIGl0LlxuICpcbiAqIElnbm9yZWQgcGF0aHMgYXJlIHRoZSBleGNlcHRpb246IGAtZmRgIGxlYXZlcyBldmVyeXRoaW5nIGAuZ2l0aWdub3JlYFxuICogbWF0Y2hlcywgd2hpY2ggaXMgcHJlY2lzZWx5IHdoZXJlIGEgcmVwb3NpdG9yeSBrZWVwcyB0aGUgY29udGVudCBhIGxhdGVyXG4gKiBydW4gKipleGVjdXRlcyoqIOKAlCBgbm9kZV9tb2R1bGVzLy5iaW5gIHNoaW1zIGEgZ2F0ZSBpbnZva2VzLCBhIGAudmVudmBcbiAqIHdob3NlIGludGVycHJldGVyIGFuZCBzaXRlLXBhY2thZ2VzIGFyZSBpbXBvcnRlZCwgYSBgdGFyZ2V0L2Agb3IgYGRpc3QvYFxuICogaG9sZGluZyBjb21waWxlZCBvdXRwdXQgYSBiZW5jaG1hcmsgcnVucy4gU28gYSBtb2RpZmljYXRpb24gdGhlcmUgb3V0bGl2ZXNcbiAqIHRoZSBjbGVhbnVwIG1lYW50IHRvIGVyYXNlIGl0IGFuZCBpcyBwaWNrZWQgdXAgYnkgdGhlIG5leHQsIGVudGlyZWx5XG4gKiBsZWdpdGltYXRlIHJ1biBvZiB0aGF0IHJlcG9zaXRvcnkuIFRoYXQgaXMgcGVyc2lzdGVuY2UsIG5vdCBhY2Nlc3M6IHRoZVxuICogbW91bnQgYm91bmRzICgjMTQwNywgIzE0NDIpIHNheSB3aG8gY2FuIHJlYWNoIHdoYXQgKm5vdyo7IHRoaXMgc2F5cyB3aGF0XG4gKiBzdXJ2aXZlcyB0aGUgcmVzZXQuXG4gKlxuICogIyMgV2h5IG5vdCBwbGFpbiBgLWZkeGBcbiAqXG4gKiBgZ2l0IGNsZWFuIC1mZHhgIHdvdWxkIGRpc2NhcmQgKipldmVyeXRoaW5nKiogaWdub3JlZCBvbiBldmVyeSBydW4sXG4gKiBpbmNsdWRpbmcgdGhlIHB1cmUgZG93bmxvYWQgY2FjaGVzIHdhcm0gY2xvbmVzIGV4aXN0IHRvIGtlZXAg4oCUIHRoZSBjb3N0XG4gKiBgd29ya192b2x1bWVfdGllcnMudHNgIGFscmVhZHkgd29ya3MgdG8gYXZvaWQgb24gbGFyZ2UgZGF0YSByZXBvc2l0b3JpZXMuXG4gKiBTbyB0aGUgY2xlYW4gaXMgKipwYXRoc3BlYy1zY29wZWQqKiB0byB0aGUgZGlyZWN0b3J5IG5hbWVzIHRoYXQgY2FycnlcbiAqIGV4ZWN1dGFibGUgY29udGVudCwgYW5kIGV2ZXJ5dGhpbmcgZWxzZSBpZ25vcmVkIChkb3dubG9hZCBjYWNoZXMsIGNvdmVyYWdlXG4gKiBvdXRwdXQsIGxvZ3MsIHRoZSB3b3JrZXIncyBvd24gZG90LXN0YXRlKSBzdGF5cyB3YXJtLiBXaGF0IGlzIGRpc2NhcmRlZCBpc1xuICogcmVidWlsdCBmcm9tIHRyYWNrZWQgc291cmNlcyBwbHVzIGNhY2hlcyB0aGF0IGxpdmUgKm91dHNpZGUqIHRoZSBjbG9uZVxuICogKGBERU5PX0RJUmAsIGB+Ly5ucG1gLCBgfi8uY2FyZ29gLCB0aGUgcGlwIGNhY2hlKSwgc28gdGhlIGNvc3QgaXMgYW5cbiAqIGluc3RhbGwgZnJvbSBhIHdhcm0gY2FjaGUsIG5vdCBhIGNvbGQgZG93bmxvYWQuXG4gKlxuICogVGhlIHJlc2lkdWFsIOKAlCBhbiBpZ25vcmVkIHBhdGggdGhhdCBjYXJyaWVzIGV4ZWN1dGFibGUgY29udGVudCB1bmRlciBzb21lXG4gKiAqb3RoZXIqIG5hbWUg4oCUIGlzIHJlY29yZGVkIGluIGBkb2NzL1RIUkVBVC1NT0RFTC5tZGAgKFIxMikgcmF0aGVyIHRoYW5cbiAqIGFzc3VtZWQgYXdheS5cbiAqXG4gKiAjIyBXaHkgYC1mZmBcbiAqXG4gKiBBIHNpbmdsZSBgLWZgIG1ha2VzIGdpdCAqKnNraXAqKiBhbiB1bnRyYWNrZWQgZGlyZWN0b3J5IHRoYXQgY29udGFpbnMgYVxuICogbmVzdGVkIGAuZ2l0YCAoXCJTa2lwcGluZyByZXBvc2l0b3J5IG5vZGVfbW9kdWxlcy9kZXBcIiksIHdoaWNoIGlzIGV4YWN0bHlcbiAqIHdoZXJlIGEgZ2l0LWluc3RhbGxlZCBkZXBlbmRlbmN5IGxpdmVzIOKAlCBhbmQgZXhhY3RseSB0aGUgY29udGVudCB0aGF0IG11c3RcbiAqIG5vdCBzdXJ2aXZlLiBgLWZmYCByZW1vdmVzIGl0LiBUaGUgc2NvcGUgaXMgdGhlIHBhdGhzcGVjLCBzbyBubyBwYXRoXG4gKiBvdXRzaWRlIHRoZSBleGVjdXRhYmxlLWJlYXJpbmcgc2V0IGNhbiBiZSByZWFjaGVkIGJ5IHRoZSBleHRyYSBmb3JjZS5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7IHR5cGUgR2l0Q29tbWFuZE9wdGlvbnMsIHJ1bkdpdENvbW1hbmQgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuXG4vKipcbiAqIElnbm9yZWQgZGlyZWN0b3J5IG5hbWVzIHRoYXQgY2FuIGNhcnJ5IGV4ZWN1dGFibGUgY29udGVudCBpbnRvIGEgbGF0ZXIgcnVuLlxuICpcbiAqIERlbGliZXJhdGVseSBhIHNob3J0LCBuYW1lZCBzZXQgcmF0aGVyIHRoYW4gXCJldmVyeXRoaW5nIGlnbm9yZWRcIjogZWFjaCBlbnRyeVxuICogaXMgYSBwbGFjZSBhIHRvb2wgKnJ1bnMqIHNvbWV0aGluZyBmcm9tLCBhbmQgZWFjaCBpcyByZWJ1aWxkYWJsZSBmcm9tXG4gKiB0cmFja2VkIHNvdXJjZXMgcGx1cyBhbiBvdXQtb2YtY2xvbmUgY2FjaGUuXG4gKi9cbmV4cG9ydCBjb25zdCBFWEVDVVRBQkxFX0lHTk9SRURfRElSUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIFwibm9kZV9tb2R1bGVzXCIsIC8vIG5wbS9wbnBtL3lhcm4gaW5zdGFsbHMg4oCUIGAuYmluYCBzaGltcyBhIGdhdGUgaW52b2tlc1xuICBcIi52ZW52XCIsIC8vIFB5dGhvbiB2aXJ0dWFsZW52IOKAlCBgYmluL3B5dGhvbmAsIHNpdGUtcGFja2FnZXNcbiAgXCJ2ZW52XCIsIC8vIHRoZSBzYW1lLCB1bmhpZGRlbiBzcGVsbGluZ1xuICBcIi50b3hcIiwgLy8gdG94J3MgcGVyLWVudmlyb25tZW50IHZpcnR1YWxlbnZzXG4gIFwiX19weWNhY2hlX19cIiwgLy8gY29tcGlsZWQgYnl0ZWNvZGUgaW1wb3J0ZWQgaW4gcGxhY2Ugb2YgYSBzb3VyY2UgZmlsZVxuICBcInRhcmdldFwiLCAvLyBSdXN0L0phdmEgYnVpbGQgb3V0cHV0IOKAlCBiaW5hcmllcyBhIGJlbmNoIG9yIGdhdGUgcnVuc1xuICBcImJ1aWxkXCIsIC8vIGdlbmVyaWMgYnVpbGQgb3V0cHV0XG4gIFwiZGlzdFwiLCAvLyBwYWNrYWdlZCBvdXRwdXQgdGhhdCBpcyBzZXJ2ZWQgb3IgZXhlY3V0ZWRcbiAgXCJvdXRcIiwgLy8gdGhlIHNhbWUsIGFsdGVybmF0aXZlIHNwZWxsaW5nXG4gIFwidmVuZG9yXCIsIC8vIHZlbmRvcmVkIGRlcGVuZGVuY3kgc291cmNlIHRoYXQgaXMgY29tcGlsZWQgYW5kIHJ1blxuXTtcblxuLyoqXG4gKiBUaGUgYGdpdCBjbGVhbmAgaW52b2NhdGlvbiB0aGF0IGVyYXNlcyB7QGxpbmsgRVhFQ1VUQUJMRV9JR05PUkVEX0RJUlN9IGF0XG4gKiBhbnkgZGVwdGgsIGFuZCBub3RoaW5nIGVsc2UuXG4gKlxuICogVHdvIHBhdGhzcGVjIGZvcm1zIHBlciBuYW1lLCBiZWNhdXNlIG9uZSBhbG9uZSBsZWF2ZXMgYSBob2xlOlxuICpcbiAqIC0gYDooZ2xvYikqKlxcLzxuYW1lPi8qKmAgbWF0Y2hlcyB0aGUgKmNvbnRlbnRzKiBvZiBhIHJlYWwgZGlyZWN0b3J5LCBhbmRcbiAqICAgZ2l0IHJlbW92ZXMgdGhlIGRpcmVjdG9yeSB3aXRoIHRoZW0uIEEgYmFyZSBgPG5hbWU+YCB3b3VsZCBtYXRjaCBvbmx5IGF0XG4gKiAgIHRoZSByZXBvc2l0b3J5IHJvb3QsIHNvIGEgbW9ub3JlcG8ncyBgcGFja2FnZXMvKlxcL25vZGVfbW9kdWxlc2Agc3Vydml2ZWQuXG4gKiAtIGA6KGdsb2IpKipcXC88bmFtZT5gIG1hdGNoZXMgdGhlIGVudHJ5IGl0c2VsZiwgd2hpY2ggaXMgd2hhdCBjYXRjaGVzIGFcbiAqICAgKipzeW1saW5rZWQqKiBkZXBlbmRlbmN5IGRpcmVjdG9yeSAoYG5vZGVfbW9kdWxlcyAtPiBzdG9yZS9yZWFsYCkuIEdpdFxuICogICBkb2VzIG5vdCBkZXNjZW5kIGEgc3ltbGluaywgc28gdGhlIGNvbnRlbnRzIGZvcm0gbWF0Y2hlcyBub3RoaW5nIHRoZXJlIOKAlFxuICogICBhbmQgYGxuIC1zYCB3b3VsZCBvdGhlcndpc2UgYmUgYSBvbmUtY29tbWFuZCBldmFzaW9uIG9mIHRoaXMgY29udHJvbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlnbm9yZWRFeGVjdXRhYmxlQ2xlYW5BcmdzKCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFtcbiAgICBcImNsZWFuXCIsXG4gICAgXCItZmZkeFwiLFxuICAgIFwiLS1cIixcbiAgICAuLi5FWEVDVVRBQkxFX0lHTk9SRURfRElSUy5mbGF0TWFwKChkaXIpID0+IFtcbiAgICAgIGA6KGdsb2IpKiovJHtkaXJ9YCxcbiAgICAgIGA6KGdsb2IpKiovJHtkaXJ9LyoqYCxcbiAgICBdKSxcbiAgXTtcbn1cblxuLyoqXG4gKiBFcmFzZSB0aGUgdW50cmFja2VkIGZpbGVzIGFuZCB0aGVuIHRoZSBpZ25vcmVkIGV4ZWN1dGFibGUgcGF0aHMgaW5cbiAqIGBvcHRpb25zLmN3ZGAuXG4gKlxuICogVGhlIHVudHJhY2tlZCBgY2xlYW4gLWZkYCBrZWVwcyB0aGUgYmVzdC1lZmZvcnQgc2VtYW50aWNzIGV2ZXJ5IGNhbGxlciBoYXNcbiAqIHJlbGllZCBvbiBzaW5jZSBpdCB3YXMgd3JpdHRlbiDigJQgYnV0IGl0cyBmYWlsdXJlIGlzIG5vdyByZXBvcnRlZCByYXRoZXIgdGhhblxuICogZHJvcHBlZC4gVGhlICoqaWdub3JlZCoqIGNsZWFuIGlzIGEgc2VjdXJpdHkgY29udHJvbCwgc28gaXRzIGZhaWx1cmUgaXNcbiAqIHJldHVybmVkOiBhIHJ1biB0aGF0IGNvdWxkIG5vdCBlcmFzZSB0aGUgcHJldmlvdXMgcnVuJ3MgZXhlY3V0YWJsZSBjb250ZW50XG4gKiBtdXN0IG5vdCBiZSBhYmxlIHRvIGNvbnRpbnVlIGFzIHRob3VnaCBpdCBoYWQuXG4gKlxuICogQHBhcmFtIG9wdGlvbnMgLSBHaXQgY29tbWFuZCBvcHRpb25zOyBgY3dkYCBpcyB0aGUgdHJlZSB0byBjbGVhbi5cbiAqIEByZXR1cm5zIGBva2Agb25jZSB0aGUgaWdub3JlZCBleGVjdXRhYmxlIHBhdGhzIGFyZSBnb25lOyBhIGZhaWwtbG91ZCBlcnJvclxuICogbmFtaW5nIHRoZSBwYXRoIGFuZCBnaXQncyBvd24gbWVzc2FnZSB3aGVuIHRoZXkgbWF5IHN0aWxsIGJlIHByZXNlbnQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjbGVhbldvcmtpbmdUcmVlKFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxSZXN1bHQ8dm9pZD4+IHtcbiAgY29uc3Qgd2hlcmUgPSBvcHRpb25zLmN3ZCA/PyBEZW5vLmN3ZCgpO1xuXG4gIGNvbnN0IHVudHJhY2tlZCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoW1wiY2xlYW5cIiwgXCItZmRcIl0sIG9wdGlvbnMpO1xuICBpZiAoIXVudHJhY2tlZC5vaykge1xuICAgIGNvbnNvbGUud2FybihcbiAgICAgIGBbY2xlYW5dIGNvdWxkIG5vdCByZW1vdmUgdW50cmFja2VkIGZpbGVzIGluICR7d2hlcmV9IOKAlCBgICtcbiAgICAgICAgYCR7dW50cmFja2VkLmVycm9yLm1lc3NhZ2V9YCxcbiAgICApO1xuICB9IGVsc2UgaWYgKHVudHJhY2tlZC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgY29uc29sZS53YXJuKFxuICAgICAgYFtjbGVhbl0gY291bGQgbm90IHJlbW92ZSB1bnRyYWNrZWQgZmlsZXMgaW4gJHt3aGVyZX0g4oCUIGdpdCBleGl0ZWQgYCArXG4gICAgICAgIGAke3VudHJhY2tlZC52YWx1ZS5jb2RlfTogJHt1bnRyYWNrZWQudmFsdWUuc3RkZXJyLnRyaW0oKX1gLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBpZ25vcmVkID0gYXdhaXQgcnVuR2l0Q29tbWFuZChpZ25vcmVkRXhlY3V0YWJsZUNsZWFuQXJncygpLCBvcHRpb25zKTtcbiAgY29uc3QgZGV0YWlsID0gIWlnbm9yZWQub2tcbiAgICA/IGlnbm9yZWQuZXJyb3IubWVzc2FnZVxuICAgIDogaWdub3JlZC52YWx1ZS5jb2RlICE9PSAwXG4gICAgPyBgZ2l0IGV4aXRlZCAke2lnbm9yZWQudmFsdWUuY29kZX06ICR7aWdub3JlZC52YWx1ZS5zdGRlcnIudHJpbSgpfWBcbiAgICA6IG51bGw7XG4gIGlmIChkZXRhaWwgIT09IG51bGwpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYFNFQ1VSSVRZIChJc3N1ZSAjMTQ0Myk6IGNvdWxkIG5vdCBlcmFzZSBpZ25vcmVkIGV4ZWN1dGFibGUgcGF0aHMgYCArXG4gICAgICAgICAgYGluICR7d2hlcmV9IOKAlCAke2RldGFpbH0uIENvbnRlbnQgYSBwcmV2aW91cyBydW4gbGVmdCBpbiBgICtcbiAgICAgICAgICBgJHtFWEVDVVRBQkxFX0lHTk9SRURfRElSUy5qb2luKFwiLCBcIil9IG1heSBzdGlsbCBiZSBwcmVzZW50LmAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQThDQyxHQUdELFNBQWlDLGFBQWEsUUFBUSxtQkFBbUI7QUFFekU7Ozs7OztDQU1DLEdBQ0QsT0FBTyxNQUFNLDBCQUE2QztFQUN4RDtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtDQUNELENBQUM7QUFFRjs7Ozs7Ozs7Ozs7OztDQWFDLEdBQ0QsT0FBTyxTQUFTO0VBQ2QsT0FBTztJQUNMO0lBQ0E7SUFDQTtPQUNHLHdCQUF3QixPQUFPLENBQUMsQ0FBQyxNQUFRO1FBQzFDLENBQUMsVUFBVSxFQUFFLEtBQUs7UUFDbEIsQ0FBQyxVQUFVLEVBQUUsSUFBSSxHQUFHLENBQUM7T0FDdEI7R0FDRjtBQUNIO0FBRUE7Ozs7Ozs7Ozs7Ozs7Q0FhQyxHQUNELE9BQU8sZUFBZSxpQkFDcEIsVUFBNkIsQ0FBQyxDQUFDO0VBRS9CLE1BQU0sUUFBUSxRQUFRLEdBQUcsSUFBSSxLQUFLLEdBQUc7RUFFckMsTUFBTSxZQUFZLE1BQU0sY0FBYztJQUFDO0lBQVM7R0FBTSxFQUFFO0VBQ3hELElBQUksQ0FBQyxVQUFVLEVBQUUsRUFBRTtJQUNqQixRQUFRLElBQUksQ0FDVixDQUFDLDRDQUE0QyxFQUFFLE1BQU0sR0FBRyxDQUFDLEdBQ3ZELEdBQUcsVUFBVSxLQUFLLENBQUMsT0FBTyxFQUFFO0VBRWxDLE9BQU8sSUFBSSxVQUFVLEtBQUssQ0FBQyxJQUFJLEtBQUssR0FBRztJQUNyQyxRQUFRLElBQUksQ0FDVixDQUFDLDRDQUE0QyxFQUFFLE1BQU0sY0FBYyxDQUFDLEdBQ2xFLEdBQUcsVUFBVSxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUUsRUFBRSxVQUFVLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxJQUFJO0VBRWpFO0VBRUEsTUFBTSxVQUFVLE1BQU0sY0FBYyw4QkFBOEI7RUFDbEUsTUFBTSxTQUFTLENBQUMsUUFBUSxFQUFFLEdBQ3RCLFFBQVEsS0FBSyxDQUFDLE9BQU8sR0FDckIsUUFBUSxLQUFLLENBQUMsSUFBSSxLQUFLLElBQ3ZCLENBQUMsV0FBVyxFQUFFLFFBQVEsS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQUUsUUFBUSxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksSUFBSSxHQUNsRTtFQUNKLElBQUksV0FBVyxNQUFNO0lBQ25CLE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTyxJQUFJLE1BQ1QsQ0FBQyxpRUFBaUUsQ0FBQyxHQUNqRSxDQUFDLEdBQUcsRUFBRSxNQUFNLEdBQUcsRUFBRSxPQUFPLGlDQUFpQyxDQUFDLEdBQzFELEdBQUcsd0JBQXdCLElBQUksQ0FBQyxNQUFNLHNCQUFzQixDQUFDO0lBRW5FO0VBQ0Y7RUFDQSxPQUFPO0lBQUUsSUFBSTtJQUFNLE9BQU87RUFBVTtBQUN0QyJ9
// denoCacheMetadata=10173425641560105156,11541734880451799345