/**
 * What the merge looks like when the milestone sync reaches its final-mile
 * commit, and how a failed git command on that path is described
 * (Issue #1964).
 *
 * The sync's agent rung runs in the very clone the merge conflicted in, and
 * an agent that commits the merge itself leaves the worker's own
 * `git commit -m …` with nothing to do: git exits 1 and prints "nothing to
 * commit, working tree clean" on **stdout**. The sync read stderr alone, so
 * the diagnosis was lost, the resolution was thrown away and the same cycle
 * repeated until a human took the branch.
 *
 * Three small pieces fix that:
 *
 * - {@link readMergeCommitState} — is the merge still in progress, has it
 *   already been committed as the merge of the two sides, or is HEAD
 *   something else entirely?
 * - {@link assertAdoptedMergeIsSafe} — a commit the worker did not write is
 *   held to the same pre-commit safety gate before it is adopted.
 * - {@link describeGitFailure} — git's own account of a failure, stderr
 *   **and** stdout, so a stdout-only refusal is never logged as "no stderr".
 *   The sync path's own callers read it from here; other subsystems keep
 *   their own spelling of the same fallback.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { runGitCommand } from "./git_timeout.ts";
import { classifyStagedPath, mergedInUnchanged } from "./pre_commit_safety.ts";
/**
 * Git's own account of a failed command — **stderr and stdout** (Issue #1964).
 *
 * `git commit` with nothing to commit exits 1 and explains itself on stdout;
 * so does `git merge` in some refusals. Reading stderr alone turned those into
 * "git reported no stderr", which is the diagnosis being discarded rather than
 * reported. Both streams travel here, stderr first, and a command that printed
 * nothing at all says so with its exit code rather than blaming stderr.
 *
 * @param result - The `runGitCommand` result for the failed command
 * @param format - How much of the output to keep, and from which end
 * @returns A non-empty, single-line description of what git said
 */ export function describeGitFailure(result, format = {}) {
  const { lines = 3, from = "tail" } = format;
  const text = result.ok ? [
    result.value.stderr.trim(),
    result.value.stdout.trim()
  ].filter(Boolean).join("\n") : result.error.message.trim();
  const all = text.split("\n").map((line)=>line.trim()).filter(Boolean);
  const picked = from === "head" ? all.slice(0, lines) : all.slice(-lines);
  const detail = picked.join(" | ");
  if (detail) return detail;
  return result.ok ? `git exited ${result.value.code} and printed nothing` : "git could not be run";
}
/** The commit and its parents, as `rev-list --parents -n 1` reports them. */ async function readHeadParents(options) {
  const result = await runGitCommand([
    "rev-list",
    "--parents",
    "-n",
    "1",
    "HEAD"
  ], options);
  if (!result.ok || result.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`HEAD and its parents could not be read: ${describeGitFailure(result)}`)
    };
  }
  const [sha, ...parents] = result.value.stdout.trim().split(/\s+/).filter(Boolean);
  if (!sha) {
    return {
      ok: false,
      error: new Error("HEAD resolved to nothing")
    };
  }
  return {
    ok: true,
    value: {
      sha,
      parents
    }
  };
}
/**
 * Read the merge state before the sync's final-mile commit (Issue #1964).
 *
 * A rung that committed the merge itself is recognised by what it left
 * behind — a two-parent HEAD whose parents are exactly the branch's pre-merge
 * commit and the default branch's tip — not by trusting that it said so.
 * Anything else with no `MERGE_HEAD` is reported as the failure it is, by
 * name, rather than discovered as an unexplained `git commit` exit 1.
 *
 * @param args.preMergeSha - Where the milestone branch stood before the merge
 * @param args.defaultSha - The default-branch tip being merged in
 * @param args.options - Git options; `cwd` is the clone holding the merge
 * @returns The merge state, never a throw
 */ export async function readMergeCommitState(args) {
  const { preMergeSha, defaultSha, options } = args;
  // `rev-parse --verify --quiet` exits 1 for "that ref does not exist" and
  // anything else (128 for a broken repository, 124 for the timeout the
  // runner synthesises) for "the question could not be answered". Only the
  // first is a determinate "no merge in progress".
  const mergeHead = await runGitCommand([
    "rev-parse",
    "--verify",
    "--quiet",
    "MERGE_HEAD"
  ], options);
  if (mergeHead.ok && mergeHead.value.code === 0) {
    return {
      kind: "in-progress"
    };
  }
  if (!mergeHead.ok || mergeHead.value.code !== 1) {
    return {
      kind: "unknown",
      detail: `whether a merge is still in progress could not be read: ${describeGitFailure(mergeHead)}`
    };
  }
  const head = await readHeadParents(options);
  if (!head.ok) return {
    kind: "unknown",
    detail: head.error.message
  };
  const { sha, parents } = head.value;
  if (!preMergeSha || !defaultSha) {
    return {
      kind: "unknown",
      detail: `the merge is no longer in progress and HEAD ${sha} cannot be ` + `judged against it: ${preMergeSha ? "" : "the pre-merge commit "}${!preMergeSha && !defaultSha ? "and " : ""}${defaultSha ? "" : "the default branch's tip "}could not be read`
    };
  }
  const isResolutionMerge = parents.length === 2 && [
    preMergeSha,
    defaultSha
  ].every((want)=>parents.includes(want));
  if (isResolutionMerge) return {
    kind: "already-committed",
    sha
  };
  return {
    kind: "no-merge",
    detail: `the merge is no longer in progress and HEAD ${sha} is not the ` + `merge of ${preMergeSha} and ${defaultSha} — its parent(s): ${parents.length > 0 ? parents.join(", ") : "none"}`
  };
}
/**
 * Hold a merge commit the worker did not write to the pre-commit safety gate
 * (Issue #1964).
 *
 * The ordinary path stages the resolution and `assertSafeToCommit` inspects
 * the index before anything is committed. A rung that committed the merge
 * itself skipped that gate — `git add -A` finds a clean tree, so the
 * inspection sees nothing — and adopting the commit unchecked would let an
 * agent that ran `git add -A` land a `.env`, a credential file or the
 * worker's own `.heartbeat_*` state on a milestone branch. So the adopted
 * commit is judged by exactly the set the index gate would have seen: every
 * path the merge changes against the branch's pre-merge commit.
 *
 * A refused path the merge merely brings in — its blob and mode identical on
 * the default branch's tip, which must be one of HEAD's two parents with the
 * pre-merge commit the other — is exempt, as the index gate exempts it
 * mid-merge (Issue #2739). If HEAD's parents or that tip cannot be read,
 * nothing is exempt (fail closed). Anything the agent added or edited is
 * still refused.
 *
 * @param args.preMergeSha - Where the milestone branch stood before the merge
 * @param args.defaultSha - The default-branch tip the merge brought in
 * @param args.options - Git options; `cwd` is the clone holding the merge
 * @returns Nothing when the commit is safe to adopt, or the refusal
 */ export async function assertAdoptedMergeIsSafe(args) {
  const { preMergeSha, defaultSha, options } = args;
  const changed = await runGitCommand([
    "diff",
    "--name-only",
    "-z",
    preMergeSha,
    "HEAD"
  ], options);
  if (!changed.ok || changed.value.code !== 0) {
    // The check could not run, so nothing is known — never adopt on that.
    return {
      ok: false,
      error: new Error(`the paths it changed could not be listed, so it could not be held ` + `to the pre-commit safety gate: ${describeGitFailure(changed)}`)
    };
  }
  const refused = changed.value.stdout.split("\0").filter((path)=>path.length > 0).filter((path)=>classifyStagedPath(path) === "violation");
  if (refused.length === 0) return {
    ok: true,
    value: undefined
  };
  // Only HEAD's own merged-in parent vouches for a path: a lookalike commit
  // holding the same blobs is not what this merge brought in.
  const head = await readHeadParents(options);
  const exempt = head.ok && head.value.parents.length === 2 && [
    preMergeSha,
    defaultSha
  ].every((want)=>want.length > 0 && head.value.parents.includes(want)) ? await mergedInUnchanged({
    violations: refused,
    mergedIn: defaultSha,
    candidate: head.value.sha,
    options
  }) : new Set();
  const violations = refused.filter((path)=>!exempt.has(path));
  if (violations.length === 0) return {
    ok: true,
    value: undefined
  };
  return {
    ok: false,
    error: new Error(`the pre-commit safety gate refuses it (Issue #1758): it commits ` + `${violations.length} hidden or secret-bearing path(s): ${violations.join(", ")}`)
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9taWxlc3RvbmVfbWVyZ2Vfc3RhdGUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBXaGF0IHRoZSBtZXJnZSBsb29rcyBsaWtlIHdoZW4gdGhlIG1pbGVzdG9uZSBzeW5jIHJlYWNoZXMgaXRzIGZpbmFsLW1pbGVcbiAqIGNvbW1pdCwgYW5kIGhvdyBhIGZhaWxlZCBnaXQgY29tbWFuZCBvbiB0aGF0IHBhdGggaXMgZGVzY3JpYmVkXG4gKiAoSXNzdWUgIzE5NjQpLlxuICpcbiAqIFRoZSBzeW5jJ3MgYWdlbnQgcnVuZyBydW5zIGluIHRoZSB2ZXJ5IGNsb25lIHRoZSBtZXJnZSBjb25mbGljdGVkIGluLCBhbmRcbiAqIGFuIGFnZW50IHRoYXQgY29tbWl0cyB0aGUgbWVyZ2UgaXRzZWxmIGxlYXZlcyB0aGUgd29ya2VyJ3Mgb3duXG4gKiBgZ2l0IGNvbW1pdCAtbSDigKZgIHdpdGggbm90aGluZyB0byBkbzogZ2l0IGV4aXRzIDEgYW5kIHByaW50cyBcIm5vdGhpbmcgdG9cbiAqIGNvbW1pdCwgd29ya2luZyB0cmVlIGNsZWFuXCIgb24gKipzdGRvdXQqKi4gVGhlIHN5bmMgcmVhZCBzdGRlcnIgYWxvbmUsIHNvXG4gKiB0aGUgZGlhZ25vc2lzIHdhcyBsb3N0LCB0aGUgcmVzb2x1dGlvbiB3YXMgdGhyb3duIGF3YXkgYW5kIHRoZSBzYW1lIGN5Y2xlXG4gKiByZXBlYXRlZCB1bnRpbCBhIGh1bWFuIHRvb2sgdGhlIGJyYW5jaC5cbiAqXG4gKiBUaHJlZSBzbWFsbCBwaWVjZXMgZml4IHRoYXQ6XG4gKlxuICogLSB7QGxpbmsgcmVhZE1lcmdlQ29tbWl0U3RhdGV9IOKAlCBpcyB0aGUgbWVyZ2Ugc3RpbGwgaW4gcHJvZ3Jlc3MsIGhhcyBpdFxuICogICBhbHJlYWR5IGJlZW4gY29tbWl0dGVkIGFzIHRoZSBtZXJnZSBvZiB0aGUgdHdvIHNpZGVzLCBvciBpcyBIRUFEXG4gKiAgIHNvbWV0aGluZyBlbHNlIGVudGlyZWx5P1xuICogLSB7QGxpbmsgYXNzZXJ0QWRvcHRlZE1lcmdlSXNTYWZlfSDigJQgYSBjb21taXQgdGhlIHdvcmtlciBkaWQgbm90IHdyaXRlIGlzXG4gKiAgIGhlbGQgdG8gdGhlIHNhbWUgcHJlLWNvbW1pdCBzYWZldHkgZ2F0ZSBiZWZvcmUgaXQgaXMgYWRvcHRlZC5cbiAqIC0ge0BsaW5rIGRlc2NyaWJlR2l0RmFpbHVyZX0g4oCUIGdpdCdzIG93biBhY2NvdW50IG9mIGEgZmFpbHVyZSwgc3RkZXJyXG4gKiAgICoqYW5kKiogc3Rkb3V0LCBzbyBhIHN0ZG91dC1vbmx5IHJlZnVzYWwgaXMgbmV2ZXIgbG9nZ2VkIGFzIFwibm8gc3RkZXJyXCIuXG4gKiAgIFRoZSBzeW5jIHBhdGgncyBvd24gY2FsbGVycyByZWFkIGl0IGZyb20gaGVyZTsgb3RoZXIgc3Vic3lzdGVtcyBrZWVwXG4gKiAgIHRoZWlyIG93biBzcGVsbGluZyBvZiB0aGUgc2FtZSBmYWxsYmFjay5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgcnVuR2l0Q29tbWFuZCB9IGZyb20gXCIuL2dpdF90aW1lb3V0LnRzXCI7XG5pbXBvcnQgdHlwZSB7IEdpdENvbW1hbmRPcHRpb25zLCBHaXRDb21tYW5kT3V0cHV0IH0gZnJvbSBcIi4vZ2l0X3RpbWVvdXQudHNcIjtcbmltcG9ydCB7IGNsYXNzaWZ5U3RhZ2VkUGF0aCwgbWVyZ2VkSW5VbmNoYW5nZWQgfSBmcm9tIFwiLi9wcmVfY29tbWl0X3NhZmV0eS50c1wiO1xuXG4vKiogQSBgcnVuR2l0Q29tbWFuZGAgcmVzdWx0OiBnaXQncyBvdXRwdXQsIG9yIHRoZSBmYWlsdXJlIHRvIHJ1biBpdCBhdCBhbGwuICovXG5leHBvcnQgdHlwZSBHaXRSdW5SZXN1bHQgPSBSZXN1bHQ8R2l0Q29tbWFuZE91dHB1dD47XG5cbi8qKiBIb3cgbWFueSBsaW5lcyBvZiBnaXQncyBvdXRwdXQgYW4gZXJyb3IgbWVzc2FnZSBjYXJyaWVzLCBhbmQgZnJvbSB3aGVyZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgR2l0RmFpbHVyZUZvcm1hdCB7XG4gIC8qKiBMaW5lcyB0byBrZWVwOyBkZWZhdWx0cyB0byAzLiAqL1xuICBsaW5lcz86IG51bWJlcjtcbiAgLyoqIFdoaWNoIGVuZCBvZiB0aGUgb3V0cHV0IHRvIGtlZXA7IGRlZmF1bHRzIHRvIHRoZSB0YWlsLiAqL1xuICBmcm9tPzogXCJoZWFkXCIgfCBcInRhaWxcIjtcbn1cblxuLyoqXG4gKiBHaXQncyBvd24gYWNjb3VudCBvZiBhIGZhaWxlZCBjb21tYW5kIOKAlCAqKnN0ZGVyciBhbmQgc3Rkb3V0KiogKElzc3VlICMxOTY0KS5cbiAqXG4gKiBgZ2l0IGNvbW1pdGAgd2l0aCBub3RoaW5nIHRvIGNvbW1pdCBleGl0cyAxIGFuZCBleHBsYWlucyBpdHNlbGYgb24gc3Rkb3V0O1xuICogc28gZG9lcyBgZ2l0IG1lcmdlYCBpbiBzb21lIHJlZnVzYWxzLiBSZWFkaW5nIHN0ZGVyciBhbG9uZSB0dXJuZWQgdGhvc2UgaW50b1xuICogXCJnaXQgcmVwb3J0ZWQgbm8gc3RkZXJyXCIsIHdoaWNoIGlzIHRoZSBkaWFnbm9zaXMgYmVpbmcgZGlzY2FyZGVkIHJhdGhlciB0aGFuXG4gKiByZXBvcnRlZC4gQm90aCBzdHJlYW1zIHRyYXZlbCBoZXJlLCBzdGRlcnIgZmlyc3QsIGFuZCBhIGNvbW1hbmQgdGhhdCBwcmludGVkXG4gKiBub3RoaW5nIGF0IGFsbCBzYXlzIHNvIHdpdGggaXRzIGV4aXQgY29kZSByYXRoZXIgdGhhbiBibGFtaW5nIHN0ZGVyci5cbiAqXG4gKiBAcGFyYW0gcmVzdWx0IC0gVGhlIGBydW5HaXRDb21tYW5kYCByZXN1bHQgZm9yIHRoZSBmYWlsZWQgY29tbWFuZFxuICogQHBhcmFtIGZvcm1hdCAtIEhvdyBtdWNoIG9mIHRoZSBvdXRwdXQgdG8ga2VlcCwgYW5kIGZyb20gd2hpY2ggZW5kXG4gKiBAcmV0dXJucyBBIG5vbi1lbXB0eSwgc2luZ2xlLWxpbmUgZGVzY3JpcHRpb24gb2Ygd2hhdCBnaXQgc2FpZFxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVzY3JpYmVHaXRGYWlsdXJlKFxuICByZXN1bHQ6IEdpdFJ1blJlc3VsdCxcbiAgZm9ybWF0OiBHaXRGYWlsdXJlRm9ybWF0ID0ge30sXG4pOiBzdHJpbmcge1xuICBjb25zdCB7IGxpbmVzID0gMywgZnJvbSA9IFwidGFpbFwiIH0gPSBmb3JtYXQ7XG4gIGNvbnN0IHRleHQgPSByZXN1bHQub2tcbiAgICA/IFtyZXN1bHQudmFsdWUuc3RkZXJyLnRyaW0oKSwgcmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKCldXG4gICAgICAuZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCJcXG5cIilcbiAgICA6IHJlc3VsdC5lcnJvci5tZXNzYWdlLnRyaW0oKTtcbiAgY29uc3QgYWxsID0gdGV4dC5zcGxpdChcIlxcblwiKS5tYXAoKGxpbmUpID0+IGxpbmUudHJpbSgpKS5maWx0ZXIoQm9vbGVhbik7XG4gIGNvbnN0IHBpY2tlZCA9IGZyb20gPT09IFwiaGVhZFwiID8gYWxsLnNsaWNlKDAsIGxpbmVzKSA6IGFsbC5zbGljZSgtbGluZXMpO1xuICBjb25zdCBkZXRhaWwgPSBwaWNrZWQuam9pbihcIiB8IFwiKTtcbiAgaWYgKGRldGFpbCkgcmV0dXJuIGRldGFpbDtcbiAgcmV0dXJuIHJlc3VsdC5va1xuICAgID8gYGdpdCBleGl0ZWQgJHtyZXN1bHQudmFsdWUuY29kZX0gYW5kIHByaW50ZWQgbm90aGluZ2BcbiAgICA6IFwiZ2l0IGNvdWxkIG5vdCBiZSBydW5cIjtcbn1cblxuLyoqXG4gKiBXaGVyZSB0aGUgbWVyZ2Ugc3RhbmRzIHdoZW4gdGhlIGZpbmFsLW1pbGUgY29tbWl0IGlzIGFib3V0IHRvIHJ1bi5cbiAqXG4gKiAtIGBpbi1wcm9ncmVzc2Ag4oCUIGBNRVJHRV9IRUFEYCBpcyBzdGlsbCB0aGVyZSwgc28gdGhlIHdvcmtlciBjb21taXRzLlxuICogLSBgYWxyZWFkeS1jb21taXR0ZWRgIOKAlCB0aGUgbWVyZ2UgaXMgY29tbWl0dGVkLCBhbmQgSEVBRCBpcyB0aGUgbWVyZ2Ugb2ZcbiAqICAgdGhlIGJyYW5jaCdzIHByZS1tZXJnZSBjb21taXQgYW5kIHRoZSBkZWZhdWx0IGJyYW5jaCdzIHRpcC4gU29tZSBydW5nXG4gKiAgIGNvbW1pdHRlZCB0aGUgcmVzb2x1dGlvbjsgaXRzIG1lc3NhZ2UgaXMgcmV3cml0dGVuLCBub3QgcmVwZWF0ZWQuXG4gKiAtIGBuby1tZXJnZWAg4oCUIGBNRVJHRV9IRUFEYCBpcyBkZXRlcm1pbmF0ZWx5IGFic2VudCBhbmQgSEVBRCBpcyBzb21ldGhpbmdcbiAqICAgZWxzZS4gVGhhdCBpcyBhIGZhaWx1cmUsIGFuZCBgZGV0YWlsYCBuYW1lcyBpdC5cbiAqIC0gYHVua25vd25gIOKAlCB0aGUgc3RhdGUgY291bGQgbm90IGJlIHJlYWQgYXQgYWxsIChhIHRpbWVvdXQsIGEgYnJva2VuXG4gKiAgIHJlcG9zaXRvcnksIGEgZGVmYXVsdCB0aXAgbm9ib2R5IGNvdWxkIHJlc29sdmUpLiBOZXZlciBjb25mdXNlZCB3aXRoXG4gKiAgIGBuby1tZXJnZWA6IHRoZSBjYWxsZXIgdGhyb3dzIHdvcmsgYXdheSBvbiBgbm8tbWVyZ2VgLCBhbmQgXCJ0aGUgY2hlY2tcbiAqICAgY291bGQgbm90IHJ1blwiIG11c3QgbmV2ZXIgYmUgcmVhZCBhcyBhIGRldGVybWluYXRlIGFuc3dlci5cbiAqL1xuZXhwb3J0IHR5cGUgTWVyZ2VDb21taXRTdGF0ZSA9XG4gIHwgeyBraW5kOiBcImluLXByb2dyZXNzXCIgfVxuICB8IHsga2luZDogXCJhbHJlYWR5LWNvbW1pdHRlZFwiOyBzaGE6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcIm5vLW1lcmdlXCI7IGRldGFpbDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwidW5rbm93blwiOyBkZXRhaWw6IHN0cmluZyB9O1xuXG4vKiogVGhlIGNvbW1pdCBhbmQgaXRzIHBhcmVudHMsIGFzIGByZXYtbGlzdCAtLXBhcmVudHMgLW4gMWAgcmVwb3J0cyB0aGVtLiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVhZEhlYWRQYXJlbnRzKFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyxcbik6IFByb21pc2U8UmVzdWx0PHsgc2hhOiBzdHJpbmc7IHBhcmVudHM6IHN0cmluZ1tdIH0+PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wicmV2LWxpc3RcIiwgXCItLXBhcmVudHNcIiwgXCItblwiLCBcIjFcIiwgXCJIRUFEXCJdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmICghcmVzdWx0Lm9rIHx8IHJlc3VsdC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBIRUFEIGFuZCBpdHMgcGFyZW50cyBjb3VsZCBub3QgYmUgcmVhZDogJHtkZXNjcmliZUdpdEZhaWx1cmUocmVzdWx0KX1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIGNvbnN0IFtzaGEsIC4uLnBhcmVudHNdID0gcmVzdWx0LnZhbHVlLnN0ZG91dC50cmltKCkuc3BsaXQoL1xccysvKS5maWx0ZXIoXG4gICAgQm9vbGVhbixcbiAgKTtcbiAgaWYgKCFzaGEpIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBuZXcgRXJyb3IoXCJIRUFEIHJlc29sdmVkIHRvIG5vdGhpbmdcIikgfTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHsgc2hhLCBwYXJlbnRzIH0gfTtcbn1cblxuLyoqXG4gKiBSZWFkIHRoZSBtZXJnZSBzdGF0ZSBiZWZvcmUgdGhlIHN5bmMncyBmaW5hbC1taWxlIGNvbW1pdCAoSXNzdWUgIzE5NjQpLlxuICpcbiAqIEEgcnVuZyB0aGF0IGNvbW1pdHRlZCB0aGUgbWVyZ2UgaXRzZWxmIGlzIHJlY29nbmlzZWQgYnkgd2hhdCBpdCBsZWZ0XG4gKiBiZWhpbmQg4oCUIGEgdHdvLXBhcmVudCBIRUFEIHdob3NlIHBhcmVudHMgYXJlIGV4YWN0bHkgdGhlIGJyYW5jaCdzIHByZS1tZXJnZVxuICogY29tbWl0IGFuZCB0aGUgZGVmYXVsdCBicmFuY2gncyB0aXAg4oCUIG5vdCBieSB0cnVzdGluZyB0aGF0IGl0IHNhaWQgc28uXG4gKiBBbnl0aGluZyBlbHNlIHdpdGggbm8gYE1FUkdFX0hFQURgIGlzIHJlcG9ydGVkIGFzIHRoZSBmYWlsdXJlIGl0IGlzLCBieVxuICogbmFtZSwgcmF0aGVyIHRoYW4gZGlzY292ZXJlZCBhcyBhbiB1bmV4cGxhaW5lZCBgZ2l0IGNvbW1pdGAgZXhpdCAxLlxuICpcbiAqIEBwYXJhbSBhcmdzLnByZU1lcmdlU2hhIC0gV2hlcmUgdGhlIG1pbGVzdG9uZSBicmFuY2ggc3Rvb2QgYmVmb3JlIHRoZSBtZXJnZVxuICogQHBhcmFtIGFyZ3MuZGVmYXVsdFNoYSAtIFRoZSBkZWZhdWx0LWJyYW5jaCB0aXAgYmVpbmcgbWVyZ2VkIGluXG4gKiBAcGFyYW0gYXJncy5vcHRpb25zIC0gR2l0IG9wdGlvbnM7IGBjd2RgIGlzIHRoZSBjbG9uZSBob2xkaW5nIHRoZSBtZXJnZVxuICogQHJldHVybnMgVGhlIG1lcmdlIHN0YXRlLCBuZXZlciBhIHRocm93XG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkTWVyZ2VDb21taXRTdGF0ZShhcmdzOiB7XG4gIHByZU1lcmdlU2hhOiBzdHJpbmc7XG4gIGRlZmF1bHRTaGE6IHN0cmluZztcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnM7XG59KTogUHJvbWlzZTxNZXJnZUNvbW1pdFN0YXRlPiB7XG4gIGNvbnN0IHsgcHJlTWVyZ2VTaGEsIGRlZmF1bHRTaGEsIG9wdGlvbnMgfSA9IGFyZ3M7XG5cbiAgLy8gYHJldi1wYXJzZSAtLXZlcmlmeSAtLXF1aWV0YCBleGl0cyAxIGZvciBcInRoYXQgcmVmIGRvZXMgbm90IGV4aXN0XCIgYW5kXG4gIC8vIGFueXRoaW5nIGVsc2UgKDEyOCBmb3IgYSBicm9rZW4gcmVwb3NpdG9yeSwgMTI0IGZvciB0aGUgdGltZW91dCB0aGVcbiAgLy8gcnVubmVyIHN5bnRoZXNpc2VzKSBmb3IgXCJ0aGUgcXVlc3Rpb24gY291bGQgbm90IGJlIGFuc3dlcmVkXCIuIE9ubHkgdGhlXG4gIC8vIGZpcnN0IGlzIGEgZGV0ZXJtaW5hdGUgXCJubyBtZXJnZSBpbiBwcm9ncmVzc1wiLlxuICBjb25zdCBtZXJnZUhlYWQgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcInJldi1wYXJzZVwiLCBcIi0tdmVyaWZ5XCIsIFwiLS1xdWlldFwiLCBcIk1FUkdFX0hFQURcIl0sXG4gICAgb3B0aW9ucyxcbiAgKTtcbiAgaWYgKG1lcmdlSGVhZC5vayAmJiBtZXJnZUhlYWQudmFsdWUuY29kZSA9PT0gMCkge1xuICAgIHJldHVybiB7IGtpbmQ6IFwiaW4tcHJvZ3Jlc3NcIiB9O1xuICB9XG4gIGlmICghbWVyZ2VIZWFkLm9rIHx8IG1lcmdlSGVhZC52YWx1ZS5jb2RlICE9PSAxKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGtpbmQ6IFwidW5rbm93blwiLFxuICAgICAgZGV0YWlsOiBgd2hldGhlciBhIG1lcmdlIGlzIHN0aWxsIGluIHByb2dyZXNzIGNvdWxkIG5vdCBiZSByZWFkOiAke1xuICAgICAgICBkZXNjcmliZUdpdEZhaWx1cmUobWVyZ2VIZWFkKVxuICAgICAgfWAsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGhlYWQgPSBhd2FpdCByZWFkSGVhZFBhcmVudHMob3B0aW9ucyk7XG4gIGlmICghaGVhZC5vaykgcmV0dXJuIHsga2luZDogXCJ1bmtub3duXCIsIGRldGFpbDogaGVhZC5lcnJvci5tZXNzYWdlIH07XG5cbiAgY29uc3QgeyBzaGEsIHBhcmVudHMgfSA9IGhlYWQudmFsdWU7XG4gIGlmICghcHJlTWVyZ2VTaGEgfHwgIWRlZmF1bHRTaGEpIHtcbiAgICByZXR1cm4ge1xuICAgICAga2luZDogXCJ1bmtub3duXCIsXG4gICAgICBkZXRhaWw6IGB0aGUgbWVyZ2UgaXMgbm8gbG9uZ2VyIGluIHByb2dyZXNzIGFuZCBIRUFEICR7c2hhfSBjYW5ub3QgYmUgYCArXG4gICAgICAgIGBqdWRnZWQgYWdhaW5zdCBpdDogJHtwcmVNZXJnZVNoYSA/IFwiXCIgOiBcInRoZSBwcmUtbWVyZ2UgY29tbWl0IFwifSR7XG4gICAgICAgICAgIXByZU1lcmdlU2hhICYmICFkZWZhdWx0U2hhID8gXCJhbmQgXCIgOiBcIlwiXG4gICAgICAgIH0ke2RlZmF1bHRTaGEgPyBcIlwiIDogXCJ0aGUgZGVmYXVsdCBicmFuY2gncyB0aXAgXCJ9Y291bGQgbm90IGJlIHJlYWRgLFxuICAgIH07XG4gIH1cbiAgY29uc3QgaXNSZXNvbHV0aW9uTWVyZ2UgPSBwYXJlbnRzLmxlbmd0aCA9PT0gMiAmJlxuICAgIFtwcmVNZXJnZVNoYSwgZGVmYXVsdFNoYV0uZXZlcnkoKHdhbnQpID0+IHBhcmVudHMuaW5jbHVkZXMod2FudCkpO1xuICBpZiAoaXNSZXNvbHV0aW9uTWVyZ2UpIHJldHVybiB7IGtpbmQ6IFwiYWxyZWFkeS1jb21taXR0ZWRcIiwgc2hhIH07XG5cbiAgcmV0dXJuIHtcbiAgICBraW5kOiBcIm5vLW1lcmdlXCIsXG4gICAgZGV0YWlsOiBgdGhlIG1lcmdlIGlzIG5vIGxvbmdlciBpbiBwcm9ncmVzcyBhbmQgSEVBRCAke3NoYX0gaXMgbm90IHRoZSBgICtcbiAgICAgIGBtZXJnZSBvZiAke3ByZU1lcmdlU2hhfSBhbmQgJHtkZWZhdWx0U2hhfSDigJQgaXRzIHBhcmVudChzKTogJHtcbiAgICAgICAgcGFyZW50cy5sZW5ndGggPiAwID8gcGFyZW50cy5qb2luKFwiLCBcIikgOiBcIm5vbmVcIlxuICAgICAgfWAsXG4gIH07XG59XG5cbi8qKlxuICogSG9sZCBhIG1lcmdlIGNvbW1pdCB0aGUgd29ya2VyIGRpZCBub3Qgd3JpdGUgdG8gdGhlIHByZS1jb21taXQgc2FmZXR5IGdhdGVcbiAqIChJc3N1ZSAjMTk2NCkuXG4gKlxuICogVGhlIG9yZGluYXJ5IHBhdGggc3RhZ2VzIHRoZSByZXNvbHV0aW9uIGFuZCBgYXNzZXJ0U2FmZVRvQ29tbWl0YCBpbnNwZWN0c1xuICogdGhlIGluZGV4IGJlZm9yZSBhbnl0aGluZyBpcyBjb21taXR0ZWQuIEEgcnVuZyB0aGF0IGNvbW1pdHRlZCB0aGUgbWVyZ2VcbiAqIGl0c2VsZiBza2lwcGVkIHRoYXQgZ2F0ZSDigJQgYGdpdCBhZGQgLUFgIGZpbmRzIGEgY2xlYW4gdHJlZSwgc28gdGhlXG4gKiBpbnNwZWN0aW9uIHNlZXMgbm90aGluZyDigJQgYW5kIGFkb3B0aW5nIHRoZSBjb21taXQgdW5jaGVja2VkIHdvdWxkIGxldCBhblxuICogYWdlbnQgdGhhdCByYW4gYGdpdCBhZGQgLUFgIGxhbmQgYSBgLmVudmAsIGEgY3JlZGVudGlhbCBmaWxlIG9yIHRoZVxuICogd29ya2VyJ3Mgb3duIGAuaGVhcnRiZWF0XypgIHN0YXRlIG9uIGEgbWlsZXN0b25lIGJyYW5jaC4gU28gdGhlIGFkb3B0ZWRcbiAqIGNvbW1pdCBpcyBqdWRnZWQgYnkgZXhhY3RseSB0aGUgc2V0IHRoZSBpbmRleCBnYXRlIHdvdWxkIGhhdmUgc2VlbjogZXZlcnlcbiAqIHBhdGggdGhlIG1lcmdlIGNoYW5nZXMgYWdhaW5zdCB0aGUgYnJhbmNoJ3MgcHJlLW1lcmdlIGNvbW1pdC5cbiAqXG4gKiBBIHJlZnVzZWQgcGF0aCB0aGUgbWVyZ2UgbWVyZWx5IGJyaW5ncyBpbiDigJQgaXRzIGJsb2IgYW5kIG1vZGUgaWRlbnRpY2FsIG9uXG4gKiB0aGUgZGVmYXVsdCBicmFuY2gncyB0aXAsIHdoaWNoIG11c3QgYmUgb25lIG9mIEhFQUQncyB0d28gcGFyZW50cyB3aXRoIHRoZVxuICogcHJlLW1lcmdlIGNvbW1pdCB0aGUgb3RoZXIg4oCUIGlzIGV4ZW1wdCwgYXMgdGhlIGluZGV4IGdhdGUgZXhlbXB0cyBpdFxuICogbWlkLW1lcmdlIChJc3N1ZSAjMjczOSkuIElmIEhFQUQncyBwYXJlbnRzIG9yIHRoYXQgdGlwIGNhbm5vdCBiZSByZWFkLFxuICogbm90aGluZyBpcyBleGVtcHQgKGZhaWwgY2xvc2VkKS4gQW55dGhpbmcgdGhlIGFnZW50IGFkZGVkIG9yIGVkaXRlZCBpc1xuICogc3RpbGwgcmVmdXNlZC5cbiAqXG4gKiBAcGFyYW0gYXJncy5wcmVNZXJnZVNoYSAtIFdoZXJlIHRoZSBtaWxlc3RvbmUgYnJhbmNoIHN0b29kIGJlZm9yZSB0aGUgbWVyZ2VcbiAqIEBwYXJhbSBhcmdzLmRlZmF1bHRTaGEgLSBUaGUgZGVmYXVsdC1icmFuY2ggdGlwIHRoZSBtZXJnZSBicm91Z2h0IGluXG4gKiBAcGFyYW0gYXJncy5vcHRpb25zIC0gR2l0IG9wdGlvbnM7IGBjd2RgIGlzIHRoZSBjbG9uZSBob2xkaW5nIHRoZSBtZXJnZVxuICogQHJldHVybnMgTm90aGluZyB3aGVuIHRoZSBjb21taXQgaXMgc2FmZSB0byBhZG9wdCwgb3IgdGhlIHJlZnVzYWxcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFzc2VydEFkb3B0ZWRNZXJnZUlzU2FmZShhcmdzOiB7XG4gIHByZU1lcmdlU2hhOiBzdHJpbmc7XG4gIGRlZmF1bHRTaGE6IHN0cmluZztcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnM7XG59KTogUHJvbWlzZTxSZXN1bHQ8dm9pZD4+IHtcbiAgY29uc3QgeyBwcmVNZXJnZVNoYSwgZGVmYXVsdFNoYSwgb3B0aW9ucyB9ID0gYXJncztcbiAgY29uc3QgY2hhbmdlZCA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoXG4gICAgW1wiZGlmZlwiLCBcIi0tbmFtZS1vbmx5XCIsIFwiLXpcIiwgcHJlTWVyZ2VTaGEsIFwiSEVBRFwiXSxcbiAgICBvcHRpb25zLFxuICApO1xuICBpZiAoIWNoYW5nZWQub2sgfHwgY2hhbmdlZC52YWx1ZS5jb2RlICE9PSAwKSB7XG4gICAgLy8gVGhlIGNoZWNrIGNvdWxkIG5vdCBydW4sIHNvIG5vdGhpbmcgaXMga25vd24g4oCUIG5ldmVyIGFkb3B0IG9uIHRoYXQuXG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGB0aGUgcGF0aHMgaXQgY2hhbmdlZCBjb3VsZCBub3QgYmUgbGlzdGVkLCBzbyBpdCBjb3VsZCBub3QgYmUgaGVsZCBgICtcbiAgICAgICAgICBgdG8gdGhlIHByZS1jb21taXQgc2FmZXR5IGdhdGU6ICR7ZGVzY3JpYmVHaXRGYWlsdXJlKGNoYW5nZWQpfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgY29uc3QgcmVmdXNlZCA9IGNoYW5nZWQudmFsdWUuc3Rkb3V0LnNwbGl0KFwiXFwwXCIpXG4gICAgLmZpbHRlcigocGF0aCkgPT4gcGF0aC5sZW5ndGggPiAwKVxuICAgIC5maWx0ZXIoKHBhdGgpID0+IGNsYXNzaWZ5U3RhZ2VkUGF0aChwYXRoKSA9PT0gXCJ2aW9sYXRpb25cIik7XG4gIGlmIChyZWZ1c2VkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcblxuICAvLyBPbmx5IEhFQUQncyBvd24gbWVyZ2VkLWluIHBhcmVudCB2b3VjaGVzIGZvciBhIHBhdGg6IGEgbG9va2FsaWtlIGNvbW1pdFxuICAvLyBob2xkaW5nIHRoZSBzYW1lIGJsb2JzIGlzIG5vdCB3aGF0IHRoaXMgbWVyZ2UgYnJvdWdodCBpbi5cbiAgY29uc3QgaGVhZCA9IGF3YWl0IHJlYWRIZWFkUGFyZW50cyhvcHRpb25zKTtcbiAgY29uc3QgZXhlbXB0ID0gaGVhZC5vayAmJiBoZWFkLnZhbHVlLnBhcmVudHMubGVuZ3RoID09PSAyICYmXG4gICAgICBbcHJlTWVyZ2VTaGEsIGRlZmF1bHRTaGFdLmV2ZXJ5KCh3YW50KSA9PlxuICAgICAgICB3YW50Lmxlbmd0aCA+IDAgJiYgaGVhZC52YWx1ZS5wYXJlbnRzLmluY2x1ZGVzKHdhbnQpXG4gICAgICApXG4gICAgPyBhd2FpdCBtZXJnZWRJblVuY2hhbmdlZCh7XG4gICAgICB2aW9sYXRpb25zOiByZWZ1c2VkLFxuICAgICAgbWVyZ2VkSW46IGRlZmF1bHRTaGEsXG4gICAgICBjYW5kaWRhdGU6IGhlYWQudmFsdWUuc2hhLFxuICAgICAgb3B0aW9ucyxcbiAgICB9KVxuICAgIDogbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IHZpb2xhdGlvbnMgPSByZWZ1c2VkLmZpbHRlcigocGF0aCkgPT4gIWV4ZW1wdC5oYXMocGF0aCkpO1xuICBpZiAodmlvbGF0aW9ucy5sZW5ndGggPT09IDApIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG4gIHJldHVybiB7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICBgdGhlIHByZS1jb21taXQgc2FmZXR5IGdhdGUgcmVmdXNlcyBpdCAoSXNzdWUgIzE3NTgpOiBpdCBjb21taXRzIGAgK1xuICAgICAgICBgJHt2aW9sYXRpb25zLmxlbmd0aH0gaGlkZGVuIG9yIHNlY3JldC1iZWFyaW5nIHBhdGgocyk6ICR7XG4gICAgICAgICAgdmlvbGF0aW9ucy5qb2luKFwiLCBcIilcbiAgICAgICAgfWAsXG4gICAgKSxcbiAgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXlCQyxHQUdELFNBQVMsYUFBYSxRQUFRLG1CQUFtQjtBQUVqRCxTQUFTLGtCQUFrQixFQUFFLGlCQUFpQixRQUFRLHlCQUF5QjtBQWEvRTs7Ozs7Ozs7Ozs7O0NBWUMsR0FDRCxPQUFPLFNBQVMsbUJBQ2QsTUFBb0IsRUFDcEIsU0FBMkIsQ0FBQyxDQUFDO0VBRTdCLE1BQU0sRUFBRSxRQUFRLENBQUMsRUFBRSxPQUFPLE1BQU0sRUFBRSxHQUFHO0VBQ3JDLE1BQU0sT0FBTyxPQUFPLEVBQUUsR0FDbEI7SUFBQyxPQUFPLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSTtJQUFJLE9BQU8sS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJO0dBQUcsQ0FDdkQsTUFBTSxDQUFDLFNBQVMsSUFBSSxDQUFDLFFBQ3RCLE9BQU8sS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJO0VBQzdCLE1BQU0sTUFBTSxLQUFLLEtBQUssQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLE9BQVMsS0FBSyxJQUFJLElBQUksTUFBTSxDQUFDO0VBQy9ELE1BQU0sU0FBUyxTQUFTLFNBQVMsSUFBSSxLQUFLLENBQUMsR0FBRyxTQUFTLElBQUksS0FBSyxDQUFDLENBQUM7RUFDbEUsTUFBTSxTQUFTLE9BQU8sSUFBSSxDQUFDO0VBQzNCLElBQUksUUFBUSxPQUFPO0VBQ25CLE9BQU8sT0FBTyxFQUFFLEdBQ1osQ0FBQyxXQUFXLEVBQUUsT0FBTyxLQUFLLENBQUMsSUFBSSxDQUFDLG9CQUFvQixDQUFDLEdBQ3JEO0FBQ047QUFzQkEsMkVBQTJFLEdBQzNFLGVBQWUsZ0JBQ2IsT0FBMEI7RUFFMUIsTUFBTSxTQUFTLE1BQU0sY0FDbkI7SUFBQztJQUFZO0lBQWE7SUFBTTtJQUFLO0dBQU8sRUFDNUM7RUFFRixJQUFJLENBQUMsT0FBTyxFQUFFLElBQUksT0FBTyxLQUFLLENBQUMsSUFBSSxLQUFLLEdBQUc7SUFDekMsT0FBTztNQUNMLElBQUk7TUFDSixPQUFPLElBQUksTUFDVCxDQUFDLHdDQUF3QyxFQUFFLG1CQUFtQixTQUFTO0lBRTNFO0VBQ0Y7RUFDQSxNQUFNLENBQUMsS0FBSyxHQUFHLFFBQVEsR0FBRyxPQUFPLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSSxHQUFHLEtBQUssQ0FBQyxPQUFPLE1BQU0sQ0FDdEU7RUFFRixJQUFJLENBQUMsS0FBSztJQUNSLE9BQU87TUFBRSxJQUFJO01BQU8sT0FBTyxJQUFJLE1BQU07SUFBNEI7RUFDbkU7RUFDQSxPQUFPO0lBQUUsSUFBSTtJQUFNLE9BQU87TUFBRTtNQUFLO0lBQVE7RUFBRTtBQUM3QztBQUVBOzs7Ozs7Ozs7Ozs7O0NBYUMsR0FDRCxPQUFPLGVBQWUscUJBQXFCLElBSTFDO0VBQ0MsTUFBTSxFQUFFLFdBQVcsRUFBRSxVQUFVLEVBQUUsT0FBTyxFQUFFLEdBQUc7RUFFN0MseUVBQXlFO0VBQ3pFLHNFQUFzRTtFQUN0RSx5RUFBeUU7RUFDekUsaURBQWlEO0VBQ2pELE1BQU0sWUFBWSxNQUFNLGNBQ3RCO0lBQUM7SUFBYTtJQUFZO0lBQVc7R0FBYSxFQUNsRDtFQUVGLElBQUksVUFBVSxFQUFFLElBQUksVUFBVSxLQUFLLENBQUMsSUFBSSxLQUFLLEdBQUc7SUFDOUMsT0FBTztNQUFFLE1BQU07SUFBYztFQUMvQjtFQUNBLElBQUksQ0FBQyxVQUFVLEVBQUUsSUFBSSxVQUFVLEtBQUssQ0FBQyxJQUFJLEtBQUssR0FBRztJQUMvQyxPQUFPO01BQ0wsTUFBTTtNQUNOLFFBQVEsQ0FBQyx3REFBd0QsRUFDL0QsbUJBQW1CLFlBQ25CO0lBQ0o7RUFDRjtFQUVBLE1BQU0sT0FBTyxNQUFNLGdCQUFnQjtFQUNuQyxJQUFJLENBQUMsS0FBSyxFQUFFLEVBQUUsT0FBTztJQUFFLE1BQU07SUFBVyxRQUFRLEtBQUssS0FBSyxDQUFDLE9BQU87RUFBQztFQUVuRSxNQUFNLEVBQUUsR0FBRyxFQUFFLE9BQU8sRUFBRSxHQUFHLEtBQUssS0FBSztFQUNuQyxJQUFJLENBQUMsZUFBZSxDQUFDLFlBQVk7SUFDL0IsT0FBTztNQUNMLE1BQU07TUFDTixRQUFRLENBQUMsNENBQTRDLEVBQUUsSUFBSSxXQUFXLENBQUMsR0FDckUsQ0FBQyxtQkFBbUIsRUFBRSxjQUFjLEtBQUssMEJBQ3ZDLENBQUMsZUFBZSxDQUFDLGFBQWEsU0FBUyxLQUN0QyxhQUFhLEtBQUssNEJBQTRCLGlCQUFpQixDQUFDO0lBQ3ZFO0VBQ0Y7RUFDQSxNQUFNLG9CQUFvQixRQUFRLE1BQU0sS0FBSyxLQUMzQztJQUFDO0lBQWE7R0FBVyxDQUFDLEtBQUssQ0FBQyxDQUFDLE9BQVMsUUFBUSxRQUFRLENBQUM7RUFDN0QsSUFBSSxtQkFBbUIsT0FBTztJQUFFLE1BQU07SUFBcUI7RUFBSTtFQUUvRCxPQUFPO0lBQ0wsTUFBTTtJQUNOLFFBQVEsQ0FBQyw0Q0FBNEMsRUFBRSxJQUFJLFlBQVksQ0FBQyxHQUN0RSxDQUFDLFNBQVMsRUFBRSxZQUFZLEtBQUssRUFBRSxXQUFXLGtCQUFrQixFQUMxRCxRQUFRLE1BQU0sR0FBRyxJQUFJLFFBQVEsSUFBSSxDQUFDLFFBQVEsUUFDMUM7RUFDTjtBQUNGO0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXdCQyxHQUNELE9BQU8sZUFBZSx5QkFBeUIsSUFJOUM7RUFDQyxNQUFNLEVBQUUsV0FBVyxFQUFFLFVBQVUsRUFBRSxPQUFPLEVBQUUsR0FBRztFQUM3QyxNQUFNLFVBQVUsTUFBTSxjQUNwQjtJQUFDO0lBQVE7SUFBZTtJQUFNO0lBQWE7R0FBTyxFQUNsRDtFQUVGLElBQUksQ0FBQyxRQUFRLEVBQUUsSUFBSSxRQUFRLEtBQUssQ0FBQyxJQUFJLEtBQUssR0FBRztJQUMzQyxzRUFBc0U7SUFDdEUsT0FBTztNQUNMLElBQUk7TUFDSixPQUFPLElBQUksTUFDVCxDQUFDLGtFQUFrRSxDQUFDLEdBQ2xFLENBQUMsK0JBQStCLEVBQUUsbUJBQW1CLFVBQVU7SUFFckU7RUFDRjtFQUNBLE1BQU0sVUFBVSxRQUFRLEtBQUssQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLE1BQ3hDLE1BQU0sQ0FBQyxDQUFDLE9BQVMsS0FBSyxNQUFNLEdBQUcsR0FDL0IsTUFBTSxDQUFDLENBQUMsT0FBUyxtQkFBbUIsVUFBVTtFQUNqRCxJQUFJLFFBQVEsTUFBTSxLQUFLLEdBQUcsT0FBTztJQUFFLElBQUk7SUFBTSxPQUFPO0VBQVU7RUFFOUQsMEVBQTBFO0VBQzFFLDREQUE0RDtFQUM1RCxNQUFNLE9BQU8sTUFBTSxnQkFBZ0I7RUFDbkMsTUFBTSxTQUFTLEtBQUssRUFBRSxJQUFJLEtBQUssS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLEtBQUssS0FDcEQ7SUFBQztJQUFhO0dBQVcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxPQUMvQixLQUFLLE1BQU0sR0FBRyxLQUFLLEtBQUssS0FBSyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsU0FFakQsTUFBTSxrQkFBa0I7SUFDeEIsWUFBWTtJQUNaLFVBQVU7SUFDVixXQUFXLEtBQUssS0FBSyxDQUFDLEdBQUc7SUFDekI7RUFDRixLQUNFLElBQUk7RUFDUixNQUFNLGFBQWEsUUFBUSxNQUFNLENBQUMsQ0FBQyxPQUFTLENBQUMsT0FBTyxHQUFHLENBQUM7RUFDeEQsSUFBSSxXQUFXLE1BQU0sS0FBSyxHQUFHLE9BQU87SUFBRSxJQUFJO0lBQU0sT0FBTztFQUFVO0VBQ2pFLE9BQU87SUFDTCxJQUFJO0lBQ0osT0FBTyxJQUFJLE1BQ1QsQ0FBQyxnRUFBZ0UsQ0FBQyxHQUNoRSxHQUFHLFdBQVcsTUFBTSxDQUFDLG1DQUFtQyxFQUN0RCxXQUFXLElBQUksQ0FBQyxPQUNoQjtFQUVSO0FBQ0YifQ==
// denoCacheMetadata=10231884414824936733,17270319447044678209