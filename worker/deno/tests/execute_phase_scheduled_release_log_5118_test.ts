/**
 * A scheduled release at the finish deadline, with its work pushed, is not
 * logged as an ERROR (Issue #5118).
 *
 * Before the fix the runner logged its kill line at ERROR and the caller
 * logged "failed at phase 'execute'" at ERROR, so a run that did exactly what
 * the schedule asked (stop, push the work, resume next cycle) produced two
 * ERRORs. The kill line is now INFO, and the release is logged as
 * "released on schedule" at INFO when work was kept, WARN when nothing was.
 *
 * The composition test drives the real runner under the real execute phase
 * against a real git remote.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import { logIssueRunFailure } from "../lib/issue_run_failure_log.ts";
import { deriveRunOutcome, describeRunOutcome } from "../lib/run_outcome.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { Logger, WorkerConfig } from "../types.ts";
import {
  agentStubGate,
  createAgentStub,
  releaseAgentStub,
} from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";
import { gitOk, setupGitRepoFixture } from "./support/git_repo_fixture.ts";
import { commitAndPushPending } from "../lib/git_push.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

const ISSUE = 5118;
const REPO = "org/repo";
const REF = `${REPO}#${ISSUE}`;
const BRANCH = "issue-5118-scheduled-release-log";
const DIRTY = "worker/deno/lib/parser.ts";
const AGENT_WORK = "export const parsed = true;";
const TOOL_LINE =
  `{"type":"assistant","message":{"content":[{"type":"tool_use",` +
  `"name":"Edit","input":{"file_path":"${DIRTY}"}}]}}`;

interface CapturedLog {
  logger: Logger;
  infos: string[];
  warns: string[];
  errors: string[];
}

function captureLogger(): CapturedLog {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const logger = {
    info: (m: string) => infos.push(m),
    warn: (m: string) => warns.push(m),
    error: (m: string) => errors.push(m),
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  } as Logger;
  return { logger, infos, warns, errors };
}

function makeConfig(): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), infraRetryBackoffMs: 10 };
}

function makeContext(config: WorkerConfig): IssueContext {
  return {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Log a scheduled release without an ERROR",
    issueBody: "Do the thing.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
}

function makeState(repoPath: string): PhaseState {
  return {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now() - 1_800_000,
    executeStartHeadSha: "abc123",
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

Deno.test({
  name:
    "execute_phase #5118 - a finish-deadline release with WIP pushed logs no ERROR and stays scheduled_release",
  ignore: Deno.build.os === "windows",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const fixture = await setupGitRepoFixture("sched_release_5118_");
    const repoPath = fixture.clone;
    const captured = captureLogger();
    const clock = fakeClock();
    const ready = Promise.withResolvers<void>();
    const stub = await createAgentStub(
      `mkdir -p "$(dirname '${DIRTY}')"\n` +
        `printf '%s\\n' '${AGENT_WORK}' > '${DIRTY}'\n` +
        `printf '%s\\n' '${TOOL_LINE}'\n` +
        agentStubGate() + `exit 0\n`,
    );
    try {
      await gitOk(["checkout", "-b", BRANCH], repoPath);
      const startSha = (await gitOk(["rev-parse", "HEAD"], repoPath)).trim();
      const deps = createMockDeps({
        logger: captured.logger,
        claude: {
          runClaudeWithRetry: ((runOptions: Record<string, unknown>) => {
            const run = runClaudeWithTimeout({
              ...runOptions,
              agentBinaryPath: stub.path,
              clock,
              logger: captured.logger,
              timeoutSeconds: 1,
              killAfterSeconds: 1,
              progressIntervalMs: 86_400_000,
              descendantSnapshotIntervalMs: 86_400_000,
              onActivity: () => ready.resolve(),
              progressExtension: {
                policy: {
                  enabled: true,
                  grantSeconds: 1,
                  activityStallSeconds: 60,
                },
                treeProbe: () => Promise.resolve("advanced" as const),
                ceilingMs: clock.now() + 1_000,
                ceilingLabel: "the finish deadline",
              },
            } as never);
            return (async () => {
              await ready.promise;
              await clock.advance(1_000);
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
      const state = makeState(repoPath);
      state.executeStartHeadSha = startSha;
      const result = await workOnIssueExecuteClaude(
        makeContext(makeConfig()),
        state,
        deps,
      );

      assertEquals(result.status, "failure");
      const category = "category" in result ? result.category : undefined;
      assertEquals(category, "scheduled_release");
      const reason = "reason" in result ? result.reason ?? "" : "";
      assertStringIncludes(reason, "Released on schedule:");
      assertStringIncludes(reason, "finish deadline was reached");
      assertStringIncludes(reason, `pushed to '${BRANCH}'`);

      const remoteBranch = (await gitOk(
        ["rev-parse", "--verify", `refs/heads/${BRANCH}`],
        fixture.remote,
      )).trim();
      assertEquals(
        await gitOk(["show", `${remoteBranch}:${DIRTY}`], fixture.remote),
        `${AGENT_WORK}\n`,
        "the agent's file reached the remote issue branch",
      );
      assertEquals(state.preservedWip?.branch, BRANCH);

      const classification = "classification" in result
        ? result.classification
        : undefined;
      const outcome = deriveRunOutcome({
        success: false,
        phase: "execute",
        reason,
        category: category as never,
        classification,
        preservedWip: state.preservedWip,
      });
      assertEquals(
        describeRunOutcome(outcome),
        "no_pr:scheduled_release:execute",
      );

      logIssueRunFailure(
        captured.logger,
        REF,
        { reason, phase: "execute", category, outcome },
        false,
      );
      assertEquals(captured.errors, [], "no ERROR line anywhere in the run");
      assert(
        captured.infos.includes(
          `Issue ${REF} released on schedule at phase 'execute': ${reason}`,
        ),
        "the release is logged at INFO",
      );
      assert(
        !captured.warns.some((l) =>
          l.includes("released on schedule at phase")
        ),
        "a release that kept its work is not a WARN",
      );
    } finally {
      await releaseAgentStub(stub);
      await stub.dispose();
      await fixture.cleanup();
    }
  },
});

const RELEASE_REASON =
  "Released on schedule: the finish deadline was reached — nothing to preserve";

Deno.test("issue_run_failure_log #5118 - a release that kept nothing logs one WARN", () => {
  const captured = captureLogger();
  const outcome = deriveRunOutcome({
    success: false,
    phase: "execute",
    reason: RELEASE_REASON,
    category: "scheduled_release",
  });
  assertEquals(outcome.kind, "no_pr");
  logIssueRunFailure(
    captured.logger,
    REF,
    {
      reason: RELEASE_REASON,
      phase: "execute",
      category: "scheduled_release",
      outcome,
    },
    false,
  );
  assertEquals(captured.warns, [
    `Issue ${REF} released on schedule at phase 'execute': ${RELEASE_REASON}`,
  ]);
  assertEquals(captured.errors, []);
  assertEquals(captured.infos, []);
});

Deno.test("issue_run_failure_log #5118 - a release that kept work logs at INFO only", () => {
  const captured = captureLogger();
  const outcome = deriveRunOutcome({
    success: false,
    phase: "execute",
    reason: RELEASE_REASON,
    category: "scheduled_release",
    preservedWip: { branch: BRANCH, handoverPath: "handover.md" } as never,
  });
  logIssueRunFailure(
    captured.logger,
    REF,
    {
      reason: RELEASE_REASON,
      phase: "execute",
      category: "scheduled_release",
      outcome,
    },
    false,
  );
  assertEquals(captured.infos, [
    `Issue ${REF} released on schedule at phase 'execute': ${RELEASE_REASON}`,
  ]);
  assertEquals(captured.warns, []);
  assertEquals(captured.errors, []);
});

Deno.test("issue_run_failure_log #5118 - a timeout failure still logs the ERROR (control)", () => {
  const captured = captureLogger();
  const reason = "Claude timed out after 3600s";
  logIssueRunFailure(
    captured.logger,
    REF,
    { reason, phase: "execute", category: "timeout" },
    false,
  );
  assertEquals(captured.errors, [
    `Issue ${REF} failed at phase 'execute': ${reason}`,
  ]);
  assertEquals(captured.warns, []);
});
