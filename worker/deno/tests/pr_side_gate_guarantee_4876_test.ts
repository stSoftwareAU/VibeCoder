/**
 * The PR-side push guarantee reaches the agent's prompt (Issue #4876).
 *
 * The PR-side flows push to a PR that already exists, after running only the
 * repository's configured pre-flight commands. Their skip record must therefore
 * not promise a full gate run before the push. Each test drives one production
 * caller through its real seam and reads the prompt the agent is handed.
 *
 * Covered callers:
 * - `prFeedbackProcessorCommand.execute` (commands/pr_feedback_processor.ts)
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { prFeedbackProcessorCommand } from "../commands/pr_feedback_processor.ts";
import { prSpellingProcessorCommand } from "../commands/pr_spelling_processor.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  type ClaudeDeps,
  createMockDeps,
  type GitDeps,
  type GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";
import { openPrGh } from "./support/pr_live_state_stub.ts";

const PRE_FLIGHT_SENTENCE = "does not run the full gate before this push";
const FULL_GATE_SENTENCE = "worker runs the gate again before the PR is raised";

/** `captureBranchHead`'s default mock value (see `createMockDeps`). */
const DEFAULT_MOCK_HEAD_SHA = "0000000000000000000000000000000000000000";

const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-7.md";

const SUMMARY_V1 = `## Summary

Closes #42.

Subjectless entries are ignored.

**Docs sweep** — grep: \`x\`; section: none — internal only; siblings: none — no existing set gained a member

## Test Plan

- Added \`tests/rule_test.ts\`.
`;

const DRIFT_OPEN = "<!-- vibe-drift-verdict -->";
const DRIFT_CLOSE = "<!-- /vibe-drift-verdict -->";

/** Options shape captured from each `runClaudeWithRetry` call. */
interface CapturedOptions {
  disallowedTools?: string[];
  systemPrompt?: string;
  prompt: string;
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

/** A clean drift verdict with no findings, as the drift check reads it. */
function verdictBlock(): string {
  return [
    DRIFT_OPEN,
    "```json",
    JSON.stringify({ findings: [] }, null, 2),
    "```",
    DRIFT_CLOSE,
  ].join("\n");
}

/** Make a temp working directory carrying the fixture files the drift check reads. */
async function makeWorkDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "pr_side_gate_4876_" });
  await Deno.mkdir(`${dir}/docs/archive/pr-summaries`, { recursive: true });
  await Deno.writeTextFile(`${dir}/${SUMMARY_PATH}`, SUMMARY_V1);
  await Deno.mkdir(`${dir}/lib`, { recursive: true });
  await Deno.writeTextFile(`${dir}/lib/rule.ts`, "export const x = 1;\n");
  return dir;
}

/** A `runGitCommand` stub answering the drift check's reads by exact args. */
function makeGit(): GitDeps["runGitCommand"] {
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
      (args[2] === "origin/main...HEAD" || args[2] === "origin/release...HEAD")
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

/** A `gh` stub answering the base-ref read and ignoring every other write. */
function makeGh(): GitHubDeps["runGhCommand"] {
  return openPrGh((args: string[]) => {
    if (
      args[0] === "pr" && args[1] === "view" && args.includes("baseRefName")
    ) {
      return Promise.resolve("main");
    }
    return Promise.resolve("");
  });
}

/**
 * A `runClaudeWithRetry` stub that records each call's options and answers
 * from `outputs` in call order.
 */
function makeClaudeMock(
  outputs: ReadonlyArray<string>,
  recordedOptions: CapturedOptions[],
): ClaudeDeps["runClaudeWithRetry"] {
  let i = 0;
  return (async (options: CapturedOptions) => {
    recordedOptions.push(options);
    const idx = i++;
    const output = outputs[idx];
    if (output === undefined) {
      throw new Error(`unexpected claude call ${idx}`);
    }
    return {
      ok: true,
      value: { output, exitCode: 0, timedOut: false },
    };
  }) as unknown as ClaudeDeps["runClaudeWithRetry"];
}

// ---------------------------------------------------------------------------
// prFeedbackProcessorCommand (commands/pr_feedback_processor.ts)
// ---------------------------------------------------------------------------

Deno.test("prFeedbackProcessorCommand - the agent prompt carries the pre-flight-only push guarantee (Issue #4876)", async () => {
  const workDir = await makeWorkDir();
  try {
    const recordedOptions: CapturedOptions[] = [];
    const deps = createMockDeps({
      logger: makeSilentLogger(),
      claude: {
        runClaudeWithRetry: makeClaudeMock(
          ["Fixed", verdictBlock()],
          recordedOptions,
        ),
      },
      github: { runGhCommand: makeGh() },
      git: {
        setupRepo: () => Promise.resolve({ ok: true, value: workDir }),
        runGitCommand: makeGit(),
      },
    });
    const config = buildDefaultWorkerConfig({
      workDir,
      repoConfig: {
        "org/repo": { skipMutationCheck: true },
      },
    });

    const result = await prFeedbackProcessorCommand.execute(
      {
        operation: "process",
        repo: "org/repo",
        "pr-number": 42,
        "branch-name": "issue-42-fix-bug",
        "comment-type": "review",
        "comment-id": "123",
        "comment-body": "Fix the retry path",
      },
      config,
      deps,
    );

    assertEquals(result.success, true, result.message);
    assertEquals(
      recordedOptions.length >= 1,
      true,
      "the agent must be invoked",
    );
    const prompt = recordedOptions[0]!.prompt;
    assertStringIncludes(prompt, PRE_FLIGHT_SENTENCE);
    assertEquals(
      prompt.includes(FULL_GATE_SENTENCE),
      false,
      "a PR-side prompt must not promise a gate run before the push",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("prSpellingProcessorCommand - the agent prompt carries the pre-flight-only push guarantee (Issue #4876)", async () => {
  const workDir = await makeWorkDir();
  try {
    const recordedOptions: CapturedOptions[] = [];
    const deps = createMockDeps({
      logger: makeSilentLogger(),
      claude: {
        runClaudeWithRetry: makeClaudeMock(["Fixed spelling"], recordedOptions),
      },
      github: { runGhCommand: makeGh() },
      git: {
        setupRepo: () => Promise.resolve({ ok: true, value: workDir }),
        runGitCommand: makeGit(),
        getRepoDefaultBranch: () =>
          Promise.resolve({ ok: true, value: "main" }),
        syncFeatureBranchWithDefault: () =>
          Promise.resolve({ ok: true, value: "main" }),
        commitAndPushPending: () =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
              finalUnpushedSource: "remote-head",
            },
          }),
      },
    });
    const config = buildDefaultWorkerConfig({
      workDir,
      claudeTimeout: 600,
      repoConfig: { "org/repo": { skipMutationCheck: true } },
    });

    const result = await prSpellingProcessorCommand.execute(
      {
        operation: "process",
        repo: "org/repo",
        "pr-number": 42,
        "branch-name": "issue-42-fix-bug",
        "check-run-id": "12345",
        "check-name": "cspell",
        "encoded-annotations": btoa(JSON.stringify([{
          path: "src/main.ts",
          start_line: 1,
          message: "Unknown word: colour",
        }])),
      },
      config,
      deps,
    );

    assertEquals(result.success, true, result.message);
    assertEquals(recordedOptions.length, 1, "the agent must be invoked");
    const prompt = recordedOptions[0]!.prompt;
    assertStringIncludes(prompt, PRE_FLIGHT_SENTENCE);
    assertStringIncludes(prompt, "With none configured");
    assertEquals(
      prompt.includes(FULL_GATE_SENTENCE),
      false,
      "a spelling-fix prompt must not promise a full gate before the push",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
