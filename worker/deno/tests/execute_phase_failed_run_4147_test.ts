/**
 * The fleet execute phase must reject a crashed, empty run before it reaches
 * the analysis-only hand-off. The standalone command's sibling coverage is
 * in execute_claude_phase_test.ts (Issue #4147).
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { CLAUDE_OUTPUT_ADAPTER } from "../lib/claude_output_adapter.ts";
import { buildRunStats } from "../lib/run_stats.ts";

type Work = "none" | "uncommitted" | "local" | "remote" | "pr";

async function run(exitCode: number, output: string, work: Work = "none") {
  const workDir = await Deno.makeTempDir({ prefix: "failed_run_4147_" });
  try {
    const state: PhaseState = {
      branchName: "issue-4147-crashed-run",
      baseBranch: "Develop",
      defaultBranch: "Develop",
      repoPath: workDir,
      clarityStatus: "assessed_clear",
      claudeOutput: "",
      executeStartTime: 0,
      baselineQualityPassed: true,
      baselineQualityOutput: "",
    };
    let invocations = 0;
    const result = await workOnIssueExecuteClaude(
      {
        repo: "org/repo",
        issueNumber: 4147,
        issueTitle: "Fix the implementation",
        issueBody: "Make the change and test it.",
        issueLabels: ["work-on"],
        issueComments: "",
        githubUser: "testbot",
        config: {
          ...buildDefaultWorkerConfig(),
          workDir,
          infraRetryBackoffMs: 0,
        },
      },
      state,
      createMockDeps({
        claude: {
          runClaudeWithRetry: () => {
            invocations++;
            return Promise.resolve({
              ok: true,
              value: {
                output,
                exitCode,
                timedOut: false,
                agentOutput: CLAUDE_OUTPUT_ADAPTER.decode(output),
                runStats: buildRunStats(output, {
                  requestedModel: "test",
                  wallClockMs: 0,
                }),
              },
            });
          },
        },
        git: {
          runGitCommand: (args) =>
            Promise.resolve({
              ok: true,
              value: {
                code: 0,
                stderr: "",
                stdout: args[0] === "diff" && work === "uncommitted"
                  ? " src/fix.ts | 1 +"
                  : args[0] === "log" &&
                      ((work === "local" && args[1]?.endsWith("..HEAD")) ||
                        (work === "remote" &&
                          args[1]?.endsWith(`..origin/${state.branchName}`)))
                  ? "abc123 implement the fix"
                  : "",
              },
            }),
        },
        pr: {
          findExistingPrForIssue: () =>
            Promise.resolve(
              work === "pr"
                ? { ok: true, value: "https://github.com/org/repo/pull/42" }
                : { ok: false, error: new Error("No PR found") },
            ),
        },
      }),
    );
    return { result, invocations };
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

for (
  const output of [
    "Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row.",
    '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"errors":["No conversation found with session ID: missing-session"]}',
    "The agent process crashed before producing an answer.",
  ]
) {
  Deno.test(`#4147 fleet execute: failed empty run is retried: ${output.slice(0, 40)}`, async () => {
    const { result, invocations } = await run(1, output);
    assertEquals(result.status, "failure");
    if (result.status !== "failure") return;
    assertEquals(result.category, "interrupted");
    assertStringIncludes(result.reason, "exited 1");
    assertStringIncludes(result.reason, output);
    assertEquals(invocations, 2, "one bounded infrastructure retry");
  });
}

Deno.test("#4147 fleet execute: completed empty run can reach no_changes", async () => {
  const { result, invocations } = await run(
    0,
    "The behaviour is already correct.",
  );
  assertEquals(result.status, "early_exit");
  if (result.status !== "early_exit") return;
  assertEquals(result.reason, "no_changes");
  assertEquals(invocations, 1);
});

for (
  const output of [
    '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":1}',
    '{"type":"result","is_error":false,"num_turns":0}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Starting work"}]}}',
  ]
) {
  Deno.test(`#4147 fleet execute: exit-zero incomplete run is retried: ${output}`, async () => {
    const { result, invocations } = await run(0, output);
    assertEquals(result.status, "failure");
    assertEquals(invocations, 2);
  });
}

Deno.test("#4147 fleet execute: completed one-turn result can reach no_changes", async () => {
  const { result } = await run(
    0,
    '{"type":"result","is_error":false,"num_turns":1,"result":"Already correct"}',
  );
  assertEquals(
    result.status === "early_exit" ? result.reason : result.status,
    "no_changes",
  );
});

for (const work of ["uncommitted", "local", "remote", "pr"] as const) {
  Deno.test(`#4147 fleet execute: failed run preserves ${work} work for completion`, async () => {
    const { result, invocations } = await run(1, "Agent process failed.", work);
    assertEquals(result.status, "continue");
    assertEquals(invocations, 1);
  });
}
