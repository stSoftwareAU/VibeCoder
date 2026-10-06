/**
 * Tests for the request-changes-review retry-and-escalate path (Issue #3246).
 *
 * Modelled on `pr_feedback_processor_no_changes_test.ts`: a run that claims
 * `commentType: "pr_review"` and ends with no fix and no rebuttal must not
 * fall through to the neutral "could not identify a code change" reply —
 * it gets one in-run retry, then escalates to `needs-human` if that retry
 * also answers nothing. A rebuttal written to `.pr_response_message` on
 * either run is posted instead. A plain `"review"` comment is unaffected.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type PrFeedbackInput,
  type PrFeedbackProcessorDeps,
  processPrFeedback,
} from "../lib/pr_feedback_processor.ts";
import {
  buildReviewerNoChangeEscalation,
  probeAgentAnswer,
} from "../lib/pr_feedback_reviewer_no_change.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";
import { prResponseMessagePath } from "../lib/pr_branch_preparation.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
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

interface CapturedGh {
  comments: string[];
  labelsAdded: string[];
}

function makeMockGithub(captured: CapturedGh): Partial<GitHubDeps> {
  return {
    runGhCommand: (args: string[]) => {
      if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
      if (args[0] === "pr" && args[1] === "comment") {
        const idx = args.indexOf("--body");
        if (idx >= 0 && args[idx + 1] !== undefined) {
          captured.comments.push(args[idx + 1] as string);
        }
      }
      if (args[0] === "api" && args.includes("-X")) {
        const xIdx = args.indexOf("-X");
        if (args[xIdx + 1] === "POST") {
          const endpoint = String(args[xIdx + 2] ?? "");
          if (endpoint.includes("/labels")) {
            const fIdx = args.indexOf("-f");
            if (fIdx >= 0) {
              const f = args[fIdx + 1] ?? "";
              if (f.startsWith("labels[]=")) {
                captured.labelsAdded.push(f.slice("labels[]=".length));
              }
            }
          }
          if (endpoint.includes("/comments")) {
            for (let i = 0; i < args.length - 1; i++) {
              if (args[i] === "-f") {
                const f = args[i + 1] ?? "";
                if (f.startsWith("body=")) {
                  captured.comments.push(f.slice("body=".length));
                }
              }
            }
          }
        }
      }
      if (args[0] === "issue" && args[1] === "edit") {
        const idx = args.indexOf("--add-label");
        if (idx >= 0 && args[idx + 1] !== undefined) {
          captured.labelsAdded.push(args[idx + 1] as string);
        }
      }
      if (args[0] === "label" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      return Promise.resolve("");
    },
  };
}

/**
 * A `gh` mock that answers the PR live-state read and the label-list probe
 * normally, but throws for every write the escalation itself attempts: both
 * the REST and CLI forms of `addLabel` (`POST .../issues/N/labels` and
 * `issue edit --add-label`), and both forms of `postComment`
 * (`POST .../issues/N/comments` and `issue comment --body`) — see
 * `gh_escalation_client.ts`. Nothing the escalation writes can land, so
 * `escalateToHuman` must return `ok: false` (Issue #3246).
 */
function makeAllWritesThrowGithub(captured: CapturedGh): Partial<GitHubDeps> {
  return {
    runGhCommand: (args: string[]) => {
      if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
      if (args[0] === "label" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      if (args[0] === "api" && args.includes("-X")) {
        const xIdx = args.indexOf("-X");
        if (args[xIdx + 1] === "POST") {
          const endpoint = String(args[xIdx + 2] ?? "");
          if (endpoint.includes("/issues/") && endpoint.includes("/labels")) {
            throw new Error("mock: label-add REST call failed");
          }
          if (endpoint.includes("/comments")) {
            throw new Error("mock: comment-post REST call failed");
          }
        }
        // Any other `-X` write (e.g. the repo-level label-create call made
        // by `ensureLabelExists`) is left to succeed, so the escalation's
        // failure is caused only by the writes it makes directly.
      }
      if (args[0] === "issue" && args[1] === "edit") {
        throw new Error("mock: add-label CLI fallback failed");
      }
      if (args[0] === "issue" && args[1] === "comment") {
        throw new Error("mock: comment CLI fallback failed");
      }
      // Reads that are not writes (e.g. the dedup comment-page GET) answer
      // with nothing found and keep the escalation moving.
      if (args[0] === "pr" && args[1] === "comment") {
        const idx = args.indexOf("--body");
        if (idx >= 0 && args[idx + 1] !== undefined) {
          captured.comments.push(args[idx + 1] as string);
        }
      }
      return Promise.resolve("");
    },
  };
}

function makeInput(overrides?: Partial<PrFeedbackInput>): PrFeedbackInput {
  return {
    repo: "org/repo",
    prNumber: 77,
    branchName: "issue-77-feedback",
    commentType: "pr_review",
    commentId: "rv-555",
    commentBody: "Please address the review findings.",
    ...overrides,
  };
}

interface Scenario {
  input: PrFeedbackInput;
  /** Per-call behaviour: index 0 is the first run, index 1 the retry. */
  runBehaviours: Array<"nothing" | "rebuttal" | "fail">;
  branchHeadChangedOverride?: GitDeps["branchHeadChanged"];
  runGitCommandOverride?: GitDeps["runGitCommand"];
  githubOverride?: Partial<GitHubDeps>;
}

interface CapturedLogError {
  message: string;
  // deno-lint-ignore no-explicit-any
  context?: Record<string, any>;
}

interface ScenarioResult {
  captured: CapturedGh;
  prompts: string[];
  callCount: number;
  result: Awaited<ReturnType<typeof processPrFeedback>>;
  loggerErrors: CapturedLogError[];
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const captured: CapturedGh = { comments: [], labelsAdded: [] };
  const prompts: string[] = [];
  const loggerErrors: CapturedLogError[] = [];
  let callCount = 0;

  const workDir = await Deno.makeTempDir();
  try {
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (async (opts: { prompt: string }) => {
        prompts.push(opts.prompt);
        const behaviour = scenario.runBehaviours[callCount] ?? "nothing";
        callCount++;
        if (behaviour === "rebuttal") {
          await Deno.writeTextFile(
            prResponseMessagePath(workDir),
            `Rebuttal for ${scenario.input.commentId}: the finding does not apply — ` +
              "ran `deno test` and it passes.",
          );
        }
        if (behaviour === "fail") {
          return { ok: false, error: new Error("boom") };
        }
        return {
          ok: true,
          value: { output: "", exitCode: 0, timedOut: false },
        };
      }) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };

    const gitOverrides: Partial<GitDeps> = {
      commitAndPushPending: (() =>
        Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: false,
            commitsPushed: 0,
            finalUnpushedCount: 0,
          },
        })) as unknown as GitDeps["commitAndPushPending"],
    };
    if (scenario.branchHeadChangedOverride) {
      gitOverrides.branchHeadChanged = scenario.branchHeadChangedOverride;
    }
    if (scenario.runGitCommandOverride) {
      gitOverrides.runGitCommand = scenario.runGitCommandOverride;
    }

    const deps = createMockDeps({
      claude: mockClaude,
      github: scenario.githubOverride ?? makeMockGithub(captured),
      git: gitOverrides,
    });

    const logger: Logger = {
      ...makeSilentLogger(),
      error: (message: string, context?: Record<string, unknown>) => {
        loggerErrors.push({ message, context });
      },
    };

    const processorDeps: PrFeedbackProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger,
      deps,
      workDir,
      workRoot: workDir,
    };

    const result = await processPrFeedback(scenario.input, processorDeps);
    return { captured, prompts, callCount, result, loggerErrors };
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("reviewer no-change: both runs answer nothing — retries once, escalates", async () => {
  const { captured, prompts, callCount, result } = await runScenario({
    input: makeInput(),
    runBehaviours: ["nothing", "nothing"],
  });

  assertEquals(callCount, 2);
  assertStringIncludes(
    prompts[1] ?? "",
    "Your previous attempt left this review unanswered",
  );
  assertEquals(
    (prompts[0] ?? "").includes(
      "Your previous attempt left this review unanswered",
    ),
    false,
  );

  for (const comment of captured.comments) {
    assertEquals(comment.includes("could not identify a code change"), false);
  }
  assertEquals(captured.labelsAdded.includes("needs-human"), true);

  const escalationComment = captured.comments.find((c) => c.includes("rv-555"));
  assertEquals(escalationComment !== undefined, true);
  const hasNoFixOrRebuttal = escalationComment !== undefined &&
    (escalationComment.toLowerCase().includes("no fix") ||
      escalationComment.toLowerCase().includes("rebuttal"));
  assertEquals(hasNoFixOrRebuttal, true);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.summary, "needs-human");
  }
});

Deno.test("reviewer no-change: first run nothing, retry writes rebuttal — posts rebuttal", async () => {
  const { captured, callCount, result } = await runScenario({
    input: makeInput(),
    runBehaviours: ["nothing", "rebuttal"],
  });

  assertEquals(callCount, 2);
  const rebuttalPosted = captured.comments.some((c) =>
    c.includes("Rebuttal for rv-555")
  );
  assertEquals(rebuttalPosted, true);
  for (const comment of captured.comments) {
    assertEquals(comment.includes("could not identify a code change"), false);
  }
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
  assertEquals(result.ok, true);
});

Deno.test("reviewer no-change: first run writes rebuttal — no retry, posts rebuttal", async () => {
  const { captured, callCount, result } = await runScenario({
    input: makeInput(),
    runBehaviours: ["rebuttal"],
  });

  assertEquals(callCount, 1);
  const rebuttalPosted = captured.comments.some((c) =>
    c.includes("Rebuttal for rv-555")
  );
  assertEquals(rebuttalPosted, true);
  for (const comment of captured.comments) {
    assertEquals(comment.includes("could not identify a code change"), false);
  }
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
  assertEquals(result.ok, true);
});

Deno.test("reviewer no-change: head-moved probe unreadable — no retry, still escalates", async () => {
  const { captured, callCount, result } = await runScenario({
    input: makeInput(),
    runBehaviours: ["nothing"],
    branchHeadChangedOverride: (() =>
      Promise.resolve({
        ok: false,
        error: new Error("x"),
      })) as unknown as GitDeps["branchHeadChanged"],
  });

  assertEquals(callCount, 1);
  for (const comment of captured.comments) {
    assertEquals(comment.includes("could not identify a code change"), false);
  }
  assertEquals(captured.labelsAdded.includes("needs-human"), true);
  assertEquals(result.ok, true);
});

Deno.test("reviewer no-change: retry call itself fails — still escalates, exit code -1, failure logged", async () => {
  const { captured, callCount, result, loggerErrors } = await runScenario({
    input: makeInput(),
    runBehaviours: ["nothing", "fail"],
  });

  assertEquals(callCount, 2);
  for (const comment of captured.comments) {
    assertEquals(comment.includes("could not identify a code change"), false);
  }
  assertEquals(captured.labelsAdded.includes("needs-human"), true);
  const escalationComment = captured.comments.find((c) => c.includes("rv-555"));
  assertEquals(escalationComment !== undefined, true);
  assertStringIncludes(escalationComment ?? "", "exit code -1");
  assertEquals(result.ok, true);

  // The failed-retry block's only observable effect beyond `lastAttempt` is
  // this error log line (Issue #3246) — assert it fired with the failure.
  const retryFailureLog = loggerErrors.find((e) =>
    e.message.includes("re-run on the request-changes review failed")
  );
  assertEquals(retryFailureLog !== undefined, true);
  assertEquals(retryFailureLog?.context?.error, "boom");
});

Deno.test("reviewer no-change: escalation that cannot post anything is logged loudly", async () => {
  const captured: CapturedGh = { comments: [], labelsAdded: [] };
  const { result, loggerErrors } = await runScenario({
    input: makeInput(),
    runBehaviours: ["nothing", "nothing"],
    githubOverride: makeAllWritesThrowGithub(captured),
  });

  for (const comment of captured.comments) {
    assertEquals(comment.includes("could not identify a code change"), false);
  }

  assertEquals(result.ok, true);

  const escalationFailureLog = loggerErrors.find((e) =>
    e.message.includes(
      "escalating the unanswered request-changes review failed",
    )
  );
  assertEquals(escalationFailureLog !== undefined, true);
});

Deno.test("reviewer no-change: dirty working tree answers — no retry", async () => {
  const { callCount } = await runScenario({
    input: makeInput(),
    runBehaviours: ["nothing"],
    runGitCommandOverride: ((args: string[]) => {
      if (args[0] === "status" && args[1] === "--porcelain") {
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: " M src/foo.ts", stderr: "" },
        });
      }
      return Promise.resolve({
        ok: true,
        value: { code: 0, stdout: "", stderr: "" },
      });
    }) as unknown as GitDeps["runGitCommand"],
  });

  assertEquals(callCount, 1);
});

Deno.test("reviewer no-change: plain review comment is unaffected — neutral reply, no retry", async () => {
  const { captured, callCount, result } = await runScenario({
    input: makeInput({ commentType: "review", commentId: "999" }),
    runBehaviours: ["nothing"],
  });

  assertEquals(callCount, 1);
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "could not identify a code change");
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
  assertEquals(result.ok, true);
});

// ---------------------------------------------------------------------------
// Unit tests: probeAgentAnswer
// ---------------------------------------------------------------------------

Deno.test("probeAgentAnswer: non-empty message answers", async () => {
  const outcome = await probeAgentAnswer({
    readResponseMessage: () => Promise.resolve("I fixed it."),
    headMoved: () => Promise.resolve(false),
    workingTreeStatus: () => Promise.resolve(""),
  });
  assertEquals(outcome, "answered");
});

Deno.test("probeAgentAnswer: whitespace-only message with moved head answers", async () => {
  const outcome = await probeAgentAnswer({
    readResponseMessage: () => Promise.resolve("   \n  "),
    headMoved: () => Promise.resolve(true),
    workingTreeStatus: () => Promise.resolve(undefined),
  });
  assertEquals(outcome, "answered");
});

Deno.test("probeAgentAnswer: dirty working tree answers", async () => {
  const outcome = await probeAgentAnswer({
    readResponseMessage: () => Promise.resolve(undefined),
    headMoved: () => Promise.resolve(false),
    workingTreeStatus: () => Promise.resolve(" M some/file.ts\n"),
  });
  assertEquals(outcome, "answered");
});

Deno.test("probeAgentAnswer: everything clean and readable is nothing", async () => {
  const outcome = await probeAgentAnswer({
    readResponseMessage: () => Promise.resolve(undefined),
    headMoved: () => Promise.resolve(false),
    workingTreeStatus: () => Promise.resolve(""),
  });
  assertEquals(outcome, "nothing");
});

Deno.test("probeAgentAnswer: head-moved unreadable is unknown", async () => {
  const outcome = await probeAgentAnswer({
    readResponseMessage: () => Promise.resolve(undefined),
    headMoved: () => Promise.resolve(undefined),
    workingTreeStatus: () => Promise.resolve(""),
  });
  assertEquals(outcome, "unknown");
});

Deno.test("probeAgentAnswer: working-tree status unreadable is unknown", async () => {
  const outcome = await probeAgentAnswer({
    readResponseMessage: () => Promise.resolve(undefined),
    headMoved: () => Promise.resolve(false),
    workingTreeStatus: () => Promise.resolve(undefined),
  });
  assertEquals(outcome, "unknown");
});

// ---------------------------------------------------------------------------
// Unit test: buildReviewerNoChangeEscalation
// ---------------------------------------------------------------------------

Deno.test("buildReviewerNoChangeEscalation names the review id and attempts", () => {
  const escalation = buildReviewerNoChangeEscalation({
    reviewId: "rv-123",
    attempts: 2,
    lastExitCode: 0,
    lastDurationSeconds: 42,
  });
  assertStringIncludes(escalation.reason, "rv-123");
  assertStringIncludes(escalation.reason, "2");
  assertStringIncludes(escalation.reason.toLowerCase(), "no fix");
  assertStringIncludes(escalation.reason.toLowerCase(), "rebuttal");
});
