/**
 * The lifecycle assignment recorded by the main-loop execute phase (Issue
 * #3718).
 *
 * The assignment event must be on the host ledger before the first agent
 * invocation, so the billed work it describes always has its assignment on
 * record. A failure to record it is logged at error level and the run carries
 * on: telemetry must not stop the work.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import {
  type AssignmentMarkerStore,
  type IssueAssignmentInput,
  type IssueAssignmentSeams,
  recordIssueAssignment,
} from "../lib/issue_assignment.ts";
import {
  type AssignmentEvent,
  readLifecycleLedger,
} from "../lib/lifecycle_ledger.ts";
import { workerBuildFacts } from "../lib/worker_build_info.ts";
import type { Logger, WorkerConfig } from "../types.ts";

/** An in-memory marker store with no marker comments on the issue. */
const emptyMarkerStore: AssignmentMarkerStore = {
  listMarkerComments: () => Promise.resolve([]),
  postMarkerComment: () => Promise.resolve(),
};

/** The fixed ID the mocked recorder reports back. */
const MOCK_ASSIGNMENT_ID = "00000000-0000-4000-8000-000000000000";

/** Run `fn` with a fresh temporary directory, removed afterwards. */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** The issue, the config and the phase state, all rooted in `repoPath`. */
function fixture(
  config: WorkerConfig,
  repoPath: string,
): { ctx: IssueContext; state: PhaseState } {
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 3718,
    issueTitle: "Record the lifecycle assignment",
    issueBody: "Do the thing.",
    issueLabels: ["enhancement"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-3718-lifecycle-assignment",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  return { ctx, state };
}

Deno.test("execute_phase assignment - the assignment event is on the ledger before the first agent invocation (Issue #3718)", async () => {
  await withTempDir(async (dir) => {
    const ledgerPath = `${dir}/lifecycle_ledger_test.jsonl`;
    const seams: IssueAssignmentSeams = {
      store: emptyMarkerStore,
      ledgerPath,
      host: "test-host",
      runId: "run-3718",
      now: () => Date.parse("2026-10-14T00:00:00Z"),
      mintId: () => crypto.randomUUID(),
      buildFacts: () => workerBuildFacts(),
    };
    const { ctx, state } = fixture(buildDefaultWorkerConfig(), dir);

    let invocations = 0;
    let assignmentsAtFirstInvocation: AssignmentEvent[] | undefined;
    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (async () => {
          invocations++;
          if (assignmentsAtFirstInvocation === undefined) {
            const events = await readLifecycleLedger(ledgerPath);
            assignmentsAtFirstInvocation = events.filter(
              (event): event is AssignmentEvent => event.kind === "assignment",
            );
          }
          return {
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          };
        }) as never,
      },
      pr: {
        findExistingPrForIssue: (() =>
          Promise.resolve({ ok: true, value: null })) as never,
      },
      infrastructure: {
        recordIssueAssignment: (
          request: IssueAssignmentInput & {
            workDir: string;
          },
        ) => recordIssueAssignment(request, seams),
      },
    });

    await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(invocations >= 1, true, "the agent must have been invoked");
    assert(assignmentsAtFirstInvocation, "the ledger was read at invocation");
    assertEquals(
      assignmentsAtFirstInvocation.length,
      1,
      "exactly one assignment event is on the ledger when the agent is first invoked",
    );
    assertEquals(assignmentsAtFirstInvocation[0]?.repo, "org/repo");
    assertEquals(assignmentsAtFirstInvocation[0]?.issueNumber, 3718);
  });
});

Deno.test("execute_phase assignment - the request carries the work dir, trusted authors and a manager role (Issue #3718)", async () => {
  await withTempDir(async (dir) => {
    const config = buildDefaultWorkerConfig();
    const { ctx, state } = fixture(config, dir);
    const requests: (IssueAssignmentInput & { workDir: string })[] = [];

    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (() =>
          Promise.resolve({
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          })) as never,
      },
      pr: {
        findExistingPrForIssue: (() =>
          Promise.resolve({ ok: true, value: null })) as never,
      },
      infrastructure: {
        recordIssueAssignment: (request) => {
          requests.push(request);
          return Promise.resolve({
            assignmentId: MOCK_ASSIGNMENT_ID,
            cohort: "unassigned",
            reused: false,
          });
        },
      },
    });

    await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(requests.length, 1);
    const request = requests[0];
    assert(request, "one assignment request was made");
    assertEquals(request.workDir, config.workDir);
    assertEquals(request.repo, "org/repo");
    assertEquals(request.issueNumber, 3718);
    assert(
      request.trustedAuthors.includes("testbot"),
      "the run's own GitHub user is a trusted author",
    );
    assert(
      request.roles.some((role) => role.role === "manager"),
      "the manager role is recorded",
    );
    assertEquals(
      "subscriptionAllocation" in request,
      false,
      "no subscription allocation is passed when none is configured",
    );
  });
});

Deno.test("execute_phase assignment - a split run also records the executor role (Issue #3718)", async () => {
  await withTempDir(async (dir) => {
    const config = buildDefaultWorkerConfig();
    config.issueExecutorSplit = true;
    const { ctx, state } = fixture(config, dir);
    const requests: (IssueAssignmentInput & { workDir: string })[] = [];

    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (() =>
          Promise.resolve({
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          })) as never,
      },
      pr: {
        findExistingPrForIssue: (() =>
          Promise.resolve({ ok: true, value: null })) as never,
      },
      infrastructure: {
        recordIssueAssignment: (request) => {
          requests.push(request);
          return Promise.resolve({
            assignmentId: MOCK_ASSIGNMENT_ID,
            cohort: "unassigned",
            reused: false,
          });
        },
      },
    });

    await workOnIssueExecuteClaude(ctx, state, deps);

    const request = requests[0];
    assert(request, "one assignment request was made");
    assert(
      request.roles.some((role) => role.role === "executor"),
      "the executor role is recorded on a split run",
    );
  });
});

Deno.test("execute_phase assignment - the configured subscription allocation is passed on the request (Issue #3718)", async () => {
  await withTempDir(async (dir) => {
    const config = buildDefaultWorkerConfig();
    config.subscriptionAllocationLabel = "team-a";
    const { ctx, state } = fixture(config, dir);
    const requests: (IssueAssignmentInput & { workDir: string })[] = [];

    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (() =>
          Promise.resolve({
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          })) as never,
      },
      pr: {
        findExistingPrForIssue: (() =>
          Promise.resolve({ ok: true, value: null })) as never,
      },
      infrastructure: {
        recordIssueAssignment: (request) => {
          requests.push(request);
          return Promise.resolve({
            assignmentId: MOCK_ASSIGNMENT_ID,
            cohort: "unassigned",
            reused: false,
          });
        },
      },
    });

    await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(requests[0]?.subscriptionAllocation, "team-a");
  });
});

Deno.test("execute_phase assignment - a failed assignment is logged at error level and the run continues (Issue #3718)", async () => {
  await withTempDir(async (dir) => {
    const { ctx, state } = fixture(buildDefaultWorkerConfig(), dir);
    const errors: string[] = [];
    let invocations = 0;

    const logger: Partial<Logger> = {
      error: (message: string) => {
        errors.push(message);
      },
    };
    const deps = createMockDeps({
      logger,
      claude: {
        runClaudeWithRetry: (() => {
          invocations++;
          return Promise.resolve({
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          });
        }) as never,
      },
      pr: {
        findExistingPrForIssue: (() =>
          Promise.resolve({ ok: true, value: null })) as never,
      },
      infrastructure: {
        recordIssueAssignment: () =>
          Promise.reject(new Error("ledger disk full")),
      },
    });

    await workOnIssueExecuteClaude(ctx, state, deps);

    assert(
      errors.some((message) => message.includes("ledger disk full")),
      "the assignment failure is logged at error level with its cause",
    );
    assertEquals(
      invocations,
      1,
      "the agent still runs once when the assignment could not be recorded",
    );
  });
});
