/**
 * The codebase map in the main-loop execute phase (Issue #2621, part of
 * #2581).
 *
 * The fleet's issue runs go through `lib/phases/execute_phase.ts`, not the
 * `execute-claude-phase` CLI, so a map wired only on the CLI path left
 * `include_codebase_map` inert on every run that matters. These cases hold the
 * phase to the CLI's behaviour: the map reaches the prompt, and a map fault is
 * non-fatal.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type {
  CachedCodebaseMap,
  GetOrGenerateCodebaseMapOptions,
} from "../lib/codebase_map_cache.ts";
import type { Result } from "../types.ts";

const REPO_PATH = "/tmp/codebase-map-2621-repo";

interface PhaseRun {
  mapCalls: GetOrGenerateCodebaseMapOptions[];
  promptMaps: (string | undefined)[];
  state: PhaseState;
}

/** Run the phase with the given switches and map outcome; record what it did. */
async function runPhase(opts: {
  includeCodebaseMap: boolean;
  mapResult: Result<CachedCodebaseMap>;
}): Promise<PhaseRun> {
  const config = buildDefaultWorkerConfig();
  config.includeCodebaseMap = opts.includeCodebaseMap;
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 2621,
    issueTitle: "Render the codebase map on the main loop",
    issueBody: "Do the thing.",
    issueLabels: ["enhancement"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-2621-codebase-map",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: REPO_PATH,
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const mapCalls: GetOrGenerateCodebaseMapOptions[] = [];
  const promptMaps: (string | undefined)[] = [];

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
      getCodebaseMap: (options: GetOrGenerateCodebaseMapOptions) => {
        mapCalls.push(options);
        return Promise.resolve(opts.mapResult);
      },
      buildPrompt: ((options: { codebaseMap?: string }) => {
        promptMaps.push(options.codebaseMap);
        return Promise.resolve({
          ok: true,
          value: { systemPrompt: "mock system", prompt: "mock prompt" },
        });
      }) as never,
    },
  });

  await workOnIssueExecuteClaude(ctx, state, deps);
  return { mapCalls, promptMaps, state };
}

function mapOk(): Result<CachedCodebaseMap> {
  return {
    ok: true,
    value: {
      content: "## Codebase map\n- lib/",
      treeHash: "abcdef0123456789",
      cacheHit: false,
    },
  };
}

Deno.test("execute_phase - the map reaches the prompt (Issue #2621)", async () => {
  const run = await runPhase({
    includeCodebaseMap: true,
    mapResult: mapOk(),
  });

  assertEquals(run.mapCalls.length, 1);
  assertEquals(run.mapCalls[0]?.repo, "org/repo");
  assertEquals(run.mapCalls[0]?.repoDir, REPO_PATH);
  assertEquals(run.promptMaps, ["## Codebase map\n- lib/"]);
});

Deno.test("execute_phase - include_codebase_map off builds no map (Issue #2621)", async () => {
  const run = await runPhase({
    includeCodebaseMap: false,
    mapResult: mapOk(),
  });

  assertEquals(run.mapCalls.length, 0);
  assertEquals(run.promptMaps, [undefined]);
});

Deno.test("execute_phase - a map fault is non-fatal (Issue #2621)", async () => {
  const run = await runPhase({
    includeCodebaseMap: true,
    mapResult: { ok: false, error: new Error("git ls-files failed") },
  });

  assertEquals(run.mapCalls.length, 1);
  assertEquals(
    run.promptMaps,
    [undefined],
    "the run proceeds unmapped rather than failing",
  );
});
