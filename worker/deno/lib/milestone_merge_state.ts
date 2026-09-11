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
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions, GitCommandOutput } from "./git_timeout.ts";
import { classifyStagedPath } from "./pre_commit_safety.ts";

/** A `runGitCommand` result: git's output, or the failure to run it at all. */
export type GitRunResult = Result<GitCommandOutput>;

/** How many lines of git's output an error message carries, and from where. */
export interface GitFailureFormat {
  /** Lines to keep; defaults to 3. */
  lines?: number;
  /** Which end of the output to keep; defaults to the tail. */
  from?: "head" | "tail";
}

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
 */
export function describeGitFailure(
  result: GitRunResult,
  format: GitFailureFormat = {},
): string {
  const { lines = 3, from = "tail" } = format;
  const text = result.ok
    ? [result.value.stderr.trim(), result.value.stdout.trim()]
      .filter(Boolean).join("\n")
    : result.error.message.trim();
  const all = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const picked = from === "head" ? all.slice(0, lines) : all.slice(-lines);
  const detail = picked.join(" | ");
  if (detail) return detail;
  return result.ok
    ? `git exited ${result.value.code} and printed nothing`
    : "git could not be run";
}

/**
 * Where the merge stands when the final-mile commit is about to run.
 *
 * - `in-progress` — `MERGE_HEAD` is still there, so the worker commits.
 * - `already-committed` — the merge is committed, and HEAD is the merge of
 *   the branch's pre-merge commit and the default branch's tip. Some rung
 *   committed the resolution; its message is rewritten, not repeated.
 * - `no-merge` — `MERGE_HEAD` is determinately absent and HEAD is something
 *   else. That is a failure, and `detail` names it.
 * - `unknown` — the state could not be read at all (a timeout, a broken
 *   repository, a default tip nobody could resolve). Never confused with
 *   `no-merge`: the caller throws work away on `no-merge`, and "the check
 *   could not run" must never be read as a determinate answer.
 */
export type MergeCommitState =
  | { kind: "in-progress" }
  | { kind: "already-committed"; sha: string }
  | { kind: "no-merge"; detail: string }
  | { kind: "unknown"; detail: string };

/** The commit and its parents, as `rev-list --parents -n 1` reports them. */
async function readHeadParents(
  options: GitCommandOptions,
): Promise<Result<{ sha: string; parents: string[] }>> {
  const result = await runGitCommand(
    ["rev-list", "--parents", "-n", "1", "HEAD"],
    options,
  );
  if (!result.ok || result.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `HEAD and its parents could not be read: ${describeGitFailure(result)}`,
      ),
    };
  }
  const [sha, ...parents] = result.value.stdout.trim().split(/\s+/).filter(
    Boolean,
  );
  if (!sha) {
    return { ok: false, error: new Error("HEAD resolved to nothing") };
  }
  return { ok: true, value: { sha, parents } };
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
 */
export async function readMergeCommitState(args: {
  preMergeSha: string;
  defaultSha: string;
  options: GitCommandOptions;
}): Promise<MergeCommitState> {
  const { preMergeSha, defaultSha, options } = args;

  // `rev-parse --verify --quiet` exits 1 for "that ref does not exist" and
  // anything else (128 for a broken repository, 124 for the timeout the
  // runner synthesises) for "the question could not be answered". Only the
  // first is a determinate "no merge in progress".
  const mergeHead = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
    options,
  );
  if (mergeHead.ok && mergeHead.value.code === 0) {
    return { kind: "in-progress" };
  }
  if (!mergeHead.ok || mergeHead.value.code !== 1) {
    return {
      kind: "unknown",
      detail: `whether a merge is still in progress could not be read: ${
        describeGitFailure(mergeHead)
      }`,
    };
  }

  const head = await readHeadParents(options);
  if (!head.ok) return { kind: "unknown", detail: head.error.message };

  const { sha, parents } = head.value;
  if (!preMergeSha || !defaultSha) {
    return {
      kind: "unknown",
      detail: `the merge is no longer in progress and HEAD ${sha} cannot be ` +
        `judged against it: ${preMergeSha ? "" : "the pre-merge commit "}${
          !preMergeSha && !defaultSha ? "and " : ""
        }${defaultSha ? "" : "the default branch's tip "}could not be read`,
    };
  }
  const isResolutionMerge = parents.length === 2 &&
    [preMergeSha, defaultSha].every((want) => parents.includes(want));
  if (isResolutionMerge) return { kind: "already-committed", sha };

  return {
    kind: "no-merge",
    detail: `the merge is no longer in progress and HEAD ${sha} is not the ` +
      `merge of ${preMergeSha} and ${defaultSha} — its parent(s): ${
        parents.length > 0 ? parents.join(", ") : "none"
      }`,
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
 * @param args.preMergeSha - Where the milestone branch stood before the merge
 * @param args.options - Git options; `cwd` is the clone holding the merge
 * @returns Nothing when the commit is safe to adopt, or the refusal
 */
export async function assertAdoptedMergeIsSafe(args: {
  preMergeSha: string;
  options: GitCommandOptions;
}): Promise<Result<void>> {
  const { preMergeSha, options } = args;
  const changed = await runGitCommand(
    ["diff", "--name-only", "-z", preMergeSha, "HEAD"],
    options,
  );
  if (!changed.ok || changed.value.code !== 0) {
    // The check could not run, so nothing is known — never adopt on that.
    return {
      ok: false,
      error: new Error(
        `the paths it changed could not be listed, so it could not be held ` +
          `to the pre-commit safety gate: ${describeGitFailure(changed)}`,
      ),
    };
  }
  const violations = changed.value.stdout.split("\0")
    .filter((path) => path.length > 0)
    .filter((path) => classifyStagedPath(path) === "violation");
  if (violations.length === 0) return { ok: true, value: undefined };
  return {
    ok: false,
    error: new Error(
      `the pre-commit safety gate refuses it (Issue #1758): it commits ` +
        `${violations.length} hidden or secret-bearing path(s): ${
          violations.join(", ")
        }`,
    ),
  };
}
