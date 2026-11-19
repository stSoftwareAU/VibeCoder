/**
 * The post-run callback document names the agent provider that SERVED the run,
 * not the host's configured one (Issue #5163).
 *
 * Covers the pure `servedRunProvider` rule, the issue worker lifting it onto
 * its result, the production `processIssue` and `runIssueCallbacks` carrying
 * it, and the published document.
 *
 * Uses Australian English throughout (behaviour, colour).
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { servedRunProvider } from "../lib/run_callback_telemetry.ts";
import { workOnIssue } from "../lib/issue_worker.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  selectAgentProvider,
  setConfiguredAgentProviderId,
  setConfiguredEnabledAgentProviderIds,
} from "../lib/agent_provider.ts";
import {
  buildCallbackContextDocument,
  type TerminalIssueRun,
} from "../lib/run_callbacks.ts";
import { buildIssueRunCallbackContext } from "../lib/run_callback_context.ts";
import type { WorkOnIssueResult } from "../lib/issue_worker_types.ts";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { captureContentSnapshot } from "../lib/content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import { healthyRtkSeam } from "./support/rtk_seam.ts";
import { envFrom } from "./support/env_lookup.ts";

const REPO = "org/repo";
const hostEnv = envFrom({ VIBE_IMAGE_AGENT_PROVIDERS: "claude,deepseek" });

Deno.test("servedRunProvider - the rule", () => {
  const named = (provider?: string) => ({ runStats: { provider } });
  assertEquals(servedRunProvider([], "codex"), "codex");
  assertEquals(servedRunProvider([], undefined), undefined);
  assertEquals(servedRunProvider([], "  "), undefined);
  assertEquals(servedRunProvider([named("deepseek")], "claude"), "deepseek");
  assertEquals(
    servedRunProvider([named("deepseek"), named("deepseek")], "claude"),
    "deepseek",
  );
  assertEquals(
    servedRunProvider([named("claude"), named("codex")], "claude"),
    undefined,
  );
  assertEquals(servedRunProvider([{ runStats: {} }], "claude"), undefined);
  assertEquals(
    servedRunProvider([{}, named("deepseek")], "claude"),
    "deepseek",
  );
});

/** Run one issue on a Claude host; `pin` is the repo's agent provider. */
async function runIssue(
  pin: string | undefined,
  invoked: unknown[],
): Promise<WorkOnIssueResult> {
  const config = buildDefaultWorkerConfig();
  config.agentProvider = "claude";
  if (pin) config.repoConfig = { [REPO]: { agentProvider: pin } };
  const deps = createMockDeps({
    claude: {
      env: hostEnv,
      prepareRtkRun: healthyRtkSeam(100, 140).prepare as never,
      runClaudeWithRetry: ((options: { agentProvider?: string }) => {
        invoked.push(options);
        return Promise.resolve({
          ok: true,
          value: {
            output: "done",
            exitCode: 0,
            timedOut: false,
            runStats: {
              servedModels: [],
              requestedModel: "m",
              wallClockMs: 1,
              provider: selectAgentProvider(options.agentProvider, {
                env: hostEnv,
              }).id,
            },
          },
        });
      }) as never,
    },
    github: {
      runGhCommand: () => Promise.resolve("https://github.com/org/repo/pull/1"),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
    },
  });
  return workOnIssue({
    repo: REPO,
    issueNumber: 5163,
    issueTitle: "Name the serving provider",
    issueBody: "Fix the bug in `src/auth/login.ts:45`",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  }, deps);
}

/** The `provider` the published document carries for one result. */
function publishedProvider(result: WorkOnIssueResult): unknown {
  const run: TerminalIssueRun = {
    repo: REPO,
    issueNumber: 5163,
    result: "success",
    startedAtEpochMs: 1,
    finishedAtEpochMs: 2,
    ...(result.provider ? { provider: result.provider } : {}),
  };
  return buildCallbackContextDocument(
    buildIssueRunCallbackContext(run, { runId: "vibe-5163", host: "h" }, {
      transcriptEnabled: () => false,
      exists: () => false,
    }),
    "always",
  ).provider;
}

for (
  const [label, pin, expected] of [
    ["a pinned repo reports the pinned provider", "deepseek", "deepseek"],
    ["an unpinned repo reports the host's provider", undefined, "claude"],
  ] as const
) {
  Deno.test({
    name: `#5163 - workOnIssue: ${label}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      setConfiguredAgentProviderId("claude");
      setConfiguredEnabledAgentProviderIds(["claude", "deepseek"]);
      try {
        const invoked: unknown[] = [];
        const result = await runIssue(pin, invoked);
        assert(invoked.length >= 1, "the runner must be invoked");
        assertEquals(result.provider, expected);
        assertEquals(publishedProvider(result), expected);
      } finally {
        setConfiguredAgentProviderId(undefined);
        setConfiguredEnabledAgentProviderIds(undefined);
      }
    },
  });
}

Deno.test({
  name: "#5163 - workOnIssue: a refused claim reports the configured provider",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const config = buildDefaultWorkerConfig();
    config.agentProvider = "deepseek";
    const invoked: unknown[] = [];
    const deps = createMockDeps({
      issues: {
        claimIssue: () =>
          Promise.resolve({
            ok: true,
            value: { claimed: false, reason: "already_assigned" as const },
          }),
      },
      claude: {
        runClaudeWithRetry: ((options: unknown) => {
          invoked.push(options);
          return Promise.resolve({ ok: false, error: new Error("no") });
        }) as never,
      },
    });
    const result = await workOnIssue({
      repo: REPO,
      issueNumber: 5163,
      issueTitle: "Name the serving provider",
      issueBody: "The claim was refused.",
      issueLabels: [],
      issueComments: "",
      githubUser: "testbot",
      config,
    }, deps);
    assertEquals(invoked.length, 0);
    assertEquals(result.provider, "deepseek");
  },
});

/** Fire the production `runIssueCallbacks` and return the hook's context. */
async function hookContext(
  provider: string | undefined,
): Promise<Record<string, unknown>> {
  const root = await Deno.makeTempDir({ prefix: "provider-callback-ctx-" });
  try {
    const captured = join(root, "captured.json");
    const hook = join(root, "hook.sh");
    await Deno.writeTextFile(
      hook,
      `#!/bin/sh\ncp "$VIBECODER_CALLBACK_CONTEXT" '${captured}'\n`,
    );
    await Deno.chmod(hook, 0o755);
    const config = buildDefaultWorkerConfig({ workDir: root, repos: [REPO] });
    config.agentProvider = "claude";
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
        issueNumber: 5163,
        result: "success",
        startedAtEpochMs: 1,
        finishedAtEpochMs: 2,
        ...(provider ? { provider } : {}),
      });
      return JSON.parse(await Deno.readTextFile(captured));
    } finally {
      production.cleanup();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("#5163 - production runIssueCallbacks publishes the run's provider", async () => {
  assertEquals((await hookContext("deepseek")).provider, "deepseek");
});

Deno.test("#5163 - production runIssueCallbacks never substitutes the configured provider", async () => {
  assertEquals("provider" in await hookContext(undefined), false);
});

for (const expectedSkip of [false, true]) {
  Deno.test(`#5163 - production processIssue surfaces the run's provider (skip=${expectedSkip})`, async () => {
    const root = await Deno.makeTempDir({ prefix: "provider-process-issue-" });
    try {
      const title = "Fix login bug", body = "Fix src/auth.ts";
      const config = {
        ...buildDefaultWorkerConfig(),
        workDir: root,
        allowedAuthors: ["test-user"],
      };
      const snapshot = await captureContentSnapshot(
        resolveContentApprovalStateDir(root),
        REPO,
        42,
        title,
        body,
        "test-user",
        null,
      );
      assertEquals(snapshot.ok, true);
      const worker = createMockDeps({
        github: {
          runGhCommand: () =>
            Promise.resolve(JSON.stringify({
              title,
              body,
              author: { login: "test-user" },
              labels: [{ name: "work-on" }],
              comments: [],
              state: "OPEN",
            })),
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
            provider: "deepseek",
          }),
      });
      try {
        const result = await production.deps.processIssue({
          repo: REPO,
          issueNumber: 42,
          issueTitle: title,
          milestoneTitle: "",
        });
        assert(result.ok);
        assertEquals(result.value.skipped, expectedSkip);
        assertEquals(result.value.provider, "deepseek");
      } finally {
        production.cleanup();
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}
