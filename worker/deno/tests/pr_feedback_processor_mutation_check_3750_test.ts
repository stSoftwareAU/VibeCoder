/**
 * Tests for the review-fix run's diff-scoped mutation check wired into the
 * drift check's call site in `processPrFeedback` (Issue #3750).
 *
 * Drives the real `processPrFeedback` with the production drift check (no
 * `driftCheckFn` override) against a temporary working directory, so the wiring
 * itself is exercised: the `runMutationCheck` dep builds this run's own diff
 * from the git reads, hands it to `quality.runMutationCheck`, and its survivors
 * drive the recovery turn and reach the posted PR comment.
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
import type { MutationCheckResult } from "../lib/mutation_gate.ts";
import type { MutationRunInput } from "../lib/mutation_runner.ts";
import type { Logger, RepoConfig } from "../types.ts";
import { openPrGh } from "./support/pr_live_state_stub.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** `captureBranchHead`'s default mock value (see `createMockDeps`). */
const DEFAULT_MOCK_HEAD_SHA = "0000000000000000000000000000000000000000";

const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-7.md";
const SENTENCE = "Subjectless entries are ignored.";

const SUMMARY_V1 = `## Summary

Closes #42.

${SENTENCE}

**Docs sweep** — grep: \`x\`; section: none — internal only; siblings: none — no existing set gained a member

## Test Plan

- Added \`tests/rule_test.ts\` (2 tests).
`;

const DRIFT_OPEN = "<!-- vibe-drift-verdict -->";
const DRIFT_CLOSE = "<!-- /vibe-drift-verdict -->";

/** The run's own lines: line 1 of `lib/rule.ts`, added since the run began. */
const OWN_DIFF = [
  "diff --git a/lib/rule.ts b/lib/rule.ts",
  "index 1111111..2222222 100644",
  "--- a/lib/rule.ts",
  "+++ b/lib/rule.ts",
  "@@ -0,0 +1 @@",
  "+export const x = 1;",
  "",
].join("\n");

/** A surviving mutant on `lib/rule.ts:1`, as the runner reports it. */
const SURVIVING_RESULT: MutationCheckResult = {
  kind: "completed",
  language: "deno",
  survivors: [{
    file: "lib/rule.ts",
    line: 1,
    description: "replace the constant 1 with 0",
  }],
  killed: 0,
  total: 1,
} as MutationCheckResult;

/** A clean run: every mutant killed, so no survivors. */
const CLEAN_RESULT: MutationCheckResult = {
  kind: "completed",
  language: "deno",
  survivors: [],
  killed: 1,
  total: 1,
} as MutationCheckResult;

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
  const dir = await Deno.makeTempDir({ prefix: "pr_feedback_mutation_3750_" });
  await Deno.mkdir(`${dir}/docs/archive/pr-summaries`, { recursive: true });
  await Deno.writeTextFile(`${dir}/${SUMMARY_PATH}`, SUMMARY_V1);
  await Deno.mkdir(`${dir}/lib`, { recursive: true });
  await Deno.writeTextFile(`${dir}/lib/rule.ts`, "export const x = 1;\n");
  return dir;
}

/** A `runGitCommand` stub answering the drift check's reads by exact args (as the 3143 test). */
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

/**
 * The drift reads plus the run's own-diff reads (Issue #3750): no merges since
 * the run began, the tracked diff against the run's start, and no untracked
 * files.
 */
function makeGit(): GitDeps["runGitCommand"] {
  const drift = makeDriftGit() as unknown as (
    args: string[],
  ) => Promise<unknown>;
  return (async (args: string[]) => {
    if (args[0] === "rev-list" && args.includes("--merges")) {
      return { ok: true, value: { code: 0, stdout: "", stderr: "" } };
    }
    if (
      args[0] === "diff" && args.includes("--unified=0") &&
      args.includes(DEFAULT_MOCK_HEAD_SHA)
    ) {
      return { ok: true, value: { code: 0, stdout: OWN_DIFF, stderr: "" } };
    }
    if (args[0] === "ls-files" && args.includes("-z")) {
      return { ok: true, value: { code: 0, stdout: "", stderr: "" } };
    }
    return drift(args);
  }) as unknown as GitDeps["runGitCommand"];
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

/**
 * A mutation runner stub that records each input it is called with and
 * answers with `result` every time.
 */
function makeMutationStub(
  inputs: MutationRunInput[],
  result: MutationCheckResult,
): (input: MutationRunInput) => Promise<MutationCheckResult> {
  return (input: MutationRunInput) => {
    inputs.push(input);
    return Promise.resolve(result);
  };
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
// A survivor on this run's own line drives the recovery turn and the reply.
// ---------------------------------------------------------------------------

Deno.test("processPrFeedback - mutation check (Issue #3750): a survivor on the run's own line drives recovery and reaches the PR comment", async () => {
  const workDir = await makeWorkDir();
  try {
    const events: string[] = [];
    const recordedComments: string[] = [];
    const recordedOptions: CapturedOptions[] = [];
    const mutationInputs: MutationRunInput[] = [];

    const outputs: ReadonlyArray<string | ((o: CapturedOptions) => string)> = [
      "Fixed",
      verdictBlock([]),
      "fixed it",
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
      quality: {
        runMutationCheck: makeMutationStub(mutationInputs, SURVIVING_RESULT),
      },
      git: {
        runGitCommand: makeGit(),
        commitAndPushPending: makeCommitMock(events),
      },
    });

    const result = await processPrFeedback(
      makeInput(),
      baseProcessorDeps(workDir, deps),
    );

    assertEquals(result.ok, true);

    // The stub received this run's own diff and the default budget.
    assert(mutationInputs.length >= 1);
    assertStringIncludes(mutationInputs[0]!.diff, "lib/rule.ts");
    assertEquals(mutationInputs[0]!.budgetSeconds, 300);

    // Call 2 is the recovery turn (not read-only) and carries the survivor.
    assertEquals(recordedOptions[2]!.disallowedTools, undefined);
    assertStringIncludes(recordedOptions[2]!.prompt, "lib/rule.ts:1");

    // The survivor still stands after recovery, so the comment reports it.
    assertEquals(recordedComments.length, 1);
    assertStringIncludes(recordedComments[0]!, "Mutation check (Issue #3750)");
    assertStringIncludes(recordedComments[0]!, "lib/rule.ts:1");

    // The commit happens after the agent calls.
    assertEquals(events, ["agent:0", "agent:1", "agent:2", "commit"]);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// skip_mutation_check: the runner is never called and no recovery is driven.
// ---------------------------------------------------------------------------

Deno.test("processPrFeedback - mutation check (Issue #3750): skip_mutation_check never calls the runner or drives recovery", async () => {
  const workDir = await makeWorkDir();
  try {
    const events: string[] = [];
    const recordedComments: string[] = [];
    const recordedOptions: CapturedOptions[] = [];
    const mutationInputs: MutationRunInput[] = [];

    const outputs: ReadonlyArray<string | ((o: CapturedOptions) => string)> = [
      "Fixed",
      verdictBlock([]),
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
      quality: {
        runMutationCheck: makeMutationStub(mutationInputs, SURVIVING_RESULT),
      },
      git: {
        runGitCommand: makeGit(),
        commitAndPushPending: makeCommitMock(events),
      },
    });

    const repoConfigs: Record<string, RepoConfig> = {
      "org/repo": { skipMutationCheck: true },
    };
    const processorDeps = baseProcessorDeps(workDir, deps);
    processorDeps.repoConfigs = repoConfigs;

    const result = await processPrFeedback(makeInput(), processorDeps);

    assertEquals(result.ok, true);
    assertEquals(mutationInputs.length, 0);
    // Only the main call and the read-only drift question; no recovery turn.
    assertEquals(events, ["agent:0", "agent:1", "commit"]);
    for (const comment of recordedComments) {
      assert(!comment.includes("Mutation check"));
    }
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// mutation_check_budget_seconds: the configured budget reaches the runner.
// ---------------------------------------------------------------------------

Deno.test("processPrFeedback - mutation check (Issue #3750): mutation_check_budget_seconds reaches the runner", async () => {
  const workDir = await makeWorkDir();
  try {
    const events: string[] = [];
    const recordedComments: string[] = [];
    const recordedOptions: CapturedOptions[] = [];
    const mutationInputs: MutationRunInput[] = [];

    const outputs: ReadonlyArray<string | ((o: CapturedOptions) => string)> = [
      "Fixed",
      verdictBlock([]),
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
      quality: {
        runMutationCheck: makeMutationStub(mutationInputs, CLEAN_RESULT),
      },
      git: {
        runGitCommand: makeGit(),
        commitAndPushPending: makeCommitMock(events),
      },
    });

    const repoConfigs: Record<string, RepoConfig> = {
      "org/repo": { mutationCheckBudgetSeconds: 120 },
    };
    const processorDeps = baseProcessorDeps(workDir, deps);
    processorDeps.repoConfigs = repoConfigs;

    const result = await processPrFeedback(makeInput(), processorDeps);

    assertEquals(result.ok, true);
    assert(mutationInputs.length >= 1);
    assertEquals(mutationInputs[0]!.budgetSeconds, 120);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
