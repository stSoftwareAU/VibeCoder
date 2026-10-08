/**
 * Review dismissal is retired only on a conclusive outcome (Issue #3383).
 *
 * `claim_pr_comment.ts` no longer dismisses a `pr_review` (CHANGES_REQUESTED
 * review) at claim time — the claim is a lease, renewed from the run's
 * heartbeat. `processPrFeedback` must dismiss the review only once the run
 * RETIRES it (a verified push, a rebuttal, an escalation, or a hand-off),
 * and must CHARGE every other outcome as a failed attempt so the review is
 * retried at most twice rather than looping or wedging forever.
 *
 * Modelled on `pr_feedback_reviewer_no_change_test.ts` and
 * `pr_feedback_processor_milestone_fix_test.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
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
  PrDeps,
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
  calls: string[][];
}

function makeMockGithub(captured: CapturedGh): Partial<GitHubDeps> {
  return {
    runGhCommand: (args: string[]) => {
      captured.calls.push(args);
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

/** Records every settling call, in order, alongside `commitAndPushPending`. */
function makePrSpies(events: string[]): Partial<PrDeps> {
  return {
    markCommentProcessed: ((
      _repo: string,
      commentType: string,
      commentId: string,
    ) => {
      events.push(`markCommentProcessed:${commentType}:${commentId}`);
      return Promise.resolve({ ok: true, value: undefined });
      // deno-lint-ignore no-explicit-any
    }) as any,
    handlePrCommentFailure: ((
      _repo: string,
      _prNumber: number,
      commentType: string,
      commentId: string,
      message: string,
    ) => {
      events.push(
        `handlePrCommentFailure:${commentType}:${commentId}:${message}`,
      );
      return Promise.resolve();
      // deno-lint-ignore no-explicit-any
    }) as any,
  };
}

interface RunOptions {
  input: PrFeedbackInput;
  events: string[];
  /** Per-call claude behaviour; index 0 is the first run, index 1 a retry. */
  runBehaviours?: Array<"ok" | "nothing" | "rebuttal" | "fail" | "timeout">;
  commitAndPushResult?: {
    committedNewChanges: boolean;
    commitsPushed: number;
    finalUnpushedCount: number;
  };
  verifyPushFn?: PrFeedbackProcessorDeps["verifyPushFn"];
  promptsDir?: string;
  githubOverride?: Partial<GitHubDeps>;
  captured?: CapturedGh;
}

async function runScenario(options: RunOptions) {
  const captured = options.captured ?? {
    comments: [],
    labelsAdded: [],
    calls: [],
  };
  const workDir = await Deno.makeTempDir();
  try {
    let callCount = 0;
    const behaviours = options.runBehaviours ?? ["ok"];
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (async (_opts: { prompt: string }) => {
        const behaviour = behaviours[callCount] ?? "nothing";
        callCount++;
        if (behaviour === "rebuttal") {
          await Deno.writeTextFile(
            prResponseMessagePath(workDir),
            `Rebuttal for ${options.input.commentId}: the finding does not ` +
              "apply — ran `deno test` and it passes.",
          );
        }
        if (behaviour === "fail") {
          return { ok: false, error: new Error("boom") };
        }
        if (behaviour === "timeout") {
          return {
            ok: true,
            value: { output: "", exitCode: 1, timedOut: true },
          };
        }
        return {
          ok: true,
          value: { output: "", exitCode: 0, timedOut: false },
        };
      }) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };

    const commitAndPushResult = options.commitAndPushResult ?? {
      committedNewChanges: false,
      commitsPushed: 0,
      finalUnpushedCount: 0,
    };
    const gitOverrides: Partial<GitDeps> = {
      commitAndPushPending: (() => {
        options.events.push("commitAndPushPending");
        return Promise.resolve({ ok: true, value: commitAndPushResult });
      }) as unknown as GitDeps["commitAndPushPending"],
    };

    const deps = createMockDeps({
      claude: mockClaude,
      github: options.githubOverride ?? makeMockGithub(captured),
      git: gitOverrides,
      pr: makePrSpies(options.events),
    });

    const processorDeps: PrFeedbackProcessorDeps = {
      promptsDir: options.promptsDir ?? PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      workDir,
      workRoot: workDir,
      ...(options.verifyPushFn ? { verifyPushFn: options.verifyPushFn } : {}),
    };

    const result = await processPrFeedback(options.input, processorDeps);
    return { captured, result };
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

const REMOTE_CONFIRMS_PUSH = () =>
  Promise.resolve({
    landed: true,
    localSha: "f".repeat(40),
    remoteSha: "f".repeat(40),
    reason: "verified in test",
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("pr_review dismissal: timeout charges a failed attempt, never dismisses", async () => {
  const events: string[] = [];
  const { result } = await runScenario({
    input: makeInput(),
    events,
    runBehaviours: ["timeout"],
  });

  assertEquals(result.ok, false);
  assertEquals(
    events.filter((e) => e.startsWith("markCommentProcessed")).length,
    0,
  );
  const failures = events.filter((e) => e.startsWith("handlePrCommentFailure"));
  assertEquals(failures.length, 1);
  assertStringIncludes(failures[0] ?? "", "pr_review");
});

Deno.test("pr_review dismissal: agent error charges a failed attempt, never dismisses", async () => {
  const events: string[] = [];
  const { result } = await runScenario({
    input: makeInput(),
    events,
    runBehaviours: ["fail"],
  });

  assertEquals(result.ok, false);
  assertEquals(
    events.filter((e) => e.startsWith("markCommentProcessed")).length,
    0,
  );
  const failures = events.filter((e) => e.startsWith("handlePrCommentFailure"));
  assertEquals(failures.length, 1);
  assertStringIncludes(failures[0] ?? "", "pr_review");
});

Deno.test("pr_review dismissal: verified push dismisses once, after commitAndPushPending", async () => {
  const events: string[] = [];
  const { result } = await runScenario({
    input: makeInput(),
    events,
    runBehaviours: ["ok"],
    commitAndPushResult: {
      committedNewChanges: true,
      commitsPushed: 1,
      finalUnpushedCount: 0,
    },
    verifyPushFn: REMOTE_CONFIRMS_PUSH,
  });

  assertEquals(result.ok, true);
  const dismissals = events.filter((e) => e.startsWith("markCommentProcessed"));
  assertEquals(dismissals.length, 1);
  assertEquals(
    events.filter((e) => e.startsWith("handlePrCommentFailure")).length,
    0,
  );

  const pushIdx = events.indexOf("commitAndPushPending");
  const dismissIdx = events.findIndex((e) =>
    e.startsWith("markCommentProcessed")
  );
  assertEquals(pushIdx < dismissIdx, true, "dismissal must follow the push");
});

Deno.test("pr_review dismissal: push not landed charges, does not dismiss", async () => {
  const events: string[] = [];
  const { result } = await runScenario({
    input: makeInput(),
    events,
    runBehaviours: ["ok"],
    commitAndPushResult: {
      committedNewChanges: true,
      commitsPushed: 1,
      finalUnpushedCount: 0,
    },
    verifyPushFn: () =>
      Promise.resolve({
        landed: false,
        localSha: "f".repeat(40),
        remoteSha: "0".repeat(40),
        reason: "remote sha differs",
      }),
  });

  assertEquals(result.ok, true);
  assertEquals(
    events.filter((e) => e.startsWith("markCommentProcessed")).length,
    0,
  );
  const failures = events.filter((e) => e.startsWith("handlePrCommentFailure"));
  assertEquals(failures.length, 1);
  assertStringIncludes(failures[0] ?? "", "remote sha differs");
});

Deno.test("pr_review dismissal: rebuttal with no changes dismisses exactly once", async () => {
  const events: string[] = [];
  const { captured, result } = await runScenario({
    input: makeInput(),
    events,
    runBehaviours: ["rebuttal"],
  });

  assertEquals(result.ok, true);
  assertEquals(
    events.filter((e) => e.startsWith("markCommentProcessed")).length,
    1,
  );
  assertEquals(
    events.filter((e) => e.startsWith("handlePrCommentFailure")).length,
    0,
  );
  assertEquals(
    captured.comments.some((c) => c.includes("Rebuttal for rv-555")),
    true,
  );
});

Deno.test("pr_review dismissal: no fix, no rebuttal after in-run retry — escalates and dismisses once", async () => {
  const events: string[] = [];
  const { captured, result } = await runScenario({
    input: makeInput(),
    events,
    runBehaviours: ["nothing", "nothing"],
  });

  assertEquals(result.ok, true);
  assertEquals(
    events.filter((e) => e.startsWith("markCommentProcessed")).length,
    1,
  );
  assertEquals(
    events.filter((e) => e.startsWith("handlePrCommentFailure")).length,
    0,
  );
  assertEquals(captured.labelsAdded.includes("needs-human"), true);
});

Deno.test("pr_review dismissal: unsettled outcome (prompt build failure) is charged, never dismissed", async () => {
  const emptyPromptsDir = await Deno.makeTempDir();
  try {
    const events: string[] = [];
    const { result } = await runScenario({
      input: makeInput(),
      events,
      promptsDir: emptyPromptsDir,
    });

    // Confirms the failure mode this test exercises actually fired.
    assertEquals(result.ok, false);
    assertEquals(
      events.filter((e) => e.startsWith("markCommentProcessed")).length,
      0,
    );
    const failures = events.filter((e) =>
      e.startsWith("handlePrCommentFailure")
    );
    assertEquals(failures.length, 1);
  } finally {
    await Deno.remove(emptyPromptsDir, { recursive: true });
  }
});

Deno.test("pr_review dismissal: an 'issue' comment is unaffected — markCommentProcessed still runs before the push", async () => {
  const events: string[] = [];
  const { result } = await runScenario({
    input: makeInput({ commentType: "issue", commentId: "123" }),
    events,
    runBehaviours: ["ok"],
    commitAndPushResult: {
      committedNewChanges: true,
      commitsPushed: 1,
      finalUnpushedCount: 0,
    },
    verifyPushFn: REMOTE_CONFIRMS_PUSH,
  });

  assertEquals(result.ok, true);
  const markIdx = events.indexOf("markCommentProcessed:issue:123");
  const pushIdx = events.indexOf("commitAndPushPending");
  assertEquals(markIdx >= 0, true);
  assertEquals(markIdx < pushIdx, true, "issue comments mark before the push");
});

// ---------------------------------------------------------------------------
// Lease renewal wiring (Issue #3383)
// ---------------------------------------------------------------------------

const FLEET_AUTHOR = "vibe-coder-bot";

/**
 * A `gh` stub for the lease-renewal integration test: answers the PR
 * live-state read, reports the claim comment's posted id, and answers the
 * paginated comments read with the claim row the posted claim carried.
 */
function makeLeaseGithub(
  calls: string[][],
): { github: Partial<GitHubDeps>; postedBody: () => string | undefined } {
  let postedClaimBody: string | undefined;
  let sweepRead = false;
  const github: Partial<GitHubDeps> = {
    runGhCommand: (args: string[]) => {
      calls.push(args);
      if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
      if (args[0] === "pr" && args[1] === "comment") {
        const idx = args.indexOf("--body");
        postedClaimBody = idx >= 0 ? (args[idx + 1] as string) : undefined;
        return Promise.resolve(
          "https://github.com/org/repo/pull/77#issuecomment-901",
        );
      }
      if (
        args[0] === "api" &&
        String(args[1] ?? "").includes("issues/77/comments")
      ) {
        if (!sweepRead) {
          sweepRead = true;
          return Promise.resolve("[]");
        }
        const row = {
          id: 901,
          body: postedClaimBody ?? "",
          created_at: new Date().toISOString(),
          author: FLEET_AUTHOR,
        };
        return Promise.resolve(JSON.stringify([row]));
      }
      return Promise.resolve("");
    },
  };
  return { github, postedBody: () => postedClaimBody };
}

Deno.test(
  "pr_review dismissal: the heartbeat renews the claim's lease, and claiming never dismisses",
  async () => {
    const calls: string[][] = [];
    const { github } = makeLeaseGithub(calls);

    const workDir = await Deno.makeTempDir();
    try {
      const mockClaude: Partial<ClaudeDeps> = {
        runClaudeWithRetry: (() =>
          Promise.resolve({
            ok: true,
            value: { output: "", exitCode: 0, timedOut: false },
          })) as unknown as ClaudeDeps["runClaudeWithRetry"],
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

      const deps = createMockDeps({
        claude: mockClaude,
        github,
        git: gitOverrides,
      });

      const processorDeps: PrFeedbackProcessorDeps = {
        promptsDir: PROMPTS_DIR,
        logger: makeSilentLogger(),
        deps,
        workDir,
        workRoot: workDir,
        workerId: "worker-beta",
        claimAuthorOptions: { fleetAuthors: [FLEET_AUTHOR] },
        claimLeaseRenewMs: 0,
      };

      const result = await processPrFeedback(
        makeInput({ commentId: "4321" }),
        processorDeps,
      );
      assertEquals(result.ok, true);

      // The claim comment is renewed (PATCHed), not dismissed.
      const patched = calls.find((c) =>
        c[0] === "api" && c[1] === "-X" && c[2] === "PATCH" &&
        c[3] === "repos/org/repo/issues/comments/901"
      );
      assertEquals(
        patched !== undefined,
        true,
        "expected a lease renewal PATCH",
      );

      const dismissed = calls.some((c) =>
        c.some((a) => typeof a === "string" && a.includes("/dismissals"))
      );
      assertEquals(dismissed, false, "claiming must never dismiss the review");
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "pr_review dismissal: with the default renew interval, the initial heartbeat does not PATCH",
  async () => {
    const calls: string[][] = [];
    const { github } = makeLeaseGithub(calls);

    const workDir = await Deno.makeTempDir();
    try {
      const mockClaude: Partial<ClaudeDeps> = {
        runClaudeWithRetry: (() =>
          Promise.resolve({
            ok: true,
            value: { output: "", exitCode: 0, timedOut: false },
          })) as unknown as ClaudeDeps["runClaudeWithRetry"],
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

      const deps = createMockDeps({
        claude: mockClaude,
        github,
        git: gitOverrides,
      });

      const processorDeps: PrFeedbackProcessorDeps = {
        promptsDir: PROMPTS_DIR,
        logger: makeSilentLogger(),
        deps,
        workDir,
        workRoot: workDir,
        workerId: "worker-beta",
        claimAuthorOptions: { fleetAuthors: [FLEET_AUTHOR] },
        // No claimLeaseRenewMs override — the default renew interval is
        // minutes away, so the single initial heartbeat record must not PATCH.
      };

      const result = await processPrFeedback(
        makeInput({ commentId: "4322" }),
        processorDeps,
      );
      assertEquals(result.ok, true);

      const patched = calls.some((c) =>
        c[0] === "api" && c[1] === "-X" && c[2] === "PATCH" &&
        c[3] === "repos/org/repo/issues/comments/901"
      );
      assertEquals(patched, false, "no renewal expected within the interval");
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);
