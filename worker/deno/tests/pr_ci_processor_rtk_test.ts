/**
 * RTK output filtering wired into the CI-fix run (Issue #2384, part of #2328).
 *
 * Mirrors the issue-path suite (#2383), in both directions, plus the two
 * things this path has that the others do not:
 *
 *   - **The post-quality retry is a second spawn.** It must carry the same
 *     hook and the same line as the first attempt, from one preparation, and
 *     the saved-token figure must cover both.
 *   - **`workDir` is optional here.** The hook rides on the command line, so a
 *     run without a named checkout still records a status rather than throwing.
 *
 * Every test calls the real `prepareRtkRun` through a scripted subprocess
 * seam, and the provider id is injected — nothing here reads or writes the
 * process environment.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import type { Logger } from "../types.ts";
import { CLAUDE_PROVIDER_ID } from "../lib/agent_provider.ts";
import { OPERATIONAL_DEFAULTS } from "../lib/config_defaults.ts";
import { CODEGRAPH_PROMPT_LINE } from "../lib/codegraph_context.ts";
import type { RtkOutputResult } from "../lib/rtk_output.ts";
import { openPrGh } from "./support/pr_live_state_stub.ts";
import {
  healthyRtkSeam,
  rtkGain,
  rtkMissing,
  type RtkSeam,
  rtkSeam,
  rtkVersion,
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

const ANNOTATIONS: CheckAnnotation[] = [
  { path: "tests/main_test.ts", start_line: 42, message: "Assertion failed" },
];

/** A CodeGraph preparer reporting a built index, so both accelerators run. */
const INDEXED_CODEGRAPH =
  (() =>
    Promise.resolve({ status: "ok", enabled: true, nodeCount: 1 })) as never;

interface Observed {
  runOptions: SpawnOptions[];
  workDir: string;
  rtkOutput?: RtkOutputResult;
}

interface RunOptions {
  /** The host switch, or absent to take the processor's own default. */
  enabled?: boolean;
  /** The scripted `rtk` answers. */
  seam: RtkSeam;
  /** The provider the run is under. */
  providerId?: string;
  /** Drive the post-quality retry (Issue #1456) as well. */
  qualityRetry?: boolean;
  /** Leave `workDir` out of the processor's deps altogether. */
  noWorkDir?: boolean;
  /** Switch CodeGraph on as well, with a built index. */
  codegraphToo?: boolean;
}

async function runCiFix(options: RunOptions): Promise<Observed> {
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-rtk-2384-ci-" });
  const observed: Observed = { runOptions: [], workDir: tmpDir };
  try {
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: ((runOptions: SpawnOptions) => {
        observed.runOptions.push(runOptions);
        return Promise.resolve({
          ok: true,
          value: { output: "Fixed CI", exitCode: 0, timedOut: false },
        });
      }) as unknown as ClaudeDeps["runClaudeWithRetry"],
      prepareRtkRun: options.seam.prepare,
      rtkProviderId: () => options.providerId ?? CLAUDE_PROVIDER_ID,
      ...(options.codegraphToo
        ? { prepareCodegraphContext: INDEXED_CODEGRAPH }
        : {}),
    };
    const mockGithub: Partial<GitHubDeps> = { runGhCommand: openPrGh() };
    // Uncommitted changes before and after the gate, so the retry path runs.
    const gitMock = ((args: string[]) =>
      Promise.resolve({
        ok: true,
        value: {
          code: 0,
          stdout: args[0] === "status" && options.qualityRetry
            ? " M src/broken.ts\n"
            : "",
          stderr: "",
        },
      })) as unknown as GitDeps["runGitCommand"];
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        runGitCommand: gitMock,
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

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      ...(options.noWorkDir ? {} : { workDir: tmpDir }),
      workRoot: tmpDir,
      codegraphContextEnabled: options.codegraphToo === true,
      ...(options.enabled === undefined
        ? {}
        : { rtkOutputEnabled: options.enabled }),
      ...(options.qualityRetry
        ? {
          qualityGateFn: () =>
            Promise.resolve({
              action: "failed_fixable" as const,
              qualityOutput: "deno check failed",
              retryPrompt: "./quality.sh failing:\ndeno check failed",
            }),
        }
        : {}),
      verifyPushFn: () =>
        Promise.resolve({
          landed: true,
          localSha: "f".repeat(40),
          remoteSha: "f".repeat(40),
          reason: "verified in test",
        }),
    };

    const result = await processCiFailure({
      repo: "org/repo",
      prNumber: 42,
      branchName: "issue-42-fix-bug",
      checkRunId: "67890",
      checkName: "CI / test",
      encodedAnnotations: btoa(JSON.stringify(ANNOTATIONS)),
    }, processorDeps);
    assert(result.ok, "losing or lacking RTK must never fail a CI fix run");
    observed.rtkOutput = result.value.rtkOutput;
    return observed;
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("pr_ci_processor - the RTK switch off spawns no rtk, no settings and an unchanged prompt (Issue #2384)", async () => {
  const seam = rtkSeam([]);
  const observed = await runCiFix({
    enabled: false,
    seam,
    qualityRetry: true,
  });

  assertEquals(seam.prepared.length, 1, "the run reports a status even off");
  assertEquals(seam.prepared[0]?.enabled, false);
  assertEquals(seam.calls.length, 0, "a switched-off host spawns no rtk");
  assertEquals(observed.runOptions.length, 2, "the retry must have run");
  for (const spawn of observed.runOptions) assertNoRtkHook(spawn);
  assertEquals(observed.rtkOutput, { enabled: false, status: "off" });
});

Deno.test("pr_ci_processor - a caller that never names the RTK switch gets the shipped default (Issue #2432)", async () => {
  const seam = healthyRtkSeam(100, 140);
  const observed = await runCiFix({ seam });

  // The fallback is the one written in OPERATIONAL_DEFAULTS, never a second
  // literal here: a processor that kept its own `false` would leave a path
  // unfiltered on a host whose config says nothing.
  assertEquals(OPERATIONAL_DEFAULTS.rtkOutput.enabled, true);
  assertEquals(seam.prepared[0]?.enabled, true);
  assertCarriesRtkHook(observed.runOptions[0]);
  assertEquals(observed.rtkOutput?.status, "ok");
});

Deno.test("pr_ci_processor - the RTK switch on installs the hook and the prompt line together (Issue #2384)", async () => {
  const off = await runCiFix({ enabled: false, seam: rtkSeam([]) });
  const seam = healthyRtkSeam(100, 140);
  const on = await runCiFix({ enabled: true, seam });

  // The preparation saw the host switch, the run's provider and its checkout.
  assertEquals(seam.prepared[0]?.enabled, true);
  assertEquals(seam.prepared[0]?.providerId, CLAUDE_PROVIDER_ID);
  assertEquals(seam.prepared[0]?.cwd, on.workDir);

  // The hook and the line ride together, and they are the *only* thing the
  // switch does to the invocation — the off run is today's run.
  assertEquals(on.runOptions.length, 1);
  assertCarriesRtkHook(on.runOptions[0]);
  assertOnlyRtkDiffers(on.runOptions[0], off.runOptions[0]);

  // The figure is read again once the invocation is over.
  assertEquals(seam.calls.length, 3, "version, baseline, then the second read");
  assertEquals(on.rtkOutput, { enabled: true, status: "ok", savedTokens: 40 });
});

Deno.test("pr_ci_processor - the post-quality retry carries the same hook from one preparation (Issue #2384)", async () => {
  const off = await runCiFix({
    enabled: false,
    seam: rtkSeam([]),
    qualityRetry: true,
  });
  // Version, baseline, one read after the fix attempt, one after the retry.
  const seam = rtkSeam([
    rtkVersion(),
    rtkGain(100),
    rtkGain(140),
    rtkGain(175),
  ]);
  const on = await runCiFix({ enabled: true, seam, qualityRetry: true });

  assertEquals(on.runOptions.length, 2, "the retry must have run");
  assertEquals(
    seam.prepared.length,
    1,
    "the retry reuses the prepared run rather than probing rtk again",
  );
  for (const [index, spawn] of on.runOptions.entries()) {
    assertCarriesRtkHook(spawn);
    assertOnlyRtkDiffers(spawn, off.runOptions[index]);
  }

  assertEquals(seam.calls.length, 4, "the figure is re-read after each spawn");
  assertEquals(
    on.rtkOutput,
    { enabled: true, status: "ok", savedTokens: 75 },
    "the figure covers the fix attempt and the retry, from one baseline",
  );
});

Deno.test("pr_ci_processor - a run with no workDir still records a status rather than throwing (Issue #2384)", async () => {
  const seam = healthyRtkSeam(100, 140);
  const observed = await runCiFix({ enabled: true, seam, noWorkDir: true });

  assertEquals(seam.prepared.length, 1);
  assertEquals(
    Object.hasOwn(seam.prepared[0] ?? {}, "cwd"),
    false,
    "an unnamed checkout is left out, never passed as undefined",
  );
  // The hook rides on the command line, so it needs no checkout to install.
  assertCarriesRtkHook(observed.runOptions[0]);
  assertEquals(observed.rtkOutput, {
    enabled: true,
    status: "ok",
    savedTokens: 40,
  });

  // And the opposite: off with no workDir is still a plain `off`.
  const offSeam = rtkSeam([]);
  const off = await runCiFix({
    enabled: false,
    seam: offSeam,
    noWorkDir: true,
  });
  assertNoRtkHook(off.runOptions[0]);
  assertEquals(off.rtkOutput, { enabled: false, status: "off" });
});

Deno.test("pr_ci_processor - a host without rtk runs unfiltered rather than failing (Issue #2384)", async () => {
  const seam = rtkSeam([rtkMissing()]);
  const observed = await runCiFix({ enabled: true, seam, qualityRetry: true });

  assertEquals(observed.runOptions.length, 2, "the run still proceeds");
  for (const spawn of observed.runOptions) assertNoRtkHook(spawn);
  assertEquals(seam.calls.length, 1, "a failed preflight is never re-read");
  assertEquals(observed.rtkOutput, { enabled: true, status: "failed" });
});

Deno.test("pr_ci_processor - a provider that takes no hooks is reported, not filtered (Issue #2384)", async () => {
  const seam = rtkSeam([]);
  const observed = await runCiFix({
    enabled: true,
    seam,
    providerId: "gemini",
    qualityRetry: true,
  });

  assertEquals(seam.calls.length, 0, "an unsupported provider spawns no rtk");
  assertEquals(observed.runOptions.length, 2, "the run still proceeds");
  for (const spawn of observed.runOptions) assertNoRtkHook(spawn);
  assertEquals(observed.rtkOutput, {
    enabled: true,
    status: "unsupported",
    provider: "gemini",
  });
});

Deno.test("pr_ci_processor - RTK's pair rides outside CodeGraph's on both spawns when both are on (Issue #2384)", async () => {
  const seam = rtkSeam([
    rtkVersion(),
    rtkGain(100),
    rtkGain(140),
    rtkGain(175),
  ]);
  const observed = await runCiFix({
    enabled: true,
    seam,
    qualityRetry: true,
    codegraphToo: true,
  });

  assertEquals(observed.runOptions.length, 2, "the retry must have run");
  for (const spawn of observed.runOptions) {
    assertRtkOutsideCodegraph(spawn, CODEGRAPH_PROMPT_LINE);
  }
  assertEquals(observed.rtkOutput?.status, "ok");
});
