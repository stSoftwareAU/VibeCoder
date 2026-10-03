/**
 * Tests for pr_ci_processor.ts — CI fix processing.
 *
 * Issue #967: Part of the Deno worker orchestration migration (#918).
 * Issue #1230: Added tests for the 'process' command operation.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  formatCiAnnotations,
  processCiFailure,
  resolveCiCheckStateDir,
} from "../lib/pr_ci_processor.ts";
import {
  getCiCheckRetryCount,
  recordCiCheckRetry,
} from "../lib/pr_ci_checks.ts";
import { prCiProcessorCommand } from "../commands/pr_ci_processor.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import { milestoneFixBranchFor } from "../lib/milestone_fix_pr.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { Logger } from "../types.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
  PrDeps,
} from "../lib/issue_worker_wiring.ts";
import {
  heartbeatFilePath,
  markerStateFilePath,
} from "../lib/heartbeat_storage.ts";
import {
  heartbeatStrays,
  trackHeartbeatDirs,
} from "./support/heartbeat_placement.ts";
import {
  isPrLiveStateRead,
  openPrGh,
  prWriteCalls,
  recordingStateGh,
} from "./support/pr_live_state_stub.ts";

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
      runGhCommand: openPrGh(),
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
      workRoot: tmpDir,
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

Deno.test("processCiFailure - the heartbeat and milestone state land in the work root, not the clone (Issue #1662)", async () => {
  const workRoot = await Deno.makeTempDir({ prefix: "vibe-work-root-" });
  const workDir = await Deno.makeTempDir({ prefix: "vibe-ci-fix-clone-" });
  try {
    const dirs = { record: [] as string[], clear: [] as string[] };
    const milestoneDirs: string[] = [];

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "Fixed CI", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: { runGhCommand: openPrGh() },
      git: {
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
        ...trackHeartbeatDirs(dirs),
        recordMilestone: (dir: string) => {
          milestoneDirs.push(dir);
          return Promise.resolve({ ok: true, value: undefined });
        },
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${workRoot}/.ci_check_state`,
      workDir,
      workRoot,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    assertEquals(dirs.record, [workRoot]);
    assertEquals(dirs.clear, [workRoot]);
    // Every milestone follows the heartbeat it annotates.
    assertEquals(milestoneDirs.length >= 1, true);
    assertEquals(
      milestoneDirs.every((dir) => dir === workRoot),
      true,
      `milestones should be recorded in the work root, got ${milestoneDirs}`,
    );

    // The state files land under the work root ...
    assertEquals(
      (await Deno.stat(heartbeatFilePath(workRoot, "org/repo", 42))).isFile,
      true,
    );
    assertEquals(
      (await Deno.stat(markerStateFilePath(workRoot, "org/repo", 42)))
        .isFile,
      true,
    );

    // ... and the clone's top level gains neither.
    assertEquals(await heartbeatStrays(workDir), []);
  } finally {
    await Deno.remove(workRoot, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
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
        if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
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
      workRoot: tmpDir,
      maxCiRetries: 3,
      ghCommandFn: (args: string[]) => {
        if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
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
      runGhCommand: openPrGh(),
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
      workRoot: tmpDir,
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

Deno.test("processCiFailure - a PR branch another worktree holds spends no retry and is skipped as branch_held (Issue #1677)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const stateDir = `${tmpDir}/.ci_check_state`;
    let claudeRuns = 0;
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() => {
        claudeRuns++;
        return Promise.resolve({
          ok: true,
          value: { output: "Fixed", exitCode: 0, timedOut: false },
        });
      }) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: { runGhCommand: openPrGh() },
      git: {
        // The holder is not one of this host's lane worktrees, so nothing
        // is detached and the branch stays held for this cycle.
        runGitCommand: ((args: string[]) => {
          if (args[0] === "checkout") {
            return Promise.resolve({
              ok: true,
              value: {
                code: 128,
                stdout: "",
                stderr:
                  "fatal: 'issue-42-fix-bug' is already used by worktree at '/home/dev/other'",
              },
            });
          }
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          });
        }) as unknown as GitDeps["runGitCommand"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir,
      workDir: tmpDir,
      // Required since this branch made `workRoot` part of CiProcessorDeps:
      // the lane worktree's parent, which for this fixture is the temp root.
      // Matches the other call site in this file (`workRoot: tmpDir`).
      workRoot: tmpDir,
      maxCiRetries: 3,
    };

    // Three cycles of a held branch …
    for (let cycle = 0; cycle < 3; cycle++) {
      const result = await processCiFailure(makeInput(), processorDeps);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.value.processed, false);
        assertEquals(result.value.retryCount, 0);
        assertEquals(
          result.value.summary.includes("branch_held"),
          true,
          result.value.summary,
        );
      }
    }
    assertEquals(claudeRuns, 0, "the agent never ran on the wrong branch");
    // … and the retry budget is untouched: no counter was ever written.
    let counter: string | undefined;
    try {
      counter = await Deno.readTextFile(`${stateDir}/org_repo_67890.retries`);
    } catch {
      counter = undefined;
    }
    assertEquals(counter, undefined, "a refused checkout is not an attempt");
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
      runGhCommand: openPrGh(),
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
      workRoot: tmpDir,
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
      runGhCommand: openPrGh(),
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
      workRoot: tmpDir,
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
      runGhCommand: openPrGh(),
    };
    const deps = createMockDeps({ claude: mockClaude, github: mockGithub });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workRoot: tmpDir,
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
      runGhCommand: openPrGh(),
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
      workRoot: tmpDir,
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
      runGhCommand: openPrGh(),
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
      workRoot: tmpDir,
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
      runGhCommand: openPrGh(),
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
      workRoot: tmpDir,
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
      runGhCommand: openPrGh(),
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
      workRoot: tmpDir,
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
        if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
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
      workRoot: tmpDir,
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
        if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
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
      workRoot: tmpDir,
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
      runGhCommand: openPrGh(),
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
      workRoot: tmpDir,
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
        if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
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
      workRoot: tmpDir,
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
      runGhCommand: openPrGh(),
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
      workRoot: tmpDir,
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
      runGhCommand: openPrGh(),
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
      workRoot: tmpDir,
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
      runGhCommand: openPrGh(),
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
      workRoot: tmpDir,
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
      runGhCommand: openPrGh(),
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
      workRoot: tmpDir,
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
      workRoot: tmpDir,
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

// ============================================================================
// Issue #1673: repo context comes from the clone, not <clone>/<repo>
// ============================================================================

Deno.test("processCiFailure - injects the clone's CLAUDE.md into the prompt (Issue #1673)", async () => {
  const workRoot = await Deno.makeTempDir({ prefix: "vibe-work-root-" });
  const workDir = await Deno.makeTempDir({ prefix: "vibe-ci-fix-clone-" });
  try {
    await Deno.writeTextFile(
      `${workDir}/CLAUDE.md`,
      "# Repo guidance\n\nSENTINEL-1673-CI: prefer Australian English.\n",
    );

    const prompts: string[] = [];
    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: ((options: { prompt?: string }) => {
          prompts.push(options?.prompt ?? "");
          return Promise.resolve({
            ok: true,
            value: { output: "Fixed CI", exitCode: 0, timedOut: false },
          });
        }) as unknown as ClaudeDeps["runClaudeWithRetry"],
      },
      github: { runGhCommand: openPrGh() },
      git: {
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
      stateDir: `${workRoot}/.ci_check_state`,
      workDir,
      workRoot,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    assertEquals(prompts.length, 1);
    assertStringIncludes(prompts[0]!, "SENTINEL-1673-CI");
  } finally {
    await Deno.remove(workRoot, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("processCiFailure - warns when the checkout directory is missing (Issue #1673)", async () => {
  const workRoot = await Deno.makeTempDir({ prefix: "vibe-work-root-" });
  try {
    const warnings: string[] = [];
    const logger = makeSilentLogger();
    logger.warn = (message: string) => {
      warnings.push(message);
    };

    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (() =>
          Promise.resolve({
            ok: true,
            value: { output: "Fixed CI", exitCode: 0, timedOut: false },
          })) as unknown as ClaudeDeps["runClaudeWithRetry"],
      },
      github: { runGhCommand: openPrGh() },
      git: {
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
      logger,
      deps,
      stateDir: `${workRoot}/.ci_check_state`,
      workDir: "/nonexistent/vibe-1673-clone",
      workRoot,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    assertEquals(
      warnings.some((w) => w.includes("Repo context directory does not exist")),
      true,
      `expected a missing-directory warning, got: ${warnings.join(" | ")}`,
    );
  } finally {
    await Deno.remove(workRoot, { recursive: true });
  }
});

// ============================================================================
// Issue #1774 — the cached listing is not proof the PR is still open
// ============================================================================

Deno.test("processCiFailure - a PR closed since the cached listing gets no push, comment or label (Issue #1774)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "ci_fix_closed_" });
  try {
    const ghCalls: string[][] = [];
    let claudeRuns = 0;
    let pushes = 0;
    const deps = createMockDeps({
      github: { runGhCommand: recordingStateGh(ghCalls, "CLOSED") },
      claude: {
        runClaudeWithRetry: (() => {
          claudeRuns++;
          return Promise.resolve({
            ok: true,
            value: { output: "fixed", exitCode: 0, timedOut: false },
          });
        }) as unknown as ClaudeDeps["runClaudeWithRetry"],
      },
      git: {
        commitAndPushPending: (() => {
          pushes++;
          return Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: true,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          });
        }) as unknown as GitDeps["commitAndPushPending"],
      },
    });
    const stateDir = `${tmpDir}/.ci_check_state`;
    const messages: string[] = [];
    const logger = makeSilentLogger();
    logger.info = (message: string) => {
      messages.push(message);
    };

    const result = await processCiFailure(makeInput({ prNumber: 1732 }), {
      promptsDir: PROMPTS_DIR,
      logger,
      deps,
      stateDir,
      workDir: tmpDir,
      workRoot: tmpDir,
      workerId: "test-host-abcdef",
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.processed, false);
      assertEquals(result.value.changesPushed, false);
      assertStringIncludes(result.value.summary, "skipped: PR closed");
    }
    assertEquals(claudeRuns, 0, "no agent runs against a closed PR");
    assertEquals(pushes, 0, "no push lands on a closed PR");
    assertEquals(
      prWriteCalls(ghCalls),
      [],
      `a closed PR must receive no comment or label; got ${
        JSON.stringify(prWriteCalls(ghCalls))
      }`,
    );
    assertEquals(
      messages.some((m) => m.includes("skipped: PR closed")),
      true,
      `expected the skip line; got: ${messages.join(" | ")}`,
    );
    // The lock is taken after the check, so no lock comment was posted either.
    assertEquals(ghCalls.length, 1, "one live state read and nothing else");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - an unreadable PR state skips the cycle without spending a retry (Issue #1774)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "ci_fix_unknown_" });
  try {
    let claudeRuns = 0;
    const deps = createMockDeps({
      github: {
        runGhCommand: ((args: string[]) =>
          isPrLiveStateRead(args)
            ? Promise.reject(new Error("gh: connection reset"))
            : Promise.resolve("")) as GitHubDeps["runGhCommand"],
      },
      claude: {
        runClaudeWithRetry: (() => {
          claudeRuns++;
          return Promise.resolve({
            ok: true,
            value: { output: "fixed", exitCode: 0, timedOut: false },
          });
        }) as unknown as ClaudeDeps["runClaudeWithRetry"],
      },
    });
    const stateDir = `${tmpDir}/.ci_check_state`;

    const result = await processCiFailure(makeInput(), {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir,
      workDir: tmpDir,
      workRoot: tmpDir,
      workerId: "test-host-abcdef",
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.processed, false);
      assertStringIncludes(result.value.summary, "skipped: PR state unknown");
    }
    assertEquals(claudeRuns, 0, "unknown is never treated as open");
    // No retry was charged: the counter is untouched, so the next scan gets
    // the full budget rather than one attempt fewer.
    assertEquals(await getCiCheckRetryCount(stateDir, "org/repo", "67890"), 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - a refused milestone-fix branch checkout spends no retry (PR #2909 review)", async () => {
  // Regression test: the fix-branch `checkout -B` used to run *after*
  // `recordCiCheckRetry`, so a refused checkout (e.g. Issue #1677 lane
  // contention on the deterministic fix-branch name) burned a real retry
  // with the agent never running, while still reporting `newRetryCount - 1`
  // — a count that disagreed with the state file it had just written. The
  // checkout is now attempted before the retry is recorded, so a refusal
  // here costs nothing.
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-gated-ci-refused-" });
  try {
    const stateDir = `${tmpDir}/.ci_check_state`;
    const milestoneHead = "milestone/2909-checkout-refused";
    const prNumber = 777;
    let claudeRuns = 0;
    const ghCalls: string[][] = [];

    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (() => {
          claudeRuns++;
          return Promise.resolve({
            ok: true,
            value: { output: "Fixed", exitCode: 0, timedOut: false },
          });
        }) as unknown as ClaudeDeps["runClaudeWithRetry"],
      },
      github: {
        runGhCommand: makeGatedFixGh(ghCalls, {
          prCreate: () => {
            throw new Error("pr create must not be called");
          },
        }),
      },
      git: {
        // Not a recognised lane-worktree holder, so the detach repair does
        // not apply — the checkout stays refused for this cycle, same as
        // the "another worktree" case `preparePrBranch` handles.
        runGitCommand: ((args: string[]) => {
          if (args[0] === "checkout" && args[1] === "-B") {
            return Promise.resolve({
              ok: true,
              value: {
                code: 128,
                stdout: "",
                stderr:
                  "fatal: 'milestone-fix/2909-checkout-refused/pr-777-ci-refused-1-1' " +
                  "is already used by worktree at '/home/dev/other'",
              },
            });
          }
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          });
        }) as unknown as GitDeps["runGitCommand"],
      },
    });

    // Two cycles of a refused fix-branch checkout …
    for (let cycle = 0; cycle < 2; cycle++) {
      const result = await processCiFailure(
        makeInput({
          repo: "org/repo",
          prNumber,
          branchName: milestoneHead,
          checkRunId: "refused-1",
        }),
        {
          promptsDir: PROMPTS_DIR,
          logger: makeSilentLogger(),
          deps,
          stateDir,
          workDir: tmpDir,
          workRoot: tmpDir,
        },
      );
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.value.processed, false);
        assertEquals(
          result.value.retryCount,
          0,
          "a refused fix-branch checkout must report the count that " +
            "actually matches the (unwritten) state",
        );
        assertStringIncludes(
          result.value.summary,
          "milestone-fix branch",
        );
      }
    }
    assertEquals(claudeRuns, 0, "the agent never runs on a refused checkout");
    // … and the retry budget is untouched: no counter was ever written.
    let counter: string | undefined;
    try {
      counter = await Deno.readTextFile(
        `${stateDir}/org_repo_refused-1.retries`,
      );
    } catch {
      counter = undefined;
    }
    assertEquals(counter, undefined, "a refused checkout is not an attempt");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// Gated head — the milestone-fix branch happy path (Issue #2907, PR #2909)
// ============================================================================

const GATED_MILESTONE_HEAD = "milestone/2907-gated-fix";
const GATED_PR_NUMBER = 555;
// The discriminator folds in `checkRunId` (PR #2909 review) so a stale
// closed-unmerged fix branch from an earlier check run can never collide
// with this one — this must track the "gated-happy-1" checkRunId the happy-
// path test below feeds in.
const GATED_FIX_BRANCH = milestoneFixBranchFor(
  GATED_MILESTONE_HEAD,
  GATED_PR_NUMBER,
  "ci-gated-happy-1-1",
);

/** A `gh` stub answering the gated-head assessment and the fix-PR lookups. */
function makeGatedFixGh(
  ghCalls: string[][],
  options: { prCreate: () => Promise<string> },
): GitHubDeps["runGhCommand"] {
  return ((args: string[]) => {
    if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
    ghCalls.push(args);
    const joined = args.join(" ");
    if (joined.includes("rules/branches")) {
      return Promise.resolve(
        JSON.stringify([{ type: "required_status_checks" }]),
      );
    }
    if (args[0] === "pr" && args[1] === "list") {
      // Neither findOpenMilestoneFixPr nor raiseMilestoneFixPr's own dedup
      // check finds an existing fix PR — this run raises the first one.
      return Promise.resolve("[]");
    }
    if (args[0] === "pr" && args[1] === "create") {
      return options.prCreate();
    }
    if (args[0] === "api" && args.includes("-X") && args.includes("GET")) {
      // clearMilestoneReviewRequests: no auto-requested reviewers.
      return Promise.resolve("{}");
    }
    return Promise.resolve("");
  }) as unknown as GitHubDeps["runGhCommand"];
}

Deno.test("processCiFailure - a gated head with no fix PR in flight pushes to a milestone-fix branch and raises a PR (Issue #2907)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-gated-ci-happy-" });
  try {
    const stateDir = `${tmpDir}/.ci_check_state`;
    const gitCommands: string[][] = [];
    const commitAndPushCalls: string[] = [];
    const ghCalls: string[][] = [];
    let claudeRan = false;
    let fixBranchCheckoutBeforeClaude = false;
    let enableAutoMergeCalls = 0;

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() => {
        claudeRan = true;
        return Promise.resolve({
          ok: true,
          value: { output: "Fixed", exitCode: 0, timedOut: false },
        });
      }) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };

    const deps = createMockDeps({
      claude: mockClaude,
      github: {
        runGhCommand: makeGatedFixGh(ghCalls, {
          prCreate: () =>
            Promise.resolve("https://github.com/org/repo/pull/9002"),
        }),
      },
      git: {
        runGitCommand: ((args: string[]) => {
          gitCommands.push(args);
          if (
            args[0] === "checkout" && args[1] === "-B" &&
            args[2] === GATED_FIX_BRANCH
          ) {
            fixBranchCheckoutBeforeClaude = !claudeRan;
          }
          if (args[0] === "ls-remote") {
            // Exit 2 ("no matching refs") is the production-normal outcome:
            // no stale branch, so proceed straight to checkout without
            // deleting anything (PR #2909 review).
            return Promise.resolve({
              ok: true,
              value: { code: 2, stdout: "", stderr: "" },
            });
          }
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          });
        }) as unknown as GitDeps["runGitCommand"],
        commitAndPushPending: ((branchName: string) => {
          commitAndPushCalls.push(branchName);
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
      pr: {
        enableAutoMerge: ((() => {
          enableAutoMergeCalls++;
          return Promise.resolve({
            result: AutoMergeResult.Enabled,
            message: "should not be called",
          });
        }) as unknown) as PrDeps["enableAutoMerge"],
      },
    });

    const result = await processCiFailure(
      makeInput({
        repo: "org/repo",
        prNumber: GATED_PR_NUMBER,
        branchName: GATED_MILESTONE_HEAD,
        checkRunId: "gated-happy-1",
      }),
      {
        promptsDir: PROMPTS_DIR,
        logger: makeSilentLogger(),
        deps,
        stateDir,
        workDir: tmpDir,
        workRoot: tmpDir,
        verifyPushFn: REMOTE_CONFIRMS_PUSH,
      },
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.processed, true);
      assertEquals(result.value.changesPushed, true);
      assertStringIncludes(result.value.summary, "via fix PR #9002");
    }

    assertEquals(
      fixBranchCheckoutBeforeClaude,
      true,
      "the fix branch is checked out before Claude runs",
    );
    assertEquals(
      commitAndPushCalls,
      [GATED_FIX_BRANCH],
      "the fix, not the PR's own head, receives the commit and push",
    );
    assertEquals(
      gitCommands.some((args) =>
        args[0] === "push" && args.includes("--delete")
      ),
      false,
      "ls-remote exit 2 means the branch is absent — nothing to delete " +
        "(PR #2909 review)",
    );

    const prCreateCall = ghCalls.find((args) =>
      args[0] === "pr" && args[1] === "create"
    );
    if (prCreateCall === undefined) throw new Error("pr create was not called");
    assertEquals(
      prCreateCall[prCreateCall.indexOf("--base") + 1],
      GATED_MILESTONE_HEAD,
      "the fix PR targets the gated milestone head",
    );
    assertEquals(
      prCreateCall[prCreateCall.indexOf("--head") + 1],
      GATED_FIX_BRANCH,
    );

    assertEquals(
      enableAutoMergeCalls,
      0,
      "the milestone PR's own auto-merge is not re-armed — only the fix " +
        "PR's is (armed separately inside raiseMilestoneFixPr)",
    );

    const commentBody = ghCalls
      .filter((args) => args[0] === "pr" && args[1] === "comment")
      .map((args) => args[args.indexOf("--body") + 1] ?? "")
      .find((body) => body.includes("delivered via #9002"));
    assertEquals(
      commentBody !== undefined,
      true,
      "the reply names the fix PR that carries the change",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - a gated head whose fix PR cannot be raised reports changesPushed: false (Issue #2907)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-gated-ci-fail-" });
  try {
    const stateDir = `${tmpDir}/.ci_check_state`;
    const ghCalls: string[][] = [];

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "Fixed", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };

    const deps = createMockDeps({
      claude: mockClaude,
      github: {
        runGhCommand: makeGatedFixGh(ghCalls, {
          prCreate: () =>
            Promise.reject(new Error("GitHub API rate limit exceeded")),
        }),
      },
      git: {
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

    const result = await processCiFailure(
      makeInput({
        repo: "org/repo",
        prNumber: GATED_PR_NUMBER,
        branchName: GATED_MILESTONE_HEAD,
        checkRunId: "gated-fail-1",
      }),
      {
        promptsDir: PROMPTS_DIR,
        logger: makeSilentLogger(),
        deps,
        stateDir,
        workDir: tmpDir,
        workRoot: tmpDir,
        verifyPushFn: REMOTE_CONFIRMS_PUSH,
      },
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.processed, true);
      assertEquals(
        result.value.changesPushed,
        false,
        "the fix was made and pushed to the fix branch, but never delivered",
      );
      assertStringIncludes(
        result.value.summary,
        "could not raise the milestone-fix PR",
      );
      // A real attempt was made (the branch checked out and Claude ran), so
      // this cycle still spends a retry.
      assertEquals(result.value.retryCount, 1);
    }
    const failureComment = ghCalls
      .filter((args) => args[0] === "pr" && args[1] === "comment")
      .map((args) => args[args.indexOf("--body") + 1] ?? "")
      .find((body) => body.includes("could not be raised"));
    assertEquals(
      failureComment !== undefined,
      true,
      "the reply explains the push landed but delivery failed",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - two check runs on the same gated milestone PR never reuse a fix branch name (PR #2909 review)", async () => {
  // Regression test: before this fix the discriminator was `ci-<retryCount>`
  // alone, and the retry counter is keyed by checkRunId — so every *new*
  // check run on the milestone PR restarted at `ci-1`. A fix PR closed
  // unmerged (a human rejecting a bad fix) left `origin/…-ci-1` in place;
  // a later child-PR merge triggers a fresh check run, which reused the
  // identical branch name. `checkout -B` on that name diverges from the
  // stale remote history, the plain push is rejected, and the merge-based
  // recovery in git_push_recovery.ts resurrects the rejected commits into a
  // brand-new, auto-merge-armed fix PR — unattended. Folding `checkRunId`
  // into the discriminator makes every check run's fix branch name unique,
  // so this collision can no longer happen.
  const tmpDir = await Deno.makeTempDir({
    prefix: "vibe-gated-ci-branch-uniq-",
  });
  try {
    const stateDir = `${tmpDir}/.ci_check_state`;
    const checkoutBranches: string[] = [];

    const runOnce = async (checkRunId: string): Promise<void> => {
      const ghCalls: string[][] = [];
      const deps = createMockDeps({
        claude: {
          runClaudeWithRetry: (() =>
            Promise.resolve({
              ok: true,
              value: { output: "Fixed", exitCode: 0, timedOut: false },
            })) as unknown as ClaudeDeps["runClaudeWithRetry"],
        },
        github: {
          runGhCommand: makeGatedFixGh(ghCalls, {
            prCreate: () =>
              Promise.resolve("https://github.com/org/repo/pull/9100"),
          }),
        },
        git: {
          runGitCommand: ((args: string[]) => {
            if (args[0] === "checkout" && args[1] === "-B") {
              checkoutBranches.push(args[2]!);
            }
            if (args[0] === "ls-remote") {
              // Exit 2 ("no matching refs") — no stale branch either time
              // (PR #2909 review).
              return Promise.resolve({
                ok: true,
                value: { code: 2, stdout: "", stderr: "" },
              });
            }
            return Promise.resolve({
              ok: true,
              value: { code: 0, stdout: "", stderr: "" },
            });
          }) as unknown as GitDeps["runGitCommand"],
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

      const result = await processCiFailure(
        makeInput({
          repo: "org/repo",
          prNumber: GATED_PR_NUMBER,
          branchName: GATED_MILESTONE_HEAD,
          checkRunId,
        }),
        {
          promptsDir: PROMPTS_DIR,
          logger: makeSilentLogger(),
          deps,
          stateDir,
          workDir: tmpDir,
          workRoot: tmpDir,
          verifyPushFn: REMOTE_CONFIRMS_PUSH,
        },
      );
      assertEquals(result.ok, true);
    };

    // Two distinct check runs on the same milestone PR, each its own first
    // retry — the exact shape of "fix PR from check run A closed unmerged,
    // child PR merges, check run B fails".
    await runOnce("check-run-A");
    await runOnce("check-run-B");

    assertEquals(checkoutBranches.length, 2);
    assertEquals(
      checkoutBranches[0] === checkoutBranches[1],
      false,
      "different check runs must never check out the same fix branch name",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - a stale remote fix branch (cross-host name collision) is deleted before checkout, never merged back in (PR #2909 review)", async () => {
  // Regression test for the remaining gap the PR #2909 review found: folding
  // `checkRunId` into the discriminator only makes the name unique *per
  // host* — `newRetryCount` is a per-host file, so a second host working the
  // same still-open check run computes the identical fix-branch name. Here
  // origin already holds GATED_FIX_BRANCH (as a closed-unmerged fix PR would
  // leave it); the fix must delete it before `checkout -B` rather than let
  // the push diverge and have `recoverFromPushRejection` merge the stale,
  // rejected commits back into a fresh auto-merge-armed PR.
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-gated-ci-stale-" });
  try {
    const stateDir = `${tmpDir}/.ci_check_state`;
    const ghCalls: string[][] = [];
    const gitCommands: string[][] = [];
    let recoveryCalled = false;

    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (() =>
          Promise.resolve({
            ok: true,
            value: { output: "Fixed", exitCode: 0, timedOut: false },
          })) as unknown as ClaudeDeps["runClaudeWithRetry"],
      },
      github: {
        runGhCommand: makeGatedFixGh(ghCalls, {
          prCreate: () =>
            Promise.resolve("https://github.com/org/repo/pull/9200"),
        }),
      },
      git: {
        runGitCommand: ((args: string[]) => {
          gitCommands.push(args);
          if (args[0] === "ls-remote") {
            // Stale branch from an earlier, closed-unmerged fix PR is still
            // on origin under this exact name.
            return Promise.resolve({
              ok: true,
              value: {
                code: 0,
                stdout: `abc123\trefs/heads/${GATED_FIX_BRANCH}`,
                stderr: "",
              },
            });
          }
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          });
        }) as unknown as GitDeps["runGitCommand"],
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
        recoverFromPushRejection: (() => {
          recoveryCalled = true;
          return Promise.resolve({ ok: true, value: "recovered" });
        }) as unknown as GitDeps["recoverFromPushRejection"],
      },
    });

    const result = await processCiFailure(
      makeInput({
        repo: "org/repo",
        prNumber: GATED_PR_NUMBER,
        branchName: GATED_MILESTONE_HEAD,
        checkRunId: "gated-happy-1",
      }),
      {
        promptsDir: PROMPTS_DIR,
        logger: makeSilentLogger(),
        deps,
        stateDir,
        workDir: tmpDir,
        workRoot: tmpDir,
        verifyPushFn: REMOTE_CONFIRMS_PUSH,
      },
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.processed, true);
      assertEquals(result.value.changesPushed, true);
    }
    assertEquals(
      recoveryCalled,
      false,
      "the stale branch must be removed up front, never merged back in via recovery",
    );

    const deleteIndex = gitCommands.findIndex((args) =>
      args[0] === "push" && args.includes("--delete") &&
      args.includes(GATED_FIX_BRANCH)
    );
    const checkoutIndex = gitCommands.findIndex((args) =>
      args[0] === "checkout" && args[1] === "-B" &&
      args[2] === GATED_FIX_BRANCH
    );
    assertEquals(deleteIndex >= 0, true, "the stale remote branch is deleted");
    assertEquals(
      checkoutIndex >= 0,
      true,
      "the fix branch is still checked out",
    );
    assertEquals(
      deleteIndex < checkoutIndex,
      true,
      "the stale branch is deleted before it can be diverged from",
    );

    const prCreateCall = ghCalls.find((args) =>
      args[0] === "pr" && args[1] === "create"
    );
    if (prCreateCall === undefined) throw new Error("pr create was not called");
    assertEquals(
      prCreateCall[prCreateCall.indexOf("--head") + 1],
      GATED_FIX_BRANCH,
      "the raised PR head is the freshly re-created branch, not stale content",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - an ls-remote failure (non-2 exit) stands down instead of assuming the stale branch is absent (PR #2909 review)", async () => {
  // Regression test for the review gap: `ls-remote --exit-code` only
  // documents exit 2 as "no matching refs". A transient failure (network,
  // auth — modelled here with exit 128) must not be read as "branch
  // absent", or `checkout -B` would cut a fix branch that can silently
  // diverge from a stale remote branch a closed-unmerged fix PR left behind.
  const tmpDir = await Deno.makeTempDir({
    prefix: "vibe-gated-ci-lsremote-fail-",
  });
  try {
    const stateDir = `${tmpDir}/.ci_check_state`;
    const ghCalls: string[][] = [];
    const gitCommands: string[][] = [];
    let claudeCalled = false;

    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (() => {
          claudeCalled = true;
          return Promise.resolve({
            ok: true,
            value: { output: "Fixed", exitCode: 0, timedOut: false },
          });
        }) as unknown as ClaudeDeps["runClaudeWithRetry"],
      },
      github: {
        runGhCommand: makeGatedFixGh(ghCalls, {
          prCreate: () =>
            Promise.resolve("https://github.com/org/repo/pull/9300"),
        }),
      },
      git: {
        runGitCommand: ((args: string[]) => {
          gitCommands.push(args);
          if (args[0] === "ls-remote") {
            return Promise.resolve({
              ok: true,
              value: { code: 128, stdout: "", stderr: "fatal: could not read" },
            });
          }
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          });
        }) as unknown as GitDeps["runGitCommand"],
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

    const result = await processCiFailure(
      makeInput({
        repo: "org/repo",
        prNumber: GATED_PR_NUMBER,
        branchName: GATED_MILESTONE_HEAD,
        checkRunId: "gated-lsremote-fail-1",
      }),
      {
        promptsDir: PROMPTS_DIR,
        logger: makeSilentLogger(),
        deps,
        stateDir,
        workDir: tmpDir,
        workRoot: tmpDir,
        verifyPushFn: REMOTE_CONFIRMS_PUSH,
      },
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.processed, false);
      assertEquals(result.value.retryCount, 0);
    }
    assertEquals(
      claudeCalled,
      false,
      "Claude must not run when the stale-branch check itself failed",
    );
    assertEquals(
      gitCommands.some((args) => args[0] === "checkout" && args[1] === "-B"),
      false,
      "no fix branch is cut when ls-remote's result could not be trusted",
    );
    assertEquals(
      ghCalls.some((args) => args[0] === "pr" && args[1] === "create"),
      false,
      "no fix PR is raised when the stale-branch check failed",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// PR body sync after a successful push (Issue #3089)
// ============================================================================

/** `captureBranchHead`'s default mock value (see `createMockDeps`). */
const DEFAULT_MOCK_HEAD_SHA = "0000000000000000000000000000000000000000";

function makeSuccessfulCiPushDeps(
  tmpDir: string,
  syncPrBodyFn?: CiProcessorDeps["syncPrBodyFn"],
): CiProcessorDeps {
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Fixed CI", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: openPrGh(),
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
            commitsPushed: 1,
            finalUnpushedCount: 0,
          },
        })) as unknown as GitDeps["commitAndPushPending"],
    },
  });

  return {
    promptsDir: PROMPTS_DIR,
    logger: makeSilentLogger(),
    deps,
    stateDir: `${tmpDir}/.ci_check_state`,
    workDir: tmpDir,
    workRoot: tmpDir,
    verifyPushFn: REMOTE_CONFIRMS_PUSH,
    syncPrBodyFn,
  };
}

Deno.test("processCiFailure - syncs the PR body once after a verified push", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const calls: Array<{ prNumber: number; repo: string; beforeSha?: string }> =
      [];
    const syncPrBodyFn: CiProcessorDeps["syncPrBodyFn"] = (input) => {
      calls.push({
        prNumber: input.prNumber,
        repo: input.repo,
        beforeSha: input.beforeSha,
      });
      return Promise.resolve({
        ok: true,
        value: { status: "updated", issueNumber: 42 },
      });
    };
    const processorDeps = makeSuccessfulCiPushDeps(tmpDir, syncPrBodyFn);

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    assertEquals(calls.length, 1);
    assertEquals(calls[0]?.prNumber, 42);
    assertEquals(calls[0]?.repo, "org/repo");
    assertEquals(calls[0]?.beforeSha, DEFAULT_MOCK_HEAD_SHA);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - does not sync the PR body when nothing was pushed", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    let syncCalled = false;
    const syncPrBodyFn: CiProcessorDeps["syncPrBodyFn"] = () => {
      syncCalled = true;
      return Promise.resolve({
        ok: true,
        value: { status: "updated", issueNumber: 42 },
      });
    };
    const processorDeps = makeSuccessfulCiPushDeps(tmpDir, syncPrBodyFn);
    processorDeps.deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (() =>
          Promise.resolve({
            ok: true,
            value: { output: "Fixed CI", exitCode: 0, timedOut: false },
          })) as unknown as ClaudeDeps["runClaudeWithRetry"],
      },
      github: { runGhCommand: openPrGh() },
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
      },
    });

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    assertEquals(syncCalled, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - does not sync the PR body on a gated-head fix branch", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-ci-sync-gated-" });
  try {
    let syncCalled = false;
    const syncPrBodyFn: CiProcessorDeps["syncPrBodyFn"] = () => {
      syncCalled = true;
      return Promise.resolve({
        ok: true,
        value: { status: "updated", issueNumber: 42 },
      });
    };
    const ghCalls: string[][] = [];
    const processorDeps = makeSuccessfulCiPushDeps(tmpDir, syncPrBodyFn);
    processorDeps.stateDir = `${tmpDir}/.ci_check_state`;
    processorDeps.deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (() =>
          Promise.resolve({
            ok: true,
            value: { output: "Fixed", exitCode: 0, timedOut: false },
          })) as unknown as ClaudeDeps["runClaudeWithRetry"],
      },
      github: {
        runGhCommand: makeGatedFixGh(ghCalls, {
          prCreate: () =>
            Promise.resolve("https://github.com/org/repo/pull/9010"),
        }),
      },
      git: {
        runGitCommand: ((args: string[]) => {
          if (args[0] === "ls-remote") {
            return Promise.resolve({
              ok: true,
              value: { code: 2, stdout: "", stderr: "" },
            });
          }
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          });
        }) as unknown as GitDeps["runGitCommand"],
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

    const result = await processCiFailure(
      makeInput({
        repo: "org/repo",
        prNumber: GATED_PR_NUMBER,
        branchName: GATED_MILESTONE_HEAD,
        checkRunId: "ci-sync-gated-1",
      }),
      processorDeps,
    );

    assertEquals(result.ok, true);
    assertEquals(syncCalled, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - a failing PR body sync does not fail the run", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const processorDeps = makeSuccessfulCiPushDeps(
      tmpDir,
      () => Promise.resolve({ ok: false, error: new Error("gh pr edit boom") }),
    );

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.processed, true);
      assertEquals(result.value.changesPushed, true);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
