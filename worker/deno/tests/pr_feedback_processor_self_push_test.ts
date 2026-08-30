/**
 * Regression test for Issue #1862, part of #1855.
 *
 * Reproduces the PR #2524 scenario in stSoftwareAU/private-repo-14:
 * Claude commits-and-pushes the fix during its own run, leaving the
 * final-mile commitAndPushPending with nothing to do. The processor must
 * still recognise that HEAD moved (via the new branch_head_tracker
 * helpers) and post the success reply rather than the misleading
 * "could not identify a code change" message.
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
      if (args[0] === "pr" && args[1] === "comment") {
        const idx = args.indexOf("--body");
        if (idx >= 0 && args[idx + 1] !== undefined) {
          captured.comments.push(args[idx + 1] as string);
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
    prNumber: 2524,
    branchName: "issue-2524-feedback",
    commentType: "review",
    commentId: "999",
    commentBody: "Please resolve the 'Useless conditional' issues",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Issue #579: a claim that the push landed is now made against the REMOTE,
 * not against local state. Tests that assert a successful push therefore say
 * so explicitly — clean local state, and a moved HEAD, are no longer
 * sufficient evidence on their own.
 */
const REMOTE_CONFIRMS_PUSH = () =>
  Promise.resolve({
    landed: true,
    localSha: "f".repeat(40),
    remoteSha: "f".repeat(40),
    reason: "verified in test",
  });

Deno.test("processPrFeedback - claude self-pushed: HEAD moved => success reply", async () => {
  // The name still says "HEAD moved => success", but the implication is no
  // longer straight through. Issue #579: a LOCAL commit moves HEAD too, and
  // PR #549 claimed a push that never happened on exactly this evidence. A
  // moved HEAD now only re-opens the question; the remote answers it, which
  // is what REMOTE_CONFIRMS_PUSH stands in for below. The companion case —
  // HEAD moved and the remote disagreeing — is covered in
  // pr_feedback_processor_test.ts.
  const captured: CapturedGh = { comments: [], labelsAdded: [] };

  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };

  let captureCalls = 0;

  const mockGit: Partial<GitDeps> = {
    // Final-mile sees nothing to do — Claude already pushed.
    commitAndPushPending: (() =>
      Promise.resolve({
        ok: true,
        value: {
          committedNewChanges: false,
          commitsPushed: 0,
          finalUnpushedCount: 0,
        },
      })) as unknown as GitDeps["commitAndPushPending"],
    // Pre-Claude HEAD vs post-Claude HEAD differs — HEAD moved.
    captureBranchHead: (() => {
      captureCalls++;
      return Promise.resolve({
        ok: true,
        value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
    }) as unknown as GitDeps["captureBranchHead"],
    branchHeadChanged:
      (() => Promise.resolve({ ok: true, value: true })) as unknown as GitDeps[
        "branchHeadChanged"
      ],
  };

  const deps = createMockDeps({
    claude: mockClaude,
    github: makeMockGithub(captured),
    git: mockGit,
  });

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-self-push",
    verifyPushFn: REMOTE_CONFIRMS_PUSH,
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  // Branch reality: Claude pushed the fix.
  assertEquals(result.value.changesPushed, true);
  assertEquals(result.value.processed, true);

  // Reply should be the success message ("I've pushed a fix"), not the
  // neutral "could not identify a code change" fallback.
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "pushed a fix");
  assertEquals(
    body.includes("could not identify a code change"),
    false,
    `expected success reply, got: ${body}`,
  );

  // captureBranchHead should be called at least once (before Claude).
  assertEquals(
    captureCalls >= 1,
    true,
    `expected captureBranchHead to be called; got ${captureCalls}`,
  );

  // No needs-human label for a successful resolution.
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processPrFeedback - claude self-pushed: genuinely no changes => neutral reply", async () => {
  const captured: CapturedGh = { comments: [], labelsAdded: [] };

  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };

  const mockGit: Partial<GitDeps> = {
    commitAndPushPending: (() =>
      Promise.resolve({
        ok: true,
        value: {
          committedNewChanges: false,
          commitsPushed: 0,
          finalUnpushedCount: 0,
        },
      })) as unknown as GitDeps["commitAndPushPending"],
    captureBranchHead: (() =>
      Promise.resolve({
        ok: true,
        value: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      })) as unknown as GitDeps["captureBranchHead"],
    branchHeadChanged:
      (() => Promise.resolve({ ok: true, value: false })) as unknown as GitDeps[
        "branchHeadChanged"
      ],
  };

  const deps = createMockDeps({
    claude: mockClaude,
    github: makeMockGithub(captured),
    git: mockGit,
  });

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-no-changes",
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(result.value.changesPushed, false);
  assertEquals(result.value.processed, true);

  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "could not identify a code change");
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processPrFeedback - capture failure degrades safely without false success", async () => {
  // If captureBranchHead fails before Claude runs, branchHeadChanged must
  // not be consulted (we have no baseline). The processor should fall back
  // to commitAndPushPending's view and still produce a sensible reply.
  const captured: CapturedGh = { comments: [], labelsAdded: [] };

  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };

  let branchHeadChangedCalls = 0;

  const mockGit: Partial<GitDeps> = {
    commitAndPushPending: (() =>
      Promise.resolve({
        ok: true,
        value: {
          committedNewChanges: false,
          commitsPushed: 0,
          finalUnpushedCount: 0,
        },
      })) as unknown as GitDeps["commitAndPushPending"],
    captureBranchHead: (() =>
      Promise.resolve({
        ok: false,
        error: new Error("rev-parse HEAD failed"),
      })) as unknown as GitDeps["captureBranchHead"],
    branchHeadChanged: (() => {
      branchHeadChangedCalls++;
      return Promise.resolve({ ok: true, value: true });
    }) as unknown as GitDeps["branchHeadChanged"],
  };

  const deps = createMockDeps({
    claude: mockClaude,
    github: makeMockGithub(captured),
    git: mockGit,
  });

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-capture-fail",
  };

  const result = await processPrFeedback(makeInput(), processorDeps);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  // Without a baseline we cannot consult branchHeadChanged; the processor
  // must not call it and must not invent a success.
  assertEquals(
    branchHeadChangedCalls,
    0,
    "branchHeadChanged should not be called when capture failed",
  );
  assertEquals(result.value.changesPushed, false);

  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "could not identify a code change");
});
