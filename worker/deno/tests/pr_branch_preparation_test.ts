/**
 * Tests for pr_branch_preparation.ts — shared PR branch helpers (Issue #1458).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  preparePrBranch,
  readPrResponseMessage,
} from "../lib/pr_branch_preparation.ts";
import type { GitDeps } from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

// ---------------------------------------------------------------------------
// preparePrBranch
// ---------------------------------------------------------------------------

Deno.test("preparePrBranch - operates on the requested branch and fetches before pulling", async () => {
  const calls: string[][] = [];
  const runGitCommand = ((args: string[]) => {
    calls.push(args);
    return Promise.resolve({
      ok: true as const,
      value: { code: 0, stdout: "", stderr: "" },
    });
  }) as unknown as GitDeps["runGitCommand"];

  // Completes without throwing — the observable success outcome.
  await preparePrBranch("feature-branch", {
    logger: makeSilentLogger(),
    git: { runGitCommand },
    cwd: "/tmp/repo",
  });

  // Real contract: every git invocation operates on the requested branch,
  // so preparation cannot silently act on the wrong ref.
  for (const call of calls) {
    assertEquals(
      call.includes("feature-branch"),
      true,
      `git invocation ${JSON.stringify(call)} should target feature-branch`,
    );
  }

  // Where order genuinely matters, assert the relationship rather than pinning
  // absolute indices or an exact call count: the branch must be fetched before
  // it is pulled. Adding an unrelated git step (e.g. a rev-parse guard) or
  // swapping `checkout` for `git switch` leaves this assertion intact.
  const verbs = calls.map((call) => call[0]);
  assert(verbs.includes("fetch"), "expected a fetch invocation");
  assert(verbs.includes("pull"), "expected a pull invocation");
  assert(
    verbs.indexOf("fetch") < verbs.indexOf("pull"),
    "fetch must precede pull",
  );
});

Deno.test("preparePrBranch - a transient fetch failure is tolerated (checkout and pull still run) (Issue #4376)", async () => {
  const calls: string[][] = [];
  const runGitCommand = ((args: string[]) => {
    calls.push(args);
    if (args[0] === "fetch") {
      return Promise.resolve({
        ok: true as const,
        value: { code: 1, stdout: "", stderr: "remote rejected" },
      });
    }
    return Promise.resolve({
      ok: true as const,
      value: { code: 0, stdout: "", stderr: "" },
    });
  }) as unknown as GitDeps["runGitCommand"];

  const outcome = await preparePrBranch("feature-branch", {
    logger: makeSilentLogger(),
    git: { runGitCommand },
    cwd: "/tmp/repo",
  });
  assertEquals(outcome.ok, true);
  assertEquals(calls.length, 3, "checkout and pull still attempted");
});

Deno.test("preparePrBranch - a branch that no longer exists on origin is reported (branch_missing) and nothing else runs (Issue #4376)", async () => {
  const calls: string[][] = [];
  const runGitCommand = ((args: string[]) => {
    calls.push(args);
    if (args[0] === "fetch") {
      return Promise.resolve({
        ok: true as const,
        value: {
          code: 128,
          stdout: "",
          stderr:
            "fatal: couldn't find remote ref issue-4297-fix-shutdown-reconcile-progress-extensions-with-th",
        },
      });
    }
    return Promise.resolve({
      ok: true as const,
      value: { code: 0, stdout: "", stderr: "" },
    });
  }) as unknown as GitDeps["runGitCommand"];

  const outcome = await preparePrBranch(
    "issue-4297-fix-shutdown-reconcile-progress-extensions-with-th",
    {
      logger: makeSilentLogger(),
      git: { runGitCommand },
      cwd: "/tmp/repo",
    },
  );
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.reason, "branch_missing");
  assertEquals(calls.length, 1, "no checkout/pull on a branch that is gone");
});

Deno.test("preparePrBranch - a checkout failure is reported (checkout_failed): the agent must not run on the wrong branch (Issue #4376)", async () => {
  const calls: string[][] = [];
  const runGitCommand = ((args: string[]) => {
    calls.push(args);
    if (args[0] === "checkout") {
      return Promise.resolve({
        ok: false as const,
        error: new Error("pathspec not found"),
      });
    }
    return Promise.resolve({
      ok: true as const,
      value: { code: 0, stdout: "", stderr: "" },
    });
  }) as unknown as GitDeps["runGitCommand"];

  const outcome = await preparePrBranch("feature-branch", {
    logger: makeSilentLogger(),
    git: { runGitCommand },
    cwd: "/tmp/repo",
  });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.reason, "checkout_failed");
  assertEquals(calls.length, 2, "no pull after a failed checkout");
});

Deno.test("preparePrBranch - passes cwd to every git command", async () => {
  const captured: (string | undefined)[] = [];
  const runGitCommand = ((_args: string[], options?: { cwd?: string }) => {
    captured.push(options?.cwd);
    return Promise.resolve({
      ok: true as const,
      value: { code: 0, stdout: "", stderr: "" },
    });
  }) as unknown as GitDeps["runGitCommand"];

  await preparePrBranch("feature-branch", {
    logger: makeSilentLogger(),
    git: { runGitCommand },
    cwd: "/tmp/my-repo",
  });

  assertEquals(captured, ["/tmp/my-repo", "/tmp/my-repo", "/tmp/my-repo"]);
});

// ---------------------------------------------------------------------------
// readPrResponseMessage
// ---------------------------------------------------------------------------

Deno.test("readPrResponseMessage - returns undefined when workDir is undefined", async () => {
  const result = await readPrResponseMessage(undefined);
  assertEquals(result, undefined);
});

Deno.test("readPrResponseMessage - returns undefined when file is missing", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await readPrResponseMessage(tmpDir);
    assertEquals(result, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readPrResponseMessage - reads and consumes the file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const path = `${tmpDir}/.pr_response_message`;
    const message = "I fixed the typo on line 42.";
    await Deno.writeTextFile(path, message);

    const result = await readPrResponseMessage(tmpDir);
    assertEquals(result, message);

    // File should have been removed so a subsequent run does not see stale content
    const stillExists = await Deno.stat(path).then(() => true).catch(() =>
      false
    );
    assertEquals(stillExists, false, "file should be removed after reading");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readPrResponseMessage - trims whitespace from file content", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const path = `${tmpDir}/.pr_response_message`;
    await Deno.writeTextFile(path, "\n  Fixed the bug.  \n\n");

    const result = await readPrResponseMessage(tmpDir);
    assertEquals(result, "Fixed the bug.");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readPrResponseMessage - returns undefined for empty file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const path = `${tmpDir}/.pr_response_message`;
    await Deno.writeTextFile(path, "\n  \n");

    const result = await readPrResponseMessage(tmpDir);
    assertEquals(result, undefined);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("readPrResponseMessage - redacts secrets before returning (Issue #3202)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const path = `${tmpDir}/.pr_response_message`;
    const anthropicKey = "sk-ant-api03-" + "A".repeat(40);
    const githubToken = "ghp_" + "B".repeat(36);
    await Deno.writeTextFile(
      path,
      `I fixed the bug. The key was ${anthropicKey} and token ${githubToken}.`,
    );

    const result = await readPrResponseMessage(tmpDir);

    assert(result !== undefined, "expected a message");
    assert(
      !result!.includes(anthropicKey),
      "Anthropic key must not survive into the PR comment body",
    );
    assert(
      !result!.includes(githubToken),
      "GitHub token must not survive into the PR comment body",
    );
    assert(
      result!.includes("***REDACTED***"),
      "secrets should be replaced with the redaction placeholder",
    );
    // Non-secret prose is preserved.
    assert(result!.includes("I fixed the bug."));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
