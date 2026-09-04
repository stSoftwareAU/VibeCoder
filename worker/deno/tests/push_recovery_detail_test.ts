/**
 * A failed push recovery must name the step that failed (Issue #211).
 *
 * The processors logged a bare "Push failed after recovery attempt" and threw
 * `recoveryResult.error` away, so the operator log said nothing about whether
 * the rebase conflicted, auto-resolution failed, or `--force-with-lease` was
 * refused. The merge-conflict pass had the same hole
 * (`detail=5 commit(s) could not be pushed`, no git stderr).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import type { Logger } from "../types.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844)
// — named as a parameter on every call rather than pinned by deleting the
// host's overrides from the shared process environment (Issue #1024).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

interface CapturedLog {
  message: string;
  context: string;
}

function makeCapturingLogger(sink: CapturedLog[]): Logger {
  const noop = () => {};
  const capture = (message: string, context?: unknown) => {
    sink.push({ message, context: JSON.stringify(context ?? {}) });
  };
  return {
    info: noop,
    warn: capture,
    error: capture,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

const RECOVERY_ERROR =
  "--force-with-lease push also failed: stale info: refs/heads/issue-42-fix";

Deno.test("processCiFailure - logs the recovery failure reason, not just 'push failed' (Issue #211)", async () => {
  const tmpDir = await Deno.makeTempDir();
  const logs: CapturedLog[] = [];
  try {
    const annotations: CheckAnnotation[] = [
      { path: "a.ts", start_line: 1, message: "boom" },
    ];
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
              finalUnpushedCount: 2,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
        recoverFromPushRejection: (() =>
          Promise.resolve({
            ok: false,
            error: new Error(RECOVERY_ERROR),
          })) as unknown as GitDeps["recoverFromPushRejection"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeCapturingLogger(logs),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
    };

    const result = await processCiFailure({
      repo: "org/repo",
      prNumber: 42,
      branchName: "issue-42-fix",
      checkRunId: "1",
      checkName: "CI / test",
      encodedAnnotations: btoa(JSON.stringify(annotations)),
    }, processorDeps);

    assertEquals(result.ok, true);
    const failureLine = logs.find((entry) =>
      entry.message.includes("Push failed after recovery attempt")
    );
    assert(failureLine, "expected the push-failure line to be logged");
    assert(
      failureLine.context.includes("stale info") ||
        failureLine.message.includes("stale info"),
      `expected git's own recovery failure in the log, got: ${failureLine.message} ${failureLine.context}`,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
