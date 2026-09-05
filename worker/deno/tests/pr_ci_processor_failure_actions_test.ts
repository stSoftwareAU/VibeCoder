/**
 * Integration tests for the PR failure action wiring inside
 * `processCiFailure` (Issue #1893).
 *
 * Covers:
 *   - Dispatcher is invoked when the repo configures `ciProviders`
 *     and the rendered excerpt is injected into the CI fix prompt.
 *   - All-errors dispatcher result is logged and the CI fix flow
 *     proceeds with an unchanged prompt (no excerpt block).
 *   - Dispatcher is NOT invoked when the repo has no
 *     `ciProviders` configured.
 *   - The built-in GitHub Actions log provider (Issue #3580) supplies the
 *     excerpt when no configured action produces one, and a non-Actions
 *     check falls through cleanly without an excerpt.
 */

import { assert, assertEquals } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { Logger, RepoConfig } from "../types.ts";
import type {
  PrFailureActionResult,
  runPrFailureActions,
} from "../lib/pr_failure_actions.ts";
import type { fetchGithubActionsLogExcerpt } from "../lib/github_actions_log_fetcher.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844)
// — named as a parameter on every call rather than pinned by deleting the
// host's overrides from the shared process environment (Issue #1024).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturingLogger extends Logger {
  warns: Array<{ message: string; context?: Record<string, unknown> }>;
  infos: Array<{ message: string; context?: Record<string, unknown> }>;
}

function makeCapturingLogger(): CapturingLogger {
  const warns: Array<{ message: string; context?: Record<string, unknown> }> =
    [];
  const infos: Array<{ message: string; context?: Record<string, unknown> }> =
    [];
  const noop = () => {};
  return {
    info: (message: string, context?: Record<string, unknown>) => {
      infos.push({ message, ...(context !== undefined ? { context } : {}) });
    },
    warn: (message: string, context?: Record<string, unknown>) => {
      warns.push({ message, ...(context !== undefined ? { context } : {}) });
    },
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
    warns,
    infos,
  };
}

function makeInput(overrides?: Partial<CiFixInput>): CiFixInput {
  const annotations: CheckAnnotation[] = [
    { path: "tests/main_test.ts", start_line: 42, message: "boom" },
  ];
  const encoded = btoa(JSON.stringify(annotations));
  return {
    repo: "stSoftwareAU/example",
    prNumber: 42,
    branchName: "feature/test",
    checkRunId: "67890",
    checkName: "example-ci / build",
    encodedAnnotations: encoded,
    targetUrl: "https://ci.example.com/job/foo/job/Develop/123/",
    ...overrides,
  };
}

interface ProcessorRig {
  capturedPrompts: string[];
  dispatcherCallCount: number;
  logger: CapturingLogger;
  processorDeps: CiProcessorDeps;
  cleanup: () => Promise<void>;
}

async function makeRig(opts: {
  repoConfigs?: Record<string, RepoConfig>;
  dispatcherResult: PrFailureActionResult[];
  actionsLogFn?: typeof fetchGithubActionsLogExcerpt;
}): Promise<ProcessorRig> {
  const tmpDir = await Deno.makeTempDir();
  const capturedPrompts: string[] = [];
  let dispatcherCallCount = 0;

  const mockClaude: Partial<ClaudeDeps> = {
    // Capture the prompt so the test can assert on its content.
    runClaudeWithRetry: ((opts: { prompt: string }) => {
      capturedPrompts.push(opts.prompt);
      return Promise.resolve({
        ok: true,
        value: { output: "ok", exitCode: 0, timedOut: false },
      });
    }) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: () => Promise.resolve(""),
  };
  const deps = createMockDeps({
    claude: mockClaude,
    github: mockGithub,
    git: {
      commitAndPushPending: (() =>
        Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: false,
            commitsPushed: 1,
            finalUnpushedCount: 0,
          },
        })) as unknown as GitDeps["commitAndPushPending"],
    },
  });

  const dispatcher: typeof runPrFailureActions = (() => {
    dispatcherCallCount++;
    return Promise.resolve(opts.dispatcherResult);
  }) as unknown as typeof runPrFailureActions;

  const logger = makeCapturingLogger();

  const processorDeps: CiProcessorDeps = {
    promptsDir: PROMPTS_DIR,
    logger,
    deps,
    workDir: tmpDir,
    stateDir: `${tmpDir}/.ci_check_state`,
    ...(opts.repoConfigs !== undefined
      ? { repoConfigs: opts.repoConfigs }
      : {}),
    prFailureActionsFn: dispatcher,
    ...(opts.actionsLogFn !== undefined
      ? { actionsLogFn: opts.actionsLogFn }
      : {}),
  };

  return {
    capturedPrompts,
    get dispatcherCallCount() {
      return dispatcherCallCount;
    },
    logger,
    processorDeps,
    cleanup: () => Deno.remove(tmpDir, { recursive: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("processCiFailure - injects PR failure action excerpt into prompt", async () => {
  const repoConfigs: Record<string, RepoConfig> = {
    "stSoftwareAU/example": {
      ciProviders: [{ provider: "example-ci", jobPath: "foo/job/Develop" }],
    } as unknown as RepoConfig,
  };

  const rig = await makeRig({
    repoConfigs,
    dispatcherResult: [
      {
        providerId: "example-ci",
        ok: true,
        excerpt: {
          providerId: "example-ci",
          buildId: "123",
          status: "FAILURE",
          url: "https://ci.example.com/job/foo/job/Develop/123/",
          logText: "ERROR: example-ci build failed at step compile\n",
        },
      },
    ],
  });

  try {
    const result = await processCiFailure(makeInput(), rig.processorDeps);
    assert(result.ok);
    assertEquals(rig.dispatcherCallCount, 1);
    assertEquals(rig.capturedPrompts.length, 1);
    const prompt = rig.capturedPrompts[0]!;
    assert(
      prompt.includes("## PR Failure Action Output"),
      "excerpt header missing",
    );
    assert(prompt.includes("example-ci build #123"), "build header missing");
    assert(
      prompt.includes("ERROR: example-ci build failed at step compile"),
      "log tail missing",
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("processCiFailure - all-errors dispatcher result is logged but does not abort", async () => {
  const repoConfigs: Record<string, RepoConfig> = {
    "stSoftwareAU/example": {
      ciProviders: [{ provider: "example-ci", jobPath: "foo/job/Develop" }],
    } as unknown as RepoConfig,
  };

  const rig = await makeRig({
    repoConfigs,
    dispatcherResult: [
      { providerId: "example-ci", ok: false, error: "example-ci is down" },
    ],
  });

  try {
    const result = await processCiFailure(makeInput(), rig.processorDeps);
    assert(
      result.ok,
      "processCiFailure must succeed despite dispatcher errors",
    );
    assertEquals(rig.dispatcherCallCount, 1);
    assertEquals(rig.capturedPrompts.length, 1);
    const prompt = rig.capturedPrompts[0]!;
    assert(
      !prompt.includes("## PR Failure Action Output"),
      "excerpt block must be absent when all actions fail",
    );

    // The all-errors path must log a warning so operators see the outage.
    const warned = rig.logger.warns.some((w) =>
      w.message.includes("All configured PR failure actions errored")
    );
    assert(warned, "all-errors warning should be emitted");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("processCiFailure - built-in GitHub Actions provider supplies the excerpt with no repo config (Issue #3580)", async () => {
  const actionsLogFn = (() =>
    Promise.resolve({
      kind: "excerpt" as const,
      providerId: "github-actions" as const,
      jobId: 456,
      excerpt: "error: deno test failed — 2 failing",
    })) as unknown as typeof fetchGithubActionsLogExcerpt;

  const rig = await makeRig({ dispatcherResult: [], actionsLogFn });

  try {
    const result = await processCiFailure(
      makeInput({
        checkName: "quality",
        targetUrl: "https://github.com/o/r/actions/runs/123/job/456",
      }),
      rig.processorDeps,
    );
    assert(result.ok);
    assertEquals(rig.dispatcherCallCount, 0);
    const prompt = rig.capturedPrompts[0]!;
    assert(
      prompt.includes("## PR Failure Action Output"),
      "excerpt header missing",
    );
    assert(
      prompt.includes("error: deno test failed — 2 failing"),
      "Actions log excerpt missing from prompt",
    );

    // The chosen provider id must be logged so a fall-through is visible.
    const logged = rig.logger.infos.some((i) =>
      i.message === "CI log provider selected" &&
      i.context?.provider === "github-actions"
    );
    assert(logged, "provider id should be logged");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("processCiFailure - non-Actions check falls through without an excerpt (Issue #3580)", async () => {
  const actionsLogFn = (() =>
    Promise.resolve({
      kind: "not-applicable" as const,
      reason: "check target URL is not a GitHub Actions job URL",
    })) as unknown as typeof fetchGithubActionsLogExcerpt;

  const rig = await makeRig({ dispatcherResult: [], actionsLogFn });

  try {
    const result = await processCiFailure(
      makeInput({ checkName: "continuous-integration/external-ci/pr-head" }),
      rig.processorDeps,
    );
    assert(result.ok, "a non-Actions check must not fail the CI fix flow");
    const prompt = rig.capturedPrompts[0]!;
    assert(
      !prompt.includes("## PR Failure Action Output"),
      "no excerpt expected for a non-Actions check",
    );
    const warned = rig.logger.warns.some((w) =>
      w.message === "No CI log provider produced an excerpt"
    );
    assert(warned, "fall-through should be logged");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("processCiFailure - dispatcher not invoked when repo has no ciProviders", async () => {
  // No repoConfigs entry for the repo => getPrFailureActions returns [].
  const rig = await makeRig({
    dispatcherResult: [],
  });

  try {
    const result = await processCiFailure(makeInput(), rig.processorDeps);
    assert(result.ok);
    assertEquals(rig.dispatcherCallCount, 0);
    assertEquals(rig.capturedPrompts.length, 1);
    const prompt = rig.capturedPrompts[0]!;
    assert(
      !prompt.includes("## PR Failure Action Output"),
      "no excerpt expected without configured actions",
    );
  } finally {
    await rig.cleanup();
  }
});
