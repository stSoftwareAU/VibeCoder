/**
 * Tests for pr_spelling_processor.ts — spelling fix processing.
 *
 * Issue #967: Part of the Deno worker orchestration migration (#918).
 * Issue #1230: Added tests for the 'process' command operation.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  type CheckAnnotation,
  decodeAnnotations,
  formatAnnotations,
  processSpellingFailure,
  type SpellingFixInput,
  type SpellingProcessorDeps,
} from "../lib/pr_spelling_processor.ts";
import { prSpellingProcessorCommand } from "../commands/pr_spelling_processor.ts";
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

function makeInput(overrides?: Partial<SpellingFixInput>): SpellingFixInput {
  const annotations: CheckAnnotation[] = [
    { path: "src/main.ts", start_line: 10, message: "Unknown word: colour" },
    { path: "src/utils.ts", start_line: 5, message: "Unknown word: behaviour" },
  ];
  const encoded = btoa(JSON.stringify(annotations));

  return {
    repo: "org/repo",
    prNumber: 42,
    branchName: "issue-42-fix-bug",
    checkRunId: "12345",
    checkName: "cspell",
    encodedAnnotations: encoded,
    ...overrides,
  };
}

// ============================================================================
// decodeAnnotations
// ============================================================================

Deno.test("decodeAnnotations - decodes valid base64 JSON", () => {
  const annotations: CheckAnnotation[] = [
    { path: "file.ts", start_line: 1, message: "Typo" },
  ];
  const encoded = btoa(JSON.stringify(annotations));
  const result = decodeAnnotations(encoded);
  assertEquals(result.length, 1);
  assertEquals(result[0]!.path, "file.ts");
  assertEquals(result[0]!.message, "Typo");
});

Deno.test("decodeAnnotations - returns empty array for empty string", () => {
  assertEquals(decodeAnnotations("").length, 0);
});

Deno.test("decodeAnnotations - returns empty array for invalid base64", () => {
  assertEquals(decodeAnnotations("not-valid!!!").length, 0);
});

Deno.test("decodeAnnotations - returns empty array for non-array JSON", () => {
  const encoded = btoa('{"not": "an array"}');
  assertEquals(decodeAnnotations(encoded).length, 0);
});

Deno.test("decodeAnnotations - handles multiple annotations", () => {
  const annotations: CheckAnnotation[] = [
    { path: "a.ts", start_line: 1, message: "msg1" },
    { path: "b.ts", start_line: 2, message: "msg2" },
    { path: "c.ts", start_line: 3, message: "msg3" },
  ];
  const encoded = btoa(JSON.stringify(annotations));
  const result = decodeAnnotations(encoded);
  assertEquals(result.length, 3);
  assertEquals(result[2]!.path, "c.ts");
});

// ============================================================================
// formatAnnotations
// ============================================================================

Deno.test("formatAnnotations - formats annotations as markdown", () => {
  const annotations: CheckAnnotation[] = [
    { path: "src/main.ts", start_line: 10, message: "Unknown word: colour" },
  ];
  const result = formatAnnotations(annotations);
  assertEquals(result.includes("**src/main.ts:10**"), true);
  assertEquals(result.includes("Unknown word: colour"), true);
  assertEquals(result.includes("spelling issues were detected"), true);
});

Deno.test("formatAnnotations - handles empty annotations", () => {
  const result = formatAnnotations([]);
  assertEquals(result.includes("No specific annotations"), true);
  assertEquals(result.includes("run the spelling check locally"), true);
});

Deno.test("formatAnnotations - formats multiple annotations", () => {
  const annotations: CheckAnnotation[] = [
    { path: "a.ts", start_line: 1, message: "word1" },
    { path: "b.ts", start_line: 2, message: "word2" },
  ];
  const result = formatAnnotations(annotations);
  assertEquals(result.includes("**a.ts:1**"), true);
  assertEquals(result.includes("**b.ts:2**"), true);
});

// ============================================================================
// processSpellingFailure — integration with mock deps
// ============================================================================

Deno.test("processSpellingFailure - succeeds with mock Claude output", async () => {
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Fixed spelling", exitCode: 0, timedOut: false },
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

  const processorDeps: SpellingProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test",
  };

  const result = await processSpellingFailure(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.processed, true);
    assertEquals(result.value.changesPushed, true);
    assertEquals(result.value.annotationCount, 2);
  }
});

Deno.test("processSpellingFailure - handles Claude timeout", async () => {
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "", exitCode: 124, timedOut: true },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: () => Promise.resolve(""),
  };
  const deps = createMockDeps({ claude: mockClaude, github: mockGithub });

  const processorDeps: SpellingProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
  };

  const result = await processSpellingFailure(makeInput(), processorDeps);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("timed out"), true);
  }
});

// ============================================================================
// Heartbeat lifecycle — startHeartbeat/stopHeartbeat (Issue #1204)
// ============================================================================

Deno.test("processSpellingFailure - starts and stops heartbeat during processing", async () => {
  let heartbeatRecordCount = 0;
  let heartbeatCleared = false;

  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Fixed spelling", exitCode: 0, timedOut: false },
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

  const processorDeps: SpellingProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test",
  };

  const result = await processSpellingFailure(makeInput(), processorDeps);
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

Deno.test("processSpellingFailure - stops heartbeat even when Claude fails", async () => {
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

  const processorDeps: SpellingProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test",
  };

  const result = await processSpellingFailure(makeInput(), processorDeps);
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

Deno.test("processSpellingFailure - reports no changes for empty output", async () => {
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

  const processorDeps: SpellingProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
  };

  const result = await processSpellingFailure(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.changesPushed, false);
    assertEquals(result.value.summary.includes("no changes needed"), true);
  }
});

// ============================================================================
// prSpellingProcessorCommand — command-level tests (Issue #1230)
// ============================================================================

Deno.test("prSpellingProcessorCommand - decode-annotations operation works", async () => {
  const annotations: CheckAnnotation[] = [
    { path: "file.ts", start_line: 1, message: "Typo" },
  ];
  const encoded = btoa(JSON.stringify(annotations));
  const config = buildDefaultWorkerConfig();
  const result = await prSpellingProcessorCommand.execute(
    { operation: "decode-annotations", encoded },
    config,
  );
  assertEquals(result.success, true);
  assertEquals(result.message.includes("1 annotation"), true);
});

Deno.test("prSpellingProcessorCommand - format-annotations operation works", async () => {
  const annotations: CheckAnnotation[] = [
    { path: "src/main.ts", start_line: 10, message: "Unknown word: colour" },
  ];
  const encoded = btoa(JSON.stringify(annotations));
  const config = buildDefaultWorkerConfig();
  const result = await prSpellingProcessorCommand.execute(
    { operation: "format-annotations", encoded },
    config,
  );
  assertEquals(result.success, true);
  assertEquals(result.message.includes("src/main.ts:10"), true);
  assertEquals(result.message.includes("colour"), true);
});

Deno.test("prSpellingProcessorCommand - process rejects missing arguments", async () => {
  const config = buildDefaultWorkerConfig();
  const result = await prSpellingProcessorCommand.execute(
    { operation: "process", repo: "", "pr-number": 0 },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Missing required arguments"), true);
});

Deno.test("prSpellingProcessorCommand - unknown operation returns error", async () => {
  const config = buildDefaultWorkerConfig();
  const result = await prSpellingProcessorCommand.execute(
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

Deno.test("processSpellingFailure - pushes commits after Claude makes changes (Issue #1412)", async () => {
  let pushCalled = false;
  let pushBranch = "";

  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Fixed spelling", exitCode: 0, timedOut: false },
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

  const processorDeps: SpellingProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-repo",
  };

  const input = makeInput();
  const result = await processSpellingFailure(input, processorDeps);

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

Deno.test("processSpellingFailure - reports no changes when Claude does nothing (Issue #1412, updated #1643)", async () => {
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

  const processorDeps: SpellingProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
  };

  const result = await processSpellingFailure(makeInput(), processorDeps);

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

Deno.test("processSpellingFailure - reports push failure accurately (Issue #1412)", async () => {
  let commentBody = "";

  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Fixed spelling", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: (args: string[]) => {
      // Capture the comment body from the pr comment call
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

  const processorDeps: SpellingProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-repo",
  };

  const result = await processSpellingFailure(makeInput(), processorDeps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.value.changesPushed,
      false,
      "changesPushed should be false when push fails",
    );
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

Deno.test("processSpellingFailure - retries push after recovery from rejection (Issue #1412)", async () => {
  let pushCallCount = 0;
  let recoveryCalled = false;

  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Fixed spelling", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: () => Promise.resolve(""),
  };

  const deps = createMockDeps({
    claude: mockClaude,
    github: mockGithub,
    git: {
      // Issue #1643: first call commits but leaves commits unpushed;
      // recovery succeeds; retry call returns clean state.
      commitAndPushPending: (() => {
        pushCallCount++;
        if (pushCallCount === 1) {
          return Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: true,
              commitsPushed: 0,
              finalUnpushedCount: 1,
            },
          });
        }
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

  const processorDeps: SpellingProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-repo",
  };

  const result = await processSpellingFailure(makeInput(), processorDeps);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.value.changesPushed,
      true,
      "should succeed after recovery",
    );
  }
  assertEquals(
    recoveryCalled,
    true,
    "recoverFromPushRejection should be called on first push failure",
  );
  assertEquals(
    pushCallCount,
    2,
    "commitAndPushPending should be retried after recovery (Issue #1643)",
  );
});

// ============================================================================
// Issue #1863: HEAD-SHA change detection for Claude self-pushed commits
// ============================================================================

Deno.test("processSpellingFailure - Claude self-pushed: HEAD moved triggers success reply (Issue #1863)", async () => {
  let commentBody = "";

  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Pushed fix", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: (args: string[]) => {
      const idx = args.indexOf("--body");
      if (idx >= 0 && args[idx + 1] !== undefined) {
        commentBody = args[idx + 1] as string;
      }
      return Promise.resolve("");
    },
  };

  const deps = createMockDeps({
    claude: mockClaude,
    github: mockGithub,
    git: {
      // Claude self-pushed: final-mile commit-and-push finds nothing to do.
      commitAndPushPending: (() =>
        Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: false,
            commitsPushed: 0,
            finalUnpushedCount: 0,
          },
        })) as unknown as GitDeps["commitAndPushPending"],
      captureBranchHead: (() =>
        Promise.resolve({
          ok: true,
          value: "sha-before",
        })) as unknown as GitDeps["captureBranchHead"],
      // HEAD moved during Claude run — work landed via self-push.
      branchHeadChanged: (() =>
        Promise.resolve({ ok: true, value: true })) as unknown as GitDeps[
          "branchHeadChanged"
        ],
    },
  });

  const processorDeps: SpellingProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-repo",
  };

  const result = await processSpellingFailure(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.value.changesPushed,
      true,
      "changesPushed must be true when HEAD moved during the Claude run",
    );
  }
  assertEquals(
    commentBody.includes("pushed fixes"),
    true,
    "success reply must be posted when Claude self-pushed",
  );
  assertEquals(
    commentBody.includes("no changes were needed"),
    false,
    "must not post the dismissive no-changes reply",
  );
});

Deno.test("processSpellingFailure - genuine no-changes when HEAD unchanged still posts no-changes reply (Issue #1863)", async () => {
  let commentBody = "";

  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: (args: string[]) => {
      const idx = args.indexOf("--body");
      if (idx >= 0 && args[idx + 1] !== undefined) {
        commentBody = args[idx + 1] as string;
      }
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
            committedNewChanges: false,
            commitsPushed: 0,
            finalUnpushedCount: 0,
          },
        })) as unknown as GitDeps["commitAndPushPending"],
      captureBranchHead: (() =>
        Promise.resolve({
          ok: true,
          value: "sha-before",
        })) as unknown as GitDeps["captureBranchHead"],
      // HEAD did not move — genuine no-op.
      branchHeadChanged: (() =>
        Promise.resolve({ ok: true, value: false })) as unknown as GitDeps[
          "branchHeadChanged"
        ],
    },
  });

  const processorDeps: SpellingProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-repo",
  };

  const result = await processSpellingFailure(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.changesPushed, false);
  }
  assertEquals(
    commentBody.includes("no changes were needed"),
    true,
    "no-changes reply must still be posted when HEAD did not move",
  );
});

// ============================================================================
// Issue #1458: Branch checkout for spelling processor
// ============================================================================

Deno.test("processSpellingFailure - checks out PR branch before running Claude (Issue #1458)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const gitCalls: string[][] = [];
    let claudeCalledAt = -1;

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() => {
        claudeCalledAt = gitCalls.length;
        return Promise.resolve({
          ok: true,
          value: { output: "Fixed spelling", exitCode: 0, timedOut: false },
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

    const processorDeps: SpellingProcessorDeps = {
      logger: makeSilentLogger(),
      deps,
      workDir: tmpDir,
    };

    const input = makeInput();
    const result = await processSpellingFailure(input, processorDeps);
    assertEquals(result.ok, true);

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
