/**
 * RTK output filtering wired into the PR-feedback run (Issue #2384, part of
 * #2328).
 *
 * Mirrors the issue-path suite (#2383), in both directions: off changes
 * nothing about the spawn, an available RTK installs the `Bash` hook and the
 * one recall line together, and a missing binary or a provider that takes no
 * hooks gets neither while the feedback run itself carries on.
 *
 * Every test calls the real `prepareRtkRun` through a scripted subprocess
 * seam, and the provider id is injected — nothing here reads or writes the
 * process environment.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
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
import { CLAUDE_PROVIDER_ID } from "../lib/agent_provider.ts";
import { OPERATIONAL_DEFAULTS } from "../lib/config_defaults.ts";
import { CODEGRAPH_PROMPT_LINE } from "../lib/codegraph_context.ts";
import type { RtkOutputResult } from "../lib/rtk_output.ts";
import { openPrGh } from "./support/pr_live_state_stub.ts";
import {
  healthyRtkSeam,
  rtkMissing,
  type RtkSeam,
  rtkSeam,
} from "./support/rtk_seam.ts";
import {
  assertCarriesRtkHook,
  assertNoRtkHook,
  assertOnlyRtkDiffers,
  assertRtkOutsideCodegraph,
  type SpawnOptions,
} from "./support/rtk_wiring_asserts.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

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

/** A CodeGraph preparer reporting a built index, so both accelerators run. */
const INDEXED_CODEGRAPH =
  (() =>
    Promise.resolve({ status: "ok", enabled: true, nodeCount: 1 })) as never;

interface Observed {
  runOptions: SpawnOptions[];
  rtkOutput?: RtkOutputResult;
}

/**
 * Run one feedback round.
 *
 * @param enabled - The host switch, or `undefined` to leave the option out
 *   altogether and take the processor's own default
 */
async function runFeedback(
  enabled: boolean | undefined,
  seam: RtkSeam,
  providerId: string = CLAUDE_PROVIDER_ID,
  codegraphToo = false,
): Promise<Observed> {
  const observed: Observed = { runOptions: [] };
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: ((options: SpawnOptions) => {
      observed.runOptions.push(options);
      return Promise.resolve({
        ok: true,
        value: { output: "Fixed the typo", exitCode: 0, timedOut: false },
      });
    }) as unknown as ClaudeDeps["runClaudeWithRetry"],
    prepareRtkRun: seam.prepare,
    rtkProviderId: () => providerId,
    ...(codegraphToo ? { prepareCodegraphContext: INDEXED_CODEGRAPH } : {}),
  };
  const mockGithub: Partial<GitHubDeps> = { runGhCommand: openPrGh() };
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

  const processorDeps: PrFeedbackProcessorDeps = {
    promptsDir: PROMPTS_DIR,
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/rtk-2384-feedback-clone",
    workRoot: "/tmp/rtk-2384-feedback-work",
    ...(enabled === undefined ? {} : { rtkOutputEnabled: enabled }),
    codegraphContextEnabled: codegraphToo,
    verifyPushFn: () =>
      Promise.resolve({
        landed: true,
        localSha: "f".repeat(40),
        remoteSha: "f".repeat(40),
        reason: "verified in test",
      }),
  };

  const result = await processPrFeedback({
    repo: "org/repo",
    prNumber: 42,
    branchName: "issue-42-fix-bug",
    commentType: "review",
    commentId: "123",
    commentBody: "Please fix the typo on line 10",
  }, processorDeps);
  assert(result.ok, "losing or lacking RTK must never fail a feedback run");
  observed.rtkOutput = result.value.rtkOutput;
  return observed;
}

Deno.test("pr_feedback_processor - the RTK switch off spawns no rtk, no settings and an unchanged prompt (Issue #2384)", async () => {
  const seam = rtkSeam([]);
  const observed = await runFeedback(false, seam);

  assertEquals(seam.prepared.length, 1, "the run reports a status even off");
  assertEquals(seam.prepared[0]?.enabled, false);
  assertEquals(seam.calls.length, 0, "a switched-off host spawns no rtk");
  assertEquals(observed.runOptions.length, 1);
  assertNoRtkHook(observed.runOptions[0]);
  assertEquals(observed.rtkOutput, { enabled: false, status: "off" });
});

Deno.test("pr_feedback_processor - a caller that never names the RTK switch gets the shipped default (Issue #2432)", async () => {
  const seam = healthyRtkSeam(100, 140);
  const observed = await runFeedback(undefined, seam);

  // The fallback is the one written in OPERATIONAL_DEFAULTS, never a second
  // literal here: a processor that kept its own `false` would leave a path
  // unfiltered on a host whose config says nothing.
  assertEquals(OPERATIONAL_DEFAULTS.rtkOutput.enabled, true);
  assertEquals(seam.prepared[0]?.enabled, true);
  assertCarriesRtkHook(observed.runOptions[0]);
  assertEquals(observed.rtkOutput?.status, "ok");
});

Deno.test("pr_feedback_processor - the RTK switch on installs the hook and the prompt line together (Issue #2384)", async () => {
  const off = await runFeedback(false, rtkSeam([]));
  const seam = healthyRtkSeam(100, 140);
  const on = await runFeedback(true, seam);

  // The preparation saw the host switch, the run's provider and its checkout.
  assertEquals(seam.prepared[0]?.enabled, true);
  assertEquals(seam.prepared[0]?.providerId, CLAUDE_PROVIDER_ID);
  assertEquals(seam.prepared[0]?.cwd, "/tmp/rtk-2384-feedback-clone");

  // The hook and the line ride together, and they are the *only* thing the
  // switch does to the invocation — the off run is today's run.
  assertCarriesRtkHook(on.runOptions[0]);
  assertOnlyRtkDiffers(on.runOptions[0], off.runOptions[0]);

  // The figure is read again once the invocation is over.
  assertEquals(seam.calls.length, 3, "version, baseline, then the second read");
  assertEquals(on.rtkOutput, { enabled: true, status: "ok", savedTokens: 40 });
});

Deno.test("pr_feedback_processor - a host without rtk runs unfiltered rather than failing (Issue #2384)", async () => {
  const seam = rtkSeam([rtkMissing()]);
  const observed = await runFeedback(true, seam);

  assertEquals(observed.runOptions.length, 1, "the run still proceeds");
  assertNoRtkHook(observed.runOptions[0]);
  assertEquals(observed.rtkOutput, { enabled: true, status: "failed" });
});

Deno.test("pr_feedback_processor - a provider that takes no hooks is reported, not filtered (Issue #2384)", async () => {
  const seam = rtkSeam([]);
  const observed = await runFeedback(true, seam, "gemini");

  assertEquals(seam.calls.length, 0, "an unsupported provider spawns no rtk");
  assertEquals(observed.runOptions.length, 1, "the run still proceeds");
  assertNoRtkHook(observed.runOptions[0]);
  assertEquals(observed.rtkOutput, {
    enabled: true,
    status: "unsupported",
    provider: "gemini",
  });
});

Deno.test("pr_feedback_processor - RTK's pair rides outside CodeGraph's when both are on (Issue #2384)", async () => {
  const seam = healthyRtkSeam(100, 140);
  const observed = await runFeedback(true, seam, CLAUDE_PROVIDER_ID, true);

  assertRtkOutsideCodegraph(observed.runOptions[0], CODEGRAPH_PROMPT_LINE);
  assertEquals(observed.rtkOutput?.status, "ok");
});
