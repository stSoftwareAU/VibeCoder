/**
 * Tests for the standing-violation hold on the CI-fix re-arm (Issue #3685).
 *
 * After a CI-fix push lands on the PR's own head, `processCiFailure` re-arms
 * auto-merge. A PR labelled `standing-violation` must not be re-armed, on
 * either the unguarded path or the locked path, while an unlabelled PR still
 * is. The label is read from the claim-point live-state read, so no extra
 * `gh` call is made.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { STANDING_VIOLATION_LABEL } from "../lib/standing_violation_routing.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import type { Logger } from "../types.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
  PrDeps,
} from "../lib/issue_worker_wiring.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844)
// — named as a parameter on every call rather than pinned by deleting the
// host's overrides from the shared process environment (Issue #1024).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A logger that records every info message so the hold can be asserted. */
function makeRecordingLogger(infoLines: string[]): Logger {
  const noop = () => {};
  return {
    info: (message: string) => {
      infoLines.push(message);
    },
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

function makeInput(): CiFixInput {
  const annotations: CheckAnnotation[] = [
    {
      path: "tests/main_test.ts",
      start_line: 42,
      message: "Test assertion failed",
    },
  ];
  return {
    repo: "org/repo",
    prNumber: 42,
    branchName: "issue-42-fix-bug",
    checkRunId: "67890",
    checkName: "CI / test",
    encodedAnnotations: btoa(JSON.stringify(annotations)),
  };
}

/**
 * Issue #1643 / #579: the push is claimed only when the remote confirms it,
 * so the re-arm block is reached only on a verified push.
 */
const REMOTE_CONFIRMS_PUSH = () =>
  Promise.resolve({
    landed: true,
    localSha: "f".repeat(40),
    remoteSha: "f".repeat(40),
    reason: "verified in test",
  });

/** The `enableAutoMerge` calls the pass made, in order. */
interface ArmCall {
  repo: string;
  prNumber: number;
}

/**
 * Build the mock fleet for a CI fix whose claim-point read reports an open PR
 * carrying `labels`. Every other `gh` call answers "", and each
 * `enableAutoMerge` call is recorded into `arms`.
 */
function makeDeps(
  labels: string[],
  arms: ArmCall[],
): ReturnType<typeof createMockDeps> {
  const payload = JSON.stringify({
    autoMergeRequest: null,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    state: "OPEN",
    labels: labels.map((name) => ({ name })),
  });
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Fixed CI", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: (args: string[]) =>
      Promise.resolve(isPrLiveStateRead(args) ? payload : ""),
  };
  return createMockDeps({
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
    pr: {
      enableAutoMerge: ((options: ArmCall) => {
        arms.push({ repo: options.repo, prNumber: options.prNumber });
        return Promise.resolve({
          result: AutoMergeResult.Enabled,
          message: "armed",
        });
      }) as unknown as PrDeps["enableAutoMerge"],
    },
  });
}

// ============================================================================
// Issue #3685: standing-violation PRs are not re-armed after a CI-fix push
// ============================================================================

Deno.test("processCiFailure - a PR labelled standing-violation is not re-armed after a CI-fix push (Issue #3685)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-standing-violation-" });
  try {
    const arms: ArmCall[] = [];
    const infoLines: string[] = [];
    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeRecordingLogger(infoLines),
      deps: makeDeps([STANDING_VIOLATION_LABEL, "bug"], arms),
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      workRoot: tmpDir,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const result = await processCiFailure(makeInput(), processorDeps);

    // Positive control: the push landed and the re-arm block was reached.
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.changesPushed, true);
    }
    assertEquals(
      arms.length,
      0,
      "a standing-violation PR must not have auto-merge re-armed",
    );
    const holdLine = infoLines.find((line) =>
      line.includes(STANDING_VIOLATION_LABEL)
    );
    if (holdLine === undefined) {
      throw new Error("the standing-violation hold was not logged");
    }
    assertStringIncludes(holdLine, "not re-arming");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - an unlabelled PR is still re-armed after a CI-fix push (Issue #3685)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-standing-violation-" });
  try {
    const arms: ArmCall[] = [];
    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeRecordingLogger([]),
      deps: makeDeps(["bug"], arms),
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
      arms,
      [{ repo: "org/repo", prNumber: 42 }],
      "an unlabelled PR must still have auto-merge re-armed exactly once",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - a labelled PR is not re-armed on the locked path (Issue #3685)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-standing-violation-" });
  try {
    const arms: ArmCall[] = [];
    const infoLines: string[] = [];
    // Production runs the CI fix under the cross-host PR lock, so this test
    // does too: the hold has to hold on the path the worker actually takes.
    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeRecordingLogger(infoLines),
      deps: makeDeps([STANDING_VIOLATION_LABEL], arms),
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      workRoot: tmpDir,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
      workerId: "worker-1",
      acquireLockFn: (() =>
        Promise.resolve({
          ok: true,
          value: { acquired: true, lockCommentId: 1 },
        })) as unknown as CiProcessorDeps["acquireLockFn"],
      releaseLockFn: (() =>
        Promise.resolve({
          ok: true,
          value: undefined,
        })) as unknown as CiProcessorDeps["releaseLockFn"],
      startLockRenewalFn: (() => ({
        stop: () => {},
      })) as unknown as CiProcessorDeps["startLockRenewalFn"],
    };

    const result = await processCiFailure(makeInput(), processorDeps);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.changesPushed, true);
    }
    assertEquals(
      arms.length,
      0,
      "a standing-violation PR must not have auto-merge re-armed on the locked path",
    );
    const holdLine = infoLines.find((line) =>
      line.includes(STANDING_VIOLATION_LABEL)
    );
    if (holdLine === undefined) {
      throw new Error("the standing-violation hold was not logged");
    }
    assertStringIncludes(holdLine, "not re-arming");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
