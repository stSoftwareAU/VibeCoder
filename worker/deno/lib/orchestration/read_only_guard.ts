/**
 * Keeps a read-only orchestration role read-only (Issue #4356).
 *
 * Codex roles cannot use the CLI's own sandbox inside the agent container:
 * it needs bubblewrap and a fresh procfs mount, and the container's masked
 * `/proc` makes the kernel refuse that mount even when bubblewrap is
 * installed. So every role runs with the container as its sandbox, and the
 * worker enforces "read-only" for the manager and reviewer here: it records
 * the checkout before the call and puts back whatever the call changed —
 * the branch, `HEAD`, the index and every tracked or untracked file. Files
 * git ignores are outside the guard.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { runGitCommand } from "../git_timeout.ts";
import type { Result } from "../../types.ts";

/** The state of one checkout before a read-only call. */
export interface CheckoutSnapshot {
  cwd: string;
  /** The branch `HEAD` named, or null when it was detached. */
  branchRef: string | null;
  head: string;
  /** A tree object holding every tracked and untracked file. */
  tree: string;
  /** The real index file and its bytes, so staging is put back too. */
  indexPath: string;
  index: Uint8Array | null;
}

async function git(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const run = await runGitCommand(args, { cwd, env });
  if (!run.ok) throw run.error;
  if (run.value.code !== 0) {
    throw new Error(
      `git ${args[0]} failed in ${cwd}: ${
        run.value.stderr.trim() || `exit ${run.value.code}`
      }`,
    );
  }
  return run.value.stdout.trim();
}

/** Runs `body` with a throwaway index file, removed afterwards. */
async function withScratchIndex<T>(
  body: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const path = await Deno.makeTempFile({ prefix: "vibe-read-only-index-" });
  // git refuses an empty file as an index; it must not exist yet.
  await Deno.remove(path);
  try {
    return await body({ GIT_INDEX_FILE: path });
  } finally {
    await Deno.remove(path).catch(() => {});
  }
}

/** The tree of the working tree as it stands, untracked files included. */
async function workingTree(cwd: string, head: string): Promise<string> {
  return await withScratchIndex(async (env) => {
    await git(cwd, ["read-tree", head], env);
    await git(cwd, ["add", "-A"], env);
    return await git(cwd, ["write-tree"], env);
  });
}

async function readIndex(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * Record the checkout at `cwd` so {@link restoreCheckout} can put it back.
 *
 * @param cwd - The checkout the read-only role will run in.
 * @returns The snapshot, or why the checkout could not be recorded.
 */
export async function snapshotCheckout(
  cwd: string,
): Promise<Result<CheckoutSnapshot>> {
  try {
    const head = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
    const branch = await runGitCommand(["symbolic-ref", "-q", "HEAD"], { cwd });
    const branchRef = branch.ok && branch.value.code === 0
      ? branch.value.stdout.trim()
      : null;
    const indexPath = await git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ]);
    return {
      ok: true,
      value: {
        cwd,
        branchRef,
        head,
        tree: await workingTree(cwd, head),
        indexPath,
        index: await readIndex(indexPath),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Put the checkout back the way {@link snapshotCheckout} found it.
 *
 * @param snap - The snapshot taken before the read-only call.
 * @returns Whether anything had changed, or why it could not be put back.
 */
export async function restoreCheckout(
  snap: CheckoutSnapshot,
): Promise<Result<{ changed: boolean }>> {
  const { cwd } = snap;
  try {
    let changed = false;

    const branch = await runGitCommand(["symbolic-ref", "-q", "HEAD"], { cwd });
    const branchRef = branch.ok && branch.value.code === 0
      ? branch.value.stdout.trim()
      : null;
    if (branchRef !== snap.branchRef) {
      changed = true;
      // Point HEAD back without touching files; the tree is restored below.
      if (snap.branchRef === null) {
        await git(cwd, ["update-ref", "--no-deref", "HEAD", snap.head]);
      } else {
        await git(cwd, ["symbolic-ref", "HEAD", snap.branchRef]);
      }
    }
    const head = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
    if (head !== snap.head) {
      changed = true;
      await git(cwd, ["reset", "-q", "--soft", snap.head]);
    }

    const tree = await workingTree(cwd, snap.head);
    if (tree !== snap.tree) {
      changed = true;
      // A two-tree read-tree moves the files from the current tree to the
      // recorded one: changed files are rewritten, added ones removed and
      // deleted ones restored.
      await withScratchIndex(async (env) => {
        await git(cwd, ["read-tree", tree], env);
        // A fresh index has no stat data, and the merge refuses every entry
        // it cannot prove is up to date.
        await git(cwd, ["update-index", "-q", "--refresh"], env);
        await git(cwd, ["read-tree", "-m", "-u", tree, snap.tree], env);
      });
    }

    if (!sameBytes(await readIndex(snap.indexPath), snap.index)) {
      changed = true;
      if (snap.index === null) {
        await Deno.remove(snap.indexPath).catch(() => {});
      } else {
        await Deno.writeFile(snap.indexPath, snap.index);
      }
    }
    return { ok: true, value: { changed } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
