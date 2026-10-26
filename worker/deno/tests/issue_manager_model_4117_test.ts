/**
 * The issue manager runs on the model the `issue` phase routes to (Issue #4117).
 *
 * A host whose `.config.json` sets no `claude_model` used to load
 * `claudeModel: "opus"`, and the main-loop issue run passed that as an explicit
 * `--model`, which wins over phase routing. Every manager session was served
 * by Opus while the run-stats comment expected the Sonnet default, so each run
 * was flagged degraded. These tests compose the real config loader, the real
 * execute phase and the real Claude argv builder, so the default and the call
 * site cannot drift apart again.
 */

import { assertEquals } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { selectAgentProvider } from "../lib/agent_provider.ts";
import type { PhaseState } from "../lib/issue_worker_types.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";
import type { SessionResumeState } from "../lib/session_resume.ts";
import type { ConfigFile } from "../types.ts";

async function loadHostConfig(file: ConfigFile) {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify(file));
  try {
    return await loadConfig(configPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

/** The options the main-loop issue run hands the runner on this host. */
async function issueRunOptions(file: ConfigFile): Promise<RunClaudeOptions> {
  const loaded = await loadHostConfig(file);
  const config = buildDefaultWorkerConfig({
    includeCodebaseMap: false,
    claudeModel: loaded.claudeModel,
  });
  const ctx = {
    config,
    repo: "org/repo",
    issueNumber: 4117,
    issueTitle: "Manager model",
    issueBody: "Run the manager on its routed tier",
    issueComments: "",
    issueLabels: [],
    githubUser: "worker",
  };
  const state: PhaseState = {
    branchName: "issue-4117-manager-model",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/issue-4117",
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  let captured: RunClaudeOptions | undefined;
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: async (options) => {
        captured = options;
        return {
          ok: true,
          value: { output: "done", exitCode: 0, timedOut: false },
        };
      },
    },
    pr: { findExistingPrForIssue: async () => ({ ok: true, value: "" }) },
  });
  await workOnIssueExecuteClaude(ctx, state, deps);
  if (!captured) throw new Error("the issue run never reached the runner");
  return captured;
}

/** The `--model` value the Claude CLI would be spawned with. */
function spawnedModel(
  options: RunClaudeOptions,
  sessionResumeState?: SessionResumeState,
): string | undefined {
  const args = selectAgentProvider("claude", {}).buildInvocation({
    prompt: options.prompt,
    model: options.model,
    phase: options.phase,
    effort: options.effort,
    promptViaStdin: true,
    ...(sessionResumeState ? { sessionResumeState } : {}),
  });
  const i = args.indexOf("--model");
  return i === -1 ? undefined : args[i + 1];
}

const UNCONFIGURED: ConfigFile = {
  allowed_authors: ["testuser"],
  repos: ["org/repo"],
};

Deno.test("issue #4117: an unconfigured host spawns the issue manager on Sonnet", async () => {
  const options = await issueRunOptions(UNCONFIGURED);
  assertEquals(spawnedModel(options), "sonnet");
});

Deno.test("issue #4117: a resumed issue session is spawned on Sonnet too", async () => {
  const options = await issueRunOptions(UNCONFIGURED);
  const resumed: SessionResumeState = {
    sessionId: "4a9c39a9-587e-4beb-9779-dcaa40c8ace2",
    phaseCount: 3,
    providerId: "claude",
  };
  assertEquals(spawnedModel(options, resumed), "sonnet");
});

Deno.test("issue #4117: a host that sets claude_model keeps it for the issue manager", async () => {
  const options = await issueRunOptions({
    ...UNCONFIGURED,
    claude_model: "opus",
  });
  assertEquals(spawnedModel(options), "opus");
});
