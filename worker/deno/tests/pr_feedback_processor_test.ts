/**
 * Tests for pr_feedback_processor.ts — PR feedback processing.
 *
 * Issue #967: Part of the Deno worker orchestration migration (#918).
 * Issue #1230: Added tests for the 'process' command operation.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildFeedbackCommitMessage,
  decodeCommentBody,
  type PrFeedbackInput,
  type PrFeedbackProcessorDeps,
  processPrFeedback,
  summariseLargeComment,
} from "../lib/pr_feedback_processor.ts";
import { prFeedbackProcessorCommand } from "../commands/pr_feedback_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { Logger } from "../types.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import { pinPromptsToThisCheckout } from "./support/repo_prompts.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
pinPromptsToThisCheckout();

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

function makeInput(overrides?: Partial<PrFeedbackInput>): PrFeedbackInput {
  return {
    repo: "org/repo",
    prNumber: 42,
    branchName: "issue-42-fix-bug",
    commentType: "review",
    commentId: "123",
    commentBody: "Please fix the typo on line 10",
    ...overrides,
  };
}

// ============================================================================
// decodeCommentBody
// ============================================================================

/**
 * Issue #579: a claim that the push landed is now made against the REMOTE,
 * not against local state. Tests that assert a successful push therefore say
 * so explicitly — the whole point is that clean local state is no longer
 * sufficient evidence.
 */
const REMOTE_CONFIRMS_PUSH = () =>
  Promise.resolve({
    landed: true,
    localSha: "f".repeat(40),
    remoteSha: "f".repeat(40),
    reason: "verified in test",
  });

Deno.test("decodeCommentBody - decodes valid base64", () => {
  const encoded = btoa("Hello World");
  assertEquals(decodeCommentBody(encoded), "Hello World");
});

Deno.test("decodeCommentBody - returns original on invalid base64", () => {
  assertEquals(decodeCommentBody("not-valid-base64!!!"), "not-valid-base64!!!");
});

Deno.test("decodeCommentBody - handles empty string", () => {
  assertEquals(decodeCommentBody(""), "");
});

// ============================================================================
// summariseLargeComment
// ============================================================================

Deno.test("summariseLargeComment - returns body when under token limit", () => {
  const body = "Short comment";
  assertEquals(summariseLargeComment(body, 50000), body);
});

Deno.test("summariseLargeComment - truncates when over token limit", () => {
  const body = "word ".repeat(60000);
  const result = summariseLargeComment(body, 100);
  assertEquals(result.includes("[Comment truncated"), true);
  assertEquals(result.length < body.length, true);
});

// ============================================================================
// buildFeedbackCommitMessage
// ============================================================================

Deno.test("buildFeedbackCommitMessage - includes PR number", () => {
  const msg = buildFeedbackCommitMessage(42, "Fix the alignment issue");
  assertEquals(msg.includes("PR #42"), true);
  assertEquals(msg.includes("Automated fix"), true);
});

Deno.test("buildFeedbackCommitMessage - truncates long comment", () => {
  const longComment = "a".repeat(100);
  const msg = buildFeedbackCommitMessage(42, longComment);
  assertEquals(msg.includes("a".repeat(50)), true);
  assertEquals(msg.includes("a".repeat(100)), false);
});

// ============================================================================
// processPrFeedback — integration with mock deps
// ============================================================================

Deno.test("processPrFeedback - succeeds with mock Claude output", async () => {
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Fixed the issue", exitCode: 0, timedOut: false },
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
  });

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test",
    verifyPushFn: REMOTE_CONFIRMS_PUSH,
    qualityInstructions: "",
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.processed, true);
    assertEquals(result.value.changesPushed, true);
  }
});

Deno.test("processPrFeedback - handles Claude timeout", async () => {
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "", exitCode: 124, timedOut: true },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const deps = createMockDeps({ claude: mockClaude });

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test",
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("timed out"), true);
  }
});

Deno.test("processPrFeedback - handles Claude failure", async () => {
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: false,
        error: new Error("Rate limit exceeded"),
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const deps = createMockDeps({ claude: mockClaude });

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test",
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("execution failed"), true);
  }
});

// ============================================================================
// processPrFeedback — PR comment claim integration (Issue #1072)
// ============================================================================

Deno.test("processPrFeedback - skips processing when claim lost to another worker", async () => {
  // Mock gh that simulates another worker's earlier claim
  const contestedClaims = JSON.stringify([
    {
      id: 100,
      body: "<!-- PR_COMMENT_CLAIM:other-worker:123 -->",
      created_at: "2026-04-01T00:00:01Z",
    },
    {
      id: 101,
      body: "<!-- PR_COMMENT_CLAIM:my-worker:123 -->",
      created_at: "2026-04-01T00:00:02Z",
    },
  ]);

  let apiCallCount = 0;
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: (args: string[]) => {
      if (args[0] === "api" && !args.includes("-X")) {
        const endpoint = String(args[1]);
        if (endpoint.includes("/comments")) {
          apiCallCount++;
          if (apiCallCount === 1) return Promise.resolve("[]"); // cleanup
          return Promise.resolve(contestedClaims); // verification
        }
      }
      return Promise.resolve("");
    },
  };
  const deps = createMockDeps({ github: mockGithub });

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test",
    workerId: "my-worker",
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.processed, false);
    assertEquals(result.value.changesPushed, false);
    assertEquals(result.value.summary.includes("already claimed"), true);
  }
});

Deno.test("processPrFeedback - proceeds when claim won", async () => {
  const singleClaim = JSON.stringify([
    {
      id: 100,
      body: "<!-- PR_COMMENT_CLAIM:my-worker:123 -->",
      created_at: "2026-04-01T00:00:00Z",
    },
  ]);

  let apiCallCount = 0;
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Fixed the issue", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: (args: string[]) => {
      if (args[0] === "api" && !args.includes("-X")) {
        const endpoint = String(args[1]);
        if (endpoint.includes("/comments")) {
          apiCallCount++;
          if (apiCallCount === 1) return Promise.resolve("[]");
          return Promise.resolve(singleClaim);
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

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test",
    verifyPushFn: REMOTE_CONFIRMS_PUSH,
    workerId: "my-worker",
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.processed, true);
    assertEquals(result.value.changesPushed, true);
  }
});

Deno.test("processPrFeedback - works without workerId (backward compatible)", async () => {
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

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test",
    // No workerId — claim step should be skipped
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.processed, true);
  }
});

// ============================================================================
// Heartbeat lifecycle — startHeartbeat/stopHeartbeat (Issue #1204)
// ============================================================================

Deno.test("processPrFeedback - starts and stops heartbeat during processing", async () => {
  let heartbeatRecordCount = 0;
  let heartbeatCleared = false;

  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Fixed the typo.", exitCode: 0, timedOut: false },
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
  });

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test",
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
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
});

Deno.test("processPrFeedback - stops heartbeat even when Claude fails", async () => {
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
    pr: {
      handlePrCommentFailure: () => Promise.resolve(),
    },
  });

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test",
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
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
});

Deno.test("processPrFeedback - reports no changes when Claude output empty", async () => {
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
  const deps = createMockDeps({ claude: mockClaude, github: mockGithub });

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test",
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.changesPushed, false);
    assertEquals(result.value.summary.includes("no changes needed"), true);
  }
});

// ============================================================================
// processPrFeedback — cwd passed to Claude (Issue #1297)
// ============================================================================

Deno.test("processPrFeedback - passes workDir as cwd to Claude invocation", async () => {
  let capturedCwd: string | undefined;

  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: ((options: Record<string, unknown>) => {
      capturedCwd = options.cwd as string | undefined;
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

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-repo/MyRepo",
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  assertEquals(
    capturedCwd,
    "/tmp/test-repo/MyRepo",
    "workDir should be passed as cwd to Claude so it runs in the target repo",
  );
});

// ============================================================================
// prFeedbackProcessorCommand — command-level tests (Issue #1230)
// ============================================================================

Deno.test("prFeedbackProcessorCommand - decode-comment operation works", async () => {
  const config = buildDefaultWorkerConfig();
  const result = await prFeedbackProcessorCommand.execute(
    { operation: "decode-comment", encoded: btoa("Hello World") },
    config,
  );
  assertEquals(result.success, true);
  assertEquals(result.message, "Hello World");
});

Deno.test("prFeedbackProcessorCommand - build-commit-message operation works", async () => {
  const config = buildDefaultWorkerConfig();
  const result = await prFeedbackProcessorCommand.execute(
    {
      operation: "build-commit-message",
      "pr-number": 42,
      "comment-body": "Fix the alignment",
    },
    config,
  );
  assertEquals(result.success, true);
  assertEquals(result.message.includes("PR #42"), true);
});

Deno.test("prFeedbackProcessorCommand - process rejects missing arguments", async () => {
  const config = buildDefaultWorkerConfig();
  const result = await prFeedbackProcessorCommand.execute(
    { operation: "process", repo: "", "pr-number": 0 },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Missing required arguments"), true);
});

Deno.test("prFeedbackProcessorCommand - unknown operation returns error", async () => {
  const config = buildDefaultWorkerConfig();
  const result = await prFeedbackProcessorCommand.execute(
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

Deno.test("processPrFeedback - pushes commits after Claude makes changes (Issue #1412)", async () => {
  let pushCalled = false;
  let pushBranch = "";

  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Fixed the issue", exitCode: 0, timedOut: false },
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

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test",
    verifyPushFn: REMOTE_CONFIRMS_PUSH,
  };

  const input = makeInput();
  const result = await processPrFeedback(input, processorDeps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.changesPushed, true);
  }
  assertEquals(
    pushCalled,
    true,
    "commitAndPushPending should be called after Claude makes changes (Issue #1643)",
  );
  assertEquals(
    pushBranch,
    input.branchName,
    "push should target the PR branch",
  );
});

// ============================================================================
// Issue #1458: Branch checkout + .pr_response_message for feedback processor
// ============================================================================

Deno.test("processPrFeedback - checks out PR branch before running Claude (Issue #1458)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const gitCalls: string[][] = [];
    let claudeCalledAt = -1;

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() => {
        claudeCalledAt = gitCalls.length;
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

    const processorDeps: PrFeedbackProcessorDeps = {
      logger: makeSilentLogger(),
      deps,
      workDir: tmpDir,
    };

    const input = makeInput();
    const result = await processPrFeedback(input, processorDeps);
    assertEquals(result.ok, true);

    // Claude should have been called after git fetch+checkout
    assertEquals(
      claudeCalledAt >= 2,
      true,
      `Claude should run after fetch and checkout; git calls before Claude = ${claudeCalledAt}`,
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

Deno.test("processPrFeedback - uses .pr_response_message as comment body when present (Issue #1458)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const customMessage =
      "I rewrote the validator to guard against empty input.";
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

    const processorDeps: PrFeedbackProcessorDeps = {
      logger: makeSilentLogger(),
      deps,
      workDir: tmpDir,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const result = await processPrFeedback(makeInput(), processorDeps);
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

Deno.test("processPrFeedback - falls back to default message when .pr_response_message absent (Issue #1458)", async () => {
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

    const processorDeps: PrFeedbackProcessorDeps = {
      logger: makeSilentLogger(),
      deps,
      workDir: tmpDir,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const result = await processPrFeedback(makeInput(), processorDeps);
    assertEquals(result.ok, true);

    const usedDefault = commentBodies.some((body) =>
      body.includes("I've pushed a fix for this feedback")
    );
    assertEquals(
      usedDefault,
      true,
      `Expected default fix-pushed message; got: ${commentBodies.join(" | ")}`,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processPrFeedback - reports push failure accurately (Issue #1458)", async () => {
  let commentBody = "";

  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Fixed", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: (args: string[]) => {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx >= 0 && args[bodyIdx + 1]) {
        commentBody = args[bodyIdx + 1]!;
      }
      return Promise.resolve("");
    },
  };

  const deps = createMockDeps({
    claude: mockClaude,
    github: mockGithub,
    git: {
      // Issue #1643: commit succeeded but push failed; recovery also fails.
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

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-repo",
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.changesPushed, false);
    assertEquals(
      result.value.summary.includes("failed to push"),
      true,
      "summary should indicate push failure",
    );
  }
  assertEquals(
    commentBody.includes("failed to push"),
    true,
    "PR comment should inform about push failure instead of claiming success",
  );
});

Deno.test("processPrFeedback - reports no changes when Claude does nothing (Issue #1412, updated #1643)", async () => {
  // Issue #1643: commitAndPushPending is always called as the final-mile
  // guard. When there is genuinely nothing to commit or push it is a
  // no-op — the processor must report changesPushed=false.
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

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test",
  };

  const result = await processPrFeedback(makeInput(), processorDeps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.changesPushed, false);
  }
  assertEquals(
    pushCalled,
    true,
    "commitAndPushPending is always invoked as the final-mile guard (Issue #1643)",
  );
});

// ===========================================================================
// Issue #579 — a completion claim must be verified against the remote
//
// PR #549: the agent posted "Unblocked — both things holding this PR are
// fixed and pushed" at 00:40:26Z. The branch's last commit was 21:23:04Z and
// nothing had been pushed; git auth had failed silently. A run that fails
// loudly gets retried. A run that reports success is finished — the claim
// goes on the PR, the budget is spent, and the lane moves on.
// ===========================================================================

Deno.test("processPrFeedback - a local commit with a failed push never claims success (Issue #579)", async () => {
  let commentBody = "";
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Fixed", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: (args: string[]) => {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx >= 0 && args[bodyIdx + 1]) commentBody = args[bodyIdx + 1]!;
      return Promise.resolve("");
    },
  };

  const deps = createMockDeps({
    claude: mockClaude,
    github: mockGithub,
    git: {
      // The exact incident shape: the push helper fails outright, so no
      // unpushed count is ever measured...
      commitAndPushPending: (() =>
        Promise.resolve({
          ok: false,
          error: new Error("could not read Username for 'https://github.com'"),
        })) as unknown as GitDeps["commitAndPushPending"],
      // ...while Claude's own local commit moves HEAD. Before this fix, the
      // unmeasured count defaulted to 0, `0 === 0 && hasChanges` was true,
      // and the processor claimed the push had landed.
      branchHeadChanged: (() =>
        Promise.resolve({ ok: true, value: true })) as unknown as GitDeps[
          "branchHeadChanged"
        ],
    },
  });

  const result = await processPrFeedback(makeInput(), {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-repo",
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.changesPushed, false);
  }
  // The claim the incident produced must not appear.
  assertEquals(
    commentBody.includes("I've pushed"),
    false,
    `must not claim a push landed; got: ${commentBody}`,
  );
  assertStringIncludes(commentBody, "failed to push");
  assertStringIncludes(commentBody, "NOT on the remote");
});

Deno.test("processPrFeedback - a push the remote does not confirm is reported, not claimed (Issue #579)", async () => {
  let commentBody = "";
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Fixed", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: (args: string[]) => {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx >= 0 && args[bodyIdx + 1]) commentBody = args[bodyIdx + 1]!;
      return Promise.resolve("");
    },
  };

  const deps = createMockDeps({
    claude: mockClaude,
    github: mockGithub,
    git: {
      // Local state says the push was clean...
      commitAndPushPending: (() =>
        Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: true,
            commitsPushed: 1,
            finalUnpushedCount: 0,
          },
        })) as unknown as GitDeps["commitAndPushPending"],
    },
  });

  const result = await processPrFeedback(makeInput(), {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-repo",
    // ...and the remote disagrees. Local signals cannot see this, which is
    // why the claim is made against the remote.
    verifyPushFn: () =>
      Promise.resolve({
        landed: false,
        reason: "'fix/x' on the remote is at deadbeef, local is at cafebabe",
      }),
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.changesPushed, false);
  assertEquals(commentBody.includes("I've pushed"), false);
  // The reason reaches the reader — Issue #211's lesson applied here.
  assertStringIncludes(commentBody, "on the remote is at deadbeef");
});

Deno.test("processPrFeedback - a verified push claims success and names the SHA (Issue #579)", async () => {
  let commentBody = "";
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Fixed", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: (args: string[]) => {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx >= 0 && args[bodyIdx + 1]) commentBody = args[bodyIdx + 1]!;
      return Promise.resolve("");
    },
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
            commitsPushed: 1,
            finalUnpushedCount: 0,
          },
        })) as unknown as GitDeps["commitAndPushPending"],
    },
  });

  const result = await processPrFeedback(makeInput(), {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-repo",
    verifyPushFn: () =>
      Promise.resolve({
        landed: true,
        localSha: "abc12345".padEnd(40, "0"),
        remoteSha: "abc12345".padEnd(40, "0"),
        reason: "verified",
      }),
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.changesPushed, true);
  // The SHA makes a stale claim falsifiable at a glance.
  assertStringIncludes(commentBody, "abc12345");
  assertStringIncludes(commentBody, "Verified on the remote");
});
