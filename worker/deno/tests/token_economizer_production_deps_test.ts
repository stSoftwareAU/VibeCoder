/**
 * Drive the run-core callbacks through the real PR processors to the agent
 * boundary. Capturing an internal processor's config alone would not prove
 * that an enabled host actually offers the plugin to its coding agent.
 */
import { assert, assertEquals } from "@std/assert";
import { join, sep } from "node:path";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { processPrFeedback } from "../lib/pr_feedback_processor.ts";
import { processCiFailure } from "../lib/pr_ci_processor.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";
import { CLAUDE_PROVIDER_ID } from "../lib/agent_provider.ts";
import { openPrWithBranchLockGh } from "./support/pr_branch_lock_stub.ts";
import { rtkSeam } from "./support/rtk_seam.ts";
import { captureContentSnapshot } from "../lib/content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import type { TokenEconomizerRunStats } from "../lib/token_economizer_run_stats.ts";
import { envFrom } from "./support/env_lookup.ts";

const REPO = "org/repo";
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

for (const kind of ["pr-feedback", "ci-fix"] as const) {
  for (const enabled of [false, true]) {
    Deno.test(`run-core ${kind} reaches the agent with TokenEconomizer ${enabled ? "on" : "off"}`, async () => {
      const workDir = await Deno.makeTempDir({ prefix: "te-production-deps-" });
      const repoDir = join(workDir, "repo");
      const pluginDir = join(workDir, "plugin");
      await Deno.mkdir(repoDir);
      await Deno.mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
      await Deno.writeTextFile(
        join(pluginDir, ".claude-plugin", "plugin.json"),
        '{"name":"tokeneconomizer-fixture"}\n',
      );
      const invocations: RunClaudeOptions[] = [];
      const messages: string[] = [];
      const testLogger = createLogger({
        write: (message) => messages.push(message),
      });
      const workerDeps = createMockDeps({
        claude: {
          tokenEconomizerPluginDir: pluginDir,
          runClaudeWithRetry: (options) => {
            invocations.push(options);
            return Promise.resolve({
              ok: true,
              value: {
                output: "Fixed the issue",
                exitCode: 0,
                timedOut: false,
              },
            });
          },
          prepareRtkRun: rtkSeam([]).prepare,
          rtkProviderId: () => CLAUDE_PROVIDER_ID,
        },
        github: { runGhCommand: openPrWithBranchLockGh() },
        git: {
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
      // The production factory binds heartbeat writes to live GitHub. Keep
      // the injected external heartbeat transport for this offline fixture.
      const crashHandling = { ...workerDeps.crashHandling };
      // GitHub coordination and remote push checks are external boundaries.
      // The processors remain real and receive the factory's host configuration.
      const verifyPushFn = () =>
        Promise.resolve({
          landed: true,
          localSha: "f".repeat(40),
          remoteSha: "f".repeat(40),
          reason: "verified by the test remote",
        });
      let cleanup: (() => void) | undefined;
      try {
        const production = await createProductionRunCoreDeps({
          repoDir,
          workDir,
          githubUser: "test-user",
          logger: testLogger,
          workerDeps,
          config: buildDefaultWorkerConfig({
            workDir,
            repos: [REPO],
            rtkOutput: { enabled: false },
            codegraphContext: { enabled: false },
            tokenEconomizer: {
              ...buildDefaultWorkerConfig().tokenEconomizer,
              enabled,
            },
          }),
          findPrCommentsToFix: () =>
            Promise.resolve({
              ok: true,
              value: {
                repo: REPO,
                prNumber: 42,
                branchName: "issue-42-fix",
                commentType: "review",
                commentId: "123",
                encodedBody: btoa("Please fix the typo"),
              },
            }),
          findFailedCiChecks: () =>
            Promise.resolve({
              ok: true,
              value: {
                repo: REPO,
                prNumber: 42,
                branchName: "issue-42-fix",
                checkId: "check-1",
                checkName: "build",
                encodedAnnotations: btoa("[]"),
              },
            }),
          setupRepoFn: () =>
            Promise.resolve({ success: true, message: repoDir }),
          runGitCommandFn: () =>
            Promise.resolve({
              ok: true,
              value: { code: 0, stdout: "", stderr: "" },
            }),
          processPrFeedbackFn: (input, deps) =>
            processPrFeedback(input, {
              ...deps,
              deps: { ...deps.deps, crashHandling },
              promptsDir: PROMPTS_DIR,
              workerId: undefined,
              prUpdateLockHeldFn: async () => false,
              verifyPushFn,
            }),
          processCiFailure: (input, deps) =>
            processCiFailure(input, {
              ...deps,
              deps: { ...deps.deps, crashHandling },
              promptsDir: PROMPTS_DIR,
              workerId: undefined,
              verifyPushFn,
            }),
        });
        cleanup = production.cleanup;
        const result = kind === "pr-feedback"
          ? await production.deps.findAndProcessPrFeedback()
          : await production.deps.findAndProcessCiFailure();
        assertEquals(
          result,
          { ok: true, value: { processed: true } },
          messages.join("\n"),
        );
        assert(
          invocations.length > 0,
          "the real processor must reach the agent",
        );
        for (const invocation of invocations) {
          if (enabled) {
            const launch = invocation.tokenEconomizer;
            assert(launch, "the enabled host's agent must receive the launch");
            assertEquals(launch.pluginDir, pluginDir);
            assertEquals(launch.env.TE_TOOLPRUNE, "off");
            assertEquals(launch.env.TE_MICROSKILLS, "envfacts");
            assert(
              launch.env.TOKENECONOMIZER_HOME.startsWith(
                join(
                  await Deno.realPath(workDir),
                  ".token-economizer",
                  "runs",
                ) + sep,
              ),
              "the agent's state must stay under the work root",
            );
          } else {
            assertEquals(invocation.tokenEconomizer, undefined);
          }
        }
      } finally {
        cleanup?.();
        await Deno.remove(workDir, { recursive: true });
      }
    });
  }
}

const STATS: TokenEconomizerRunStats = {
  enabled: true,
  status: "stopped",
  persistence: "unavailable",
  factsInjected: 4958,
};

/** Run one issue through the production `processIssue` with a stubbed worker. */
for (const expectedSkip of [false, true]) {
  Deno.test(
    `production processIssue ${
      expectedSkip ? "drops" : "surfaces"
    } the TokenEconomizer stats for the callbacks (skip=${expectedSkip})`,
    async () => {
      const root = await Deno.makeTempDir({ prefix: "te-process-issue-" });
      const repo = "org/repo",
        title = "Fix login bug",
        body = "Fix src/auth.ts";
      const config = {
        ...buildDefaultWorkerConfig(),
        workDir: root,
        allowedAuthors: ["test-user"],
      };
      const snapshot = await captureContentSnapshot(
        resolveContentApprovalStateDir(root),
        repo,
        42,
        title,
        body,
        "test-user",
      );
      assertEquals(snapshot.ok, true);
      const worker = createMockDeps({
        github: {
          runGhCommand: () =>
            Promise.resolve(
              JSON.stringify({
                title,
                body,
                author: { login: "test-user" },
                labels: [{ name: "work-on" }],
                comments: [],
                state: "OPEN",
              }),
            ),
        },
      });
      const production = await createProductionRunCoreDeps({
        repoDir: root,
        workDir: root,
        githubUser: "test-user",
        logger: createLogger({ write: () => {} }),
        config,
        workerDeps: worker,
        env: envFrom({ HOME: root }),
        workOnIssue: () =>
          Promise.resolve({
            success: false,
            category: "quality_check" as const,
            expectedSkip,
            phase: "completion",
            reason: "quality.sh: 2 tests failed",
            timings: {},
            tokenEconomizer: STATS,
          }),
      });
      try {
        const result = await production.deps.processIssue({
          repo,
          issueNumber: 42,
          issueTitle: title,
          milestoneTitle: "",
        });
        assert(result.ok);
        assertEquals(result.value.skipped, expectedSkip);
        assertEquals(
          result.value.tokenEconomizer,
          expectedSkip ? undefined : STATS,
        );
      } finally {
        production.cleanup();
        await Deno.remove(root, { recursive: true });
      }
    },
  );
}

/** Fire the production `runIssueCallbacks` and return the hook's context. */
async function hookContext(
  enabled: boolean,
  tokenEconomizer: TokenEconomizerRunStats | undefined,
): Promise<Record<string, unknown>> {
  const root = await Deno.makeTempDir({ prefix: "te-callback-ctx-" });
  const captured = join(root, "captured.json");
  const hook = join(root, "hook.sh");
  await Deno.writeTextFile(
    hook,
    `#!/bin/sh\ncp "$VIBECODER_CALLBACK_CONTEXT" '${captured}'\n`,
  );
  await Deno.chmod(hook, 0o755);
  const config = buildDefaultWorkerConfig({
    workDir: root,
    repos: [REPO],
    tokenEconomizer: {
      ...buildDefaultWorkerConfig().tokenEconomizer,
      enabled,
    },
  });
  config.callbacks = { always: hook, timeoutSeconds: 30 };
  const production = await createProductionRunCoreDeps({
    repoDir: root,
    workDir: root,
    githubUser: "test-user",
    logger: createLogger({ write: () => {} }),
    config,
    env: envFrom({ HOME: root }),
  });
  try {
    await production.deps.runIssueCallbacks!({
      repo: REPO,
      issueNumber: 4958,
      result: "success",
      startedAtEpochMs: 1,
      finishedAtEpochMs: 2,
      ...(tokenEconomizer ? { tokenEconomizer } : {}),
    });
    return JSON.parse(await Deno.readTextFile(captured));
  } finally {
    production.cleanup();
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("production runIssueCallbacks publishes the run's TokenEconomizer stats", async () => {
  const doc = await hookContext(true, STATS);
  const block = doc.tokenEconomizer as Record<string, unknown>;
  assert(block, "the context must carry a tokenEconomizer block");
  assertEquals(block.enabled, true);
  assertEquals(block.status, "stopped");
  assertEquals(block.factsInjected, 4958);
});

Deno.test("production runIssueCallbacks states not-run when a switched-on run carried no stats", async () => {
  const doc = await hookContext(true, undefined);
  const block = doc.tokenEconomizer as Record<string, unknown>;
  assertEquals(block?.enabled, true);
  assertEquals(block?.status, "not-run");
});

Deno.test("production runIssueCallbacks omits the block when the switch is off", async () => {
  const doc = await hookContext(false, undefined);
  assertEquals("tokenEconomizer" in doc, false);
});
