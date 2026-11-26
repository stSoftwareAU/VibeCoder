/**
 * A protective stop on the external orchestration path keeps its type (Issue
 * #5618). A runner error that is a guest memory floor stop or a host-disk park
 * must not be retried by the orchestrator, and must reach the execute phase as
 * the typed error, so the phase releases the run as `interrupted` or
 * `host_disk` rather than recording an `internal_error` classed `worker-crash`.
 *
 * Australian English spelling throughout (behaviour, recognised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  NO_HOST_GIT_CONFIG,
  NO_HOST_HOOKS_ARGS,
} from "./support/no_host_git_config.ts";
import type {
  ClaudeRunResult,
  RunClaudeOptions,
} from "../lib/claude_runner.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { CONTAINER_IMAGE_STAMP_ENV } from "../lib/container_stamp.ts";
import type { ExternalIssueRunInput } from "../lib/execute_claude_phase.ts";
import {
  GuestMemoryFloorError,
  guestMemoryFloorReason,
} from "../lib/guest_memory_floor.ts";
import {
  HostDiskParkError,
  inFlightParkReason,
  judgeHostDiskForBuild,
} from "../lib/heavy_build_gate.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import {
  type IssueRunGateDeps,
  runOrchestratedIssueRun,
} from "../lib/orchestration/issue_run_gate.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import {
  resetAutomaticProviderState,
  setAutomaticProviderRoutingActive,
} from "../lib/provider_auto_state.ts";
import { classifyRunFailure } from "../lib/run_outcome_classifier.ts";
import type { Result } from "../types.ts";

const REPO = "stSoftwareAU/VibeCoder";

/** The issue's logged figures: 460 MiB available, floor 806 MiB. */
const FLOOR_REASON = guestMemoryFloorReason(
  460 * 1024 * 1024,
  806 * 1024 * 1024,
  2,
);

/** The real producer's park reason for a host disk below its floor. */
function diskParkReason(): string {
  const reason = inFlightParkReason(judgeHostDiskForBuild({
    status: {
      level: "low",
      availableBytes: 3 * 1024 ** 3,
      totalBytes: 100 * 1024 ** 3,
      source: "native-df",
      detail: "3 GiB free, below its 10 GiB floor",
    },
    floorBytes: 10 * 1024 ** 3,
    trimRefused: false,
  }));
  assert(reason !== null, "a low reading must produce a park reason");
  return reason;
}

const DISK_REASON = diskParkReason();

/** A fake runner: other roles succeed, the executor fails with `error`. */
function runnerFailingExecutor(error: Error): {
  executorCalls: () => number;
  runClaudeWithRetry: IssueRunGateDeps["runClaudeWithRetry"];
} {
  let executorCalls = 0;
  return {
    executorCalls: () => executorCalls,
    runClaudeWithRetry: (options: RunClaudeOptions) => {
      if (options.orchestrationRole !== "executor") {
        const value: Result<ClaudeRunResult> = {
          ok: true,
          value: { exitCode: 0, output: "step output", timedOut: false },
        };
        return Promise.resolve(value);
      }
      executorCalls++;
      return Promise.resolve({ ok: false, error } as Result<ClaudeRunResult>);
    },
  };
}

function inputFor(dir: string): ExternalIssueRunInput {
  return {
    claudeOptions: { prompt: "unused", cwd: dir },
    retryOptions: {},
    workDir: dir,
    repo: REPO,
    issueNumber: 5618,
    branch: "issue-5618-protective-stop",
    workspaceDir: dir,
    brief: "Keep protective stops typed",
    settings: { maxRetries: 1 },
  };
}

function depsFor(
  dir: string,
  runClaudeWithRetry: IssueRunGateDeps["runClaudeWithRetry"],
): IssueRunGateDeps {
  return {
    runClaudeWithRetry,
    preflight: async () => {},
    stateDir: `${dir}/state`,
    env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token", CODEX_HOME: `${dir}/codex` },
    now: () => 1_000,
    log: () => {},
    warn: () => {},
  };
}

async function withWorkDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/codex`);
    await Deno.writeTextFile(
      `${dir}/codex/auth.json`,
      JSON.stringify({ auth_mode: "chatgpt" }),
    );
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("protective stop gate - a guest memory floor stop is not retried and stays typed (Issue #5618)", async () => {
  await withWorkDir(async (dir) => {
    const fake = runnerFailingExecutor(new GuestMemoryFloorError(FLOOR_REASON));
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assert(!outcome.ok);
    assert(outcome.error instanceof GuestMemoryFloorError);
    assertEquals(outcome.error.message, FLOOR_REASON);
    assert(outcome.error.message.startsWith("[GUEST_MEMORY_FLOOR]"));
    assertEquals(fake.executorCalls(), 1);
  });
});

Deno.test("protective stop gate - a host-disk park is not retried and stays typed (Issue #5618)", async () => {
  await withWorkDir(async (dir) => {
    const fake = runnerFailingExecutor(
      new HostDiskParkError(DISK_REASON, true),
    );
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assert(!outcome.ok);
    assert(outcome.error instanceof HostDiskParkError);
    assertEquals(outcome.error.agentStarted, true);
    assertEquals(outcome.error.message, DISK_REASON);
    assertEquals(fake.executorCalls(), 1);
  });
});

Deno.test("protective stop gate - a plain executor error is still retried and wrapped (Issue #5618)", async () => {
  await withWorkDir(async (dir) => {
    const fake = runnerFailingExecutor(new Error("boom"));
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assert(!outcome.ok);
    assert(!(outcome.error instanceof GuestMemoryFloorError));
    assert(!(outcome.error instanceof HostDiskParkError));
    assertStringIncludes(
      outcome.error.message,
      "executor call failed after 2 attempt(s): boom",
    );
    assertEquals(fake.executorCalls(), 2);
  });
});

/** A committed git checkout. */
async function gitCheckout(dir: string): Promise<string> {
  const repo = `${dir}/repo`;
  await Deno.mkdir(repo);
  const git = async (...args: string[]) => {
    const out = await new Deno.Command("git", {
      args: [...NO_HOST_HOOKS_ARGS, ...args],
      cwd: repo,
      env: { ...NO_HOST_GIT_CONFIG },
    }).output();
    assertEquals(out.success, true, `git ${args.join(" ")}`);
  };
  await git("init", "-q");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.com");
  await Deno.writeTextFile(`${repo}/code.ts`, "base\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "base");
  return repo;
}

Deno.test("protective stop - the execute phase releases an orchestrated guest memory floor stop as interrupted (Issue #5618)", async () => {
  setAutomaticProviderRoutingActive(true);
  const dir = await Deno.makeTempDir();
  try {
    const repo = await gitCheckout(dir);
    await Deno.mkdir(`${dir}/codex`);
    await Deno.writeTextFile(
      `${dir}/codex/auth.json`,
      JSON.stringify({ auth_mode: "chatgpt" }),
    );
    const config = buildDefaultWorkerConfig();
    config.repoConfig = { "org/repo": { agentProvider: "codex" } };
    const ctx: IssueContext = {
      repo: "org/repo",
      issueNumber: 5618,
      issueTitle: "Fix a bug",
      issueBody: "Do the thing.",
      issueLabels: ["bug"],
      issueComments: "",
      githubUser: "testbot",
      config,
    };
    const state: PhaseState = {
      branchName: "issue-5618-protective-stop",
      baseBranch: "main",
      defaultBranch: "main",
      repoPath: repo,
      clarityStatus: "assessed_clear",
      claudeOutput: "",
      executeStartTime: Date.now(),
      baselineQualityPassed: true,
      baselineQualityOutput: "",
    };
    const fake = runnerFailingExecutor(new GuestMemoryFloorError(FLOOR_REASON));
    const deps = createMockDeps({
      claude: {
        env: (name) =>
          name === CONTAINER_IMAGE_STAMP_ENV ? undefined : Deno.env.get(name),
        runClaudeWithRetry: () => {
          throw new Error("automatic Codex must use the external orchestrator");
        },
        runOrchestratedIssueRun: (input) =>
          runOrchestratedIssueRun(
            {
              ...input,
              workspaceDir: repo,
              settings: { ...input.settings, maxRetries: 1 },
            },
            depsFor(dir, fake.runClaudeWithRetry),
          ),
      },
    });

    const result = await workOnIssueExecuteClaude(ctx, state, deps);

    assert(result.status === "failure", `status: ${result.status}`);
    assertEquals(result.category, "interrupted");
    assert(result.reason.startsWith("[GUEST_MEMORY_FLOOR]"), result.reason);
    assertStringIncludes(result.reason, "460 MiB available, floor 806 MiB");
    assert(!/call failed after/.test(result.reason), result.reason);
    const classification = classifyRunFailure(
      result.category,
      result.reason,
      true,
    );
    assertEquals(classification.failureClass, "interrupted");
    assertEquals(fake.executorCalls(), 1);
  } finally {
    resetAutomaticProviderState();
    await Deno.remove(dir, { recursive: true });
  }
});
