/**
 * Tests for the `raise-all-idle-tasks` command (Issue #3196).
 *
 * Covers:
 *   - no repos (no --monitored-repos, no config.repos) -> failure;
 *   - --monitored-repos CSV is honoured;
 *   - config.repos fallback is used when --monitored-repos is absent;
 *   - happy path -> seeds all ten wrappers per repo and reports the count.
 *
 * All dependencies are injected so the tests never touch the network. The real
 * template body builders resolve cwd-relative prompt paths, so the seeding
 * tests run with cwd at the repo root.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

import { raiseAllIdleTasksCommand } from "../commands/raise_all_idle_tasks.ts";
import type { RaiseAllIdleTasksResult } from "../lib/raise_all_idle_tasks.ts";
import { IDLE_TASK_WRAPPER_TITLES } from "../lib/idle_task_backfill.ts";
import type { Result, WorkerConfig } from "../types.ts";
import { withRepoRootCwd } from "./support/repo_prompts.ts";

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
  findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
  nowFn: stableNow,
  log: () => {},
});

Deno.test("raise-all-idle-tasks - no repos returns failure", async () => {
  const result = await raiseAllIdleTasksCommand.execute({}, EMPTY_CONFIG);
  assertEquals(result.success, false);
  assert(result.message.includes("No repos"));
});

Deno.test("raise-all-idle-tasks - honours --monitored-repos CSV", async () => {
  await withRepoRootCwd(async () => {
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
});

Deno.test("raise-all-idle-tasks - falls back to config.repos", async () => {
  await withRepoRootCwd(async () => {
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
});
