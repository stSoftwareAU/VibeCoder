/**
 * Processor-level tests for the result-placeholder reply recovery (Issue
 * #3124) wired into `_processFeedbackWithHeartbeat`.
 *
 * A `.pr_response_message` Claude leaves behind carrying a bare fill-in-later
 * token (e.g. `QUALITY_RESULT_PLACEHOLDER`) must earn one extra in-run
 * recovery turn — a second call to `runClaudeWithRetry` — before the message
 * is ever read back for the PR comment. A clean file must not spend that
 * extra turn.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  type PrFeedbackInput,
  type PrFeedbackProcessorDeps,
  processPrFeedback,
} from "../lib/pr_feedback_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import { openPrGh } from "./support/pr_live_state_stub.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

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

/**
 * Runs `processPrFeedback` with a `.pr_response_message` pre-staged in a real
 * temp `workDir`, counting how many times `runClaudeWithRetry` is invoked.
 */
async function runWithStagedMessage(
  message: string,
): Promise<{
  result: Awaited<ReturnType<typeof processPrFeedback>>;
  runClaudeWithRetryCalls: number;
}> {
  const tmpDir = await Deno.makeTempDir({ prefix: "placeholder-retry-test-" });
  try {
    await Deno.writeTextFile(`${tmpDir}/.pr_response_message`, message);

    let runClaudeWithRetryCalls = 0;
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: ((..._args: unknown[]) => {
        runClaudeWithRetryCalls++;
        return Promise.resolve({
          ok: true,
          value: { output: "Fixed the issue", exitCode: 0, timedOut: false },
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
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      workDir: tmpDir,
      workRoot: tmpDir,
      qualityInstructions: "",
    };

    const result = await processPrFeedback(makeInput(), processorDeps);
    return { result, runClaudeWithRetryCalls };
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

Deno.test(
  "processPrFeedback - a bare result-placeholder token in .pr_response_message earns one extra recovery turn (Issue #3124)",
  async () => {
    const { result, runClaudeWithRetryCalls } = await runWithStagedMessage(
      "Full `./quality.sh`: QUALITY_RESULT_PLACEHOLDER",
    );

    assertEquals(result.ok, true);
    // One call for the main feedback turn, one for the placeholder recovery.
    assertEquals(runClaudeWithRetryCalls, 2);
  },
);

Deno.test(
  "processPrFeedback - a clean .pr_response_message does not spend the recovery turn (Issue #3124)",
  async () => {
    const { result, runClaudeWithRetryCalls } = await runWithStagedMessage(
      "Full `./quality.sh`: passed",
    );

    assertEquals(result.ok, true);
    // Only the main feedback turn — the file is already clean.
    assertEquals(runClaudeWithRetryCalls, 1);
  },
);
