/**
 * Tests for git_repo_validation.ts — Repository state validation (Issue #621, #912).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { validateRepoState } from "../lib/git_repo_validation.ts";

/** Create a temporary git repository. */
async function createTempRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "git-validation-test-" });

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

  await Deno.writeTextFile(`${dir}/README.md`, "# Test");
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
// validateRepoState — clean repo on correct branch
// ---------------------------------------------------------------------------

Deno.test("git repo validation - passes on clean repo with correct branch", async () => {
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

    // Create and switch to the feature branch
    await run(["checkout", "-b", "issue-42-test"]);

    const result = await validateRepoState("issue-42-test", "main", false, {
      cwd: dir,
    });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.valid, true);
    }
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// validateRepoState — wrong branch
// ---------------------------------------------------------------------------

Deno.test("git repo validation - fails when on wrong branch without recovery", async () => {
  const dir = await createTempRepo();
  try {
    const result = await validateRepoState("issue-42-test", "main", false, {
      cwd: dir,
    });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.valid, false);
      assertEquals(result.value.errorCode, 2);
    }
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// validateRepoState — dirty working directory
// ---------------------------------------------------------------------------

Deno.test("git repo validation - fails with uncommitted changes without recovery", async () => {
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

    await run(["checkout", "-b", "issue-42-test"]);

    // Create uncommitted changes
    await Deno.writeTextFile(`${dir}/dirty.txt`, "uncommitted");

    const result = await validateRepoState("issue-42-test", "main", false, {
      cwd: dir,
    });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.valid, false);
      assertEquals(result.value.errorCode, 1);
    }
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// validateRepoState — dirty working directory with recovery
// ---------------------------------------------------------------------------

Deno.test("git repo validation - recovers from dirty working directory", async () => {
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

    await run(["checkout", "-b", "issue-42-test"]);

    // Create uncommitted changes
    await Deno.writeTextFile(`${dir}/dirty.txt`, "uncommitted");

    const result = await validateRepoState("issue-42-test", "main", true, {
      cwd: dir,
    });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.valid, true);
      assertEquals(result.value.actions.length > 0, true);
    }
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// validateRepoState — detached HEAD with recovery
// ---------------------------------------------------------------------------

Deno.test("git repo validation - recovers from detached HEAD", async () => {
  const dir = await createTempRepo();
  try {
    const run = async (args: string[]) => {
      const cmd = new Deno.Command("git", {
        args,
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      });
      return await cmd.output();
    };

    // Create the feature branch
    await run(["checkout", "-b", "issue-42-test"]);
    await Deno.writeTextFile(`${dir}/feature.txt`, "content");
    await run(["add", "."]);
    await run(["commit", "-m", "feature"]);

    // Detach HEAD
    const hashOutput = await run(["rev-parse", "HEAD"]);
    const hash = new TextDecoder().decode(hashOutput.stdout).trim();
    await run(["checkout", hash]);

    const result = await validateRepoState("issue-42-test", "main", true, {
      cwd: dir,
    });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.valid, true);
      assertEquals(result.value.actions.length > 0, true);
    }
  } finally {
    await cleanup(dir);
  }
});
