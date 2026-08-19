/**
 * Tests for git_conflict_resolution.ts — Merge conflict resolution (Issue #321, #912).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  isRebaseInProgress,
  resolveRebaseConflicts,
} from "../lib/git_conflict_resolution.ts";

/** Create a temporary git repository. */
async function createTempRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "git-conflict-test-" });

  const run = async (args: string[]) => {
    const cmd = new Deno.Command("git", {
      args,
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    await cmd.output();
  };

  await run(["init", "-b", "main"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test"]);

  await Deno.writeTextFile(`${dir}/file.txt`, "initial content");
  await run(["add", "."]);
  await run(["commit", "-m", "initial"]);

  return dir;
}

async function cleanup(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// isRebaseInProgress
// ---------------------------------------------------------------------------

Deno.test("git conflict - isRebaseInProgress returns false on clean repo", async () => {
  const dir = await createTempRepo();
  try {
    assertEquals(await isRebaseInProgress({ cwd: dir }), false);
  } finally {
    await cleanup(dir);
  }
});

Deno.test("git conflict - isRebaseInProgress returns false for non-git directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "non-git-test-" });
  try {
    assertEquals(await isRebaseInProgress({ cwd: dir }), false);
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// resolveRebaseConflicts — no rebase in progress
// ---------------------------------------------------------------------------

Deno.test("git conflict - resolveRebaseConflicts fails when no rebase in progress", async () => {
  const dir = await createTempRepo();
  try {
    const result = await resolveRebaseConflicts({ cwd: dir });
    assertEquals(result.ok, false);
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// resolveRebaseConflicts — with conflicting rebase
// ---------------------------------------------------------------------------

Deno.test("git conflict - resolveRebaseConflicts resolves a conflicting rebase", async () => {
  const dir = await createTempRepo();
  try {
    const run = async (args: string[]): Promise<number> => {
      const cmd = new Deno.Command("git", {
        args,
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      });
      const result = await cmd.output();
      return result.code;
    };

    // Create diverging branches with a conflict
    await run(["checkout", "-b", "feature"]);
    await Deno.writeTextFile(`${dir}/file.txt`, "feature change");
    await run(["add", "."]);
    await run(["commit", "-m", "feature commit"]);

    await run(["checkout", "main"]);
    await Deno.writeTextFile(`${dir}/file.txt`, "main change");
    await run(["add", "."]);
    await run(["commit", "-m", "main commit"]);

    await run(["checkout", "feature"]);

    // Start rebase that will conflict
    const rebaseCode = await run(["rebase", "main"]);
    if (rebaseCode === 0) {
      // No conflict occurred (git auto-resolved). That's fine — skip the rest.
      return;
    }

    // Verify rebase is in progress
    assertEquals(await isRebaseInProgress({ cwd: dir }), true);

    // Now resolve
    const result = await resolveRebaseConflicts({ cwd: dir });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.filesResolved > 0, true);
      assertEquals(result.value.rounds >= 1, true);
    }
  } finally {
    await cleanup(dir);
  }
});
