/**
 * Tests for git_state_recovery.ts — Git state recovery (Issue #467, #912).
 *
 * Tests use a real temporary git repository to exercise the recovery logic
 * against actual git state.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { recoverGitState } from "../lib/git_state_recovery.ts";

/** Create a temporary git repository for testing. */
async function createTempRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "git-recovery-test-" });

  const run = async (args: string[]) => {
    const cmd = new Deno.Command("git", {
      args,
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    await cmd.output();
  };

  await run(["init"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test"]);

  // Create initial commit so HEAD exists
  await Deno.writeTextFile(`${dir}/README.md`, "# Test");
  await run(["add", "."]);
  await run(["commit", "-m", "initial"]);

  return dir;
}

/** Clean up a temporary directory. */
async function cleanup(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// recoverGitState — no recovery needed
// ---------------------------------------------------------------------------

Deno.test("git state recovery - recoverGitState on clean repo takes no action", async () => {
  const dir = await createTempRepo();
  try {
    const result = await recoverGitState("main", { cwd: dir });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.actions.length, 0);
      assertEquals(result.value.recovered, true);
    }
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// recoverGitState — detached HEAD
// ---------------------------------------------------------------------------

Deno.test("git state recovery - recoverGitState recovers from detached HEAD", async () => {
  const dir = await createTempRepo();
  try {
    // Create a detached HEAD by checking out a commit hash
    const getHash = new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      cwd: dir,
      stdout: "piped",
    });
    const hashOutput = await getHash.output();
    const hash = new TextDecoder().decode(hashOutput.stdout).trim();

    const detach = new Deno.Command("git", {
      args: ["checkout", hash],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    await detach.output();

    // Verify HEAD is detached
    const checkHead = new Deno.Command("git", {
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
      cwd: dir,
      stdout: "piped",
    });
    const headOutput = await checkHead.output();
    const head = new TextDecoder().decode(headOutput.stdout).trim();
    assertEquals(head, "HEAD");

    // Now recover
    const result = await recoverGitState("main", { cwd: dir });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.actions.length > 0, true);
      assertStringIncludes(result.value.actions[0]!, "Detached HEAD");
    }
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// recoverGitState — in-progress merge
// ---------------------------------------------------------------------------

Deno.test("git state recovery - recoverGitState aborts in-progress merge", async () => {
  const dir = await createTempRepo();
  try {
    const run = async (args: string[]) => {
      const cmd = new Deno.Command("git", {
        args,
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      });
      await cmd.output();
    };

    // Create a conflicting merge scenario
    await run(["checkout", "-b", "feature"]);
    await Deno.writeTextFile(`${dir}/README.md`, "# Feature branch change");
    await run(["add", "."]);
    await run(["commit", "-m", "feature change"]);

    await run(["checkout", "main"]);
    await Deno.writeTextFile(`${dir}/README.md`, "# Main branch change");
    await run(["add", "."]);
    await run(["commit", "-m", "main change"]);

    // Start a merge that will conflict
    await run(["merge", "feature"]);
    // Merge might auto-resolve or conflict; either way test recovery

    const result = await recoverGitState("main", { cwd: dir });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.recovered, true);
    }
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// recoverGitState — non-git directory
// ---------------------------------------------------------------------------

Deno.test("git state recovery - recoverGitState handles non-git directory gracefully", async () => {
  const dir = await Deno.makeTempDir({ prefix: "non-git-test-" });
  try {
    const result = await recoverGitState("main", { cwd: dir });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.actions.length, 0);
    }
  } finally {
    await cleanup(dir);
  }
});
