/**
 * Regression test for Issue #2907.
 *
 * When a milestone PR's head is itself a ruleset-gated `milestone/**`
 * branch, the fleet account cannot push a feedback fix straight to it
 * (GH013). The processor must instead do the work on a side branch and
 * deliver it through a fix PR into the gated head, rather than losing the
 * fix silently.
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
import type { Logger } from "../types.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

const MILESTONE_HEAD = "milestone/2794-worker-deno-milestone-fix-pr";

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
  calls: string[][];
}

function makeMockGithub(
  captured: CapturedGh,
  options: { gated: boolean; failFixPrCreate?: boolean },
): Partial<GitHubDeps> {
  return {
    runGhCommand: (args: string[]) => {
      captured.calls.push(args);
      if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
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
      if (args[0] === "pr" && args[1] === "list") {
        // No pre-existing fix PR — always create a fresh one.
        return Promise.resolve("[]");
      }
      if (args[0] === "pr" && args[1] === "create") {
        if (options.failFixPrCreate) {
          return Promise.reject(
            new Error("HTTP 422: reference already exists"),
          );
        }
        return Promise.resolve(
          "https://github.com/org/repo/pull/9001",
        );
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

function makeInput(overrides?: Partial<PrFeedbackInput>): PrFeedbackInput {
  return {
    repo: "org/repo",
    prNumber: 2866,
    branchName: MILESTONE_HEAD,
    commentType: "review",
    commentId: "555",
    commentBody: "Please resolve the review comments",
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

function makeSuccessfulPushGit(
  gitCalls: string[][],
): Partial<GitDeps> {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("processPrFeedback - gated head: works on a fix branch and raises a fix PR", async () => {
  const captured: CapturedGh = { comments: [], calls: [] };
  const gitCalls: string[][] = [];

  const deps = createMockDeps({
    claude: makeClaudeOk(),
    github: makeMockGithub(captured, { gated: true }),
    git: makeSuccessfulPushGit(gitCalls),
  });

  const processorDeps: PrFeedbackProcessorDeps = {
    promptsDir: PROMPTS_DIR,
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-milestone-fix-gated",
    workRoot: "/tmp/test-milestone-fix-gated",
    verifyPushFn: REMOTE_CONFIRMS_PUSH,
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  // A checkout -B onto a milestone-fix branch happened before Claude ran.
  const checkout = gitCalls.find((c) => c[0] === "checkout" && c[1] === "-B");
  if (!checkout) throw new Error("expected a checkout -B call");
  const fixBranch = checkout[2] as string;
  assertStringIncludes(fixBranch, "milestone-fix/");
  assertStringIncludes(fixBranch, "pr-2866-");

  // The fix PR was raised from the fix branch into the gated milestone head.
  const created = captured.calls.find((c) =>
    c[0] === "pr" && c[1] === "create"
  );
  if (!created) throw new Error("expected a pr create call");
  assertEquals(created[created.indexOf("--base") + 1], MILESTONE_HEAD);
  assertEquals(created[created.indexOf("--head") + 1], fixBranch);

  assertEquals(result.value.changesPushed, true);
  assertStringIncludes(result.value.summary, "fix PR #9001");

  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "PR #9001");
  assertStringIncludes(body, MILESTONE_HEAD);
});

Deno.test("processPrFeedback - gated head: fix PR creation failure => honest fix-PR-raise-failed reply", async () => {
  const captured: CapturedGh = { comments: [], calls: [] };
  const gitCalls: string[][] = [];

  const deps = createMockDeps({
    claude: makeClaudeOk(),
    github: makeMockGithub(captured, {
      gated: true,
      failFixPrCreate: true,
    }),
    git: makeSuccessfulPushGit(gitCalls),
  });

  const processorDeps: PrFeedbackProcessorDeps = {
    promptsDir: PROMPTS_DIR,
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-milestone-fix-pr-fail",
    workRoot: "/tmp/test-milestone-fix-pr-fail",
    verifyPushFn: REMOTE_CONFIRMS_PUSH,
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(result.value.changesPushed, false);

  // Issue #2907: the fix branch DID push successfully to origin — only the
  // follow-on PR into the gated head failed — so the reply must not claim
  // the work is "still on the worker's local branch" (it isn't).
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "pushed the fix to");
  assertStringIncludes(body, "on origin");
  assertStringIncludes(body, "could not raise");
  assertStringIncludes(body, MILESTONE_HEAD);
});

Deno.test("processPrFeedback - gated head: fix-branch checkout failure => honest gated-checkout-failed reply", async () => {
  const captured: CapturedGh = { comments: [], calls: [] };
  const gitCalls: string[][] = [];

  const deps = createMockDeps({
    claude: makeClaudeOk(),
    github: makeMockGithub(captured, { gated: true }),
    git: {
      runGitCommand: ((args: string[], _opts?: unknown) => {
        gitCalls.push(args);
        if (args[0] === "checkout" && args[1] === "-B") {
          return Promise.resolve({
            ok: true,
            value: { code: 1, stdout: "", stderr: "cannot lock ref" },
          });
        }
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
        });
      }) as unknown as GitDeps["runGitCommand"],
    },
  });

  const processorDeps: PrFeedbackProcessorDeps = {
    promptsDir: PROMPTS_DIR,
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-milestone-fix-checkout-fail",
    workRoot: "/tmp/test-milestone-fix-checkout-fail",
    verifyPushFn: REMOTE_CONFIRMS_PUSH,
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(result.value.processed, false);
  assertEquals(result.value.changesPushed, false);

  // Claude never ran here, so the reply must not claim a fix was made.
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "ruleset-gated");
  assertStringIncludes(body, "could not create the fix");
  assertStringIncludes(body, "No changes were made");
  assertStringIncludes(body, "cannot lock ref");
});

Deno.test("processPrFeedback - non-gated head: unchanged behaviour, pushes to the original branch", async () => {
  const captured: CapturedGh = { comments: [], calls: [] };
  const gitCalls: string[][] = [];

  const deps = createMockDeps({
    claude: makeClaudeOk(),
    github: makeMockGithub(captured, { gated: false }),
    git: makeSuccessfulPushGit(gitCalls),
  });

  const processorDeps: PrFeedbackProcessorDeps = {
    promptsDir: PROMPTS_DIR,
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-milestone-fix-non-gated",
    workRoot: "/tmp/test-milestone-fix-non-gated",
    verifyPushFn: REMOTE_CONFIRMS_PUSH,
  };

  const input = makeInput({ branchName: "issue-2866-ordinary-branch" });
  const result = await processPrFeedback(input, processorDeps);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const checkout = gitCalls.find((c) => c[0] === "checkout" && c[1] === "-B");
  assertEquals(checkout, undefined, "no fix-branch checkout expected");

  const created = captured.calls.find((c) =>
    c[0] === "pr" && c[1] === "create"
  );
  assertEquals(created, undefined, "no fix PR expected for a non-gated head");

  assertEquals(result.value.changesPushed, true);
  assertEquals(result.value.summary, "Pushed fixes for PR #2866 feedback");
});

Deno.test("processPrFeedback - gated head: PR branch held elsewhere => stands down before cutting a fix branch", async () => {
  // Regression for a PR #2909 review finding: preparePrBranch's result was
  // never checked, so a `branch_held` worktree (Issue #1677) stayed on the
  // previous task's branch and `checkout -B <fixBranch>` cut the fix branch
  // from that wrong HEAD instead of standing down.
  const captured: CapturedGh = { comments: [], calls: [] };
  const gitCalls: string[][] = [];

  const deps = createMockDeps({
    claude: makeClaudeOk(),
    github: makeMockGithub(captured, { gated: true }),
    git: {
      runGitCommand: ((args: string[], _opts?: unknown) => {
        gitCalls.push(args);
        if (args[0] === "checkout" && args[1] === "--end-of-options") {
          return Promise.resolve({
            ok: true,
            value: {
              code: 1,
              stdout: "",
              stderr:
                `fatal: '${MILESTONE_HEAD}' is already checked out at '/tmp/other-worktree'`,
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

  const processorDeps: PrFeedbackProcessorDeps = {
    promptsDir: PROMPTS_DIR,
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-milestone-fix-branch-held",
    workRoot: "/tmp/test-milestone-fix-branch-held",
    verifyPushFn: REMOTE_CONFIRMS_PUSH,
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(result.value.processed, false);
  assertEquals(result.value.changesPushed, false);

  // No fix branch was ever cut, and no fix PR was raised, from the
  // unverified HEAD.
  const checkoutB = gitCalls.find((c) => c[0] === "checkout" && c[1] === "-B");
  assertEquals(checkoutB, undefined, "no fix-branch checkout expected");
  const created = captured.calls.find((c) =>
    c[0] === "pr" && c[1] === "create"
  );
  assertEquals(created, undefined, "no fix PR expected");
});
