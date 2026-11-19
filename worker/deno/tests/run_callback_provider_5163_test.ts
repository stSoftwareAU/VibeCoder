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
import {
  type AgentLaunch,
  servedRunProvider,
} from "../lib/run_callback_telemetry.ts";
import { trackAgentLaunches } from "../lib/agent_launch_tracking.ts";
import { HostDiskParkError } from "../lib/heavy_build_gate.ts";
import { AgentTurnLimitError } from "../lib/claude_turn_limit.ts";
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
  assertEquals(servedRunProvider([], "codex"), "codex");
  assertEquals(servedRunProvider([], undefined), undefined);
  assertEquals(servedRunProvider([], "  "), undefined);
  assertEquals(servedRunProvider([{ provider: "deepseek" }], "x"), "deepseek");
  assertEquals(
    servedRunProvider(
      [{ provider: "deepseek" }, { provider: "deepseek" }],
      "x",
    ),
    "deepseek",
  );
  assertEquals(
    servedRunProvider([{ provider: "claude" }, { provider: "codex" }], "x"),
    undefined,
  );
  assertEquals(servedRunProvider([{}], "claude"), undefined);
  assertEquals(
    servedRunProvider([{}, { provider: "deepseek" }], "claude"),
    undefined,
  );
  assertEquals(
    servedRunProvider([{ provider: "  " }, { provider: "deepseek" }], "claude"),
    undefined,
  );
});

type Runner = (options: { agentProvider?: string }) => Promise<unknown>;

/** Track a scripted runner and return the tracked call plus the launches. */
function tracked(runner: Runner) {
  const launches: AgentLaunch[] = [];
  const input = createMockDeps({
    claude: { runClaudeWithRetry: runner as never },
  });
  const deps = trackAgentLaunches(input, launches);
  const call = () => (deps.claude.runClaudeWithRetry as Runner)({});
  return { launches, call, input, deps };
}

const okWith = (stats?: { provider: string }) =>
  Promise.resolve({
    ok: true,
    value: {
      output: "",
      exitCode: 0,
      timedOut: false,
      ...(stats
        ? {
          runStats: {
            servedModels: [],
            requestedModel: "m",
            wallClockMs: 1,
            ...stats,
          },
        }
        : {}),
    },
  });

Deno.test("trackAgentLaunches - an ok launch records its provider", async () => {
  const t = tracked(() => okWith({ provider: "deepseek" }));
  await t.call();
  assertEquals(t.launches, [{ provider: "deepseek" }]);
});

Deno.test("trackAgentLaunches - an ok launch without stats records none", async () => {
  const t = tracked(() => okWith());
  await t.call();
  assertEquals(t.launches, [{}]);
});

Deno.test("trackAgentLaunches - a host-disk park records none and passes the result", async () => {
  const result = { ok: false, error: new HostDiskParkError("disk full", true) };
  const t = tracked(() => Promise.resolve(result));
  assert(await t.call() === result);
  assertEquals(t.launches, [{}]);
});

Deno.test("trackAgentLaunches - a turn-cap error records its billed provider", async () => {
  const billed = {
    output: "",
    exitCode: 0,
    timedOut: false,
    runStats: {
      servedModels: [],
      requestedModel: "m",
      wallClockMs: 1,
      provider: "deepseek",
    },
  };
  const t = tracked(() =>
    Promise.resolve({
      ok: false,
      error: new AgentTurnLimitError("cap", billed as never),
    })
  );
  await t.call();
  assertEquals(t.launches, [{ provider: "deepseek" }]);
});

Deno.test("trackAgentLaunches - a throwing runner records none and rethrows", async () => {
  const boom = new Error("boom");
  const t = tracked(() => Promise.reject(boom));
  const thrown = await t.call().then(() => undefined, (e) => e);
  assert(thrown === boom);
  assertEquals(t.launches, [{}]);
});

Deno.test("trackAgentLaunches - mixed launches leave the provider unknown", async () => {
  const providers = ["deepseek", "claude"];
  const t = tracked(() => okWith({ provider: providers.shift()! }));
  await t.call();
  await t.call();
  assertEquals(servedRunProvider(t.launches, "claude"), undefined);
});

Deno.test("trackAgentLaunches - other deps pass through unchanged", () => {
  const t = tracked(() => okWith());
  assert(t.deps.github === t.input.github);
});

/** Run one issue on a Claude host; `pin` is the repo's agent provider. */
async function runIssue(
  pin: string | undefined,
  invoked: unknown[],
  runner?: Runner,
  extra?: Parameters<typeof createMockDeps>[0],
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
        if (runner) return runner(options);
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
    ...extra,
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

for (
  const [label, runner] of [
    ["a host-disk park after an agent ran", () =>
      Promise.resolve({
        ok: false,
        error: new HostDiskParkError("disk full", true),
      })],
    ["a launch that reported no stats", () => okWith()],
  ] as const
) {
  Deno.test({
    name: `#5163 - workOnIssue: ${label} leaves the provider unknown`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      setConfiguredAgentProviderId("claude");
      setConfiguredEnabledAgentProviderIds(["claude", "deepseek"]);
      try {
        const invoked: { agentProvider?: string }[] = [];
        const result = await runIssue("deepseek", invoked, runner);
        assert(invoked.length >= 1, "the runner must be invoked");
        assertEquals(invoked[0]!.agentProvider, "deepseek");
        assertEquals(result.provider, undefined);
        assertEquals(publishedProvider(result), undefined);
      } finally {
        setConfiguredAgentProviderId(undefined);
        setConfiguredEnabledAgentProviderIds(undefined);
      }
    },
  });
}

// The quality gate fails once after the execute call, so the remediation
// phase launches a second agent through the runner (the reviewer's finding 3).
for (
  const [label, later, expected] of [
    ["a later agent on another provider", "claude", undefined],
    ["a later agent on the same provider", "deepseek", "deepseek"],
  ] as const
) {
  Deno.test({
    name: `#5163 - workOnIssue: ${label} counts toward the served provider`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      setConfiguredAgentProviderId("claude");
      setConfiguredEnabledAgentProviderIds(["claude", "deepseek"]);
      try {
        const invoked: unknown[] = [];
        const providers = ["deepseek", later];
        let failed = false;
        const runner: Runner = () =>
          okWith({ provider: providers[invoked.length - 1] ?? later });
        const gate = (passed: boolean) =>
          Promise.resolve({
            ok: true as const,
            value: {
              checks: [],
              summary: { text: passed ? "passed" : "failed", passed },
              passed,
              output: passed ? "all good" : "lint error",
            },
          });
        const result = await runIssue("deepseek", invoked, runner, {
          quality: {
            runQualityGate: () => {
              if (invoked.length >= 1 && !failed) {
                failed = true;
                return gate(false);
              }
              return gate(true);
            },
          },
          // The execute agent changed a file, so the run reaches the gate.
          git: {
            runGitCommand: (args: string[]) =>
              Promise.resolve({
                ok: true as const,
                value: {
                  code: 0,
                  stdout: args[0] === "diff" ? "fix.ts\n" : "",
                  stderr: "",
                },
              }),
          },
        } as never);
        assert(failed, "the quality gate must have failed once");
        assert(invoked.length >= 2, "a later agent must launch");
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
