/**
 * Tests for pr_ci_processor.ts — CI fix processing.
 *
 * Issue #967: Part of the Deno worker orchestration migration (#918).
 * Issue #1230: Added tests for the 'process' command operation.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  formatCiAnnotations,
  processCiFailure,
  resolveCiCheckStateDir,
} from "../lib/pr_ci_processor.ts";
import { recordCiCheckRetry } from "../lib/pr_ci_checks.ts";
import { prCiProcessorCommand } from "../commands/pr_ci_processor.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { Logger } from "../types.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
  PrDeps,
} from "../lib/issue_worker_wiring.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844)
// — named as a parameter on every call rather than pinned by deleting the
// host's overrides from the shared process environment (Issue #1024).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeInput(overrides?: Partial<CiFixInput>): CiFixInput {
  const annotations: CheckAnnotation[] = [
    {
      path: "tests/main_test.ts",
      start_line: 42,
      message: "Test assertion failed",
    },
  ];
  const encoded = btoa(JSON.stringify(annotations));

  return {
    repo: "org/repo",
    prNumber: 42,
    branchName: "issue-42-fix-bug",
    checkRunId: "67890",
    checkName: "CI / test",
    encodedAnnotations: encoded,
    ...overrides,
  };
}

// ============================================================================
// formatCiAnnotations
// ============================================================================

/**
 * Issue #579: a claim that the push landed is now made against the REMOTE,
 * not against local state. Tests that assert a successful push therefore say
 * so explicitly — clean local state, and a moved HEAD, are no longer
 * sufficient evidence on their own.
 */
const REMOTE_CONFIRMS_PUSH = () =>
  Promise.resolve({
    landed: true,
    localSha: "f".repeat(40),
    remoteSha: "f".repeat(40),
    reason: "verified in test",
  });

Deno.test("formatCiAnnotations - formats CI failure details", () => {
  const annotations: CheckAnnotation[] = [
    { path: "tests/main_test.ts", start_line: 42, message: "Assertion failed" },
  ];
  const result = formatCiAnnotations(annotations);
  assertEquals(result.includes("CI failure details were detected"), true);
  assertEquals(result.includes("**tests/main_test.ts:42**"), true);
  assertEquals(result.includes("Assertion failed"), true);
});

Deno.test("formatCiAnnotations - handles empty annotations", () => {
  const result = formatCiAnnotations([]);
  assertEquals(result.includes("No specific annotations"), true);
  assertEquals(result.includes("check the CI logs"), true);
});

Deno.test("formatCiAnnotations - formats multiple CI annotations", () => {
  const annotations: CheckAnnotation[] = [
    { path: "a.ts", start_line: 1, message: "error1" },
    { path: "b.ts", start_line: 2, message: "error2" },
    { path: "c.ts", start_line: 3, message: "error3" },
  ];
  const result = formatCiAnnotations(annotations);
  assertEquals(result.includes("**a.ts:1**"), true);
  assertEquals(result.includes("**c.ts:3**"), true);
});

// ============================================================================
// processCiFailure — integration with mock deps
// ============================================================================

Deno.test("processCiFailure - succeeds with mock Claude output", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "Fixed CI", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: () => Promise.resolve(""),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        // Issue #1643: processor now uses commitAndPushPending as the
        // final-mile guard rather than pushUnpushedCommits directly.
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.processed, true);
      assertEquals(result.value.changesPushed, true);
      assertEquals(result.value.retryCount, 1);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - skips when max retries exceeded", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const stateDir = `${tmpDir}/.ci_check_state`;
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.writeTextFile(`${stateDir}/org_repo_67890.retries`, "3");

    const ghCalls: string[][] = [];
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: (args: string[]) => {
        ghCalls.push(args);
        return Promise.resolve("");
      },
    };
    const deps = createMockDeps({ github: mockGithub });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir,
      maxCiRetries: 3,
      ghCommandFn: (args: string[]) => {
        ghCalls.push(args);
        return Promise.resolve("");
      },
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.processed, false);
      assertEquals(result.value.summary.includes("exceeded max retries"), true);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - increments retry count", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const stateDir = `${tmpDir}/.ci_check_state`;

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "Fixed", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: () => Promise.resolve(""),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        // Issue #1643: processor now uses commitAndPushPending.
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir,
      workDir: tmpDir,
    };

    // First run
    const result1 = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result1.ok, true);
    if (result1.ok) {
      assertEquals(result1.value.retryCount, 1);
    }

    // Second run
    const result2 = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result2.ok, true);
    if (result2.ok) {
      assertEquals(result2.value.retryCount, 2);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// Heartbeat lifecycle — startHeartbeat/stopHeartbeat (Issue #1204)
// ============================================================================

Deno.test("processCiFailure - starts and stops heartbeat during processing", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    let heartbeatRecordCount = 0;
    let heartbeatCleared = false;

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "Fixed CI issue", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: () => Promise.resolve(""),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        // Issue #1643: processor uses commitAndPushPending.
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
      },
      crashHandling: {
        recordHeartbeat: () => {
          heartbeatRecordCount++;
          return Promise.resolve({ ok: true, value: undefined });
        },
        clearHeartbeat: () => {
          heartbeatCleared = true;
          return Promise.resolve({ ok: true, value: undefined });
        },
      },
      pr: {
        enableAutoMerge: (() =>
          Promise.resolve()) as unknown as PrDeps["enableAutoMerge"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    assertEquals(
      heartbeatRecordCount >= 1,
      true,
      "heartbeat should be recorded at least once via startHeartbeat",
    );
    assertEquals(
      heartbeatCleared,
      true,
      "heartbeat should be cleared after processing completes",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - stops heartbeat even when Claude fails", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    let heartbeatRecordCount = 0;
    let heartbeatCleared = false;

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: false,
          error: new Error("Claude failed"),
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: () => Promise.resolve(""),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      crashHandling: {
        recordHeartbeat: () => {
          heartbeatRecordCount++;
          return Promise.resolve({ ok: true, value: undefined });
        },
        clearHeartbeat: () => {
          heartbeatCleared = true;
          return Promise.resolve({ ok: true, value: undefined });
        },
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, false);
    assertEquals(
      heartbeatRecordCount >= 1,
      true,
      "heartbeat should be recorded even when Claude fails",
    );
    assertEquals(
      heartbeatCleared,
      true,
      "heartbeat should be cleared even when processing fails",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - handles Claude failure", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: false,
          error: new Error("Rate limit"),
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: () => Promise.resolve(""),
    };
    const deps = createMockDeps({ claude: mockClaude, github: mockGithub });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.message.includes("execution failed"), true);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// Final-mile push (Issue #1643) — regression tests
// ============================================================================

Deno.test("processCiFailure - pushes commits even when Claude output is empty (Issue #1643)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    let commitAndPushCalled = false;
    const mockClaude: Partial<ClaudeDeps> = {
      // Claude makes a silent commit — produces no terminal output.
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: () => Promise.resolve(""),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        commitAndPushPending: ((() => {
          commitAndPushCalled = true;
          return Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          });
        }) as unknown) as GitDeps["commitAndPushPending"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    assertEquals(
      commitAndPushCalled,
      true,
      "commitAndPushPending must be called even when Claude output is empty",
    );
    if (result.ok) {
      assertEquals(
        result.value.changesPushed,
        true,
        "changesPushed must be true when commitAndPushPending pushed a commit",
      );
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - reports push failure when commits remain unpushed (Issue #1643)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "Fixed", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: () => Promise.resolve(""),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: true,
              commitsPushed: 0,
              finalUnpushedCount: 1, // commits committed but push failed
            },
          })) as unknown as GitDeps["commitAndPushPending"],
        recoverFromPushRejection: (() =>
          Promise.resolve({
            ok: false,
            error: new Error("recovery failed"),
          })) as unknown as GitDeps["recoverFromPushRejection"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(
        result.value.changesPushed,
        false,
        "changesPushed must be false when commits remain unpushed",
      );
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// prCiProcessorCommand — command-level tests (Issue #1230)
// ============================================================================

Deno.test("prCiProcessorCommand - format-ci-annotations operation works", async () => {
  const annotations: CheckAnnotation[] = [
    { path: "tests/main_test.ts", start_line: 42, message: "Assertion failed" },
  ];
  const encoded = btoa(JSON.stringify(annotations));
  const config = buildDefaultWorkerConfig();
  const result = await prCiProcessorCommand.execute(
    { operation: "format-ci-annotations", encoded },
    config,
  );
  assertEquals(result.success, true);
  assertEquals(result.message.includes("tests/main_test.ts:42"), true);
  assertEquals(result.message.includes("Assertion failed"), true);
});

Deno.test("prCiProcessorCommand - process rejects missing arguments", async () => {
  const config = buildDefaultWorkerConfig();
  const result = await prCiProcessorCommand.execute(
    { operation: "process", repo: "", "pr-number": 0 },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Missing required arguments"), true);
});

Deno.test("prCiProcessorCommand - unknown operation returns error", async () => {
  const config = buildDefaultWorkerConfig();
  const result = await prCiProcessorCommand.execute(
    { operation: "nonexistent" },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Unknown operation"), true);
  assertEquals(result.message.includes("process"), true);
});

// ============================================================================
// Issue #1412: Explicit push after Claude makes changes
// ============================================================================

Deno.test("processCiFailure - pushes commits after Claude makes changes (Issue #1412, updated #1643)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Issue #1643: behaviour now uses commitAndPushPending — verify it is
    // invoked with the PR branch and that changesPushed reflects the
    // honest post-condition (finalUnpushedCount === 0).
    let pushCalled = false;
    let pushBranch = "";

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "Fixed CI", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: () => Promise.resolve(""),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        commitAndPushPending: ((branch: string) => {
          pushCalled = true;
          pushBranch = branch;
          return Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          });
        }) as unknown as GitDeps["commitAndPushPending"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const input = makeInput();
    const result = await processCiFailure(input, processorDeps);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.changesPushed, true);
    }
    assertEquals(
      pushCalled,
      true,
      "commitAndPushPending should be called after Claude makes changes",
    );
    assertEquals(
      pushBranch,
      input.branchName,
      "push should target the PR branch",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// Issue #1455: Branch checkout, .pr_response_message, push recovery
// ============================================================================

Deno.test("processCiFailure - checks out PR branch before running Claude (Issue #1455)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const gitCalls: string[][] = [];
    let claudeCalledAt = -1;
    let gitCallsAtClaude = 0;

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() => {
        claudeCalledAt = gitCalls.length;
        gitCallsAtClaude = gitCalls.length;
        return Promise.resolve({
          ok: true,
          value: { output: "Fixed", exitCode: 0, timedOut: false },
        });
      }) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: () => Promise.resolve(""),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        runGitCommand: ((args: string[]) => {
          gitCalls.push(args);
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          });
        }) as unknown as GitDeps["runGitCommand"],
        // Issue #1643: processor uses commitAndPushPending.
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
    };

    const input = makeInput();
    const result = await processCiFailure(input, processorDeps);
    assertEquals(result.ok, true);

    // Claude should have been called after git fetch+checkout
    assertEquals(
      claudeCalledAt >= 2,
      true,
      `Claude should run after fetch and checkout; gitCalls before Claude = ${gitCallsAtClaude}`,
    );

    const hasFetch = gitCalls.some((args, idx) =>
      idx < claudeCalledAt &&
      args[0] === "fetch" &&
      args.includes(input.branchName)
    );
    const hasCheckout = gitCalls.some((args, idx) =>
      idx < claudeCalledAt &&
      args[0] === "checkout" &&
      args.includes(input.branchName)
    );

    assertEquals(
      hasFetch,
      true,
      "git fetch origin <branch> should run before Claude",
    );
    assertEquals(
      hasCheckout,
      true,
      "git checkout <branch> should run before Claude",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - uses .pr_response_message as comment body when present (Issue #1455)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const customMessage =
      "Fixed the failing test by correcting the assertion on line 42.";
    await Deno.writeTextFile(`${tmpDir}/.pr_response_message`, customMessage);

    const commentBodies: string[] = [];
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "Fixed", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "comment") {
          const bodyIdx = args.indexOf("--body");
          if (bodyIdx >= 0) {
            const body = args[bodyIdx + 1];
            if (body !== undefined) commentBodies.push(body);
          }
        }
        return Promise.resolve("");
      },
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        // Issue #1643: processor uses commitAndPushPending.
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);

    const usedCustom = commentBodies.some((body) =>
      body.includes(customMessage)
    );
    assertEquals(
      usedCustom,
      true,
      `Expected comment body to include .pr_response_message content; got: ${
        commentBodies.join(" | ")
      }`,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - falls back to default message when .pr_response_message absent (Issue #1455)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const commentBodies: string[] = [];
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "Fixed", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "comment") {
          const bodyIdx = args.indexOf("--body");
          if (bodyIdx >= 0) {
            const body = args[bodyIdx + 1];
            if (body !== undefined) commentBodies.push(body);
          }
        }
        return Promise.resolve("");
      },
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        // Issue #1643: processor uses commitAndPushPending.
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    const usedDefault = commentBodies.some((body) =>
      body.includes("I've pushed a fix")
    );
    assertEquals(
      usedDefault,
      true,
      `Expected default 'pushed a fix' message; got: ${
        commentBodies.join(" | ")
      }`,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - recovers from push rejection and reports success (Issue #1455, updated #1643)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Issue #1643: the processor now uses commitAndPushPending. The
    // first call returns finalUnpushedCount > 0 (push failed), the
    // processor invokes recoverFromPushRejection, then retries
    // commitAndPushPending which succeeds.
    let pushCallCount = 0;
    let recoveryCalled = false;

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "Fixed", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: () => Promise.resolve(""),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        commitAndPushPending: (() => {
          pushCallCount++;
          if (pushCallCount === 1) {
            // First attempt: commit committed but push failed.
            return Promise.resolve({
              ok: true,
              value: {
                committedNewChanges: true,
                commitsPushed: 0,
                finalUnpushedCount: 1,
              },
            });
          }
          // Retry after recovery: clean.
          return Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          });
        }) as unknown as GitDeps["commitAndPushPending"],
        recoverFromPushRejection: (() => {
          recoveryCalled = true;
          return Promise.resolve({ ok: true, value: "recovered" });
        }) as unknown as GitDeps["recoverFromPushRejection"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.changesPushed, true);
    }
    assertEquals(
      recoveryCalled,
      true,
      "recoverFromPushRejection should be invoked",
    );
    assertEquals(
      pushCallCount,
      2,
      "commitAndPushPending should be retried after recovery",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - reports accurate failure when push cannot be recovered (Issue #1455)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const commentBodies: string[] = [];
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "Fixed", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "comment") {
          const bodyIdx = args.indexOf("--body");
          if (bodyIdx >= 0) {
            const body = args[bodyIdx + 1];
            if (body !== undefined) commentBodies.push(body);
          }
        }
        return Promise.resolve("");
      },
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        // Issue #1643: commit succeeded but push left commits unpushed,
        // and recovery itself fails — must not claim success.
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: true,
              commitsPushed: 0,
              finalUnpushedCount: 1,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
        recoverFromPushRejection: (() =>
          Promise.resolve({
            ok: false,
            error: new Error("recovery failed"),
          })) as unknown as GitDeps["recoverFromPushRejection"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.changesPushed, false);
    }

    const claimedPushed = commentBodies.some((body) =>
      body.includes("I've pushed a fix")
    );
    const reportedFailure = commentBodies.some((body) =>
      body.includes("failed to push")
    );
    assertEquals(
      claimedPushed,
      false,
      "must not claim 'pushed a fix' when push failed",
    );
    assertEquals(reportedFailure, true, "must report push failure to the PR");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - reports no changes when Claude does nothing (Issue #1412, updated #1643)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Issue #1643: commitAndPushPending is always called as the final-mile
    // guard. When there is genuinely nothing to commit or push it is a
    // no-op (committedNewChanges=false, commitsPushed=0,
    // finalUnpushedCount=0). The processor must report changesPushed=false
    // — but it does still call commitAndPushPending to verify state.
    let pushCalled = false;

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: () => Promise.resolve(""),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        commitAndPushPending: (() => {
          pushCalled = true;
          return Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 0,
              finalUnpushedCount: 0,
            },
          });
        }) as unknown as GitDeps["commitAndPushPending"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
    };

    const result = await processCiFailure(makeInput(), processorDeps);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.changesPushed, false);
    }
    assertEquals(
      pushCalled,
      true,
      "commitAndPushPending is always invoked as the final-mile guard (Issue #1643)",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// Issue #1456: Post-Claude quality check
// ============================================================================

/**
 * Helper to build a runGitCommand mock that returns a scripted git status
 * response and records all calls. Non-status commands return code 0.
 */
function makeGitMock(porcelainOutputs: string[]): {
  runGitCommand: GitDeps["runGitCommand"];
  calls: string[][];
} {
  const calls: string[][] = [];
  let statusIdx = 0;
  const fn = ((args: string[]) => {
    calls.push(args);
    if (args[0] === "status") {
      const stdout = porcelainOutputs[statusIdx] ?? "";
      statusIdx++;
      return Promise.resolve({
        ok: true,
        value: { code: 0, stdout, stderr: "" },
      });
    }
    return Promise.resolve({
      ok: true,
      value: { code: 0, stdout: "", stderr: "" },
    });
  }) as unknown as GitDeps["runGitCommand"];
  return { runGitCommand: fn, calls };
}

Deno.test("processCiFailure - skips quality check when no uncommitted changes (Issue #1456)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    let qualityFnCalled = false;
    let claudeCallCount = 0;

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() => {
        claudeCallCount++;
        return Promise.resolve({
          ok: true,
          value: { output: "Fixed", exitCode: 0, timedOut: false },
        });
      }) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: () => Promise.resolve(""),
    };
    // All status calls return empty (no uncommitted changes)
    const { runGitCommand, calls } = makeGitMock(["", "", ""]);
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        runGitCommand,
        // Issue #1643: processor uses commitAndPushPending.
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      qualityGateFn: () => {
        qualityFnCalled = true;
        return Promise.resolve({ action: "passed", qualityOutput: "" });
      },
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);

    assertEquals(
      qualityFnCalled,
      false,
      "qualityGateFn must not run when no uncommitted changes",
    );
    assertEquals(
      claudeCallCount,
      1,
      "Claude must only run once when no retry is needed",
    );

    const hasCommit = calls.some((args) => args[0] === "commit");
    assertEquals(
      hasCommit,
      false,
      "no commit should be made when there are no uncommitted changes",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - runs quality check and commits uncommitted changes (Issue #1456)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    let qualityFnCalled = false;
    let claudeCallCount = 0;

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() => {
        claudeCallCount++;
        return Promise.resolve({
          ok: true,
          value: { output: "Fixed", exitCode: 0, timedOut: false },
        });
      }) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: () => Promise.resolve(""),
    };
    // Status returns uncommitted changes before quality, then still uncommitted
    // after quality (e.g., Claude wrote the fix but did not commit), so the
    // post-quality commit path kicks in.
    const { runGitCommand, calls } = makeGitMock([
      " M src/file.ts\n",
      " M src/file.ts\n",
    ]);
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        runGitCommand,
        // Issue #1643: processor uses commitAndPushPending.
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      qualityGateFn: () => {
        qualityFnCalled = true;
        return Promise.resolve({ action: "passed", qualityOutput: "" });
      },
    };

    const input = makeInput();
    const result = await processCiFailure(input, processorDeps);
    assertEquals(result.ok, true);

    assertEquals(
      qualityFnCalled,
      true,
      "qualityGateFn must run when uncommitted changes exist",
    );
    assertEquals(
      claudeCallCount,
      1,
      "Claude must not be retried when quality passes",
    );

    const hasAdd = calls.some((args) => args[0] === "add");
    const hasCommit = calls.some((args) => args[0] === "commit");
    assertEquals(hasAdd, true, "git add should stage the remaining changes");
    assertEquals(
      hasCommit,
      true,
      "git commit should run for remaining changes",
    );

    // The commit message should reference the check name
    const commitArgs = calls.find((args) => args[0] === "commit");
    const commitMessage = commitArgs?.[commitArgs.indexOf("-m") + 1] ?? "";
    assertEquals(
      commitMessage.includes(input.checkName),
      true,
      `commit message should reference the check name; got: ${commitMessage}`,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - retries Claude when quality check fails (Issue #1456)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    let claudeCallCount = 0;
    const claudePrompts: string[] = [];

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: ((options: { prompt: string }) => {
        claudeCallCount++;
        claudePrompts.push(options.prompt);
        return Promise.resolve({
          ok: true,
          value: { output: "Fixed", exitCode: 0, timedOut: false },
        });
      }) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: () => Promise.resolve(""),
    };
    // Status returns uncommitted changes on both pre- and post-quality checks
    const { runGitCommand, calls } = makeGitMock([
      " M src/broken.ts\n",
      " M src/broken.ts\n",
    ]);
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        runGitCommand,
        // Issue #1643: processor uses commitAndPushPending.
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
      },
    });

    const qualityOutput = "Deno type check failed: src/broken.ts:3 TS2304";
    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      qualityGateFn: () =>
        Promise.resolve({
          action: "failed_fixable",
          qualityOutput,
          retryPrompt: `./quality.sh failing:\n${qualityOutput}`,
        }),
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);

    assertEquals(
      claudeCallCount,
      2,
      "Claude should be called twice — initial fix + quality retry",
    );
    const retryPrompt = claudePrompts[1] ?? "";
    assertEquals(
      retryPrompt.includes(qualityOutput),
      true,
      `retry prompt should include the quality failure output; got: ${retryPrompt}`,
    );

    const hasCommit = calls.some((args) => args[0] === "commit");
    assertEquals(
      hasCommit,
      true,
      "remaining changes should be committed after the retry attempt",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - a PR whose branch no longer exists on origin (merged/closed after listing) is skipped: no agent run, no push (Issue #4376)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "ci_fix_gone_" });
  try {
    const gitCalls: string[][] = [];
    let claudeRuns = 0;
    const deps = createMockDeps({
      git: {
        runGitCommand: ((args: string[]) => {
          gitCalls.push(args);
          if (args[0] === "fetch" && args.includes("origin")) {
            return Promise.resolve({
              ok: true,
              value: {
                code: 128,
                stdout: "",
                stderr: "fatal: couldn't find remote ref issue-4297-gone",
              },
            });
          }
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          });
        }) as unknown as GitDeps["runGitCommand"],
      },
      claude: {
        runClaudeWithRetry: (() => {
          claudeRuns++;
          return Promise.resolve({
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          });
        }) as unknown as ClaudeDeps["runClaudeWithRetry"],
      },
    });
    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
    };
    const result = await processCiFailure(
      makeInput({ prNumber: 4363, branchName: "issue-4297-gone" }),
      processorDeps,
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.processed, false);
      assertEquals(result.value.changesPushed, false);
      assertEquals(result.value.summary.includes("branch_missing"), true);
    }
    assertEquals(claudeRuns, 0, "the agent never runs on the wrong branch");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The retry-state location (Issue #580). A bare relative default resolved
// against the process CWD — the worker checkout, read-only since #514 — so
// every CI-fix pass died on its first counter write and the fleet stopped
// repairing red checks entirely.
// ---------------------------------------------------------------------------

Deno.test("resolveCiCheckStateDir - lands on the work volume, not the read-only CWD", () => {
  assertEquals(
    resolveCiCheckStateDir("/home/vibe/auto-issue-work"),
    "/home/vibe/auto-issue-work/.ci_check_state",
  );
  // WORK_DIR serves when the caller passes nothing.
  assertEquals(
    resolveCiCheckStateDir(
      undefined,
      (n) => n === "WORK_DIR" ? "/volume" : undefined,
    ),
    "/volume/.ci_check_state",
  );
  // Issue #552 changed this last case deliberately. It used to return the
  // legacy relative name, which the scanner and the processor could then
  // resolve to different directories — so the retry cap was read from a store
  // nothing wrote to. The resolver is now always absolute: HOME first, then a
  // writable last resort.
  assertEquals(
    resolveCiCheckStateDir(
      undefined,
      (n) => n === "HOME" ? "/home/vibe" : undefined,
    ),
    "/home/vibe/auto-issue-work/.ci_check_state",
  );
  assertEquals(
    resolveCiCheckStateDir(undefined, () => undefined),
    "/tmp/auto-issue-work/.ci_check_state",
  );
});

Deno.test("recordCiCheckRetry - a read-only state directory does not abort the repair", async () => {
  // The live failure: EROFS on the counter write took the whole CI-fix lane
  // down with it. The count must still come back so the caller proceeds.
  const root = await Deno.makeTempDir();
  const stateDir = `${root}/state`;
  try {
    await Deno.mkdir(stateDir);
    await Deno.chmod(stateDir, 0o500);
    const count = await recordCiCheckRetry(stateDir, "org/repo", "12345");
    assertEquals(count, 1);
  } finally {
    await Deno.chmod(stateDir, 0o700);
    await Deno.remove(root, { recursive: true });
  }
});
