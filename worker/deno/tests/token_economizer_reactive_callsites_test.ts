/**
 * TokenEconomizer wiring at the three reactive call sites (Issue #4956, part
 * of #4953).
 *
 * Three agent spawns load the plugin: the PR-feedback run, the first CI-fix
 * spawn, and the CI-fix post-quality retry (a second spawn in the same
 * checkout). Each one builds its launch with `tokenEconomizerSpawnOptions` and
 * spreads the result into the options given to `runClaudeWithRetry`. These
 * tests drive the exported entry points through the same fixtures the RTK
 * suites use, capture the options handed to `runClaudeWithRetry`, and assert:
 *
 * a. An enabled host block gives the spawn a `tokenEconomizer` launch whose
 *    `pluginDir` is the vendored plugin, whose `TE_TOOLPRUNE` is `off`, and
 *    whose `TOKENECONOMIZER_HOME` sits under `<workRoot>/.token-economizer/runs/`.
 * b. No `tokenEconomizer` in the processor deps leaves no `tokenEconomizer`
 *    key in the spawn options.
 *
 * The launch resolves the plugin manifest at the fixed path
 * `/opt/tokeneconomizer/plugin`, and the processors take no seam for it. So the
 * enabled-block tests run only where that manifest is installed (the container
 * image), following `token_economizer_plugin_wiring_test.ts`. The absent-block
 * tests run everywhere.
 *
 * Every test uses a temporary work root from `Deno.makeTempDir`, removed
 * afterwards. The RTK preparer is a scripted seam with no replies, so no
 * `rtk` subprocess runs and nothing reads the process environment.
 *
 * Uses Australian English throughout (behaviour, recognised, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { prFeedbackProcessorCommand } from "../commands/pr_feedback_processor.ts";
import { prCiProcessorCommand } from "../commands/pr_ci_processor.ts";
import { join, sep } from "node:path";
import {
  type PrFeedbackProcessorDeps,
  processPrFeedback,
} from "../lib/pr_feedback_processor.ts";
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
import type { Logger, TokenEconomizerConfig } from "../types.ts";
import { CLAUDE_PROVIDER_ID } from "../lib/agent_provider.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  TOKEN_ECONOMIZER_PLUGIN_DIR,
  type TokenEconomizerLaunch,
} from "../lib/token_economizer_plugin.ts";
import {
  acquireBranchLockWithoutDelay,
  openPrWithBranchLockGh,
} from "./support/pr_branch_lock_stub.ts";
import { rtkSeam } from "./support/rtk_seam.ts";
import type { SpawnOptions } from "./support/rtk_wiring_asserts.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The repository both processors act on. */
const REPO = "org/repo";

const ANNOTATIONS: CheckAnnotation[] = [
  { path: "tests/main_test.ts", start_line: 42, message: "Assertion failed" },
];

/**
 * Whether the vendored plugin manifest is installed here. The launch checks
 * this exact file, so the enabled-block tests are ignored where it is absent.
 */
const REAL_PLUGIN_PRESENT = ((): boolean => {
  try {
    return Deno.statSync(
      join(TOKEN_ECONOMIZER_PLUGIN_DIR, ".claude-plugin", "plugin.json"),
    ).isFile;
  } catch {
    return false;
  }
})();

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

/** A host block that is switched on, from the shipped defaults. */
function enabledBlock(): TokenEconomizerConfig {
  return { ...buildDefaultWorkerConfig().tokenEconomizer, enabled: true };
}

/**
 * Runs `body` with a fresh work root holding a `clone` directory, and removes
 * the root afterwards. The root is passed in, not the clone, as production does.
 */
async function withTempWorkRoot<T>(
  body: (workRoot: string) => Promise<T>,
): Promise<T> {
  const workRoot = await Deno.makeTempDir({ prefix: "te_4956_callsite_" });
  try {
    await Deno.mkdir(join(workRoot, "clone"));
    return await body(workRoot);
  } finally {
    await Deno.remove(workRoot, { recursive: true });
  }
}

/**
 * Asserts a spawn carries the launch the enabled block produces: the vendored
 * plugin directory, `TE_TOOLPRUNE=off`, and a per-run state
 * directory under the work root.
 */
async function assertLaunchWired(
  spawn: SpawnOptions | undefined,
  workRoot: string,
  label: string,
): Promise<void> {
  assert(spawn, `${label}: expected a captured agent invocation`);
  const launch = spawn.tokenEconomizer as TokenEconomizerLaunch | undefined;
  assert(
    launch !== undefined,
    `${label}: expected a tokenEconomizer launch in the spawn options`,
  );
  assertEquals(launch.pluginDir, TOKEN_ECONOMIZER_PLUGIN_DIR, label);
  assertEquals(launch.env.TE_TOOLPRUNE, "off", label);
  // The launch canonicalises the state path, so compare against the real root.
  const realWork = await Deno.realPath(workRoot);
  const stateRoot = join(realWork, ".token-economizer", "runs") + sep;
  const home = launch.env.TOKENECONOMIZER_HOME ?? "";
  assert(
    home.startsWith(stateRoot),
    `${label}: TOKENECONOMIZER_HOME ${home} must sit under ${stateRoot}`,
  );
}

/** Asserts a spawn was handed no `tokenEconomizer` key at all. */
function assertNoLaunch(spawn: SpawnOptions | undefined, label: string): void {
  assert(spawn, `${label}: expected a captured agent invocation`);
  assertEquals(
    Object.hasOwn(spawn, "tokenEconomizer"),
    false,
    `${label}: no tokenEconomizer key may be present without a host block`,
  );
}

/**
 * One PR-feedback round, returning every spawn handed to `runClaudeWithRetry`.
 * `tokenEconomizer` is left out of the processor deps when `undefined`.
 */
async function runFeedback(
  workRoot: string,
  tokenEconomizer: TokenEconomizerConfig | undefined,
  throughCommand = false,
): Promise<SpawnOptions[]> {
  const spawns: SpawnOptions[] = [];
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: ((options: SpawnOptions) => {
      spawns.push(options);
      return Promise.resolve({
        ok: true,
        value: { output: "Fixed the typo", exitCode: 0, timedOut: false },
      });
    }) as unknown as ClaudeDeps["runClaudeWithRetry"],
    prepareRtkRun: rtkSeam([]).prepare,
    rtkProviderId: () => CLAUDE_PROVIDER_ID,
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: openPrWithBranchLockGh(),
  };
  const deps = createMockDeps({
    claude: mockClaude,
    github: mockGithub,
    git: {
      setupRepo: () =>
        Promise.resolve({ ok: true, value: join(workRoot, "clone") }),
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
    workDir: join(workRoot, "clone"),
    workRoot,
    rtkOutputEnabled: false,
    codegraphContextEnabled: false,
    ...(tokenEconomizer === undefined ? {} : { tokenEconomizer }),
    verifyPushFn: () =>
      Promise.resolve({
        landed: true,
        localSha: "f".repeat(40),
        remoteSha: "f".repeat(40),
        reason: "verified in test",
      }),
  };

  if (throughCommand) {
    const result = await prFeedbackProcessorCommand.execute(
      {
        operation: "process",
        repo: REPO,
        "pr-number": 42,
        "branch-name": "issue-42-fix-bug",
        "comment-type": "review",
        "comment-id": "123",
        "comment-body": "Please fix the typo on line 10",
      },
      buildDefaultWorkerConfig({
        workDir: workRoot,
        tokenEconomizer: tokenEconomizer ??
          buildDefaultWorkerConfig().tokenEconomizer,
        repoConfig: { [REPO]: { skipMutationCheck: true } },
      }),
      deps,
    );
    assertEquals(result.success, true, result.message);
    assert(spawns.length > 0, result.message);
    return spawns;
  }

  const result = await processPrFeedback({
    repo: REPO,
    prNumber: 42,
    branchName: "issue-42-fix-bug",
    commentType: "review",
    commentId: "123",
    commentBody: "Please fix the typo on line 10",
  }, processorDeps);
  assert(result.ok, "a feedback run must complete with the launch wired");
  return spawns;
}

/**
 * One CI-fix round, returning every spawn handed to `runClaudeWithRetry`.
 * With `qualityRetry`, the checkout stays dirty after the fix attempt and a
 * failing quality gate drives the second spawn (Issue #1456).
 */
async function runCiFix(
  workRoot: string,
  options: {
    tokenEconomizer: TokenEconomizerConfig | undefined;
    qualityRetry: boolean;
    throughCommand?: boolean;
  },
): Promise<SpawnOptions[]> {
  const spawns: SpawnOptions[] = [];
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: ((runOptions: SpawnOptions) => {
      spawns.push(runOptions);
      return Promise.resolve({
        ok: true,
        value: { output: "Fixed CI", exitCode: 0, timedOut: false },
      });
    }) as unknown as ClaudeDeps["runClaudeWithRetry"],
    prepareRtkRun: rtkSeam([]).prepare,
    rtkProviderId: () => CLAUDE_PROVIDER_ID,
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: openPrWithBranchLockGh(),
  };
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
      setupRepo: () =>
        Promise.resolve({ ok: true, value: join(workRoot, "clone") }),
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
    stateDir: join(workRoot, ".ci_check_state"),
    workDir: join(workRoot, "clone"),
    workRoot,
    codegraphContextEnabled: false,
    rtkOutputEnabled: false,
    ...(options.tokenEconomizer === undefined
      ? {}
      : { tokenEconomizer: options.tokenEconomizer }),
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

  if (options.throughCommand) {
    const result = await prCiProcessorCommand.execute(
      {
        operation: "process",
        repo: REPO,
        "pr-number": 42,
        "branch-name": "issue-42-fix-bug",
        "check-run-id": "67890",
        "check-name": "CI / test",
        "encoded-annotations": btoa(JSON.stringify(ANNOTATIONS)),
      },
      buildDefaultWorkerConfig({
        workDir: workRoot,
        tokenEconomizer: options.tokenEconomizer ??
          buildDefaultWorkerConfig().tokenEconomizer,
        repoConfig: { [REPO]: { skipMutationCheck: true } },
      }),
      deps,
      acquireBranchLockWithoutDelay,
    );
    assertEquals(result.success, true, result.message);
    assert(spawns.length > 0, result.message);
    return spawns;
  }

  const result = await processCiFailure({
    repo: REPO,
    prNumber: 42,
    branchName: "issue-42-fix-bug",
    checkRunId: "67890",
    checkName: "CI / test",
    encodedAnnotations: btoa(JSON.stringify(ANNOTATIONS)),
  }, processorDeps);
  assert(result.ok, "a CI-fix run must complete with the launch wired");
  return spawns;
}

Deno.test({
  name:
    "pr_feedback_processor - an enabled host block gives the feedback spawn the TokenEconomizer launch (Issue #4956)",
  ignore: !REAL_PLUGIN_PRESENT,
  fn: () =>
    withTempWorkRoot(async (workRoot) => {
      const spawns = await runFeedback(workRoot, enabledBlock());
      assertEquals(spawns.length, 1, "the feedback run must spawn once");
      await assertLaunchWired(spawns[0], workRoot, "feedback spawn");
    }),
});

Deno.test("pr_feedback_processor - with no tokenEconomizer in the deps the feedback spawn has no tokenEconomizer key (Issue #4956)", () =>
  withTempWorkRoot(async (workRoot) => {
    const spawns = await runFeedback(workRoot, undefined);
    assertEquals(spawns.length, 1, "the feedback run must spawn once");
    assertNoLaunch(spawns[0], "feedback spawn");
  }));

Deno.test({
  name:
    "pr_ci_processor - an enabled host block gives the first CI-fix spawn the TokenEconomizer launch (Issue #4956)",
  ignore: !REAL_PLUGIN_PRESENT,
  fn: () =>
    withTempWorkRoot(async (workRoot) => {
      const spawns = await runCiFix(workRoot, {
        tokenEconomizer: enabledBlock(),
        qualityRetry: false,
      });
      assertEquals(spawns.length, 1, "the CI-fix run must spawn once");
      await assertLaunchWired(spawns[0], workRoot, "CI-fix first spawn");
    }),
});

Deno.test("pr_ci_processor - with no tokenEconomizer in the deps the first CI-fix spawn has no tokenEconomizer key (Issue #4956)", () =>
  withTempWorkRoot(async (workRoot) => {
    const spawns = await runCiFix(workRoot, {
      tokenEconomizer: undefined,
      qualityRetry: false,
    });
    assertEquals(spawns.length, 1, "the CI-fix run must spawn once");
    assertNoLaunch(spawns[0], "CI-fix first spawn");
  }));

Deno.test({
  name:
    "pr_ci_processor - an enabled host block gives the post-quality CI-fix retry the TokenEconomizer launch (Issue #4956)",
  ignore: !REAL_PLUGIN_PRESENT,
  fn: () =>
    withTempWorkRoot(async (workRoot) => {
      const spawns = await runCiFix(workRoot, {
        tokenEconomizer: enabledBlock(),
        qualityRetry: true,
      });
      assertEquals(spawns.length, 2, "the quality retry must have spawned");
      await assertLaunchWired(spawns[1], workRoot, "CI-fix retry spawn");
    }),
});

Deno.test("pr_ci_processor - with no tokenEconomizer in the deps the post-quality retry has no tokenEconomizer key (Issue #4956)", () =>
  withTempWorkRoot(async (workRoot) => {
    const spawns = await runCiFix(workRoot, {
      tokenEconomizer: undefined,
      qualityRetry: true,
    });
    assertEquals(spawns.length, 2, "the quality retry must have spawned");
    assertNoLaunch(spawns[1], "CI-fix retry spawn");
  }));

for (const enabled of [false, true]) {
  for (const kind of ["pr-feedback", "ci-fix"] as const) {
    Deno.test({
      name: `${kind} command carries the ${
        enabled ? "enabled" : "disabled"
      } host block to the agent (Issue #4956)`,
      ignore: enabled && !REAL_PLUGIN_PRESENT,
      fn: () =>
        withTempWorkRoot(async (workRoot) => {
          const block = { ...enabledBlock(), enabled };
          const spawns = kind === "pr-feedback"
            ? await runFeedback(workRoot, block, true)
            : await runCiFix(workRoot, {
              tokenEconomizer: block,
              qualityRetry: false,
              throughCommand: true,
            });
          assert(spawns.length > 0, "the command must reach the agent");
          for (const spawn of spawns) {
            if (enabled) {
              await assertLaunchWired(
                spawn,
                workRoot,
                `${kind} command enabled`,
              );
            } else assertNoLaunch(spawn, `${kind} command disabled`);
          }
        }),
    });
  }
}
