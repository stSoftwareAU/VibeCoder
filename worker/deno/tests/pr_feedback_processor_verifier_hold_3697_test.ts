/**
 * Tests for releasing a pre-PR verifier hold after a verified fix (Issue
 * #3697). A held PR carries the `standing-violation` label; when the
 * PR-feedback pass pushes a verified fix to the PR's own head, it removes the
 * label so the Priority 1.65 auto-merge sweep can arm the PR again.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type PrFeedbackInput,
  type PrFeedbackProcessorDeps,
  processPrFeedback,
} from "../lib/pr_feedback_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { LogContext, Logger } from "../types.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

const PR_NUMBER = 2524;
const HEAD_BRANCH = "issue-2524-feedback";
const MILESTONE_HEAD = "milestone/2794-worker-deno-milestone-fix-pr";
const RELEASE_CALL = [
  "api",
  "-X",
  "DELETE",
  `repos/org/repo/issues/${PR_NUMBER}/labels/standing-violation`,
];

interface CapturedGh {
  calls: string[][];
  comments: string[];
}

interface CapturedLog {
  info: string[];
  errors: string[];
  /** The context object passed with each error, in call order. */
  errorContexts: (LogContext | undefined)[];
}

function makeCapturingLogger(captured: CapturedLog): Logger {
  const noop = () => {};
  return {
    info: (message: string) => {
      captured.info.push(message);
    },
    warn: noop,
    error: (message: string, context?: LogContext) => {
      captured.errors.push(message);
      captured.errorContexts.push(context);
    },
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

function makeMockGithub(
  captured: CapturedGh,
  options: {
    /** The PR's head is a ruleset-gated milestone branch. */
    gated: boolean;
    /** The label-removal call itself fails. */
    failLabelRemoval?: boolean;
  },
): Partial<GitHubDeps> {
  return {
    runGhCommand: (args: string[]) => {
      captured.calls.push(args);
      if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
      if (args[0] === "api" && args.includes("DELETE")) {
        if (options.failLabelRemoval) {
          return Promise.reject(new Error("HTTP 500: label removal failed"));
        }
        return Promise.resolve("");
      }
      const joined = args.join(" ");
      if (joined.includes("rules/branches")) {
        return Promise.resolve(
          JSON.stringify(
            options.gated ? [{ type: "pull_request", ruleset_id: 1 }] : [],
          ),
        );
      }
      if (joined.includes("requested_reviewers")) {
        return Promise.resolve(JSON.stringify({ users: [], teams: [] }));
      }
      if (args[0] === "api" && args[1] === "user") {
        return Promise.resolve("fleet-bot\n");
      }
      if (joined.includes("reactions") && args.includes("--paginate")) {
        return Promise.resolve(
          JSON.stringify([{ id: 42, login: "fleet-bot" }]),
        );
      }
      if (args[0] === "pr" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      if (args[0] === "pr" && args[1] === "create") {
        return Promise.resolve("https://github.com/org/repo/pull/9001");
      }
      if (args[0] === "pr" && args[1] === "merge") {
        return Promise.resolve("");
      }
      if (args[0] === "pr" && args[1] === "comment") {
        const idx = args.indexOf("--body");
        if (idx >= 0 && args[idx + 1] !== undefined) {
          captured.comments.push(args[idx + 1] as string);
        }
        return Promise.resolve("");
      }
      if (args[0] === "label" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      return Promise.resolve("");
    },
  };
}

function makeSuccessfulPushGit(gitCalls: string[][]): Partial<GitDeps> {
  return {
    runGitCommand: ((args: string[], _opts?: unknown) => {
      gitCalls.push(args);
      return Promise.resolve({
        ok: true,
        value: { code: 0, stdout: "", stderr: "" },
      });
    }) as unknown as GitDeps["runGitCommand"],
    commitAndPushPending: (() =>
      Promise.resolve({
        ok: true,
        value: {
          committedNewChanges: true,
          commitsPushed: 1,
          finalUnpushedCount: 0,
        },
      })) as unknown as GitDeps["commitAndPushPending"],
    captureBranchHead: (() =>
      Promise.resolve({
        ok: true,
        value: "a".repeat(40),
      })) as unknown as GitDeps["captureBranchHead"],
    branchHeadChanged:
      (() => Promise.resolve({ ok: true, value: true })) as unknown as GitDeps[
        "branchHeadChanged"
      ],
  };
}

function makeClaudeOk(): Partial<ClaudeDeps> {
  return {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
}

const REMOTE_CONFIRMS_PUSH = () =>
  Promise.resolve({
    landed: true,
    localSha: "f".repeat(40),
    remoteSha: "f".repeat(40),
    reason: "verified in test",
  });

const REMOTE_DISAGREES_PUSH = () =>
  Promise.resolve({
    landed: false,
    localSha: "f".repeat(40),
    remoteSha: "0".repeat(40),
    reason: "remote does not show the fix in test",
  });

function makeInput(overrides?: Partial<PrFeedbackInput>): PrFeedbackInput {
  return {
    repo: "org/repo",
    prNumber: PR_NUMBER,
    branchName: HEAD_BRANCH,
    commentType: "issue",
    commentId: "4242",
    commentBody: "Please resolve the verifier finding",
    ...overrides,
  };
}

/** Runs the processor once and returns what the test needs to inspect. */
async function runOnce(options: {
  input?: Partial<PrFeedbackInput>;
  gated?: boolean;
  verifyPushFn?: () => Promise<{
    landed: boolean;
    localSha: string;
    remoteSha: string;
    reason: string;
  }>;
  failLabelRemoval?: boolean;
}) {
  const captured: CapturedGh = { calls: [], comments: [] };
  const capturedLog: CapturedLog = { info: [], errors: [], errorContexts: [] };
  const gitCalls: string[][] = [];

  const deps = createMockDeps({
    claude: makeClaudeOk(),
    github: makeMockGithub(captured, {
      gated: options.gated ?? false,
      failLabelRemoval: options.failLabelRemoval,
    }),
    git: makeSuccessfulPushGit(gitCalls),
  });

  const processorDeps: PrFeedbackProcessorDeps = {
    promptsDir: PROMPTS_DIR,
    logger: makeCapturingLogger(capturedLog),
    deps,
    workDir: "/tmp/test-verifier-hold-3697",
    workRoot: "/tmp/test-verifier-hold-3697",
    verifyPushFn: options.verifyPushFn ?? REMOTE_CONFIRMS_PUSH,
  };

  const result = await processPrFeedback(
    makeInput(options.input),
    processorDeps,
  );
  return { result, captured, capturedLog, gitCalls };
}

function isReleaseCall(args: string[]): boolean {
  return JSON.stringify(args) === JSON.stringify(RELEASE_CALL);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("processPrFeedback - a verified fix on the PR's own head releases the verifier hold (Issue #3697)", async () => {
  const { result, captured, capturedLog } = await runOnce({
    input: { releasesVerifierHold: true },
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(result.value.changesPushed, true);
  assertEquals(result.value.processed, true);
  assertEquals(
    captured.calls.filter(isReleaseCall).length,
    1,
    "the standing-violation label must be removed exactly once",
  );
  assertEquals(capturedLog.errors.length, 0);
  assertStringIncludes(
    capturedLog.info.join("\n"),
    "released the pre-PR verifier hold",
  );
});

Deno.test("processPrFeedback - without releasesVerifierHold the label is left alone (Issue #3697)", async () => {
  const absent = await runOnce({});
  assertEquals(absent.result.ok, true);
  assertEquals(absent.captured.calls.filter(isReleaseCall).length, 0);

  const explicitFalse = await runOnce({
    input: { releasesVerifierHold: false },
  });
  assertEquals(explicitFalse.result.ok, true);
  assertEquals(explicitFalse.captured.calls.filter(isReleaseCall).length, 0);
});

Deno.test("processPrFeedback - a push that did not land does not release the verifier hold (Issue #3697)", async () => {
  const { result, captured } = await runOnce({
    input: { releasesVerifierHold: true },
    verifyPushFn: REMOTE_DISAGREES_PUSH,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(result.value.changesPushed, false);
  assertEquals(captured.calls.filter(isReleaseCall).length, 0);
});

Deno.test("processPrFeedback - a fix delivered through a fix branch does not release the verifier hold (Issue #3697)", async () => {
  const { result, captured, gitCalls } = await runOnce({
    input: { branchName: MILESTONE_HEAD, releasesVerifierHold: true },
    gated: true,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;

  // The fix went through a fix branch into the gated head, not to this PR.
  const checkout = gitCalls.find((c) => c[0] === "checkout" && c[1] === "-B");
  if (!checkout) throw new Error("expected a checkout -B onto a fix branch");
  assertStringIncludes(checkout[2] as string, "milestone-fix/");
  assertEquals(
    captured.calls.some((c) => c[0] === "pr" && c[1] === "create"),
    true,
    "the fix PR into the gated head was raised",
  );

  assertEquals(captured.calls.filter(isReleaseCall).length, 0);
});

Deno.test("processPrFeedback - a failed label removal is logged as an error and the result is still processed (Issue #3697)", async () => {
  const { result, captured, capturedLog } = await runOnce({
    input: { releasesVerifierHold: true },
    failLabelRemoval: true,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(result.value.processed, true);
  assertEquals(result.value.changesPushed, true);
  assertEquals(captured.calls.filter(isReleaseCall).length, 1);
  assertStringIncludes(
    capturedLog.errors.join("\n"),
    "could not remove the standing-violation label",
  );
  // The error names the PR and carries the thrown Error's message (not its
  // `Error: …` string form), so an operator can find and retry the removal.
  assertEquals(capturedLog.errorContexts, [{
    repo: "org/repo",
    prNumber: PR_NUMBER,
    error: "HTTP 500: label removal failed",
  }]);
});
