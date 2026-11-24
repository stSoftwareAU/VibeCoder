/**
 * A Codex safety refusal on the orchestrated path, end to end (Issue #5506).
 *
 * The Codex adapter's real classification of the provider's safety-flag
 * refusal goes through the real external orchestrator
 * (`runOrchestratedIssueRun`) and the real execute phase. The phase's failure
 * reason then goes to `classifyRunFailure`, which must call it an
 * `agent-outcome` and not a `worker-crash`. Only the provider process is faked.
 *
 * Australian English spelling throughout (behaviour, recognised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  NO_HOST_GIT_CONFIG,
  NO_HOST_HOOKS_ARGS,
} from "./support/no_host_git_config.ts";
import type { AgentFailure } from "../lib/agent_output.ts";
import {
  CODEX_OUTPUT_ADAPTER,
  CODEX_SAFETY_REFUSAL_HEADLINE,
} from "../lib/codex_output_adapter.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { runOrchestratedIssueRun } from "../lib/orchestration/issue_run_gate.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import {
  resetAutomaticProviderState,
  setAutomaticProviderRoutingActive,
} from "../lib/provider_auto_state.ts";
import { classifyRunFailure } from "../lib/run_outcome_classifier.ts";

/** The provider's own safety-flag text from the #5456 transcript. */
const SAFETY_FLAG_MESSAGE =
  "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. If you’re doing authorized security work that requires more cyber permissive safeguards, apply for Daybreak access via https://platform.openai.com/settings/organization/status-and-access before retrying.";

/** What the Codex adapter makes of that refusal, exactly as the runner would. */
function codexSafetyFailure(): AgentFailure {
  const stdout = [
    JSON.stringify({ type: "error", message: SAFETY_FLAG_MESSAGE }),
    JSON.stringify({
      type: "turn.failed",
      error: { message: SAFETY_FLAG_MESSAGE },
    }),
  ].join("\n");
  const failure = CODEX_OUTPUT_ADAPTER.classify(
    { stdout, stderr: "", exitCode: 1 },
    CODEX_OUTPUT_ADAPTER.decode(stdout),
  );
  assert(failure, "the Codex adapter classified no failure");
  return failure;
}

/** A committed git checkout, which the Codex read-only guard needs. */
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

Deno.test("codex safety refusal - the orchestrated execute-phase reason is an agent-outcome, not a worker-crash (Issue #5506)", async () => {
  // A fleet image stamps the providers it carries; this test needs Codex.
  const stamped = Deno.env.get("VIBE_IMAGE_AGENT_PROVIDERS");
  Deno.env.delete("VIBE_IMAGE_AGENT_PROVIDERS");
  setAutomaticProviderRoutingActive(true);
  const dir = await Deno.makeTempDir();
  try {
    const repo = await gitCheckout(dir);
    // A ChatGPT login proves the fixed-price Codex subscription.
    await Deno.mkdir(`${dir}/codex`);
    await Deno.writeTextFile(
      `${dir}/codex/auth.json`,
      JSON.stringify({ auth_mode: "chatgpt" }),
    );
    const config = buildDefaultWorkerConfig();
    config.repoConfig = { "org/repo": { agentProvider: "codex" } };
    const ctx: IssueContext = {
      repo: "org/repo",
      issueNumber: 5506,
      issueTitle: "Fix a security bug",
      issueBody: "Do the thing.",
      issueLabels: ["bug"],
      issueComments: "",
      githubUser: "testbot",
      config,
    };
    const state: PhaseState = {
      branchName: "issue-5506-safety-refusal",
      baseBranch: "main",
      defaultBranch: "main",
      repoPath: repo,
      clarityStatus: "assessed_clear",
      claudeOutput: "",
      executeStartTime: Date.now(),
      baselineQualityPassed: true,
      baselineQualityOutput: "",
    };
    const refusal = codexSafetyFailure();
    let providerCalls = 0;
    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: () => {
          throw new Error("automatic Codex must use the external orchestrator");
        },
        // The real orchestrator; only the provider process is faked.
        runOrchestratedIssueRun: (input) =>
          runOrchestratedIssueRun(
            { ...input, workspaceDir: repo },
            {
              runClaudeWithRetry: () => {
                providerCalls++;
                return Promise.resolve({
                  ok: true,
                  value: {
                    exitCode: 1,
                    output: "",
                    timedOut: false,
                    agentFailure: refusal,
                  },
                });
              },
              preflight: async () => {},
              stateDir: `${dir}/state`,
              env: {
                CLAUDE_CODE_OAUTH_TOKEN: "test-token",
                CODEX_HOME: `${dir}/codex`,
              },
              now: () => 1_000,
              log: () => {},
              warn: () => {},
            },
          ),
      },
    });

    const result = await workOnIssueExecuteClaude(ctx, state, deps);

    assert(result.status === "failure", `status: ${result.status}`);
    assertEquals(result.category, "internal_error");
    const reason = result.reason;
    // The orchestrator retried, then wrapped the adapter's message.
    assert(providerCalls > 1, `provider calls: ${providerCalls}; ${reason}`);
    assert(
      /^Claude execution failed: manager call failed after \d+ attempt\(s\): /
        .test(reason),
      reason,
    );
    assertStringIncludes(reason, CODEX_SAFETY_REFUSAL_HEADLINE);

    const classification = classifyRunFailure(
      result.category,
      reason,
      true,
    );
    assertEquals(classification.failureClass, "agent-outcome");
    assertEquals(classification.fixability, "not_code_fixable");
  } finally {
    resetAutomaticProviderState();
    if (stamped !== undefined) {
      Deno.env.set("VIBE_IMAGE_AGENT_PROVIDERS", stamped);
    }
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("codex safety refusal - the orchestrator's prefix around another failure is still a worker-crash (Issue #5506)", () => {
  assertEquals(
    classifyRunFailure(
      "internal_error",
      "Claude execution failed: manager call failed after 2 attempt(s): boom — evidence: Codex refused the content as a safety risk",
      true,
    ).failureClass,
    "worker-crash",
  );
});
