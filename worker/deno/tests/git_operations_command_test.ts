/**
 * Tests for git_operations command — unified git operations (Issue #912).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { gitOperationsCommand } from "../commands/git_operations.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const config = buildDefaultWorkerConfig();

// ---------------------------------------------------------------------------
// create-branch-name operation
// ---------------------------------------------------------------------------

Deno.test("git operations command - create-branch-name creates branch name", async () => {
  const result = await gitOperationsCommand.execute(
    {
      operation: "create-branch-name",
      "issue-number": 42,
      "issue-title": "Fix login bug",
    },
    config,
  );
  assertEquals(result.success, true);
  assertEquals(result.message, "issue-42-fix-login-bug");
});

Deno.test("git operations command - create-branch-name requires arguments", async () => {
  const result = await gitOperationsCommand.execute(
    { operation: "create-branch-name" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Missing required");
});

// ---------------------------------------------------------------------------
// create-milestone-branch-name operation
// ---------------------------------------------------------------------------

Deno.test("git operations command - create-milestone-branch-name works", async () => {
  const result = await gitOperationsCommand.execute(
    {
      operation: "create-milestone-branch-name",
      "milestone-title": "OIDC Auth",
    },
    config,
  );
  assertEquals(result.success, true);
  assertEquals(result.message, "milestone/oidc-auth");
});

// ---------------------------------------------------------------------------
// is-protected-branch operation
// ---------------------------------------------------------------------------

Deno.test("git operations command - is-protected-branch detects protected branches", async () => {
  const result = await gitOperationsCommand.execute(
    { operation: "is-protected-branch", "branch-name": "main" },
    config,
  );
  assertEquals(result.success, true);
  assertEquals(result.message, "true");
});

Deno.test("git operations command - is-protected-branch detects feature branches", async () => {
  const result = await gitOperationsCommand.execute(
    { operation: "is-protected-branch", "branch-name": "issue-42-test" },
    config,
  );
  assertEquals(result.success, true);
  assertEquals(result.message, "false");
});

// ---------------------------------------------------------------------------
// detect-push-rejection operation
// ---------------------------------------------------------------------------

Deno.test("git operations command - detect-push-rejection detects rejection", async () => {
  const result = await gitOperationsCommand.execute(
    {
      operation: "detect-push-rejection",
      "push-output": "error: (fetch first)",
    },
    config,
  );
  assertEquals(result.success, true);
  assertEquals(result.message, "true");
});

// ---------------------------------------------------------------------------
// detect-existing-pr operation
// ---------------------------------------------------------------------------

Deno.test("git operations command - detect-existing-pr extracts PR URL", async () => {
  const result = await gitOperationsCommand.execute(
    {
      operation: "detect-existing-pr",
      "error-output": "already exists: https://github.com/org/repo/pull/42",
    },
    config,
  );
  assertEquals(result.success, true);
  assertEquals(result.message, "https://github.com/org/repo/pull/42");
});

// ---------------------------------------------------------------------------
// unknown operation
// ---------------------------------------------------------------------------

Deno.test("git operations command - unknown operation returns error", async () => {
  const result = await gitOperationsCommand.execute(
    { operation: "nonexistent" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Unknown git operation");
});

// ---------------------------------------------------------------------------
// missing operation
// ---------------------------------------------------------------------------

Deno.test("git operations command - missing operation returns error", async () => {
  const result = await gitOperationsCommand.execute({}, config);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Unknown git operation");
});

// ---------------------------------------------------------------------------
// validate-repo-state (with real temp repo)
// ---------------------------------------------------------------------------

Deno.test("git operations command - validate-repo-state on clean feature branch", async () => {
  const dir = await Deno.makeTempDir({ prefix: "git-cmd-test-" });
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

    await run(["init"]);
    await run(["config", "user.email", "test@example.com"]);
    await run(["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${dir}/README.md`, "# Test");
    await run(["add", "."]);
    await run(["commit", "-m", "initial"]);
    await run(["checkout", "-b", "issue-42-test"]);

    const result = await gitOperationsCommand.execute(
      {
        operation: "validate-repo-state",
        "feature-branch": "issue-42-test",
        "base-branch": "main",
        cwd: dir,
      },
      config,
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message, "passed");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
