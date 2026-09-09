/**
 * Uncommitted working-tree work — listing it, naming it, and committing it
 * through the final-mile chokepoint (Issue #1684).
 *
 * The quality-gate remediation phase used to hand a failing `quality.sh` to a
 * Claude fix run, rerun the gate against the edited working tree, log "Quality
 * gate passed" and return — with nothing ever committing what the agent
 * changed. The verdict described a tree, the PR carried the branch, and the
 * two were different: on GRQ-health#188 the fix to two workflow files was
 * simply thrown away by the next `reset --hard`, and the pre-PR rebase was
 * declined because of those very files.
 *
 * So the shape is shared rather than reimplemented per caller:
 *
 *  - {@link listPendingWorkPaths} answers "what is uncommitted that a commit
 *    would actually carry" — worker-owned state files (Issue #1661) are
 *    excluded, because they are unstaged at the chokepoint anyway and must
 *    never make a tree look dirty;
 *  - {@link commitPendingWork} puts that work on the branch via
 *    `commitAndPushPending`, inheriting the pre-commit safety gate (#1758),
 *    the worker-file unstaging (#1661) and the run-id trailer (#2381);
 *  - {@link describePaths} names the paths (bounded) wherever a message would
 *    otherwise report only a count — a log that says "2 path(s) modified"
 *    cannot tell anyone what was lost.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { commitAndPushPending } from "./git_push.ts";
import type { runGitCommand } from "./git_timeout.ts";
import { isWorkerStatePath } from "./worker_state_paths.ts";

/** The git seams these helpers need — satisfied by the worker's `GitDeps`. */
export interface PendingWorkGit {
  runGitCommand: typeof runGitCommand;
  commitAndPushPending: typeof commitAndPushPending;
}

/** How many paths a message names before it summarises the remainder. */
export const PATH_LIST_LIMIT = 10;

/** The one-character escapes git's C-style quoting emits. */
const C_QUOTE_ESCAPES: Record<string, number> = {
  n: 0x0a,
  t: 0x09,
  r: 0x0d,
  f: 0x0c,
  b: 0x08,
  v: 0x0b,
  a: 0x07,
  '"': 0x22,
  "\\": 0x5c,
};

/**
 * Undo git's C-style quoting of a porcelain path, so a path with a space or a
 * non-ASCII character reads as itself rather than as its escape sequence.
 *
 * Git quotes each non-ASCII *byte* as a three-digit octal escape, so the
 * escapes are decoded to bytes and the bytes decoded as UTF-8 — `JSON.parse`
 * cannot do this, because `\303` is not a JSON escape.
 */
export function decodePorcelainPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const body = path.slice(1, -1);
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      bytes.push(...encoder.encode(body[i]));
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    const simple = C_QUOTE_ESCAPES[next];
    if (simple !== undefined) {
      bytes.push(simple);
      continue;
    }
    const octal = body.slice(i, i + 3);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 2;
      continue;
    }
    bytes.push(...encoder.encode(next));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Repository-relative paths named by `git status --porcelain` output.
 *
 * Porcelain v1: two status columns, a space, then the path. A rename reads
 * `R  old -> new`; the new path is the one that matters.
 */
export function parsePorcelainPaths(stdout: string): string[] {
  return stdout.split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim())
    .map((path) => path.split(" -> ").pop() ?? path)
    .map(decodePorcelainPath)
    .filter((path) => path.length > 0);
}

/**
 * Name the paths, bounded, for a log line or a refusal message.
 *
 * A count alone ("2 path(s) modified") tells a reader that something was lost
 * without telling them what — the exact failure Issue #1684 records against
 * the pre-PR rebase refusal.
 *
 * A path is working-tree data, so control characters (a newline in a filename
 * is legal on Linux) are replaced before the name reaches a log line or a
 * failure reason that a release comment is built from: one line in, one line
 * out.
 */
export function describePaths(
  paths: readonly string[],
  limit = PATH_LIST_LIMIT,
): string {
  if (paths.length === 0) return "(none)";
  const shown = paths.slice(0, limit).map((path) =>
    // deno-lint-ignore no-control-regex
    path.replace(/[\u0000-\u001F\u007F]/g, "?")
  );
  const rest = paths.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` (+${rest} more)` : "");
}

/**
 * Uncommitted paths a commit would actually carry, or `null` when git could
 * not be asked.
 *
 * Worker-owned state files are excluded: the chokepoint unstages them
 * (Issue #1661), so counting them as pending work would refuse a clean tree
 * over a file the worker itself dropped in the clone.
 *
 * `null` is deliberately distinct from `[]` — "git failed" is not "the tree
 * is clean", and a caller that treats the two alike is the silent failure
 * this module exists to remove.
 */
export async function listPendingWorkPaths(
  git: PendingWorkGit,
  repoPath: string,
): Promise<string[] | null> {
  const status = await git.runGitCommand(["status", "--porcelain"], {
    cwd: repoPath,
  });
  if (!status.ok || status.value.code !== 0) return null;
  return parsePorcelainPaths(status.value.stdout).filter(
    (path) => !isWorkerStatePath(path),
  );
}

/** What {@link commitPendingWork} found and did. */
export interface PendingWorkCommitResult {
  /** Paths that were uncommitted before the attempt. */
  pending: string[];
  /** Paths still uncommitted afterwards — empty means the branch has them. */
  remaining: string[];
  /** True when the chokepoint created a commit. */
  committed: boolean;
  /** Why the chokepoint refused, when it did. */
  error?: string;
  /** True when `git status` could not be read, before or after the commit. */
  statusUnknown: boolean;
}

/**
 * Commit whatever the working tree carries onto `branchName`, through
 * `commitAndPushPending`.
 *
 * Never throws: the caller decides whether leftover `remaining` paths are a
 * warning or a failure. A clean tree is a no-op — no empty commit, no push.
 */
export async function commitPendingWork(options: {
  git: PendingWorkGit;
  repoPath: string;
  branchName: string;
  message: string;
}): Promise<PendingWorkCommitResult> {
  const { git, repoPath, branchName, message } = options;

  const pending = await listPendingWorkPaths(git, repoPath);
  if (pending === null) {
    return {
      pending: [],
      remaining: [],
      committed: false,
      statusUnknown: true,
    };
  }
  if (pending.length === 0) {
    return { pending, remaining: [], committed: false, statusUnknown: false };
  }

  const commit = await git.commitAndPushPending(branchName, message, {
    cwd: repoPath,
  });

  const remaining = await listPendingWorkPaths(git, repoPath);
  return {
    pending,
    remaining: remaining ?? pending,
    committed: commit.ok ? commit.value.committedNewChanges : false,
    ...(commit.ok ? {} : { error: commit.error.message }),
    statusUnknown: remaining === null,
  };
}
