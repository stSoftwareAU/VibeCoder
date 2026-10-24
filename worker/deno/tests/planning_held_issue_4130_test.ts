/**
 * `planHeldIssue` (Issue #4130): the planning round for an issue whose claim
 * the caller already holds. It must not claim the issue and must not start or
 * clear a heartbeat, because the coding run's heartbeat is live.
 *
 * `processIssuePlanning` is run beside it as a control, so the counters are
 * shown to move when a claim and a heartbeat really happen.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { AgentTurnLimitError } from "../lib/claude_turn_limit.ts";
import type { IssueContext } from "../lib/issue_worker.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import {
  planHeldIssue,
  type PlanningProcessorDeps,
  processIssuePlanning,
} from "../lib/planning_processor.ts";
import type { GitHubClient, WorkerConfig } from "../types.ts";
import type { GraftContextResult } from "../lib/graft_context.ts";
import type { CodegraphContextResult } from "../lib/codegraph_context.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const FLEET_LOGIN = "testbot";

/** Counts every claim, heartbeat and GitHub call a planning round makes. */
interface Counters {
  claims: number;
  heartbeatRecords: number;
  heartbeatClears: number;
  claudeCalls: number;
  gh: string[][];
}

function coverageReadResponse(): string {
  return JSON.stringify({
    body: "Parent",
    comments: [{
      author: { login: FLEET_LOGIN },
      body: [
        "## Plan published",
        "",
        "1. #101 — Break the issue down (`enhancement`)",
        "2. #102 — Carry it into the gate (`enhancement`, depends on #101)",
        "",
        "## Plan Coverage",
        "",
        "| Ask | Covered by | Notes |",
        "| --- | --- | --- |",
        "| Break the issue down | #101, #102 | Both published |",
      ].join("\n"),
    }],
  });
}

function isCoverageRead(args: string[]): boolean {
  const jsonIdx = args.indexOf("--json");
  return args[0] === "issue" && args[1] === "view" && jsonIdx >= 0 &&
    (args[jsonIdx + 1] ?? "").includes("comments");
}

/** Sub-issues a fleet account already filed: the pre-check closes without Claude. */
function fleetSubIssueSearch(): string {
  return JSON.stringify([101, 102].map((number) => ({
    number,
    url: `https://github.com/org/repo/issues/${number}`,
    author: { login: FLEET_LOGIN },
  })));
}

function ghFor(args: string[], subIssuesExist: boolean): string {
  if (isCoverageRead(args)) return coverageReadResponse();
  if (subIssuesExist && args.includes("search")) return fleetSubIssueSearch();
  return "";
}

function stubGhClient(): GitHubClient {
  return {
    getIssue: () =>
      Promise.resolve({
        number: 100,
        title: "Break down auth refactor",
        body: "",
        labels: [],
        author: "user",
        assignees: [],
        createdAt: "",
        updatedAt: "",
      }),
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

function makeConfig(): WorkerConfig {
  return { ...buildDefaultWorkerConfig() };
}

function makeContext(): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 100,
    issueTitle: "Break down auth refactor",
    issueBody: "This issue needs to be broken into sub-issues.",
    issueLabels: ["planning"],
    issueComments: "",
    githubUser: FLEET_LOGIN,
    config: makeConfig(),
  };
}

function countingDeps(
  counters: Counters,
  options: {
    subIssuesExist: boolean;
    claudeFails?: boolean;
    /** Makes Claude fail with an ordinary error, which the round handles. */
    claudeErrors?: boolean;
    codegraph?: CodegraphContextResult;
    graft?: GraftContextResult;
  },
): PlanningProcessorDeps {
  const deps = createMockDeps({
    issues: {
      claimIssue: () => {
        counters.claims++;
        return Promise.resolve({
          ok: true,
          value: { claimed: true, winnerId: FLEET_LOGIN },
        });
      },
    },
    crashHandling: {
      recordHeartbeat: () => {
        counters.heartbeatRecords++;
        return Promise.resolve({ ok: true, value: undefined });
      },
      clearHeartbeat: () => {
        counters.heartbeatClears++;
        return Promise.resolve({ ok: true, value: undefined });
      },
    },
    claude: {
      runClaudeWithRetry: (() => {
        counters.claudeCalls++;
        if (options.claudeErrors) {
          return Promise.resolve({
            ok: false,
            error: new Error("claude exited 1"),
          });
        }
        if (options.claudeFails) {
          return Promise.resolve({
            ok: false,
            error: new AgentTurnLimitError("error_max_turns"),
          });
        }
        return Promise.resolve({
          ok: true,
          value: {
            output: "Created https://github.com/org/repo/issues/101",
            exitCode: 0,
            timedOut: false,
          },
        });
      }) as never,
      ...(options.codegraph
        ? {
          prepareCodegraphContext: (() =>
            Promise.resolve(options.codegraph)) as never,
        }
        : {}),
    },
    github: {
      runGhCommand: (args: string[]) => {
        counters.gh.push(args);
        return Promise.resolve(ghFor(args, options.subIssuesExist));
      },
    },
  });
  return {
    promptsDir: PROMPTS_DIR,
    ghClient: stubGhClient(),
    logger: deps.logger,
    deps,
    ...(options.graft
      ? { collectGraftContext: () => Promise.resolve(options.graft!) }
      : {}),
  };
}

function freshCounters(): Counters {
  return {
    claims: 0,
    heartbeatRecords: 0,
    heartbeatClears: 0,
    claudeCalls: 0,
    gh: [],
  };
}

Deno.test("planHeldIssue: makes no claim and touches no heartbeat while a round runs", async () => {
  const counters = freshCounters();
  const processorDeps = countingDeps(counters, { subIssuesExist: true });
  const result = await planHeldIssue(makeContext(), processorDeps);

  assert(result.ok, "the held round completes");
  assertEquals(result.value.subIssueUrls.length, 2);
  assertEquals(counters.claims, 0, "no claimIssue call");
  assertEquals(counters.heartbeatRecords, 0, "no heartbeat record");
  assertEquals(counters.heartbeatClears, 0, "no heartbeat clear");
});

Deno.test("planHeldIssue: the control, processIssuePlanning, does claim and touch the heartbeat", async () => {
  const counters = freshCounters();
  const processorDeps = countingDeps(counters, { subIssuesExist: true });
  const result = await processIssuePlanning(makeContext(), processorDeps);

  assert(result.ok);
  assertEquals(counters.claims, 1, "the outer entry point claims once");
  assert(counters.heartbeatRecords >= 1, "and starts a heartbeat");
  assertEquals(counters.heartbeatClears, 1, "and clears it at the end");
});

Deno.test("planHeldIssue: an AgentTurnLimitError propagates instead of being handled as a planning failure", async () => {
  const counters = freshCounters();
  const processorDeps = countingDeps(counters, {
    subIssuesExist: false,
    claudeFails: true,
  });
  await assertRejects(
    () => planHeldIssue(makeContext(), processorDeps),
    AgentTurnLimitError,
  );
  assertEquals(counters.claims, 0, "no claim while the round fails");
  assertEquals(
    counters.heartbeatClears,
    0,
    "the live heartbeat is not cleared",
  );
  assertEquals(
    counters.gh.filter((args) => args[0] === "issue" && args[1] === "comment"),
    [],
    "no failure comment is posted by planHeldIssue",
  );
});

const OK_GRAFT: GraftContextResult = {
  status: "ok",
  enabled: true,
  buildSeconds: 1,
  bundleChars: 10,
  nodeCount: 3,
  callEdgeCount: 2,
  bundle: "export function f() {}",
};
const OK_CODEGRAPH: CodegraphContextResult = {
  status: "ok",
  enabled: true,
  nodeCount: 500,
};

function codegraphContext(): IssueContext {
  const ctx = makeContext();
  ctx.config = { ...ctx.config, codegraphContext: { enabled: true } };
  return ctx;
}

Deno.test("planHeldIssue: attaches the Graft facts to a successful round", async () => {
  const processorDeps = countingDeps(freshCounters(), {
    subIssuesExist: false,
    graft: OK_GRAFT,
  });
  const result = await planHeldIssue(makeContext(), processorDeps);

  assert(result.ok, "the held round completes");
  assertEquals(result.value.graftContext?.status, "ok");
});

Deno.test("planHeldIssue: attaches the CodeGraph facts to a successful round", async () => {
  const processorDeps = countingDeps(freshCounters(), {
    subIssuesExist: false,
    codegraph: OK_CODEGRAPH,
  });
  const result = await planHeldIssue(codegraphContext(), processorDeps);

  assert(result.ok, "the held round completes");
  assertEquals(result.value.codegraphContext?.status, "ok");
});

Deno.test("planHeldIssue: a failed round stays failed when it collected CodeGraph facts", async () => {
  const processorDeps = countingDeps(freshCounters(), {
    subIssuesExist: false,
    claudeErrors: true,
    codegraph: OK_CODEGRAPH,
  });
  const result = await planHeldIssue(codegraphContext(), processorDeps);

  assertEquals(
    result.ok,
    false,
    "facts must not turn a failure into a success",
  );
});
