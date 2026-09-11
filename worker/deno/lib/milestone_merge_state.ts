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
 * Two small pieces fix that, and both live here so every caller on the sync
 * path reads the same one:
 *
 * - {@link readMergeCommitState} — is the merge still in progress, has it
 *   already been committed as the merge of the two sides, or is HEAD
 *   something else entirely?
 * - {@link describeGitFailure} — git's own account of a failure, stderr
 *   **and** stdout, so a stdout-only refusal is never logged as "no stderr".
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";

/** One git invocation's output, as `runGitCommand` reports it. */
export interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** A `runGitCommand` result: git's output, or the failure to run it at all. */
export type GitRunResult = Result<GitOutput>;

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
 * - `no-merge` — `MERGE_HEAD` is gone and HEAD is something else. That is a
 *   failure, and `detail` names it.
 */
export type MergeCommitState =
  | { kind: "in-progress" }
  | { kind: "already-committed"; sha: string }
  | { kind: "no-merge"; detail: string };

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

  const mergeHead = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
    options,
  );
  if (mergeHead.ok && mergeHead.value.code === 0) {
    return { kind: "in-progress" };
  }

  const head = await readHeadParents(options);
  if (!head.ok) return { kind: "no-merge", detail: head.error.message };

  const { sha, parents } = head.value;
  const expected = [preMergeSha, defaultSha].filter(Boolean);
  const isResolutionMerge = expected.length === 2 &&
    parents.length === 2 &&
    expected.every((want) => parents.includes(want));
  if (isResolutionMerge) return { kind: "already-committed", sha };

  return {
    kind: "no-merge",
    detail: `the merge is no longer in progress and HEAD ${sha} is not the ` +
      `merge of ${preMergeSha || "(pre-merge commit unknown)"} and ${
        defaultSha || "(default tip unknown)"
      } — its parent(s): ${parents.length > 0 ? parents.join(", ") : "none"}`,
  };
}
