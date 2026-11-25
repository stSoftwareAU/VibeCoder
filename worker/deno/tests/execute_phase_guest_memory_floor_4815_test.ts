/**
 * A guest memory stop raised while the agent runs in the execute phase
 * (Issue #4815): the work is preserved on the issue branch and the run is
 * released as interrupted. The real runner runs under the phase.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { Logger } from "../types.ts";
import {
  agentStubGate,
  createAgentStub,
  releaseAgentStub,
} from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";
import { gitOk, setupGitRepoFixture } from "./support/git_repo_fixture.ts";
import { commitAndPushPending } from "../lib/git_push.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import { handoverFilePath } from "../lib/preserved_wip_branch.ts";

const ISSUE = 4815;
const REPO = "org/repo";
const BRANCH = "issue-4815-guest-memory-floor";
const DIRTY = "worker/deno/lib/parser.ts";
const AGENT_WORK = "export const parsed = true;";
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  skipReason: () => {},
  timing: () => {},
  scanSummary: () => {},
  workerSummary: () => {},
} as Logger;

Deno.test({
  name:
    "execute_phase #4815 - a guest memory stop mid-execute is preserved and released as interrupted",
  ignore: Deno.build.os === "windows",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const fixture = await setupGitRepoFixture("guest_memory_4815_");
    const repoPath = fixture.clone;
    const clock = fakeClock();
    const ready = Promise.withResolvers<void>();
    const stub = await createAgentStub(
      `echo started >> "$0.starts"\n` +
        `mkdir -p "$(dirname '${DIRTY}')"\n` +
        `printf '%s\\n' '${AGENT_WORK}' > '${DIRTY}'\n` +
        `printf '%s\\n' '{"type":"result","result":"working"}'\n` +
        agentStubGate() + `echo finished >> "$0.finished"\nexit 0\n`,
    );
    try {
      await gitOk(["checkout", "-b", BRANCH], repoPath);
      const startSha = (await gitOk(["rev-parse", "HEAD"], repoPath)).trim();
      const deps = createMockDeps({
        logger,
        claude: {
          runClaudeWithRetry: ((runOptions: Record<string, unknown>) => {
            const run = runClaudeWithTimeout({
              ...runOptions,
              agentBinaryPath: stub.path,
              clock,
              logger,
              timeoutSeconds: 3600,
              killAfterSeconds: 1,
              guestMemoryPollMs: 1_000,
              probeMemoryPressure: () =>
                Promise.resolve({
                  level: "high" as const,
                  totalBytes: 8 * GIB,
                  availableBytes: 100 * MIB,
                }),
              progressIntervalMs: 86_400_000,
              descendantSnapshotIntervalMs: 86_400_000,
              onActivity: () => ready.resolve(),
            } as never);
            return (async () => {
              await ready.promise;
              for (let i = 0; i < 3; i++) {
                await clock.advance(1_000);
                await new Promise((r) => setTimeout(r, 20));
              }
              return await run;
            })();
          }) as never,
        },
        pr: {
          findExistingPrForIssue: (() =>
            Promise.resolve({ ok: false, error: new Error("No PR") })) as never,
        },
        git: { runGitCommand, commitAndPushPending },
      });
      const config = { ...buildDefaultWorkerConfig(), infraRetryBackoffMs: 10 };
      const context: IssueContext = {
        repo: REPO,
        issueNumber: ISSUE,
        issueTitle: "Stop the agent at the guest memory floor",
        issueBody: "Do the thing.",
        issueLabels: [],
        issueComments: "",
        githubUser: "testbot",
        config,
      };
      const state: PhaseState = {
        branchName: BRANCH,
        baseBranch: "main",
        defaultBranch: "main",
        repoPath,
        clarityStatus: "assessed_clear",
        claudeOutput: "",
        executeStartTime: Date.now() - 1_800_000,
        executeStartHeadSha: startSha,
        baselineQualityPassed: true,
        baselineQualityOutput: "",
      };
      const result = await workOnIssueExecuteClaude(context, state, deps);

      assertEquals(result.status, "failure");
      const category = "category" in result ? result.category : undefined;
      assertEquals(category, "interrupted");
      const reason = "reason" in result ? result.reason ?? "" : "";
      assertStringIncludes(reason, "[GUEST_MEMORY_FLOOR]");

      const remoteBranch = (await gitOk(
        ["rev-parse", "--verify", `refs/heads/${BRANCH}`],
        fixture.remote,
      )).trim();
      assertEquals(
        await gitOk(["show", `${remoteBranch}:${DIRTY}`], fixture.remote),
        `${AGENT_WORK}\n`,
      );
      const handoverPath = handoverFilePath(ISSUE);
      const handover = await gitOk(
        ["show", `${remoteBranch}:${handoverPath}`],
        fixture.remote,
      );
      assertStringIncludes(handover, "guest memory floor");
      assertEquals(
        (await gitOk(["status", "--porcelain"], repoPath)).trim(),
        "",
      );
      assertEquals(state.preservedWip?.branch, BRANCH);
      assertEquals(state.preservedWip?.handoverPath, handoverPath);
      assertEquals(
        (await Deno.readTextFile(`${stub.path}.starts`)).trim().split("\n"),
        ["started"],
      );
      await assertRejects(
        () => Deno.stat(`${stub.path}.finished`),
        Deno.errors.NotFound,
      );
      assert(result.status === "failure");
    } finally {
      await releaseAgentStub(stub);
      await stub.dispose();
      await fixture.cleanup();
    }
  },
});
