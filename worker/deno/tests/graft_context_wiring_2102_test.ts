/**
 * Graft context wiring for the issue, planning and question runs
 * (Issue #2102, part of #2060).
 *
 * Each of the three paths must, on an enabled host, collect the bundle once
 * with the issue title and body as the query and hand it to its prompt
 * builder; on a host that never opted in it must collect nothing and spawn
 * nothing; and a `failed` collection must leave the run to proceed unbundled
 * with the outcome still reported.
 *
 * The disabled cases use the *real* collector rather than a fake, because
 * `status: "off"` is returned only by the pre-spawn short-circuit — a run that
 * spawned `graft` against these fixtures would come back `failed` instead.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ExecuteClaudePhaseDeps,
  type ExecuteClaudePhaseOptions,
  runExecuteClaudePhase,
} from "../lib/execute_claude_phase.ts";
import type { CachedIssuePromptOptions } from "../lib/prompt_builder_cache.ts";
import type {
  CollectGraftContextOptions,
  GraftContextResult,
} from "../lib/graft_context.ts";
import { processIssuePlanning } from "../lib/planning_processor.ts";
import { processIssueQuestion } from "../lib/question_processor.ts";
import { collectGraftContext } from "../lib/graft_context.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import type { PhaseState } from "../lib/issue_worker_types.ts";
import type { IssuePromptOptions } from "../lib/prompt_builder.ts";
import {
  createMockDeps,
  type InfrastructureDeps,
} from "../lib/issue_worker_wiring.ts";
import type { IssueContext } from "../lib/issue_worker.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Text unique enough that finding it in a prompt proves the bundle landed. */
const BUNDLE = "export function parseIsoDate(raw: string): number {}";

const ISSUE_TITLE = "Fix the date parser";
const ISSUE_BODY = "The parser drops the year on ISO-8601 inputs.";

/** The query the three paths must all ask Graft. */
const EXPECTED_QUERY = `${ISSUE_TITLE}\n\n${ISSUE_BODY}`;

/** A collector that records its calls and answers with a fixed outcome. */
function fakeCollector(outcome: GraftContextResult): {
  collect: (options: CollectGraftContextOptions) => Promise<GraftContextResult>;
  calls: CollectGraftContextOptions[];
} {
  const calls: CollectGraftContextOptions[] = [];
  return {
    calls,
    collect: (options: CollectGraftContextOptions) => {
      calls.push(options);
      return Promise.resolve(outcome);
    },
  };
}

/** An `ok` collection carrying {@link BUNDLE}. */
function okOutcome(): GraftContextResult {
  return {
    status: "ok",
    enabled: true,
    buildSeconds: 12.5,
    bundleChars: BUNDLE.length,
    nodeCount: 820,
    callEdgeCount: 1204,
    bundle: BUNDLE,
  };
}

/** A collection that failed after the build — no bundle, figures kept. */
function failedOutcome(): GraftContextResult {
  return {
    status: "failed",
    enabled: true,
    buildSeconds: 300,
    nodeCount: 820,
    callEdgeCount: 1204,
  };
}

// ===========================================================================
// The issue run — runExecuteClaudePhase
// ===========================================================================

function createPhaseDeps(
  captured: { options?: CachedIssuePromptOptions },
  logs: string[],
): ExecuteClaudePhaseDeps {
  return {
    runClaudeWithRetry: () =>
      Promise.resolve({
        ok: true,
        value: { exitCode: 0, output: "done", timedOut: false },
      }),
    buildIssuePrompt: () =>
      Promise.resolve({
        ok: true,
        value: { systemPrompt: "sys", prompt: "user" },
      }),
    buildCachedIssuePrompt: (options: CachedIssuePromptOptions) => {
      captured.options = options;
      return Promise.resolve({
        ok: true as const,
        value: {
          systemPrompt: "sys",
          prompt: "user",
          promptSha: "a".repeat(64),
          cacheHit: false,
        },
      });
    },
    validateRepoState: () =>
      Promise.resolve({
        ok: true,
        value: { valid: true, actions: [], warnings: [] },
      }),
    findExistingPrForBranch: () =>
      Promise.resolve({ ok: false, error: new Error("No PR found") }),
    retargetPrToMilestone: () => Promise.resolve({ ok: true, value: "ok" }),
    finalisePr: () => Promise.resolve({ ok: true, value: "ok" }),
    ensureIssueClosedIfPrMerged: () =>
      Promise.resolve({ ok: true, value: undefined }),
    runGitCommand: (args: string[]) =>
      Promise.resolve({
        ok: true,
        value: args[0] === "status" ? "M src/main.ts" : "",
      }),
    recordHeartbeat: () => Promise.resolve({ ok: true, value: undefined }),
    clearHeartbeat: () => Promise.resolve({ ok: true, value: undefined }),
    getPromptsCommit: () => Promise.resolve({ ok: true, value: "abc1234" }),
    log: (message: string) => logs.push(message),
  };
}

function phaseOptions(
  overrides: Partial<ExecuteClaudePhaseOptions> = {},
): ExecuteClaudePhaseOptions {
  return {
    repo: "org/repo",
    issueNumber: 42,
    issueTitle: ISSUE_TITLE,
    issueBody: ISSUE_BODY,
    issueLabels: "bug",
    githubUser: "testbot",
    branchName: "issue-42-fix-the-date-parser",
    baseBranch: "main",
    milestoneBranch: "",
    clarityStatus: "clear",
    workDir: "/tmp/graft-wiring-2102",
    includeRecentActivity: false,
    includeCodebaseMap: false,
    ...overrides,
  };
}

Deno.test("runExecuteClaudePhase - the switch off collects nothing and injects nothing", async () => {
  const captured: { options?: CachedIssuePromptOptions } = {};
  const logs: string[] = [];

  // No collector injected: the real one runs, and only its pre-spawn
  // short-circuit can answer `off`.
  const result = await runExecuteClaudePhase(
    phaseOptions(),
    createPhaseDeps(captured, logs),
  );

  assertEquals(result.graftContext?.status, "off");
  assertEquals(result.graftContext?.enabled, false);
  assertEquals(captured.options?.graftContextBundle, undefined);
  assertEquals(logs.some((line) => line.includes("Graft context:")), false);
});

Deno.test("runExecuteClaudePhase - an enabled host injects the bundle and asks for the issue", async () => {
  const captured: { options?: CachedIssuePromptOptions } = {};
  const logs: string[] = [];
  const collector = fakeCollector(okOutcome());

  const result = await runExecuteClaudePhase(
    phaseOptions({ graftContextEnabled: true }),
    {
      ...createPhaseDeps(captured, logs),
      collectGraftContext: collector.collect,
    },
  );

  assertEquals(collector.calls.length, 1);
  assertEquals(collector.calls[0]?.query, EXPECTED_QUERY);
  assertEquals(collector.calls[0]?.enabled, true);
  // The same checkout the codebase map reads.
  assertEquals(collector.calls[0]?.repoDir, "/tmp/graft-wiring-2102/repo");
  assertEquals(captured.options?.graftContextBundle, BUNDLE);
  assertEquals(result.graftContext?.status, "ok");
  assert(
    logs.some((line) => line.includes("Graft context: ok")),
    `expected the phase to report the collection, got: ${logs.join(" | ")}`,
  );
  assert(
    logs.some((line) => line.includes("820 nodes")),
    "the log line must carry the figures",
  );
});

Deno.test("runExecuteClaudePhase - a failed collection is reported and the run proceeds", async () => {
  const captured: { options?: CachedIssuePromptOptions } = {};
  const logs: string[] = [];
  const collector = fakeCollector(failedOutcome());

  const result = await runExecuteClaudePhase(
    phaseOptions({ graftContextEnabled: true }),
    {
      ...createPhaseDeps(captured, logs),
      collectGraftContext: collector.collect,
    },
  );

  assertEquals(captured.options?.graftContextBundle, undefined);
  assertEquals(result.graftContext?.status, "failed");
  assert(
    result.action !== "failure",
    `a failed collection must not fail the run, got ${result.action}`,
  );
  assert(
    logs.some((line) => line.includes("Graft context: failed")),
    "a failed collection must still be reported",
  );
});

// ===========================================================================
// The planning and question runs — shared fixtures
// ===========================================================================

function makeConfig(enabled: boolean): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    graftContext: { enabled },
  };
}

function makeContext(
  enabled: boolean,
  overrides?: Partial<IssueContext>,
): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 100,
    issueTitle: ISSUE_TITLE,
    issueBody: ISSUE_BODY,
    issueLabels: ["planning"],
    issueComments: "",
    githubUser: "testbot",
    config: makeConfig(enabled),
    ...overrides,
  };
}

/** A gh client that answers every call the two processors make. */
function makeGhClient() {
  return {
    getIssue: () =>
      Promise.resolve({
        number: 100,
        title: ISSUE_TITLE,
        body: ISSUE_BODY,
        labels: [],
        author: "user",
        assignees: [],
        createdAt: "",
        updatedAt: "",
      }),
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

/** Whether these `gh` args are the plan-coverage gate's parent read. */
function isCoverageRead(args: string[]): boolean {
  const jsonIdx = args.indexOf("--json");
  return args[0] === "issue" && args[1] === "view" && jsonIdx >= 0 &&
    (args[jsonIdx + 1] ?? "").includes("comments");
}

/** The compliant `## Plan Coverage` table the close-out gate reads. */
function coverageReadResponse(): string {
  return JSON.stringify({
    body: "Parent",
    comments: [{
      author: { login: "testbot" },
      body: [
        "## Plan published",
        "",
        "1. #101 — Fix the parser (`bug`)",
        "",
        "## Plan Coverage",
        "",
        "| Ask | Covered by | Notes |",
        "| --- | --- | --- |",
        "| Fix the date parser | #101 | Published |",
      ].join("\n"),
    }],
  });
}

// ===========================================================================
// The planning run — processIssuePlanning
// ===========================================================================

/** Mock worker deps capturing every prompt handed to the agent. */
function planningDeps(prompts: string[]) {
  const claudeOutput = `Created the following sub-issues:
- https://github.com/org/repo/issues/101 — Fix the parser
- https://github.com/org/repo/issues/102 — Cover it with a test`;
  return createMockDeps({
    claude: {
      runClaudeWithRetry: (options: { prompt: string }) => {
        prompts.push(options.prompt);
        return Promise.resolve({
          ok: true,
          value: { output: claudeOutput, exitCode: 0, timedOut: false },
        });
      },
    },
    github: {
      runGhCommand: (args: string[]) =>
        Promise.resolve(isCoverageRead(args) ? coverageReadResponse() : ""),
    },
  });
}

Deno.test("processIssuePlanning - the switch off collects nothing and injects nothing", async () => {
  const prompts: string[] = [];
  const deps = planningDeps(prompts);

  const result = await processIssuePlanning(makeContext(false), {
    promptsDir: PROMPTS_DIR,
    ghClient: makeGhClient(),
    logger: deps.logger,
    deps,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.graftContext?.status, "off");
  assert(prompts.length > 0, "the planner must have been prompted");
  assertEquals(prompts[0]?.includes("Graft Code Bundle"), false);
});

Deno.test("processIssuePlanning - an enabled host injects the bundle and asks for the issue", async () => {
  const prompts: string[] = [];
  const deps = planningDeps(prompts);
  const collector = fakeCollector(okOutcome());

  const result = await processIssuePlanning(makeContext(true), {
    promptsDir: PROMPTS_DIR,
    ghClient: makeGhClient(),
    logger: deps.logger,
    deps,
    collectGraftContext: collector.collect,
  });

  assertEquals(collector.calls.length, 1);
  assertEquals(collector.calls[0]?.query, EXPECTED_QUERY);
  assertEquals(collector.calls[0]?.enabled, true);
  assertStringIncludes(prompts[0] ?? "", "Graft Code Bundle");
  assertStringIncludes(prompts[0] ?? "", BUNDLE);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.graftContext?.status, "ok");
});

Deno.test("processIssuePlanning - a failed collection is reported and planning proceeds", async () => {
  const prompts: string[] = [];
  const deps = planningDeps(prompts);
  const collector = fakeCollector(failedOutcome());

  const result = await processIssuePlanning(makeContext(true), {
    promptsDir: PROMPTS_DIR,
    ghClient: makeGhClient(),
    logger: deps.logger,
    deps,
    collectGraftContext: collector.collect,
  });

  assertEquals(prompts[0]?.includes("Graft Code Bundle"), false);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.processed, true);
    assertEquals(result.value.graftContext?.status, "failed");
  }
});

// ===========================================================================
// The question run — processIssueQuestion
// ===========================================================================

/** Mock worker deps capturing the prompt handed to the agent. */
function questionDeps(prompts: string[]) {
  return createMockDeps({
    claude: {
      runClaudeWithRetry: (options: { prompt: string }) => {
        prompts.push(options.prompt);
        return Promise.resolve({
          ok: true,
          value: {
            output: "The parser reads the year from group 1.",
            exitCode: 0,
            timedOut: false,
          },
        });
      },
    },
  });
}

function questionContext(enabled: boolean): IssueContext {
  return makeContext(enabled, { issueNumber: 50, issueLabels: ["question"] });
}

Deno.test("processIssueQuestion - the switch off collects nothing and injects nothing", async () => {
  const prompts: string[] = [];
  const deps = questionDeps(prompts);

  const result = await processIssueQuestion(questionContext(false), {
    promptsDir: PROMPTS_DIR,
    ghClient: makeGhClient(),
    logger: deps.logger,
    deps,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.graftContext?.status, "off");
  assert(prompts.length > 0, "the agent must have been prompted");
  assertEquals(prompts[0]?.includes("Graft Code Bundle"), false);
});

Deno.test("processIssueQuestion - an enabled host injects the bundle and asks for the issue", async () => {
  const prompts: string[] = [];
  const deps = questionDeps(prompts);
  const collector = fakeCollector(okOutcome());

  const result = await processIssueQuestion(questionContext(true), {
    promptsDir: PROMPTS_DIR,
    ghClient: makeGhClient(),
    logger: deps.logger,
    deps,
    collectGraftContext: collector.collect,
  });

  assertEquals(collector.calls.length, 1);
  assertEquals(collector.calls[0]?.query, EXPECTED_QUERY);
  assertEquals(collector.calls[0]?.enabled, true);
  assertStringIncludes(prompts[0] ?? "", "Graft Code Bundle");
  assertStringIncludes(prompts[0] ?? "", BUNDLE);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.graftContext?.status, "ok");
});

Deno.test("processIssueQuestion - a failed collection is reported and the answer proceeds", async () => {
  const prompts: string[] = [];
  const deps = questionDeps(prompts);
  const collector = fakeCollector(failedOutcome());

  const result = await processIssueQuestion(questionContext(true), {
    promptsDir: PROMPTS_DIR,
    ghClient: makeGhClient(),
    logger: deps.logger,
    deps,
    collectGraftContext: collector.collect,
  });

  assertEquals(prompts[0]?.includes("Graft Code Bundle"), false);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.responseType, "answer");
    assertEquals(result.value.graftContext?.status, "failed");
  }
});

// ===========================================================================
// The issue run in the main loop — workOnIssueExecuteClaude
// ===========================================================================

/** Run the main-loop execute phase once and report what Graft did. */
async function runMainLoopExecute(
  enabled: boolean,
  collect: InfrastructureDeps["collectGraftContext"],
): Promise<{
  state: PhaseState;
  promptOptions: IssuePromptOptions[];
}> {
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 42,
    issueTitle: ISSUE_TITLE,
    issueBody: ISSUE_BODY,
    issueLabels: ["bug", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config: makeConfig(enabled),
  };
  const state: PhaseState = {
    branchName: "issue-42-fix-the-date-parser",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/graft-wiring-2102/repo",
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const promptOptions: IssuePromptOptions[] = [];
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "done", exitCode: 0, timedOut: false },
        })) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
    infrastructure: {
      collectGraftContext: collect,
      buildPrompt: ((options: IssuePromptOptions) => {
        promptOptions.push(options);
        return Promise.resolve({
          ok: true,
          value: { systemPrompt: "sys", prompt: "user" },
        });
      }) as never,
    },
  });

  await workOnIssueExecuteClaude(ctx, state, deps);
  return { state, promptOptions };
}

Deno.test("execute_phase - the switch off collects nothing and injects nothing", async () => {
  // The real collector: only its pre-spawn short-circuit answers `off`.
  const { state, promptOptions } = await runMainLoopExecute(
    false,
    collectGraftContext,
  );

  assertEquals(state.graftContext?.status, "off");
  assertEquals(promptOptions[0]?.graftContextBundle, undefined);
});

Deno.test("execute_phase - an enabled host injects the bundle and asks for the issue", async () => {
  const collector = fakeCollector(okOutcome());
  const { state, promptOptions } = await runMainLoopExecute(
    true,
    collector.collect,
  );

  assertEquals(collector.calls.length, 1);
  assertEquals(collector.calls[0]?.query, EXPECTED_QUERY);
  assertEquals(collector.calls[0]?.enabled, true);
  assertEquals(collector.calls[0]?.repoDir, "/tmp/graft-wiring-2102/repo");
  assertEquals(promptOptions[0]?.graftContextBundle, BUNDLE);
  assertEquals(state.graftContext?.status, "ok");
});

Deno.test("execute_phase - a failed collection is recorded and the run proceeds", async () => {
  const collector = fakeCollector(failedOutcome());
  const { state, promptOptions } = await runMainLoopExecute(
    true,
    collector.collect,
  );

  assertEquals(promptOptions[0]?.graftContextBundle, undefined);
  assertEquals(state.graftContext?.status, "failed");
  // The prompt was still built and the agent still ran.
  assertEquals(promptOptions.length, 1);
});
