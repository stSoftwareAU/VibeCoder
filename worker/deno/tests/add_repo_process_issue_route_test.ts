/**
 * Tests for `routeAddRepoInProcessIssue` (Issue #2579).
 *
 * The main worker loop must route a claimed `work-on` issue titled
 * `add-repo: owner/repo` to the `process-add-repo` command rather than
 * the standard coding/PR flow. These tests pin that routing shape with
 * an injected `execute` stub so no real network is touched:
 *   1. An `add-repo:` title is routed to `process-add-repo`, forwarding
 *      repo / issue-number / title; the outcome mirrors the command's
 *      `success` flag.
 *   2. A non-`add-repo:` title passes through (`{ routed: false }`) and
 *      the command is NEVER invoked — the caller runs the normal path.
 *   3. The prefix test is case-insensitive and tolerant of leading
 *      whitespace, matching `parseAddRepoTitle`.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  isAddRepoTitle,
  type ProcessAddRepoExecuteFn,
  routeAddRepoInProcessIssue,
} from "../lib/add_repo_process_issue_route.ts";
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

// Only the fields the helper threads through matter; cast keeps the test
// focused without standing up a full WorkerConfig.
const CONFIG = { workDir: "/tmp/work" } as unknown as WorkerConfig;

interface ExecuteCall {
  args: Record<string, unknown>;
  config: WorkerConfig;
}

function makeExecuteStub(
  result: CommandResult,
): { fn: ProcessAddRepoExecuteFn; calls: ExecuteCall[] } {
  const calls: ExecuteCall[] = [];
  const fn: ProcessAddRepoExecuteFn = (args, config) => {
    calls.push({ args, config });
    return Promise.resolve(result);
  };
  return { fn, calls };
}

Deno.test("routeAddRepoInProcessIssue - routes add-repo: title to process-add-repo", async () => {
  const { fn, calls } = makeExecuteStub({
    success: true,
    message: "process-add-repo: added example-org/private-repo-23",
    data: { outcome: "added" },
  });

  const outcome = await routeAddRepoInProcessIssue(
    {
      repo: "stSoftwareAU/VibeCoder",
      issueNumber: 2579,
      issueTitle: "add-repo: example-org/private-repo-23",
      config: CONFIG,
    },
    { logger: makeLogger(), executeFn: fn },
  );

  assertEquals(outcome, { routed: true, success: true });
  assertEquals(calls.length, 1);
  const call = calls[0]!;
  assertEquals(call.args["repo"], "stSoftwareAU/VibeCoder");
  assertEquals(call.args["issue-number"], 2579);
  assertEquals(call.args["title"], "add-repo: example-org/private-repo-23");
  assertEquals(call.config, CONFIG);
});

Deno.test("routeAddRepoInProcessIssue - mirrors command failure as success=false", async () => {
  const { fn } = makeExecuteStub({
    success: false,
    message: "process-add-repo: validation failed",
  });

  const outcome = await routeAddRepoInProcessIssue(
    {
      repo: "stSoftwareAU/VibeCoder",
      issueNumber: 99,
      issueTitle: "add-repo: example-org/private-repo-6",
      config: CONFIG,
    },
    { logger: makeLogger(), executeFn: fn },
  );

  assertEquals(outcome, { routed: true, success: false });
});

Deno.test("routeAddRepoInProcessIssue - normal title passes through untouched", async () => {
  const { fn, calls } = makeExecuteStub({ success: true, message: "unused" });

  const outcome = await routeAddRepoInProcessIssue(
    {
      repo: "stSoftwareAU/VibeCoder",
      issueNumber: 1234,
      issueTitle: "Fix the date parser",
      config: CONFIG,
    },
    { logger: makeLogger(), executeFn: fn },
  );

  assertEquals(outcome, { routed: false });
  assertEquals(
    calls.length,
    0,
    "command must not be invoked for a normal title",
  );
});

Deno.test("isAddRepoTitle - matches case-insensitively and tolerates whitespace", () => {
  assert(isAddRepoTitle("add-repo: owner/repo"));
  assert(isAddRepoTitle("ADD-REPO: owner/repo"));
  assert(isAddRepoTitle("  add-repo: owner/repo  "));
  assert(!isAddRepoTitle("Fix the date parser"));
  assert(!isAddRepoTitle("please add-repo: owner/repo"));
  assert(!isAddRepoTitle(""));
});
