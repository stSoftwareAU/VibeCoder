/**
 * Tests for the drift check's wiring into `processPrFeedback` (Issue #3143).
 *
 * Drives the real `processPrFeedback` with the production drift check (no
 * `driftCheckFn` override) against a temporary working directory, so the
 * wiring itself — not just `runPrFeedbackDriftCheck` in isolation — is
 * exercised: the call site, its placement before `commitAndPushPending`, and
 * the residual reaching the reply through `.pr_response_message`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type PrFeedbackInput,
  type PrFeedbackProcessorDeps,
  processPrFeedback,
} from "../lib/pr_feedback_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";
import { openPrGh } from "./support/pr_live_state_stub.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** `captureBranchHead`'s default mock value (see `createMockDeps`). */
const DEFAULT_MOCK_HEAD_SHA = "0000000000000000000000000000000000000000";

const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-7.md";
const SENTENCE = "Subjectless entries are ignored.";

const SUMMARY_V1 = `## Summary

Closes #42.

${SENTENCE}

**Docs sweep** — grep: \`x\`; section: none — internal only

## Test Plan

- Added \`tests/rule_test.ts\` (2 tests).
`;

const DRIFT_OPEN = "<!-- vibe-drift-verdict -->";
const DRIFT_CLOSE = "<!-- /vibe-drift-verdict -->";

function verdictBlock(
  findings: { file: string; sentence: string; reason: string }[],
): string {
  return [
    DRIFT_OPEN,
    "```json",
    JSON.stringify({ findings }, null, 2),
    "```",
    DRIFT_CLOSE,
  ].join("\n");
}

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
    prNumber: 42,
    branchName: "issue-42-fix-bug",
    commentType: "review",
    commentId: "123",
    commentBody: "Please fix the typo on line 10",
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

/** Make a temp working directory carrying the fixture files the check reads. */
async function makeWorkDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "pr_feedback_drift_3143_" });
  await Deno.mkdir(`${dir}/docs/archive/pr-summaries`, { recursive: true });
  await Deno.writeTextFile(`${dir}/${SUMMARY_PATH}`, SUMMARY_V1);
  await Deno.mkdir(`${dir}/lib`, { recursive: true });
  await Deno.writeTextFile(`${dir}/lib/rule.ts`, "export const x = 1;\n");
  return dir;
}

/** A `runGitCommand` stub answering the drift check's reads by exact args. */
function makeDriftGit(): GitDeps["runGitCommand"] {
  return (async (args: string[]) => {
    if (
      args[0] === "diff" && args[1] === "--name-only" &&
      args[2] === DEFAULT_MOCK_HEAD_SHA
    ) {
      return {
        ok: true,
        value: { code: 0, stdout: "lib/rule.ts\n", stderr: "" },
      };
    }
    if (args[0] === "ls-files" && args.includes("--others")) {
      return { ok: true, value: { code: 0, stdout: "", stderr: "" } };
    }
    if (
      args[0] === "diff" && args[1] === "--name-only" &&
      args[2] === "origin/main...HEAD"
    ) {
      return {
        ok: true,
        value: {
          code: 0,
          stdout: `lib/rule.ts\n${SUMMARY_PATH}\n`,
          stderr: "",
        },
      };
    }
    return { ok: true, value: { code: 0, stdout: "", stderr: "" } };
  }) as unknown as GitDeps["runGitCommand"];
}

/** A `runGitCommand` stub whose push changed nothing (empty diffs). */
function makeNoChangeGit(): GitDeps["runGitCommand"] {
  return (() =>
    Promise.resolve({
      ok: true,
      value: { code: 0, stdout: "", stderr: "" },
    })) as unknown as GitDeps["runGitCommand"];
}

/** A `gh` stub answering the base-ref read and recording posted comments. */
function makeDriftGh(recordedComments: string[]): GitHubDeps["runGhCommand"] {
  return openPrGh((args: string[]) => {
    if (
      args[0] === "pr" && args[1] === "view" && args.includes("baseRefName")
    ) {
      return Promise.resolve("main");
    }
    if (args[0] === "pr" && args[1] === "comment") {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx >= 0) recordedComments.push(args[bodyIdx + 1]!);
      return Promise.resolve("");
    }
    return Promise.resolve("");
  });
}

/** Options shape captured from each `runClaudeWithRetry` call. */
interface CapturedOptions {
  disallowedTools?: string[];
  systemPrompt?: string;
  prompt: string;
}

/**
 * A `runClaudeWithRetry` stub that pushes `agent:<n>` into `events` on every
 * call (so ordering against "commit" is visible) and answers from `outputs`
 * in call order.
 */
function makeClaudeMock(
  events: string[],
  outputs: ReadonlyArray<string | ((opts: CapturedOptions) => string)>,
  recordedOptions: CapturedOptions[],
): ClaudeDeps["runClaudeWithRetry"] {
  let i = 0;
  return (async (options: CapturedOptions) => {
    recordedOptions.push(options);
    const idx = i++;
    events.push(`agent:${idx}`);
    const entry = outputs[idx];
    if (entry === undefined) {
      throw new Error(`unexpected claude call ${idx}`);
    }
    const output = typeof entry === "function" ? entry(options) : entry;
    return {
      ok: true,
      value: { output, exitCode: 0, timedOut: false },
    };
  }) as unknown as ClaudeDeps["runClaudeWithRetry"];
}

/** A `commitAndPushPending` stub that pushes "commit" into `events`. */
function makeCommitMock(events: string[]): GitDeps["commitAndPushPending"] {
  return (async () => {
    events.push("commit");
    return {
      ok: true,
      value: {
        committedNewChanges: false,
        commitsPushed: 1,
        finalUnpushedCount: 0,
      },
    };
  }) as unknown as GitDeps["commitAndPushPending"];
}

function baseProcessorDeps(
  workDir: string,
  deps: ReturnType<typeof createMockDeps>,
): PrFeedbackProcessorDeps {
  return {
    promptsDir: PROMPTS_DIR,
    logger: makeSilentLogger(),
    deps,
    workDir,
    workRoot: "/tmp/test-work-root",
    verifyPushFn: REMOTE_CONFIRMS_PUSH,
    qualityInstructions: "",
  };
}

// ---------------------------------------------------------------------------
// Case B: recovery leaves the sentence — reported to the PR.
// ---------------------------------------------------------------------------

Deno.test("processPrFeedback - drift check: recovery leaves the sentence, reported via the PR comment", async () => {
  const workDir = await makeWorkDir();
  try {
    const events: string[] = [];
    const recordedComments: string[] = [];
    const recordedOptions: CapturedOptions[] = [];

    const outputs: ReadonlyArray<string | ((o: CapturedOptions) => string)> = [
      "Fixed",
      () =>
        verdictBlock([{
          file: SUMMARY_PATH,
          sentence: SENTENCE,
          reason: "the fix now rejects a subjectless entry",
        }]),
      "did nothing",
    ];

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: makeClaudeMock(events, outputs, recordedOptions),
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: makeDriftGh(recordedComments),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        runGitCommand: makeDriftGit(),
        commitAndPushPending: makeCommitMock(events),
      },
    });

    const result = await processPrFeedback(
      makeInput(),
      baseProcessorDeps(workDir, deps),
    );

    assertEquals(result.ok, true);
    assertEquals(events, ["agent:0", "agent:1", "agent:2", "commit"]);

    // Call 1 (index 1) is the read-only drift question.
    const readOnlyOptions = recordedOptions[1]!;
    assert(readOnlyOptions.disallowedTools?.includes("Write"));
    assert(readOnlyOptions.disallowedTools?.includes("Edit"));

    // Call 2 (index 2) is the recovery turn, carrying the sentence.
    const recoveryOptions = recordedOptions[2]!;
    assertStringIncludes(recoveryOptions.prompt, SENTENCE);

    assertEquals(recordedComments.length, 1);
    assertStringIncludes(recordedComments[0]!, "Drift check (Issue #3143)");
    assertStringIncludes(recordedComments[0]!, SENTENCE);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Case A: recovery fixes the sentence — nothing drift-related posted.
// ---------------------------------------------------------------------------

Deno.test("processPrFeedback - drift check: recovery fixes the sentence, no drift section posted", async () => {
  const workDir = await makeWorkDir();
  try {
    const events: string[] = [];
    const recordedComments: string[] = [];
    const recordedOptions: CapturedOptions[] = [];

    const outputs: ReadonlyArray<string | ((o: CapturedOptions) => string)> = [
      "Fixed",
      () =>
        verdictBlock([{
          file: SUMMARY_PATH,
          sentence: SENTENCE,
          reason: "the fix now rejects a subjectless entry",
        }]),
      "fixed it",
    ];

    const baseClaudeMock = makeClaudeMock(events, outputs, recordedOptions);
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (async (options: unknown) => {
        const opts = options as CapturedOptions;
        const result = await (baseClaudeMock as unknown as (
          o: unknown,
        ) => Promise<
          {
            ok: true;
            value: { output: string; exitCode: number; timedOut: boolean };
          }
        >)(opts);
        // The recovery turn (no disallowedTools, carries the sentence it
        // was asked to fix) rewrites the summary, as a real agent would.
        if (!opts.disallowedTools && opts.prompt.includes(SENTENCE)) {
          await Deno.writeTextFile(
            `${workDir}/${SUMMARY_PATH}`,
            SUMMARY_V1.replace(
              SENTENCE,
              "Subjectless entries are now rejected.",
            ),
          );
        }
        return result;
      }) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: makeDriftGh(recordedComments),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        runGitCommand: makeDriftGit(),
        commitAndPushPending: makeCommitMock(events),
      },
    });

    const result = await processPrFeedback(
      makeInput(),
      baseProcessorDeps(workDir, deps),
    );

    assertEquals(result.ok, true);
    assertEquals(events, ["agent:0", "agent:1", "agent:2", "commit"]);

    const summaryContent = await Deno.readTextFile(
      `${workDir}/${SUMMARY_PATH}`,
    );
    assert(!summaryContent.includes(SENTENCE));

    assertEquals(recordedComments.length, 1);
    assert(!recordedComments[0]!.includes("Drift check (Issue #3143)"));
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// A push that changed nothing makes only the main claude call.
// ---------------------------------------------------------------------------

Deno.test("processPrFeedback - drift check: a push that changed nothing makes only the main claude call", async () => {
  const workDir = await makeWorkDir();
  try {
    const events: string[] = [];
    const recordedComments: string[] = [];
    const recordedOptions: CapturedOptions[] = [];

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: makeClaudeMock(events, ["Fixed"], recordedOptions),
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: makeDriftGh(recordedComments),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        runGitCommand: makeNoChangeGit(),
        commitAndPushPending: makeCommitMock(events),
      },
    });

    const result = await processPrFeedback(
      makeInput(),
      baseProcessorDeps(workDir, deps),
    );

    assertEquals(result.ok, true);
    assertEquals(events, ["agent:0", "commit"]);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// An injected driftCheckFn that throws does not abort the run.
// ---------------------------------------------------------------------------

Deno.test("processPrFeedback - drift check: a throwing driftCheckFn does not abort the run", async () => {
  const workDir = await makeWorkDir();
  try {
    const events: string[] = [];
    const recordedComments: string[] = [];
    const recordedOptions: CapturedOptions[] = [];

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: makeClaudeMock(events, ["Fixed"], recordedOptions),
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: makeDriftGh(recordedComments),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        runGitCommand: makeDriftGit(),
        commitAndPushPending: makeCommitMock(events),
      },
    });

    const processorDeps = baseProcessorDeps(workDir, deps);
    processorDeps.driftCheckFn = (() => {
      throw new Error("drift check exploded");
    }) as unknown as PrFeedbackProcessorDeps["driftCheckFn"];

    const result = await processPrFeedback(makeInput(), processorDeps);

    assertEquals(result.ok, true);
    assertEquals(events, ["agent:0", "commit"]);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The change request body reaches the drift check (Issue #3244).
// ---------------------------------------------------------------------------

Deno.test("processPrFeedback - drift check: the change request body is passed to the drift check (Issue #3244)", async () => {
  const workDir = await makeWorkDir();
  try {
    const events: string[] = [];
    const recordedComments: string[] = [];
    const recordedOptions: CapturedOptions[] = [];

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: makeClaudeMock(events, ["Fixed"], recordedOptions),
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: makeDriftGh(recordedComments),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        runGitCommand: makeDriftGit(),
        commitAndPushPending: makeCommitMock(events),
      },
    });

    const capturedInputs: Array<{ changeRequest?: string }> = [];
    const processorDeps = baseProcessorDeps(workDir, deps);
    processorDeps.driftCheckFn = ((
      input: { changeRequest?: string },
    ) => {
      capturedInputs.push(input);
      return Promise.resolve({ status: "clean", checked: [] });
    }) as unknown as PrFeedbackProcessorDeps["driftCheckFn"];

    const commentBody = "Please fix the typo on line 10";
    const result = await processPrFeedback(
      makeInput({ commentBody }),
      processorDeps,
    );

    assertEquals(result.ok, true);
    assertEquals(capturedInputs.length, 1);
    assertEquals(capturedInputs[0]!.changeRequest, commentBody);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
