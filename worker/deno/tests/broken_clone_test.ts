/**
 * Tests for `discardBrokenClone` (Issue #2848).
 *
 * A clone directory that exists but holds no git repository — an interrupted
 * clone, or a `.git` left corrupt — wedged every run at setup: it passed the
 * "already cloned" check, and every git call in it then failed with
 * `not a git repository … Stopping at filesystem boundary`. The helper removes
 * such a directory so the caller clones afresh, and never touches a real one.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { discardBrokenClone } from "../lib/broken_clone.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("discardBrokenClone - removes a directory that holds no repository", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const repoPath = `${workDir}/widget`;
    await Deno.mkdir(repoPath);
    await Deno.writeTextFile(`${repoPath}/README.md`, "half a clone\n");

    const result = await discardBrokenClone(repoPath);

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value, true);
    assertEquals(await exists(repoPath), false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("discardBrokenClone - removes a directory whose .git is corrupt", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const repoPath = `${workDir}/widget`;
    await Deno.mkdir(`${repoPath}/.git`, { recursive: true });

    const result = await discardBrokenClone(repoPath);

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value, true);
    assertEquals(await exists(repoPath), false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("discardBrokenClone - leaves a real repository untouched", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const repoPath = `${workDir}/widget`;
    await Deno.mkdir(repoPath);
    const init = await new Deno.Command("git", {
      args: ["init", "-q"],
      cwd: repoPath,
    }).output();
    assertEquals(init.code, 0);

    const result = await discardBrokenClone(repoPath);

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value, false);
    assertEquals(await exists(`${repoPath}/.git`), true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("discardBrokenClone - a directory nested in another repository is still broken", async () => {
  // The parent's repository must not vouch for a clone that has none.
  const workDir = await Deno.makeTempDir();
  try {
    const init = await new Deno.Command("git", {
      args: ["init", "-q"],
      cwd: workDir,
    }).output();
    assertEquals(init.code, 0);
    const repoPath = `${workDir}/widget`;
    await Deno.mkdir(repoPath);

    const result = await discardBrokenClone(repoPath);

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value, true);
    assertEquals(await exists(repoPath), false);
    assertEquals(await exists(`${workDir}/.git`), true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("discardBrokenClone - a missing directory is nothing to discard", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const result = await discardBrokenClone(`${workDir}/widget`);

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value, false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
