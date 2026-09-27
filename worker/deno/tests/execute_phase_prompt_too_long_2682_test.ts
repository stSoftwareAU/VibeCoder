/**
 * Issue #2682 — execute-phase wiring: a `Prompt is too long` refusal on a
 * resumed session retries once on a fresh session without failing; a second
 * refusal fails under the `prompt-too-long` category.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type { PhaseState } from "../lib/issue_worker_types.ts";
import type { Logger } from "../types.ts";
import {
  type IssueContext,
  workOnIssueExecuteClaude,
} from "../lib/issue_worker.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  detectFailureCategory,
  getFailureCategoryDisplay,
} from "../lib/failure_diagnosis.ts";

interface CapturedLog {
  level: string;
  msg: string;
  ctx?: unknown;
}

function makeLogger(captured: CapturedLog[]): Logger {
  return {
    info: (msg, ctx) => captured.push({ level: "info", msg, ctx }),
    warn: (msg, ctx) => captured.push({ level: "warn", msg, ctx }),
    error: (msg, ctx) => captured.push({ level: "error", msg, ctx }),
    debug: (msg, ctx) => captured.push({ level: "debug", msg, ctx }),
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

function makeState(overrides?: Partial<PhaseState>): PhaseState {
  return {
    branchName: "issue-42-test",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    ...overrides,
  };
}

function makeContext(workDir: string): IssueContext {
  return {
    repo: "org/test-repo",
    issueNumber: 42,
    issueTitle: "Test issue",
    issueBody: "Body",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: {
      ...buildDefaultWorkerConfig(),
      workDir,
      infraRetryBackoffMs: 0,
    },
  };
}

/** Runs the execute phase with a scripted sequence of agent outputs. */
async function runWithOutputs(outputs: string[]) {
  const workDir = await Deno.makeTempDir({ prefix: "ptl_exec_2682_" });
  try {
    const ctx = makeContext(workDir);
    const state = makeState({
      sessionResumeState: { sessionId: "oversized-session", phaseCount: 1 },
    });
    const captured: CapturedLog[] = [];
    let calls = 0;
    const deps = createMockDeps({
      logger: makeLogger(captured),
      claude: {
        runClaudeWithRetry: (() => {
          const output = outputs[Math.min(calls, outputs.length - 1)];
          calls++;
          return Promise.resolve({
            ok: true,
            value: { output, exitCode: 0, timedOut: false },
          });
        }) as never,
      },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({ ok: false, error: new Error("No PR") }),
      },
    });
    const result = await workOnIssueExecuteClaude(ctx, state, deps);
    return { result, state, captured, calls: () => calls };
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

const discardLines = (captured: CapturedLog[]) =>
  captured.filter((l) =>
    l.level === "warn" && l.msg.includes("Discarded resumed session")
  );

Deno.test("#2682 execute - refusal on a resumed session retries once on a fresh session and does not fail", async () => {
  const { result, state, captured, calls } = await runWithOutputs([
    "Prompt is too long",
    "Implemented the change and committed it.",
  ]);

  assertEquals(calls(), 2);
  assertEquals(state.promptTooLongRetried, true);
  assertNotEquals(state.sessionResumeState?.sessionId, "oversized-session");
  const lines = discardLines(captured);
  assertEquals(lines.length, 1);
  assert(lines[0].msg.includes("oversized-session"));
  // Whatever the phase decides next, it is not a prompt-too-long failure.
  const reason = result.status === "failure" ? result.reason : "";
  assertNotEquals(detectFailureCategory(reason), "prompt_too_long");
});

Deno.test("#2682 execute - a second refusal on the fresh session fails as prompt-too-long", async () => {
  const { result, captured, calls } = await runWithOutputs([
    "Prompt is too long",
  ]);

  assertEquals(calls(), 2, "one uncounted retry, then no further attempt");
  assertEquals(discardLines(captured).length, 1);
  assertEquals(result.status, "failure");
  const reason = result.status === "failure" ? result.reason : "";
  assertEquals(detectFailureCategory(reason), "prompt_too_long");
  assertEquals(
    getFailureCategoryDisplay(detectFailureCategory(reason)),
    "prompt-too-long",
  );
  assert(
    captured.some((l) =>
      l.level === "error" &&
      (l.ctx as { category?: string } | undefined)?.category ===
        "prompt-too-long"
    ),
    "the log reports category prompt-too-long",
  );
});

Deno.test("#2682 execute - refusal on a fresh session fails immediately without a retry", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "ptl_exec_2682_" });
  try {
    const ctx = makeContext(workDir);
    const state = makeState();
    const captured: CapturedLog[] = [];
    let calls = 0;
    const deps = createMockDeps({
      logger: makeLogger(captured),
      claude: {
        runClaudeWithRetry: (() => {
          calls++;
          return Promise.resolve({
            ok: true,
            value: {
              output: "Prompt is too long",
              exitCode: 0,
              timedOut: false,
            },
          });
        }) as never,
      },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({ ok: false, error: new Error("No PR") }),
      },
    });
    const result = await workOnIssueExecuteClaude(ctx, state, deps);
    assertEquals(calls, 1);
    assertEquals(discardLines(captured).length, 0);
    assertEquals(result.status, "failure");
    const reason = result.status === "failure" ? result.reason : "";
    assertEquals(detectFailureCategory(reason), "prompt_too_long");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
