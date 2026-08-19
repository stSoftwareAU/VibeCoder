/**
 * Tests for the `raise-boy-scout-idle-tasks` command (Issue #2933).
 *
 * Covers:
 *   - no repos (no --monitored-repos, no config.repos) -> failure;
 *   - --monitored-repos CSV is honoured;
 *   - config.repos fallback is used when --monitored-repos is absent;
 *   - happy path -> seeds the four Boy Scout wrappers and reports the count.
 *
 * All dependencies are injected so the tests never touch the network. The real
 * template body builders resolve cwd-relative prompt paths, so the seeding
 * tests run with cwd at the repo root.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

import { raiseBoyScoutIdleTasksCommand } from "../commands/raise_boy_scout_idle_tasks.ts";
import type { RaiseBoyScoutIdleTasksResult } from "../lib/boy_scout_idle_tasks.ts";
import type { Result, WorkerConfig } from "../types.ts";

function dataOf(
  result: { data?: unknown },
): RaiseBoyScoutIdleTasksResult | undefined {
  return result.data as RaiseBoyScoutIdleTasksResult | undefined;
}

const EMPTY_CONFIG = {} as unknown as WorkerConfig;

const labelOk = (): Promise<Result<void>> =>
  Promise.resolve({ ok: true, value: undefined });

const stableNow = () => new Date("2026-06-18T00:00:00.000Z");

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

async function withRepoRootCwd<T>(fn: () => Promise<T>): Promise<T> {
  const original = Deno.cwd();
  Deno.chdir(REPO_ROOT);
  try {
    return await fn();
  } finally {
    Deno.chdir(original);
  }
}

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

Deno.test("raise-boy-scout-idle-tasks - no repos returns failure", async () => {
  const result = await raiseBoyScoutIdleTasksCommand.execute({}, EMPTY_CONFIG);
  assertEquals(result.success, false);
  assert(result.message.includes("No repos"));
});

Deno.test("raise-boy-scout-idle-tasks - honours --monitored-repos CSV", async () => {
  await withRepoRootCwd(async () => {
    const { fn, created } = makeMockGh();
    const result = await raiseBoyScoutIdleTasksCommand.execute(
      {
        "monitored-repos": "org/alpha, org/beta",
        __testDeps: testDeps(fn),
      },
      EMPTY_CONFIG,
    );

    assertEquals(result.success, true);
    assertEquals(dataOf(result)?.repos.length, 2);
    assertEquals(dataOf(result)?.totalCreated, 8);
    assertEquals(created.length, 8);
  });
});

Deno.test("raise-boy-scout-idle-tasks - falls back to config.repos", async () => {
  await withRepoRootCwd(async () => {
    const { fn, created } = makeMockGh();
    const config = { repos: ["org/gamma"] } as unknown as WorkerConfig;
    const result = await raiseBoyScoutIdleTasksCommand.execute(
      { __testDeps: testDeps(fn) },
      config,
    );

    assertEquals(result.success, true);
    assertEquals(dataOf(result)?.repos.length, 1);
    assertEquals(dataOf(result)?.totalCreated, 4);
    assertEquals(created.every((c) => c.repo === "org/gamma"), true);
  });
});
