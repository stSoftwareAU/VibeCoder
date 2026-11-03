/**
 * Regression tests for Issue #4641: the reasons the worker posts in a TARGET
 * repository must not carry a VibeCoder issue number. GitHub resolves a bare
 * `#N` against the repository the comment lives in, so `(Issue #2682)` links
 * to an unrelated issue there. The one exception is a live PR number, which
 * belongs to the target repository and is kept.
 *
 * Covers the three reason builders that reach a target-repo comment:
 * the changed-workflow gate message, the prompt-too-long reason, and the
 * context-budget failure message from the execute phase.
 *
 * Same approach as tests/failure_comment_no_vibecoder_numbers_4585_test.ts.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildChangedWorkflowGateMessage,
  evaluateChangedWorkflowGate,
} from "../lib/changed_workflow_gate.ts";
import {
  detectFailureCategory,
  PROMPT_TOO_LONG_MARKER,
  WORKFLOW_GATE_MARKER,
} from "../lib/failure_diagnosis.ts";
import { buildPromptTooLongReason } from "../lib/prompt_too_long.ts";
import {
  type ExecuteClaudePhaseDeps,
  type ExecuteClaudePhaseOptions,
  runExecuteClaudePhase,
} from "../lib/execute_claude_phase.ts";

/** Every `#<digits>` token in the text, in order. */
function hashNumbers(text: string): string[] {
  return text.match(/#\d+/g) ?? [];
}

const CI_PATH = ".github/workflows/ci.yml";

/** A workflow that passes every gate check, with its checkout pinned to a tag. */
const TAG_PINNED = `name: Unit Tests

on:
  pull_request:
    branches: [main, milestone/*]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          persist-credentials: false
      - name: Run tests
        run: |
          set -euo pipefail
          deno test --allow-none
          echo done
`;

Deno.test("changed-workflow gate message - a PR-backed block names only the live PR number (Issue #4641)", async () => {
  const verdict = await evaluateChangedWorkflowGate({
    defaultBranch: "main",
    deps: {
      listChangedFiles: () => Promise.resolve([CI_PATH]),
      readFile: () => Promise.resolve(TAG_PINNED),
      readBaseFile: () => Promise.resolve(null),
    },
  });
  // Guard against a vacuous pass: the message must describe a real finding.
  assertEquals(verdict.ok, false, "the fixture must block");
  assert(verdict.findings.length > 0, "the fixture must carry a finding");

  const message = buildChangedWorkflowGateMessage(verdict, {
    number: 77,
    url: "https://github.com/org/repo/pull/77",
  });
  assert(
    message.includes("PR #77 (https://github.com/org/repo/pull/77)"),
    "the live PR reference must be kept",
  );
  assertEquals(
    hashNumbers(message),
    ["#77"],
    "only the target repo's own PR number may appear",
  );
  assertEquals(detectFailureCategory(message), "workflow_gate");
  assert(message.includes(WORKFLOW_GATE_MARKER), "the gate marker is kept");
});

Deno.test("changed-workflow gate message - a block with no PR names no number at all (Issue #4641)", async () => {
  const verdict = await evaluateChangedWorkflowGate({
    defaultBranch: "main",
    deps: {
      listChangedFiles: () => Promise.resolve([CI_PATH]),
      readFile: () => Promise.resolve(TAG_PINNED),
      readBaseFile: () => Promise.resolve(null),
    },
  });
  assertEquals(verdict.ok, false, "the fixture must block");
  assert(verdict.findings.length > 0, "the fixture must carry a finding");

  const message = buildChangedWorkflowGateMessage(verdict);
  assert(message.includes("no PR was raised"), "the no-PR opening is used");
  assertEquals(
    hashNumbers(message),
    [],
    `a no-PR block carries a VibeCoder number: ${message}`,
  );
  assertEquals(detectFailureCategory(message), "workflow_gate");
  assert(message.includes(WORKFLOW_GATE_MARKER), "the gate marker is kept");
});

Deno.test("prompt-too-long reason - no output snippet names no number (Issue #4641)", () => {
  const reason = buildPromptTooLongReason();
  assert(reason.includes(PROMPT_TOO_LONG_MARKER), "the marker is kept");
  assertEquals(
    hashNumbers(reason),
    [],
    `prompt-too-long reason carries a number: ${reason}`,
  );
  assertEquals(detectFailureCategory(reason), "prompt_too_long");
});

Deno.test("prompt-too-long reason - with an output snippet names no number (Issue #4641)", () => {
  const reason = buildPromptTooLongReason("Prompt is too long");
  assert(reason.includes(PROMPT_TOO_LONG_MARKER), "the marker is kept");
  assert(reason.includes("Agent output: Prompt is too long"), "snippet kept");
  assertEquals(
    hashNumbers(reason),
    [],
    `prompt-too-long reason carries a number: ${reason}`,
  );
  assertEquals(detectFailureCategory(reason), "prompt_too_long");
});

/**
 * Mock deps for the execute phase, covering the calls made before the
 * context-budget check. Mirrors the defaults in
 * tests/execute_claude_phase_test.ts, which keeps its own copy private.
 */
function mockDeps(
  overrides: Partial<ExecuteClaudePhaseDeps> = {},
): ExecuteClaudePhaseDeps {
  return {
    runClaudeWithRetry: async () => ({
      ok: true,
      value: {
        exitCode: 0,
        output: "Implementation complete.",
        timedOut: false,
      },
    }),
    buildIssuePrompt: async () => ({
      ok: true,
      value: { systemPrompt: "Mock system prompt", prompt: "Mock prompt" },
    }),
    buildCachedIssuePrompt: async () => ({
      ok: true,
      value: {
        systemPrompt: "Mock system prompt",
        prompt: "Mock prompt",
        promptSha: "a".repeat(64),
        cacheHit: false,
      },
    }),
    validateRepoState: async () => ({
      ok: true,
      value: { valid: true, actions: [], warnings: [] },
    }),
    findExistingPrForBranch: async () => ({
      ok: false,
      error: new Error("No PR found"),
    }),
    retargetPrToMilestone: async () => ({ ok: true, value: "retargeted" }),
    finalisePr: async () => ({ ok: true, value: "finalised" }),
    ensureIssueClosedIfPrMerged: async () => ({ ok: true, value: undefined }),
    runGitCommand: async (args: string[]) => {
      if (args[0] === "status" && args[1] === "--porcelain") {
        return { ok: true, value: "M src/main.ts" };
      }
      if (args[0] === "log") {
        return { ok: true, value: "abc1234 feat: implement feature" };
      }
      return { ok: true, value: "" };
    },
    recordHeartbeat: async () => ({ ok: true, value: undefined }),
    clearHeartbeat: async () => ({ ok: true, value: undefined }),
    getPromptsCommit: async () => ({ ok: true, value: "abc1234" }),
    log: () => {},
    ...overrides,
  };
}

function testOptions(
  overrides: Partial<ExecuteClaudePhaseOptions> = {},
): ExecuteClaudePhaseOptions {
  return {
    repo: "owner/repo",
    issueNumber: 42,
    issueTitle: "Fix the bug",
    issueBody: "There is a bug that needs fixing.",
    issueLabels: "enhancement,work-on",
    githubUser: "bot-user",
    branchName: "issue-42-fix-the-bug",
    baseBranch: "main",
    milestoneBranch: "",
    clarityStatus: "clear",
    workDir: "/tmp/test-work",
    claudeTimeout: 14400,
    claudeKillAfter: 30,
    maxRateLimitRetries: 2,
    maxRateLimitWait: 600,
    ...overrides,
  };
}

Deno.test("execute phase context-budget failure - the planning hand-off message names no number (Issue #4641)", async () => {
  const handoffs: number[] = [];
  let claudeCalls = 0;

  // A 0.001% ceiling on a 1M window blocks any realistic prompt, and the
  // hand-off to planning succeeds, so the `Handed to planning` message is built.
  const result = await runExecuteClaudePhase(
    testOptions({ contextBudgetBlockPercent: 0.001 }),
    mockDeps({
      handOffContextBudget: async (opts) => {
        handoffs.push(opts.issueNumber);
        return true;
      },
      runClaudeWithRetry: async () => {
        claudeCalls++;
        return {
          ok: true,
          value: { exitCode: 0, output: "", timedOut: false },
        };
      },
    }),
  );

  assertEquals(result.action, "failure");
  assertEquals(result.failureType, "context_budget");
  assertEquals(claudeCalls, 0, "no billed invocation past the ceiling");
  assertEquals(handoffs, [42], "the planning hand-off was attempted");
  const message = result.failureMessage ?? "";
  assert(message.includes("Handed to planning to split it"), `got: ${message}`);
  assertEquals(
    hashNumbers(message),
    [],
    `context-budget failure message carries a number: ${message}`,
  );
});
