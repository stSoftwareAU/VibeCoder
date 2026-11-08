/**
 * Working-tree guard for the Deno mutation gate (Issue #4905).
 *
 * The Deno path writes each mutant over the real module and runs `deno test`
 * in the issue clone. A test run can leave files behind (a file literally
 * named `undefined`, a fixture a test rewrites), and the worker's later
 * recovery commit runs `git add -A`, which would commit them. So the runner
 * takes a snapshot of the tree before its first child runs and, once it is
 * done, restores the tree to that snapshot: untracked files that are new since
 * the snapshot are deleted, and tracked files that are newly modified are
 * checked out again. This mirrors the cargo path, which points `cargo mutants`
 * at an out-of-tree `mutants.out` for the same reason.
 *
 * Accepted limits:
 * - A tracked file that was already modified before the run, and that a
 *   mutant run changes further, is left as it is. Restoring it would lose the
 *   earlier edit.
 * - Empty directories a mutant run created are left, because git does not
 *   track them.
 * - Ignored files are left, because the listing honours `.gitignore`.
 *
 * Every git call goes through {@link runGitCommand} (Issue #1214). Neither
 * function throws: a failure is reported as a `console.warn` and never changes
 * the mutation verdict.
 *
 * Australian English spelling used throughout.
 */

import type { Result } from "../types.ts";
import { type GitCommandOutput, runGitCommand } from "./git_timeout.ts";

/** Paths restored per `git checkout` call, so a long list stays under the argv limit. */
const CHECKOUT_CHUNK = 100;

/** The untracked and modified paths of a working tree, repo-relative. */
export interface TreeSnapshot {
  untracked: ReadonlySet<string>;
  modified: ReadonlySet<string>;
}

/** Git's own cause line, else the Result's error message, for a warning. */
function causeOf(result: Result<GitCommandOutput>): string {
  if (!result.ok) return result.error.message;
  const first = result.value.stderr.trim().split("\n")[0] ?? "";
  return first !== "" ? first : `git exited with code ${result.value.code}`;
}

/** A thrown value's message. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Repo-relative paths from a NUL-separated git listing; empties dropped, nothing trimmed. */
function splitNul(stdout: string): string[] {
  return stdout.split("\0").filter((p) => p !== "");
}

/** A successful value, or the cause of the failure for a warning. */
type Listed<T> = { ok: true; value: T } | { ok: false; cause: string };

/** One NUL-separated git listing at `repoPath` as a set of paths. */
async function listPaths(
  repoPath: string,
  args: string[],
): Promise<Listed<Set<string>>> {
  const run = await runGitCommand(args, { cwd: repoPath });
  if (!run.ok || run.value.code !== 0) {
    return { ok: false, cause: causeOf(run) };
  }
  return { ok: true, value: new Set(splitNul(run.value.stdout)) };
}

/**
 * Both listings of the tree at `repoPath`: untracked (ignored files excluded)
 * and modified tracked files. Returns the cause of the first failure instead.
 */
async function listTree(repoPath: string): Promise<Listed<TreeSnapshot>> {
  const untracked = await listPaths(repoPath, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (!untracked.ok) return untracked;
  const modified = await listPaths(repoPath, [
    "diff",
    "--name-only",
    "-z",
    "--relative",
  ]);
  if (!modified.ok) return modified;
  return {
    ok: true,
    value: { untracked: untracked.value, modified: modified.value },
  };
}

/**
 * Snapshot the untracked and modified paths of the working tree at `repoPath`.
 *
 * @returns The snapshot, or null when git cannot list the tree (a warning
 *   names the cause). Never throws.
 */
export async function snapshotTree(
  repoPath: string,
): Promise<TreeSnapshot | null> {
  let listed: Listed<TreeSnapshot>;
  try {
    listed = await listTree(repoPath);
  } catch (err) {
    // runGitCommand throws when the run timeline refuses to spawn git.
    listed = { ok: false, cause: errorMessage(err) };
  }
  if (!listed.ok) {
    console.warn(
      `[mutation] could not snapshot the working tree: ${listed.cause}`,
    );
    return null;
  }
  return listed.value;
}

/**
 * A path a restore must never act on: absolute, a `.` or `..` segment, or a
 * trailing `/` (a nested repository directory).
 */
export function isUnsafePath(path: string): boolean {
  if (path.startsWith("/") || path.endsWith("/")) return true;
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

/**
 * Restore the working tree at `repoPath` to `before`: delete each untracked
 * path that is new since the snapshot, and check out each tracked path that
 * is newly modified. Anything present before, and ignored files, are left
 * alone. A failure or an unsafe path is a warning; this never throws.
 */
export async function restoreTree(
  repoPath: string,
  before: TreeSnapshot,
): Promise<void> {
  try {
    await restoreTreeUnguarded(repoPath, before);
  } catch (err) {
    // runGitCommand throws when the run timeline refuses to spawn git.
    console.warn(
      `[mutation] could not restore the working tree: ${errorMessage(err)}`,
    );
  }
}

async function restoreTreeUnguarded(
  repoPath: string,
  before: TreeSnapshot,
): Promise<void> {
  const listed = await listTree(repoPath);
  if (!listed.ok) {
    console.warn(
      `[mutation] could not restore the working tree: ${listed.cause}`,
    );
    return;
  }
  const after = listed.value;

  for (const path of after.untracked) {
    if (before.untracked.has(path)) continue;
    if (isUnsafePath(path)) {
      console.warn(
        `[mutation] could not restore the working tree: refusing unsafe path ${path}`,
      );
      continue;
    }
    try {
      await Deno.remove(`${repoPath}/${path}`);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) continue;
      const cause = errorMessage(err);
      console.warn(
        `[mutation] could not restore the working tree: removing ${path}: ${cause}`,
      );
    }
  }

  const toCheckout: string[] = [];
  for (const path of after.modified) {
    if (before.modified.has(path)) continue;
    if (isUnsafePath(path)) {
      console.warn(
        `[mutation] could not restore the working tree: refusing unsafe path ${path}`,
      );
      continue;
    }
    toCheckout.push(path);
  }
  for (let i = 0; i < toCheckout.length; i += CHECKOUT_CHUNK) {
    const chunk = toCheckout.slice(i, i + CHECKOUT_CHUNK);
    const checkout = await runGitCommand(
      ["checkout", "--", ...chunk.map((p) => `:(literal)${p}`)],
      { cwd: repoPath },
    );
    if (!checkout.ok || checkout.value.code !== 0) {
      console.warn(
        `[mutation] could not restore the working tree: checkout: ${
          causeOf(checkout)
        }`,
      );
    }
  }
}
