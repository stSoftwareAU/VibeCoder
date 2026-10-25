/**
 * Tests for the request-changes-review retry-and-restart path (Issues #3246,
 * #4304).
 *
 * Modelled on `pr_feedback_processor_no_changes_test.ts`: a run that claims
 * `commentType: "pr_review"` and ends with no fix and no rebuttal must not
 * fall through to the neutral "could not identify a code change" reply —
 * it gets one in-run retry. If that retry also answers nothing, the review
 * is never handed to a human (Issue #4304): the first such cycle charges a
 * failed attempt so the next cycle retries it, and a cycle that finds the
 * review already failed once abandons the PR and redoes its issue. A
 * rebuttal written to `.pr_response_message` on either run is posted
 * instead. A plain `"review"` comment is unaffected.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type PrFeedbackInput,
  type PrFeedbackProcessorDeps,
  processPrFeedback,
} from "../lib/pr_feedback_processor.ts";
import {
  describeUnansweredReview,
  probeAgentAnswer,
} from "../lib/pr_feedback_reviewer_no_change.ts";
import { createMockDeps, type PrDeps } from "../lib/issue_worker_wiring.ts";
import type { AbandonRestartRequest } from "../lib/conflict_abandon_restart.ts";
import { prReviewFailedOnceMarker } from "../lib/pr_comments.ts";
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

/** The fleet login the failed-once marker is attributed to in these tests. */
const FLEET_LOGIN = "vibe-bot";

/**
 * The paginated marker read `checkPrCommentHasFailedOnce` makes for a
 * `pr_review` (Issue #4304): one fleet-authored failed-once marker for
 * `reviewId` when `failedOnce`, nothing otherwise.
 */
function failedOncePayload(reviewId: string, failedOnce: boolean): string {
  return failedOnce
    ? JSON.stringify([{
      id: 1,
      body: `${prReviewFailedOnceMarker(reviewId)}\nFirst attempt failed.`,
      created_at: "2026-10-25T00:00:00Z",
      author: FLEET_LOGIN,
    }])
    : "[]";
}

function isMarkerRead(args: string[]): boolean {
  return args[0] === "api" && String(args[1] ?? "").includes("/comments?") &&
    args.includes("--jq");
}

function makeMockGithub(
  captured: CapturedGh,
  failedOnce = false,
): Partial<GitHubDeps> {
  return {
    runGhCommand: (args: string[]) => {
      if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
      if (isMarkerRead(args)) {
        return Promise.resolve(failedOncePayload("rv-555", failedOnce));
      }
      if (
        args[0] === "pr" && args[1] === "view" && args.includes("baseRefName")
      ) {
        return Promise.resolve("main\n");
      }
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
  /** Whether the review already carries a fleet failed-once marker. */
  failedOnce?: boolean;
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
  /** Messages each `handlePrCommentFailure` charge was made with. */
  failures: string[];
  /** Outcomes each `markCommentProcessed` dismissal was made with. */
  dismissals: string[];
  /** Every abandon-and-restart the run asked for (Issue #4304). */
  abandonRequests: AbandonRestartRequest[];
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const captured: CapturedGh = { comments: [], labelsAdded: [] };
  const prompts: string[] = [];
  const loggerErrors: CapturedLogError[] = [];
  const failures: string[] = [];
  const dismissals: string[] = [];
  const abandonRequests: AbandonRestartRequest[] = [];
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

    const prSpies: Partial<PrDeps> = {
      handlePrCommentFailure: ((
        _repo: string,
        _prNumber: number,
        _commentType: string,
        _commentId: string,
        message: string,
      ) => {
        failures.push(message);
        return Promise.resolve();
      }) as unknown as PrDeps["handlePrCommentFailure"],
      markCommentProcessed: ((
        _repo: string,
        _commentType: string,
        _commentId: string,
        _prNumber: number | undefined,
        outcome: string,
      ) => {
        dismissals.push(outcome);
        return Promise.resolve({ ok: true, value: undefined });
      }) as unknown as PrDeps["markCommentProcessed"],
    };

    const deps = createMockDeps({
      claude: mockClaude,
      github: scenario.githubOverride ??
        makeMockGithub(captured, scenario.failedOnce ?? false),
      git: gitOverrides,
      pr: prSpies,
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
      claimAuthorOptions: { fleetAuthors: [FLEET_LOGIN] },
      abandonRestartFn: (request: AbandonRestartRequest) => {
        abandonRequests.push(request);
        return Promise.resolve({
          outcome: "abandoned",
          issueNumber: 77,
          label: { kept: "work-on" },
        });
      },
    };

    const result = await processPrFeedback(scenario.input, processorDeps);
    return {
      captured,
      prompts,
      callCount,
      result,
      loggerErrors,
      failures,
      dismissals,
      abandonRequests,
    };
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("reviewer no-change: both runs answer nothing — retries once, then charges a failed attempt so the next cycle retries, never needs-human (Issue #4304)", async () => {
  const {
    captured,
    prompts,
    callCount,
    result,
    failures,
    dismissals,
    abandonRequests,
  } = await runScenario({
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
    assertEquals(comment.includes("needs-human"), false);
  }
  assertEquals(captured.labelsAdded.includes("needs-human"), false);

  // Charged, not retired: the review stays outstanding for the next cycle.
  assertEquals(failures.length, 1);
  assertStringIncludes(failures[0] ?? "", "rv-555");
  assertStringIncludes((failures[0] ?? "").toLowerCase(), "no fix");
  assertEquals(dismissals, []);
  assertEquals(abandonRequests, []);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.summary.includes("needs-human"), false);
  }
});

Deno.test("reviewer no-change: a review that already failed once and is still unanswered abandons the PR and redoes its issue (Issue #4304)", async () => {
  const { captured, callCount, result, failures, dismissals, abandonRequests } =
    await runScenario({
      input: makeInput(),
      runBehaviours: ["nothing", "nothing"],
      failedOnce: true,
    });

  assertEquals(callCount, 2);
  assertEquals(abandonRequests.length, 1);
  const request = abandonRequests[0];
  assertEquals(request?.repo, "org/repo");
  assertEquals(request?.prNumber, 77);
  assertEquals(request?.branchName, "issue-77-feedback");
  assertEquals(request?.baseBranch, "main");
  assertEquals(request?.reason?.kind, "stalled");
  if (request?.reason?.kind === "stalled") {
    assertEquals(request.reason.tried, "review-retry");
    assertStringIncludes(request.reason.detail, "rv-555");
  }

  // Neither charged (a second charge would retire it as permanently failed)
  // nor handed to a human.
  assertEquals(failures, []);
  assertEquals(dismissals, []);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
  for (const comment of captured.comments) {
    assertEquals(comment.includes("needs-human"), false);
  }
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.summary, "abandoned");
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

Deno.test("reviewer no-change: head-moved probe unreadable — no retry, still charged for the next cycle", async () => {
  const { captured, callCount, result, failures } = await runScenario({
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
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
  assertEquals(failures.length, 1);
  assertEquals(result.ok, true);
});

Deno.test("reviewer no-change: retry call itself fails — still charged, exit code -1, failure logged", async () => {
  const { captured, callCount, result, loggerErrors, failures } =
    await runScenario({
      input: makeInput(),
      runBehaviours: ["nothing", "fail"],
    });

  assertEquals(callCount, 2);
  for (const comment of captured.comments) {
    assertEquals(comment.includes("could not identify a code change"), false);
  }
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
  assertEquals(failures.length, 1);
  assertStringIncludes(failures[0] ?? "", "exit code -1");
  assertEquals(result.ok, true);

  // The failed-retry block's only observable effect beyond `lastAttempt` is
  // this error log line (Issue #3246) — assert it fired with the failure.
  const retryFailureLog = loggerErrors.find((e) =>
    e.message.includes("re-run on the request-changes review failed")
  );
  assertEquals(retryFailureLog !== undefined, true);
  assertEquals(retryFailureLog?.context?.error, "boom");
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
// Unit test: describeUnansweredReview
// ---------------------------------------------------------------------------

Deno.test("describeUnansweredReview names the review id, attempts and last run", () => {
  const text = describeUnansweredReview({
    reviewId: "rv-123",
    attempts: 2,
    lastExitCode: 0,
    lastDurationSeconds: 42,
  });
  assertStringIncludes(text, "rv-123");
  assertStringIncludes(text, "2 feedback run(s)");
  assertStringIncludes(text, "exit code 0");
  assertStringIncludes(text.toLowerCase(), "no fix");
  assertStringIncludes(text.toLowerCase(), "rebuttal");
  // Issue #4304: it is a record, never a request for a human.
  assertEquals(text.includes("needs-human"), false);
});
