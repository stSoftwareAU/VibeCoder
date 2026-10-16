/**
 * Tests for the review-fix verifier gate's wiring into `processPrFeedback`
 * (Issue #3784).
 *
 * Drives the real `processPrFeedback` against a temporary working directory,
 * with `reviewFixVerifierFn` injected as a recording stub. What is checked is
 * the call site's guards (a reviewer change request, a pushed change, a
 * complete head), the arguments it hands the gate, the extra commit-and-push
 * a recovery turn needs, and that a throwing gate never aborts the run.
 *
 * Modelled on `pr_feedback_processor_drift_check_3143_test.ts` and
 * `pr_feedback_review_dismissal_3383_test.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type PrFeedbackInput,
  type PrFeedbackProcessorDeps,
  processPrFeedback,
} from "../lib/pr_feedback_processor.ts";
import type {
  ReviewFixVerifierGateInput,
  ReviewFixVerifierGateOutcome,
} from "../lib/review_fix_verifier_gate.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";
import { openPrGh } from "./support/pr_live_state_stub.ts";
import {
  type FableReview,
  reviewBody,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_log.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** A fleet change request with one finding, as `reviewBody` renders it. */
const CHANGE_REQUEST = reviewBody(
  "changes_requested",
  {
    summary: "Please fix the retry.",
    findings: [{
      file: "lib/a.ts",
      line: 12,
      problem: "The retry never resets the counter.",
      fix: "Reset the counter on success.",
    }],
    testChanges: "none",
    testChangeNotes: [],
    unrelatedIssues: [],
    checklist: [],
  } as FableReview,
  [],
);

const RECOVERY_COMMIT_MARKER =
  "Commit after the review-fix verifier's recovery turn (Issue #3784)";

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
    prNumber: 77,
    branchName: "issue-77-feedback",
    commentType: "pr_review",
    commentId: "rv-555",
    commentBody: CHANGE_REQUEST,
    ...overrides,
  };
}

const REMOTE_CONFIRMS_PUSH = () =>
  Promise.resolve({
    landed: true,
    localSha: "f".repeat(40),
    remoteSha: "f".repeat(40),
    reason: "verified in test",
  });

/** A gate stub that records each call and answers with `outcome`, or throws. */
function makeGateStub(
  calls: ReviewFixVerifierGateInput[],
  outcome: ReviewFixVerifierGateOutcome | "throw",
): NonNullable<PrFeedbackProcessorDeps["reviewFixVerifierFn"]> {
  return (input: ReviewFixVerifierGateInput) => {
    calls.push(input);
    if (outcome === "throw") {
      return Promise.reject(new Error("review-fix gate blew up"));
    }
    return Promise.resolve(outcome);
  };
}

interface ScenarioOptions {
  input?: PrFeedbackInput;
  gate: NonNullable<PrFeedbackProcessorDeps["reviewFixVerifierFn"]>;
  /** What the agent's own final-mile commit-and-push reports. */
  commitResult: {
    committedNewChanges: boolean;
    commitsPushed: number;
    finalUnpushedCount: number;
  };
  /** Set when the processor's HEAD should read as moved during the run. */
  headMoved?: boolean;
  /** Index (0-based) of the commit-and-push call that fails, if any. */
  failCommitCall?: number;
}

interface ScenarioResult {
  result: Awaited<ReturnType<typeof processPrFeedback>>;
  commitMessages: string[];
  /** How many times the remote push check was called. */
  verifyCalls: number;
  workDir: string;
}

/**
 * Run `processPrFeedback` once with the gate stubbed. Every commit-and-push
 * call's message is recorded, so a recovery-turn commit is visible.
 */
async function runScenario(options: ScenarioOptions): Promise<ScenarioResult> {
  const workDir = await Deno.makeTempDir({ prefix: "review_fix_3784_" });
  try {
    const commitMessages: string[] = [];
    let verifyCalls = 0;
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: openPrGh(() => Promise.resolve("")),
    };
    const gitOverrides: Partial<GitDeps> = {
      commitAndPushPending: ((
        _branch: string,
        message: string,
      ) => {
        const index = commitMessages.length;
        commitMessages.push(message);
        if (index === options.failCommitCall) {
          return Promise.resolve({
            ok: false,
            error: new Error("commit-and-push failed in test"),
          });
        }
        return Promise.resolve({ ok: true, value: options.commitResult });
      }) as unknown as GitDeps["commitAndPushPending"],
      branchHeadChanged: (() =>
        Promise.resolve({
          ok: true,
          value: options.headMoved ?? false,
        })) as unknown as GitDeps["branchHeadChanged"],
    };

    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: gitOverrides,
    });

    const processorDeps: PrFeedbackProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      workDir,
      workRoot: workDir,
      verifyPushFn: () => {
        verifyCalls++;
        return REMOTE_CONFIRMS_PUSH();
      },
      qualityInstructions: "",
      reviewFixVerifierFn: options.gate,
    };

    const result = await processPrFeedback(
      options.input ?? makeInput(),
      processorDeps,
    );
    return { result, commitMessages, verifyCalls, workDir };
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

/** A push that landed: the agent's own commit-and-push moved the head. */
const PUSHED = {
  committedNewChanges: true,
  commitsPushed: 1,
  finalUnpushedCount: 0,
};

/** Nothing pushed and the head did not move. */
const NOTHING_PUSHED = {
  committedNewChanges: false,
  commitsPushed: 0,
  finalUnpushedCount: 0,
};

const CLEAN_OUTCOME: ReviewFixVerifierGateOutcome = {
  status: "clean",
  recoveryRan: false,
};

// (1) ---------------------------------------------------------------------

Deno.test("review-fix verifier wiring (#3784): a pushed change to a reviewer's change request calls the gate once with the review body", async () => {
  const calls: ReviewFixVerifierGateInput[] = [];
  const { result, workDir } = await runScenario({
    gate: makeGateStub(calls, CLEAN_OUTCOME),
    commitResult: PUSHED,
  });

  assertEquals(result.ok, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.changeRequest, CHANGE_REQUEST);
  assertEquals(calls[0]!.repoPath, workDir);
  assertEquals(calls[0]!.prNumber, 77);
  assertEquals(calls[0]!.repo, "org/repo");
  assertEquals(calls[0]!.branchName, "issue-77-feedback");
});

// (2) ---------------------------------------------------------------------

Deno.test("review-fix verifier wiring (#3784): a recovery turn's outcome commits and pushes once more", async () => {
  const withoutRecovery = await runScenario({
    gate: makeGateStub([], CLEAN_OUTCOME),
    commitResult: PUSHED,
  });
  const withRecovery = await runScenario({
    gate: makeGateStub([], { status: "recovered", recoveryRan: true }),
    commitResult: PUSHED,
  });

  assertEquals(withoutRecovery.result.ok, true);
  assertEquals(withRecovery.result.ok, true);
  assertEquals(
    withRecovery.commitMessages.length,
    withoutRecovery.commitMessages.length + 1,
  );
  const last = withRecovery.commitMessages.at(-1)!;
  assertStringIncludes(last, RECOVERY_COMMIT_MARKER);
  assertStringIncludes(last, "Address PR #77 feedback");
});

// (3) ---------------------------------------------------------------------

Deno.test("review-fix verifier wiring (#3784): a non-reviewer comment type does not call the gate", async () => {
  const calls: ReviewFixVerifierGateInput[] = [];
  const { result } = await runScenario({
    input: makeInput({ commentType: "review", commentBody: CHANGE_REQUEST }),
    gate: makeGateStub(calls, CLEAN_OUTCOME),
    commitResult: PUSHED,
  });

  assertEquals(result.ok, true);
  assertEquals(calls.length, 0);
});

// (4) ---------------------------------------------------------------------

Deno.test("review-fix verifier wiring (#3784): a reviewer change request with nothing pushed does not call the gate", async () => {
  const calls: ReviewFixVerifierGateInput[] = [];
  const { result } = await runScenario({
    gate: makeGateStub(calls, CLEAN_OUTCOME),
    commitResult: NOTHING_PUSHED,
    headMoved: false,
  });

  assertEquals(result.ok, true);
  assertEquals(calls.length, 0);
});

// (5) ---------------------------------------------------------------------

Deno.test("review-fix verifier wiring (#3784): a throwing gate does not abort the run", async () => {
  const calls: ReviewFixVerifierGateInput[] = [];
  const { result, commitMessages } = await runScenario({
    gate: makeGateStub(calls, "throw"),
    commitResult: PUSHED,
  });

  assertEquals(calls.length, 1);
  assertEquals(result.ok, true);
  // The run still reached its final commit-and-push, and no recovery commit
  // was attempted because the gate produced no outcome.
  assertEquals(commitMessages.length, 1);
  assert(!commitMessages[0]!.includes(RECOVERY_COMMIT_MARKER));
});

// (1b) --------------------------------------------------------------------

Deno.test("review-fix verifier wiring (#3784): a reviewer change request whose commits stay unpushed does not call the gate", async () => {
  const calls: ReviewFixVerifierGateInput[] = [];
  const { result, verifyCalls } = await runScenario({
    gate: makeGateStub(calls, CLEAN_OUTCOME),
    // The push is still outstanding after the final-mile commit and its
    // recovery retry, so the head is not complete and nothing is claimed.
    commitResult: {
      committedNewChanges: true,
      commitsPushed: 0,
      finalUnpushedCount: 1,
    },
  });

  assertEquals(result.ok, true);
  assertEquals(calls.length, 0);
  assertEquals(verifyCalls, 0);
});

// (2b) --------------------------------------------------------------------

Deno.test("review-fix verifier wiring (#3784): a recovery commit-and-push that fails does not claim the push", async () => {
  const calls: ReviewFixVerifierGateInput[] = [];
  const { result, commitMessages, verifyCalls } = await runScenario({
    gate: makeGateStub(calls, { status: "recovered", recoveryRan: true }),
    commitResult: PUSHED,
    // Call 0 is the agent's final-mile commit-and-push; call 1 is the
    // recovery turn's commit-and-push, which fails.
    failCommitCall: 1,
  });

  assert(result.ok);
  assertEquals(calls.length, 1);
  assertEquals(commitMessages.length, 2);
  assertStringIncludes(commitMessages[1]!, RECOVERY_COMMIT_MARKER);
  // The count is now unmeasured, so the remote check is never asked and the
  // push is not claimed on the earlier measurement.
  assertEquals(verifyCalls, 0);
  assertEquals(result.value.changesPushed, false);
});
