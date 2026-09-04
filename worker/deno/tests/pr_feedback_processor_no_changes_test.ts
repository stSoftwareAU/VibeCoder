/**
 * Tests for the classifier-aware no-changes path in pr_feedback_processor (Issue #1691).
 *
 * - With a failing CI check name attached to feedback, the worker classifies
 *   the failure (using the comment body as the log excerpt) and routes the
 *   response by category, adding `needs-human` for code-fix-required.
 * - With no CI check name, the worker bypasses the classifier and posts a
 *   neutral "could not identify a code change" message — never asserts
 *   transience.
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
import { pinPromptsToThisCheckout } from "./support/repo_prompts.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
pinPromptsToThisCheckout();

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
      // Issue #2211: capture comments and labels posted via REST API
      // (escalateToHuman's shim uses `api POST /issues/N/comments|/labels`).
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
    commentType: "review",
    commentId: "555",
    commentBody: "Please look into this.",
    ...overrides,
  };
}

async function runNoChangesScenario(
  input: PrFeedbackInput,
): Promise<CapturedGh> {
  const captured: CapturedGh = { comments: [], labelsAdded: [] };

  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };

  const deps = createMockDeps({
    claude: mockClaude,
    github: makeMockGithub(captured),
    git: {
      // No-changes scenario: nothing committed, nothing pushed.
      commitAndPushPending: (() =>
        Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: false,
            commitsPushed: 0,
            finalUnpushedCount: 0,
          },
        })) as unknown as GitDeps["commitAndPushPending"],
    },
  });

  const processorDeps: PrFeedbackProcessorDeps = {
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/test-feedback",
  };

  const result = await processPrFeedback(input, processorDeps);
  assertEquals(result.ok, true);
  return captured;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("processPrFeedback no-changes - no CI check uses neutral message, no needs-human", async () => {
  const captured = await runNoChangesScenario(makeInput());
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "could not identify a code change");
  assertEquals(body.toLowerCase().includes("transient"), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processPrFeedback no-changes - code-fix-required check adds needs-human", async () => {
  const captured = await runNoChangesScenario(makeInput({
    failingCheckName: "semgrep",
    commentBody:
      "CI failed: semgrep blocking code rules fired — detect-non-literal-regexp",
  }));
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "needs-human");
  assertStringIncludes(body, "Classifier reason");
  assertEquals(body.toLowerCase().includes("transient"), false);
  // Issue #2211: comment is now posted through escalateToHuman, so the
  // body MUST carry the helper's `**Why:**` and `**Next step:**` markers.
  assertStringIncludes(body, "**Why:**");
  assertStringIncludes(body, "**Next step:**");
  assertEquals(
    captured.labelsAdded.includes("needs-human"),
    true,
    `expected needs-human label; got: ${captured.labelsAdded.join(",")}`,
  );
});

Deno.test("processPrFeedback no-changes - timing check suggests re-run, no needs-human", async () => {
  const captured = await runNoChangesScenario(makeInput({
    failingCheckName: "tests",
    commentBody: "The test timed out after 30s in this PR.",
  }));
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "timing");
  assertStringIncludes(body, "re-run");
  assertEquals(body.toLowerCase().includes("transient"), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processPrFeedback no-changes - infrastructure check suggests re-run, no needs-human", async () => {
  const captured = await runNoChangesScenario(makeInput({
    failingCheckName: "deploy",
    commentBody: "Got connect ETIMEDOUT against 140.82.112.6:443",
  }));
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "infrastructure");
  assertStringIncludes(body, "re-run");
  assertEquals(body.toLowerCase().includes("transient"), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processPrFeedback no-changes - unknown check does not assert transience", async () => {
  const captured = await runNoChangesScenario(makeInput({
    failingCheckName: "weird-check",
    commentBody: "Some opaque thing happened that has no recognisable markers.",
  }));
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "could not determine");
  assertEquals(body.toLowerCase().includes("transient"), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});
