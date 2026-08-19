/**
 * Tests for `routeSeedIdleTasksInProcessIssue` (Issue #3860).
 *
 * The main worker loop must route a claimed issue titled
 * `seed-idle-tasks: owner/repo` to `process-seed-idle-tasks` rather than the
 * standard coding/PR flow — which would spawn the agent, whose baked `gh`
 * allowlist carries only the claimed issue's own repo, and refuse every
 * cross-repo write. These tests pin the routing shape with an injected
 * `execute` stub, so no real network is touched.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  type ProcessSeedIdleTasksExecuteFn,
  routeSeedIdleTasksInProcessIssue,
} from "../lib/seed_idle_tasks_process_issue_route.ts";
import type { CommandResult, Logger, WorkerConfig } from "../types.ts";

function makeLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

const CONFIG = {
  repos: ["stSoftwareAU/VibeCoder", "stSoftwareAU/private-repo-14"],
  workDir: "/tmp/work",
} as unknown as WorkerConfig;

interface ExecuteCall {
  args: Record<string, unknown>;
  config: WorkerConfig;
}

function makeExecuteStub(
  result: CommandResult,
): { fn: ProcessSeedIdleTasksExecuteFn; calls: ExecuteCall[] } {
  const calls: ExecuteCall[] = [];
  const fn: ProcessSeedIdleTasksExecuteFn = (args, config) => {
    calls.push({ args, config });
    return Promise.resolve(result);
  };
  return { fn, calls };
}

Deno.test("routeSeedIdleTasksInProcessIssue - routes a seeding title", async () => {
  const { fn, calls } = makeExecuteStub({ success: true, message: "seeded" });

  const outcome = await routeSeedIdleTasksInProcessIssue(
    {
      repo: "stSoftwareAU/VibeCoder",
      issueNumber: 3858,
      issueTitle: "seed-idle-tasks: stSoftwareAU/private-repo-14",
      config: CONFIG,
    },
    { logger: makeLogger(), executeFn: fn },
  );

  assertEquals(outcome, { routed: true, success: true });
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.args["repo"], "stSoftwareAU/VibeCoder");
  assertEquals(calls[0]!.args["issue-number"], 3858);
  assertEquals(
    calls[0]!.args["title"],
    "seed-idle-tasks: stSoftwareAU/private-repo-14",
  );
  // The config carrying the operator-controlled `repos` allowlist must be
  // threaded through — it is the only sanctioned source of the target.
  assertEquals(calls[0]!.config, CONFIG);
});

Deno.test("routeSeedIdleTasksInProcessIssue - mirrors command failure", async () => {
  const { fn } = makeExecuteStub({ success: false, message: "failed" });

  const outcome = await routeSeedIdleTasksInProcessIssue(
    {
      repo: "stSoftwareAU/VibeCoder",
      issueNumber: 99,
      issueTitle: "SEED-IDLE-TASKS: stSoftwareAU/private-repo-14",
      config: CONFIG,
    },
    { logger: makeLogger(), executeFn: fn },
  );

  assertEquals(outcome, { routed: true, success: false });
});

Deno.test("routeSeedIdleTasksInProcessIssue - normal title passes through", async () => {
  const { fn, calls } = makeExecuteStub({ success: true, message: "unused" });

  const outcome = await routeSeedIdleTasksInProcessIssue(
    {
      repo: "stSoftwareAU/VibeCoder",
      issueNumber: 1234,
      issueTitle: "Fix the date parser",
      config: CONFIG,
    },
    { logger: makeLogger(), executeFn: fn },
  );

  assertEquals(outcome, { routed: false });
  assertEquals(calls.length, 0);
});
