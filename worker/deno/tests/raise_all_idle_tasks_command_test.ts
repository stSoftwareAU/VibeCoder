/**
 * Tests for the `raise-all-idle-tasks` command (Issue #3196).
 *
 * Covers:
 *   - no repos (no --monitored-repos, no config.repos) -> failure;
 *   - --monitored-repos CSV is honoured;
 *   - config.repos fallback is used when --monitored-repos is absent;
 *   - happy path -> seeds all ten wrappers per repo and reports the count;
 *   - an open idle task blocks the repo unless --force, which logs
 *     action=forced and still never duplicates an open title (Issue #2753);
 *   - an unknown or unreadable flag is refused (Issue #2753).
 *
 * All dependencies are injected so the tests never touch the network. The real
 * template body builders read `prompts/<scan>/prompt.md`, so the seeding
 * tests name this checkout with the builders' `rootDir` seam (Issue #1024)
 * rather than moving the process's working directory.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { raiseAllIdleTasksCommand } from "../commands/raise_all_idle_tasks.ts";
import type { RaiseAllIdleTasksResult } from "../lib/raise_all_idle_tasks.ts";
import { IDLE_TASK_WRAPPER_TITLES } from "../lib/idle_task_backfill.ts";
import type { Result, WorkerConfig } from "../types.ts";
import { REPO_ROOT } from "./support/repo_root.ts";
import { openIdleTaskIssues } from "./support/open_idle_task_issues.ts";

const TEN = IDLE_TASK_WRAPPER_TITLES.length;

function dataOf(
  result: { data?: unknown },
): RaiseAllIdleTasksResult | undefined {
  return result.data as RaiseAllIdleTasksResult | undefined;
}

const EMPTY_CONFIG = {} as unknown as WorkerConfig;

const labelOk = (): Promise<Result<void>> =>
  Promise.resolve({ ok: true, value: undefined });

const stableNow = () => new Date("2026-07-03T00:00:00.000Z");

function makeMockGh() {
  const created: { repo: string; title: string }[] = [];
  const fn = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "create") {
      const repoIdx = args.indexOf("--repo");
      const titleIdx = args.indexOf("--title");
      created.push({ repo: args[repoIdx + 1]!, title: args[titleIdx + 1]! });
      return Promise.resolve("https://github.com/org/repo/issues/1\n");
    }
    return Promise.resolve("[]");
  };
  return { fn, created };
}

const testDeps = (fn: (args: string[]) => Promise<string>) => ({
  ghCommandFn: fn,
  ensureLabelFn: labelOk,
  findOpenIdleTaskIssuesFn: () => Promise.resolve([]),
  nowFn: stableNow,
  rootDir: REPO_ROOT,
  log: () => {},
});

Deno.test("raise-all-idle-tasks - no repos returns failure", async () => {
  const result = await raiseAllIdleTasksCommand.execute({}, EMPTY_CONFIG);
  assertEquals(result.success, false);
  assert(result.message.includes("No repos"));
});

Deno.test("raise-all-idle-tasks - honours --monitored-repos CSV", async () => {
  const { fn, created } = makeMockGh();
  const result = await raiseAllIdleTasksCommand.execute(
    {
      "monitored-repos": "org/alpha, org/beta",
      __testDeps: testDeps(fn),
    },
    EMPTY_CONFIG,
  );

  assertEquals(result.success, true);
  assertEquals(dataOf(result)?.repos.length, 2);
  assertEquals(dataOf(result)?.totalCreated, TEN * 2);
  assertEquals(created.length, TEN * 2);
});

Deno.test("raise-all-idle-tasks - falls back to config.repos", async () => {
  const { fn, created } = makeMockGh();
  const config = { repos: ["org/gamma"] } as unknown as WorkerConfig;
  const result = await raiseAllIdleTasksCommand.execute(
    { __testDeps: testDeps(fn) },
    config,
  );

  assertEquals(result.success, true);
  assertEquals(dataOf(result)?.repos.length, 1);
  assertEquals(dataOf(result)?.totalCreated, TEN);
  assertEquals(created.every((c) => c.repo === "org/gamma"), true);
});

// --- Issue #2753: --force past the any-open idle-task gate ---

const UNRELATED_OPEN = "Some other open idle task";

function gatedDeps(
  fn: (args: string[]) => Promise<string>,
  openTitles: readonly string[],
  logs: string[],
) {
  return {
    ...testDeps(fn),
    findOpenIdleTaskIssuesFn: () =>
      Promise.resolve(openIdleTaskIssues(openTitles)),
    log: (line: string) => logs.push(line),
  };
}

Deno.test("raise-all-idle-tasks - an open idle task blocks the repo without --force", async () => {
  const { fn, created } = makeMockGh();
  const logs: string[] = [];
  const result = await raiseAllIdleTasksCommand.execute(
    {
      "monitored-repos": "org/alpha",
      __testDeps: gatedDeps(fn, [UNRELATED_OPEN], logs),
    },
    EMPTY_CONFIG,
  );

  assertEquals(result.success, true);
  assertEquals(created.length, 0);
  assertEquals(logs.some((l) => l.includes("action=forced")), false);
});

Deno.test("raise-all-idle-tasks - --force files past the gate and logs action=forced", async () => {
  const { fn, created } = makeMockGh();
  const logs: string[] = [];
  const result = await raiseAllIdleTasksCommand.execute(
    {
      "monitored-repos": "org/alpha",
      force: true,
      __testDeps: gatedDeps(fn, [UNRELATED_OPEN], logs),
    },
    EMPTY_CONFIG,
  );

  assertEquals(result.success, true);
  assertEquals(created.length, TEN);
  assert(
    logs.includes("[idle-task] repo=org/alpha issue=1 action=forced"),
    `expected the forced line, got ${JSON.stringify(logs)}`,
  );
});

Deno.test("raise-all-idle-tasks - --force never duplicates an open canonical title", async () => {
  const { fn, created } = makeMockGh();
  const openTitle = IDLE_TASK_WRAPPER_TITLES[0]!;
  const result = await raiseAllIdleTasksCommand.execute(
    {
      "monitored-repos": "org/alpha",
      force: true,
      __testDeps: gatedDeps(fn, [openTitle], []),
    },
    EMPTY_CONFIG,
  );

  assertEquals(result.success, true);
  assertEquals(created.length, TEN - 1);
  assertEquals(created.some((c) => c.title === openTitle), false);
  assertEquals(dataOf(result)?.totalSkipped, 1);
});

Deno.test("raise-all-idle-tasks - an unknown flag is refused before any filing", async () => {
  const { fn, created } = makeMockGh();
  const result = await raiseAllIdleTasksCommand.execute(
    { "monitored-repos": "org/alpha", forse: true, __testDeps: testDeps(fn) },
    EMPTY_CONFIG,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--forse");
  assertStringIncludes(result.message, "--force");
  assertEquals(created.length, 0);
});

Deno.test("raise-all-idle-tasks - an unreadable --force is refused", async () => {
  const { fn, created } = makeMockGh();
  const result = await raiseAllIdleTasksCommand.execute(
    {
      "monitored-repos": "org/alpha",
      force: "maybe",
      __testDeps: testDeps(fn),
    },
    EMPTY_CONFIG,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--force");
  assertEquals(created.length, 0);
});

Deno.test("raise-all-idle-tasks - help text documents --force", () => {
  assertStringIncludes(raiseAllIdleTasksCommand.description, "--force");
});
