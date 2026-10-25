/**
 * Tests for the CI-fix re-arm (Issues #3685, #4291).
 *
 * After a CI-fix push lands on the PR's own head, `processCiFailure` re-arms
 * auto-merge. The CI quality gate is the only merge gate (Issue #4291), so
 * the re-arm happens on the unguarded and the locked path alike — whatever
 * labels the PR still carries and whatever its pre-PR review record says.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import type { Logger } from "../types.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
  PrDeps,
} from "../lib/issue_worker_wiring.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";
import { renderPreprReviewRequest } from "../lib/prepr_review_record.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844)
// — named as a parameter on every call rather than pinned by deleting the
// host's overrides from the shared process environment (Issue #1024).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A `warn` call the pass made: its message and structured context. */
interface WarnCall {
  message: string;
  context: unknown;
}

/**
 * A logger that records every info message, and every warning (with its
 * context) so a failed re-arm can be asserted.
 */
function makeRecordingLogger(
  infoLines: string[],
  warnings: WarnCall[] = [],
): Logger {
  const noop = () => {};
  return {
    info: (message: string) => {
      infoLines.push(message);
    },
    warn: (message: string, context?: unknown) => {
      warnings.push({ message, context });
    },
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
  headRefName?: string;
}

/**
 * Build the mock fleet for a CI fix whose claim-point read reports an open PR
 * carrying `labels`. Every other `gh` call answers "", and each
 * `enableAutoMerge` call is recorded into `arms` — then throws when
 * `armThrows` is set, so the failed re-arm path can be exercised.
 */
function makeDeps(
  labels: string[],
  arms: ArmCall[],
  armThrows = false,
  comments = "[]",
  commentsThrows = false,
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
    runGhCommand: (args: string[]) => {
      if (isPrLiveStateRead(args)) return Promise.resolve(payload);
      if (args.some((arg) => arg.includes("/comments"))) {
        if (commentsThrows) {
          return Promise.reject(new Error("comments unreadable"));
        }
        return Promise.resolve(comments);
      }
      return Promise.resolve("");
    },
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
        arms.push({
          repo: options.repo,
          prNumber: options.prNumber,
          headRefName: options.headRefName,
        });
        if (armThrows) {
          return Promise.reject(new Error("gh pr merge --auto failed"));
        }
        return Promise.resolve({
          result: AutoMergeResult.Enabled,
          message: "armed",
        });
      }) as unknown as PrDeps["enableAutoMerge"],
    },
  });
}

// ============================================================================
// Issue #4291: every CI-fix push re-arms auto-merge
// ============================================================================

/** The one re-arm a CI-fix push on the PR's own head makes. */
const REARM: ArmCall[] = [
  // Issue #3909: the head branch is passed so the milestone open-children
  // gate needs no extra lookup.
  { repo: "org/repo", prNumber: 42, headRefName: "issue-42-fix-bug" },
];

/** Lock seams for the cross-host PR lock production runs the CI fix under. */
const LOCKED: Partial<CiProcessorDeps> = {
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

const OPEN_RECORD = JSON.stringify([{
  author: "testbot",
  body: renderPreprReviewRequest([{
    file: "src/balance.ts",
    line: 42,
    problem: "rounding drops the final cent",
  }]),
}]);

/** Run one CI fix whose push lands, and return the re-arms it made. */
async function rearmsAfterPush(
  deps: (arms: ArmCall[]) => ReturnType<typeof createMockDeps>,
  extra: Partial<CiProcessorDeps> = {},
): Promise<ArmCall[]> {
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-ci-rearm-" });
  try {
    const arms: ArmCall[] = [];
    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeRecordingLogger([]),
      deps: deps(arms),
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      workRoot: tmpDir,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
      ...extra,
    };

    const result = await processCiFailure(makeInput(), processorDeps);

    // Positive control: the push landed and the re-arm block was reached.
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.changesPushed, true);
    }
    return arms;
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("processCiFailure - an unlabelled PR is re-armed after a CI-fix push (Issue #3685)", async () => {
  assertEquals(
    await rearmsAfterPush((arms) => makeDeps(["bug"], arms)),
    REARM,
    "auto-merge must be re-armed exactly once",
  );
});

Deno.test("processCiFailure - a PR still carrying the retired standing-violation label is re-armed (Issue #4291)", async () => {
  assertEquals(
    await rearmsAfterPush((arms) => makeDeps(["standing-violation"], arms)),
    REARM,
    "a stale label must not withhold the re-arm",
  );
});

Deno.test("processCiFailure - a stale-labelled PR is re-armed on the locked path too (Issue #4291)", async () => {
  assertEquals(
    await rearmsAfterPush(
      (arms) => makeDeps(["standing-violation"], arms),
      LOCKED,
    ),
    REARM,
    "the locked path must re-arm as the unguarded path does",
  );
});

Deno.test("processCiFailure - a CI-fix push re-arms while a pre-PR review record is open (Issue #4291)", async () => {
  assertEquals(
    await rearmsAfterPush(
      (arms) => makeDeps(["bug"], arms, false, OPEN_RECORD),
      { githubUser: "testbot", fleetLogins: ["testbot"] },
    ),
    REARM,
    "an open pre-PR review record must not withhold the re-arm",
  );
});

Deno.test("processCiFailure - a CI-fix push re-arms when the comment list cannot be read (Issue #4291)", async () => {
  assertEquals(
    await rearmsAfterPush(
      (arms) => makeDeps(["bug"], arms, false, "[]", true),
      { githubUser: "testbot" },
    ),
    REARM,
    "an unreadable comment list must not withhold the re-arm",
  );
});

Deno.test("processCiFailure - a failed re-arm is warned, not thrown (Issue #3685)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-ci-rearm-" });
  try {
    const arms: ArmCall[] = [];
    const warnings: WarnCall[] = [];
    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeRecordingLogger([], warnings),
      deps: makeDeps(["bug"], arms, true),
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      workRoot: tmpDir,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const result = await processCiFailure(makeInput(), processorDeps);

    // The pushed fix still counts: a failed re-arm never fails the pass.
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.changesPushed, true);
    }
    assertEquals(arms.length, 1, "the re-arm must have been attempted once");
    const rearmWarnings = warnings.filter((warning) =>
      warning.message === "Could not re-enable auto-merge"
    );
    assertEquals(
      rearmWarnings,
      [{
        message: "Could not re-enable auto-merge",
        context: { repo: "org/repo", prNumber: 42 },
      }],
      "a failed re-arm must be warned once, naming the repo and PR",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
