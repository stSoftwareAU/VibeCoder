/**
 * Issue #4630: the PR-feedback repair push must not go out ungated.
 *
 * `processPrFeedback` hands its final-mile push to `commitAndPushPending` with
 * the repo's pre-flight spec as the fifth argument. A repo with no pre-flight
 * commands has no such spec, so the processor substitutes
 * `CI_CARGO_ONLY_PRE_FLIGHT`, and the push then runs the repo CI's cargo checks.
 * A repo that does configure pre-flight commands keeps its own spec.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
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
import type { PreFlightGateSpec } from "../lib/git_push.ts";
import type { Logger, RepoConfig } from "../types.ts";
import { openPrGh } from "./support/pr_live_state_stub.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

const FINAL_MILE_PREFIX = "Address PR #";

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

function makeInput(): PrFeedbackInput {
  return {
    repo: "org/repo",
    prNumber: 4630,
    branchName: "issue-4630-feedback",
    commentType: "review",
    commentId: "999",
    commentBody: "Please fix the clippy lint",
  };
}

/** The pre-flight spec each final-mile `commitAndPushPending` call received. */
async function capturePreFlightSpecs(
  repoConfigs?: Record<string, RepoConfig>,
): Promise<unknown[]> {
  const workDir = await Deno.makeTempDir({ prefix: "pr-feedback-4630-" });
  try {
    const finalMile: unknown[] = [];
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "Fixed", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGit: Partial<GitDeps> = {
      commitAndPushPending: ((...args: unknown[]) => {
        if (String(args[1]).startsWith(FINAL_MILE_PREFIX)) {
          finalMile.push(args[4]);
        }
        return Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: false,
            commitsPushed: 0,
            finalUnpushedCount: 0,
          },
        });
      }) as unknown as GitDeps["commitAndPushPending"],
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: { runGhCommand: openPrGh() } as Partial<GitHubDeps>,
      git: mockGit,
    });
    const processorDeps: PrFeedbackProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      workDir,
      workRoot: workDir,
      ...(repoConfigs ? { repoConfigs } : {}),
    };

    await processPrFeedback(makeInput(), processorDeps);
    return finalMile;
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

Deno.test("processPrFeedback - repair push (Issue #4630): no pre-flight commands passes the cargo-only spec", async () => {
  const finalMile = await capturePreFlightSpecs();

  assertEquals(finalMile.length >= 1, true, "expected a final-mile push");
  const spec = finalMile[0] as PreFlightGateSpec | undefined;
  assertEquals(spec?.ciCargoOnly, true);
  assertEquals(spec?.commands, []);
});

Deno.test("processPrFeedback - repair push (Issue #4630): a repo's own pre-flight spec is kept", async () => {
  const finalMile = await capturePreFlightSpecs({
    "org/repo": { preFlight: ["deno task check"] },
  });

  assertEquals(finalMile.length >= 1, true, "expected a final-mile push");
  const spec = finalMile[0] as PreFlightGateSpec | undefined;
  assertEquals(spec?.commands, ["deno task check"]);
  assert(spec?.ciCargoOnly !== true, "a configured repo is not cargo-only");
});

/** The `ciCargoCompareRef` each agent run of one feedback pass was handed. */
async function agentCompareRefs(baseRefName: string): Promise<unknown[]> {
  const workDir = await Deno.makeTempDir({ prefix: "pr-feedback-4630-" });
  try {
    const seen: unknown[] = [];
    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: ((request: { ciCargoCompareRef?: string }) => {
          seen.push(request.ciCargoCompareRef);
          return Promise.resolve({
            ok: true,
            value: { output: "Fixed", exitCode: 0, timedOut: false },
          });
        }) as unknown as ClaudeDeps["runClaudeWithRetry"],
      },
      github: {
        runGhCommand: openPrGh((args) =>
          Promise.resolve(args.includes("baseRefName") ? baseRefName : "")
        ),
      } as Partial<GitHubDeps>,
      git: {
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
    await processPrFeedback(makeInput(), {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      workDir,
      workRoot: workDir,
    });
    return seen;
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

Deno.test("processPrFeedback - agent run (Issue #4630 review): the agent's own push compares CI cargo against the PR base", async () => {
  const seen = await agentCompareRefs("release/1");
  assert(seen.length >= 1, "expected an agent run");
  assertEquals(seen[0], "origin/release/1");
});

Deno.test('processPrFeedback - agent run (Issue #4630 review): an unreadable PR base is "" (comparison required), not undefined', async () => {
  const seen = await agentCompareRefs("");
  assert(seen.length >= 1, "expected an agent run");
  assertEquals(seen[0], "");
});
