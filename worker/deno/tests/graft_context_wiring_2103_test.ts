/**
 * Graft context wiring for the PR-feedback and CI-fix runs (Issue #2103,
 * part of #2060).
 *
 * Both paths must, on an enabled host, collect the bundle once with the PR
 * title plus the feedback or failing-check text as the query and hand it to
 * their prompt builder; on a host that never opted in they must collect
 * nothing, spawn nothing, and ask GitHub for no PR title; and a `failed`
 * collection must leave the run to proceed unbundled with the outcome still
 * reported on the processor's result.
 *
 * The disabled cases use the *real* collector rather than a fake, because
 * `status: "off"` is returned only by the pre-spawn short-circuit — a run that
 * spawned `graft` against these fixtures would come back `failed` instead.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type PrFeedbackInput,
  type PrFeedbackProcessorDeps,
  processPrFeedback,
} from "../lib/pr_feedback_processor.ts";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import {
  collectGraftContext,
  type CollectGraftContextOptions,
  type GraftContextResult,
} from "../lib/graft_context.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import type { fetchGithubActionsLogExcerpt } from "../lib/github_actions_log_fetcher.ts";
import type { Logger } from "../types.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Text unique enough that finding it in a prompt proves the bundle landed. */
const BUNDLE = "export function parseIsoDate(raw: string): number {}";

const REPO = "org/repo";
const PR_NUMBER = 2103;
const BRANCH = "issue-2103-wire-graft";
const PR_TITLE = "Wire Graft context into the PR processors";
const FEEDBACK_BODY = "The retry loop never releases the lock on a timeout.";
const CHECK_NAME = "quality";
const ANNOTATION_MESSAGE = "tests/date_test.ts:42 parseIsoDate drops the year";

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

function silentLogger(): Logger {
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

/** True when these `gh` args are the PR-title read (Issue #2103). */
function isTitleRead(args: readonly string[]): boolean {
  return args[0] === "pr" && args[1] === "view" && args.includes("title");
}

/**
 * A `gh` stub that reports an open PR, answers the title read, records every
 * call, and returns an empty JSON list for everything else.
 */
function makeGh(calls: string[][]): GitHubDeps["runGhCommand"] {
  return (args: string[]): Promise<string> => {
    calls.push(args);
    if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
    if (isTitleRead(args)) return Promise.resolve(`${PR_TITLE}\n`);
    return Promise.resolve("[]");
  };
}

/** A push that landed, so the processors take their success path. */
function pushedGit(): Partial<GitDeps> {
  return {
    commitAndPushPending: (() =>
      Promise.resolve({
        ok: true,
        value: {
          committedNewChanges: false,
          commitsPushed: 1,
          finalUnpushedCount: 0,
        },
      })) as unknown as GitDeps["commitAndPushPending"],
  };
}

/** A Claude run that succeeds, capturing the prompt it was given. */
function capturingClaude(prompts: string[]): Partial<ClaudeDeps> {
  return {
    runClaudeWithRetry: ((options: { prompt: string }) => {
      prompts.push(options.prompt);
      return Promise.resolve({
        ok: true,
        value: { output: "Applied the fix.", exitCode: 0, timedOut: false },
      });
    }) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
}

// ===========================================================================
// PR feedback — processPrFeedback
// ===========================================================================

interface FeedbackRun {
  result: Awaited<ReturnType<typeof processPrFeedback>>;
  prompts: string[];
  ghCalls: string[][];
}

async function runFeedback(options: {
  enabled: boolean;
  collect?: (
    options: CollectGraftContextOptions,
  ) => Promise<GraftContextResult>;
}): Promise<FeedbackRun> {
  const prompts: string[] = [];
  const ghCalls: string[][] = [];
  const deps = createMockDeps({
    claude: capturingClaude(prompts),
    github: { runGhCommand: makeGh(ghCalls) },
    git: pushedGit(),
  });
  const workDir = await Deno.makeTempDir();
  try {
    const input: PrFeedbackInput = {
      repo: REPO,
      prNumber: PR_NUMBER,
      branchName: BRANCH,
      commentType: "issue",
      commentId: "7001",
      commentBody: FEEDBACK_BODY,
    };
    const processorDeps: PrFeedbackProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: silentLogger(),
      deps,
      workDir,
      workRoot: workDir,
      graftContextEnabled: options.enabled,
      ...(options.collect !== undefined
        ? { collectGraftContext: options.collect }
        : {}),
    };
    const result = await processPrFeedback(input, processorDeps);
    return { result, prompts, ghCalls };
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

Deno.test("processPrFeedback - the switch off collects nothing and injects nothing", async () => {
  // The real collector: only its pre-spawn short-circuit answers `off`.
  const { result, prompts, ghCalls } = await runFeedback({
    enabled: false,
    collect: collectGraftContext,
  });

  assert(result.ok, "the feedback run must succeed");
  assertEquals(result.value.graftContext?.status, "off");
  assert(prompts.length > 0, "the agent must have been prompted");
  assertEquals(prompts[0]?.includes("Graft Code Bundle"), false);
  // A disabled host pays for no extra GitHub read either.
  assertEquals(ghCalls.some(isTitleRead), false);
});

Deno.test("processPrFeedback - an enabled host injects the bundle and asks for the PR", async () => {
  const collector = fakeCollector(okOutcome());
  const { result, prompts, ghCalls } = await runFeedback({
    enabled: true,
    collect: collector.collect,
  });

  assertEquals(collector.calls.length, 1);
  assertEquals(collector.calls[0]?.enabled, true);
  const query = collector.calls[0]?.query ?? "";
  assertStringIncludes(query, PR_TITLE);
  assertStringIncludes(query, FEEDBACK_BODY);
  assert(ghCalls.some(isTitleRead), "the PR title must have been read");

  assertStringIncludes(prompts[0] ?? "", "Graft Code Bundle");
  assertStringIncludes(prompts[0] ?? "", BUNDLE);
  assert(result.ok);
  assertEquals(result.value.graftContext?.status, "ok");
  // The recorded outcome is figures only — the bundle was spent on the prompt.
  assertEquals(result.value.graftContext?.bundle, undefined);
  assertEquals(result.value.graftContext?.nodeCount, 820);
});

Deno.test("processPrFeedback - a failed collection is reported and the run proceeds", async () => {
  const collector = fakeCollector(failedOutcome());
  const { result, prompts } = await runFeedback({
    enabled: true,
    collect: collector.collect,
  });

  assertEquals(prompts.length, 1, "the agent must still have run");
  assertEquals(prompts[0]?.includes("Graft Code Bundle"), false);
  assert(result.ok, "a failed collection must not fail the feedback run");
  assertEquals(result.value.graftContext?.status, "failed");
});

// ===========================================================================
// CI fix — processCiFailure
// ===========================================================================

interface CiRun {
  result: Awaited<ReturnType<typeof processCiFailure>>;
  prompts: string[];
  ghCalls: string[][];
}

async function runCiFix(options: {
  enabled: boolean;
  collect?: (
    options: CollectGraftContextOptions,
  ) => Promise<GraftContextResult>;
}): Promise<CiRun> {
  const prompts: string[] = [];
  const ghCalls: string[][] = [];
  const deps = createMockDeps({
    claude: capturingClaude(prompts),
    github: { runGhCommand: makeGh(ghCalls) },
    git: pushedGit(),
  });
  const workDir = await Deno.makeTempDir();
  // No CI log provider — the query is then the check name and annotations.
  const actionsLogFn = (() =>
    Promise.resolve({
      kind: "not-applicable" as const,
      reason: "check target URL is not a GitHub Actions job URL",
    })) as unknown as typeof fetchGithubActionsLogExcerpt;
  try {
    const annotations: CheckAnnotation[] = [
      {
        path: "tests/date_test.ts",
        start_line: 42,
        message: ANNOTATION_MESSAGE,
      },
    ];
    const input: CiFixInput = {
      repo: REPO,
      prNumber: PR_NUMBER,
      branchName: BRANCH,
      checkRunId: "67890",
      checkName: CHECK_NAME,
      encodedAnnotations: btoa(JSON.stringify(annotations)),
    };
    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: silentLogger(),
      deps,
      workDir,
      workRoot: workDir,
      stateDir: `${workDir}/.ci_check_state`,
      actionsLogFn,
      graftContextEnabled: options.enabled,
      ...(options.collect !== undefined
        ? { collectGraftContext: options.collect }
        : {}),
    };
    const result = await processCiFailure(input, processorDeps);
    return { result, prompts, ghCalls };
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

Deno.test("processCiFailure - the switch off collects nothing and injects nothing", async () => {
  const { result, prompts, ghCalls } = await runCiFix({
    enabled: false,
    collect: collectGraftContext,
  });

  assert(result.ok, "the CI fix run must succeed");
  assertEquals(result.value.graftContext?.status, "off");
  assert(prompts.length > 0, "the agent must have been prompted");
  assertEquals(prompts[0]?.includes("Graft Code Bundle"), false);
  assertEquals(ghCalls.some(isTitleRead), false);
});

Deno.test("processCiFailure - an enabled host injects the bundle and asks for the failing check", async () => {
  const collector = fakeCollector(okOutcome());
  const { result, prompts, ghCalls } = await runCiFix({
    enabled: true,
    collect: collector.collect,
  });

  assertEquals(collector.calls.length, 1);
  assertEquals(collector.calls[0]?.enabled, true);
  const query = collector.calls[0]?.query ?? "";
  assertStringIncludes(query, PR_TITLE);
  assertStringIncludes(query, CHECK_NAME);
  assertStringIncludes(query, ANNOTATION_MESSAGE);
  assert(ghCalls.some(isTitleRead), "the PR title must have been read");

  assertStringIncludes(prompts[0] ?? "", "Graft Code Bundle");
  assertStringIncludes(prompts[0] ?? "", BUNDLE);
  assert(result.ok);
  assertEquals(result.value.graftContext?.status, "ok");
  assertEquals(result.value.graftContext?.bundle, undefined);
  assertEquals(result.value.graftContext?.callEdgeCount, 1204);
});

Deno.test("processCiFailure - a failed collection is reported and the fix proceeds", async () => {
  const collector = fakeCollector(failedOutcome());
  const { result, prompts } = await runCiFix({
    enabled: true,
    collect: collector.collect,
  });

  assertEquals(prompts.length, 1, "the agent must still have run");
  assertEquals(prompts[0]?.includes("Graft Code Bundle"), false);
  assert(result.ok, "a failed collection must not fail the CI fix run");
  assertEquals(result.value.graftContext?.status, "failed");
});
