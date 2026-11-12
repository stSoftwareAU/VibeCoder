/**
 * The review-fix processor no longer runs a mutation check (Issue #5095).
 *
 * Drives the real `processPrFeedback` with the production drift check (no
 * `driftCheckFn` override) against a temporary working directory whose CI
 * workflow advertises a blocking `cargo mutants` job. A `cargo` on PATH
 * records any run, so a mutation process spawned by the review-fix path would
 * be seen. Only observable outcomes are asserted: the result, the agent turns
 * and commit, the PR comments and the files written.
 *
 * A genuine drift failure still takes the existing handling: the recovery turn
 * runs and the residual reaches the PR reply.
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
import { prResponseMessagePath } from "../lib/pr_branch_preparation.ts";
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

**Docs sweep** — grep: \`x\`; section: none — internal only; siblings: none — no existing set gained a member

## Test Plan

- Added \`tests/rule_test.ts\`.
`;

const DRIFT_OPEN = "<!-- vibe-drift-verdict -->";
const DRIFT_CLOSE = "<!-- /vibe-drift-verdict -->";

/** A PR-triggered CI workflow whose blocking job runs `cargo mutants`. */
const MUTANTS_WORKFLOW = [
  "name: ci",
  "on: pull_request",
  "jobs:",
  "  mutants:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: cargo mutants --timeout 60",
  "",
].join("\n");

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

/**
 * A temp working directory carrying the summary, a code file and the CI
 * workflow with the blocking `cargo mutants` job.
 */
async function makeWorkDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "pr_feedback_no_mutation_" });
  await Deno.mkdir(`${dir}/docs/archive/pr-summaries`, { recursive: true });
  await Deno.writeTextFile(`${dir}/${SUMMARY_PATH}`, SUMMARY_V1);
  await Deno.mkdir(`${dir}/lib`, { recursive: true });
  await Deno.writeTextFile(`${dir}/lib/rule.ts`, "export const x = 1;\n");
  await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/.github/workflows/ci.yml`,
    MUTANTS_WORKFLOW,
  );
  return dir;
}

/**
 * A `runGitCommand` stub answering the drift check's reads: the push changed
 * `lib/rule.ts`, and the PR touches the summary too.
 */
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
 * A `gh` stub: the base ref, the base branch's required check `mutants` (what
 * made the retired check blocking), and the PR comments it records.
 */
function makeGh(recordedComments: string[]): GitHubDeps["runGhCommand"] {
  return openPrGh((args: string[]) => {
    if (
      args[0] === "pr" && args[1] === "view" && args.includes("baseRefName")
    ) {
      return Promise.resolve("main");
    }
    if (args[0] === "api" && args[1]!.includes("rules/branches/")) {
      return Promise.resolve(JSON.stringify([[{
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "mutants" }] },
      }]]));
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/**
 * Put a `cargo` first on PATH that records every run in `marker`, so a
 * mutation process spawned by the review-fix path would leave its trace.
 */
async function withCargoShim<T>(
  fn: (marker: string) => Promise<T>,
): Promise<T> {
  const binDir = await Deno.makeTempDir({ prefix: "no_mutation_5095_bin_" });
  const marker = `${binDir}/cargo-ran`;
  await Deno.writeTextFile(
    `${binDir}/cargo`,
    `#!/bin/sh\necho "$@" >> "${marker}"\nexit 1\n`,
    { mode: 0o755 },
  );
  const oldPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${binDir}:${oldPath}`);
  try {
    return await fn(marker);
  } finally {
    Deno.env.set("PATH", oldPath);
    await Deno.remove(binDir, { recursive: true });
  }
}

Deno.test("processPrFeedback - a push with a blocking cargo mutants job completes, posts nothing about mutation, and spawns no mutation process (Issue #5095)", async () => {
  const workDir = await makeWorkDir();
  try {
    await withCargoShim(async (marker) => {
      const events: string[] = [];
      const recordedComments: string[] = [];
      const recordedOptions: CapturedOptions[] = [];

      const outputs: ReadonlyArray<string | ((o: CapturedOptions) => string)> =
        [
          "Fixed",
          verdictBlock([]),
        ];

      const deps = createMockDeps({
        claude: {
          runClaudeWithRetry: makeClaudeMock(events, outputs, recordedOptions),
        },
        github: { runGhCommand: makeGh(recordedComments) },
        git: {
          runGitCommand: makeDriftGit(),
          commitAndPushPending: makeCommitMock(events),
        },
      });

      const result = await processPrFeedback(
        makeInput(),
        baseProcessorDeps(workDir, deps),
      );

      // The normal path: the main turn, one read-only drift question, the push.
      assertEquals(result.ok, true, result.ok ? "" : result.error.message);
      assertEquals(events, ["agent:0", "agent:1", "commit"]);

      // The reply is the one PR comment, and it says nothing about mutation.
      assertEquals(recordedComments.length, 1);
      assert(!/mutat/i.test(recordedComments[0]!), recordedComments[0]);
      const message = (await fileExists(prResponseMessagePath(workDir)))
        ? await Deno.readTextFile(prResponseMessagePath(workDir))
        : "";
      assert(!/mutat/i.test(message), message);

      // No mutation process ran: no cargo invocation, no mutants output tree.
      assertEquals(await fileExists(marker), false);
      assertEquals(await fileExists(`${workDir}/mutants.out`), false);
    });
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("processPrFeedback - a genuine drift failure still runs the recovery turn and reaches the PR reply (Issue #5095)", async () => {
  const workDir = await makeWorkDir();
  try {
    await withCargoShim(async (marker) => {
      const events: string[] = [];
      const recordedComments: string[] = [];
      const recordedOptions: CapturedOptions[] = [];

      // The drift question finds a sentence the push left false; the recovery
      // turn does not fix it, so the residual is reported on the reply.
      const outputs: ReadonlyArray<string | ((o: CapturedOptions) => string)> =
        [
          "Fixed",
          () =>
            verdictBlock([{
              file: SUMMARY_PATH,
              sentence: SENTENCE,
              reason: "the fix now rejects a subjectless entry",
            }]),
          "did nothing",
        ];

      const deps = createMockDeps({
        claude: {
          runClaudeWithRetry: makeClaudeMock(events, outputs, recordedOptions),
        },
        github: { runGhCommand: makeGh(recordedComments) },
        git: {
          runGitCommand: makeDriftGit(),
          commitAndPushPending: makeCommitMock(events),
        },
      });

      const result = await processPrFeedback(
        makeInput(),
        baseProcessorDeps(workDir, deps),
      );

      assertEquals(result.ok, true, result.ok ? "" : result.error.message);
      assertEquals(events, ["agent:0", "agent:1", "agent:2", "commit"]);

      // Call 2 is the recovery turn, carrying the sentence it was asked to fix.
      assertStringIncludes(recordedOptions[2]!.prompt, SENTENCE);

      assertEquals(recordedComments.length, 1);
      assertStringIncludes(recordedComments[0]!, "### Drift check");
      assertStringIncludes(recordedComments[0]!, SENTENCE);
      assert(!/mutat/i.test(recordedComments[0]!), recordedComments[0]);
      assertEquals(await fileExists(marker), false);
    });
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
