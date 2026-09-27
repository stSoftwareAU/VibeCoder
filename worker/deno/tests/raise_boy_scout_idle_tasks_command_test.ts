/**
 * Tests for the `raise-boy-scout-idle-tasks` command (Issue #2933).
 *
 * Covers:
 *   - no repos (no --monitored-repos, no config.repos) -> failure;
 *   - --monitored-repos CSV is honoured;
 *   - config.repos fallback is used when --monitored-repos is absent;
 *   - happy path -> seeds the four Boy Scout wrappers and reports the count;
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

import { raiseBoyScoutIdleTasksCommand } from "../commands/raise_boy_scout_idle_tasks.ts";
import type { RaiseBoyScoutIdleTasksResult } from "../lib/boy_scout_idle_tasks.ts";
import type { Result, WorkerConfig } from "../types.ts";
import { DEAD_CODE_ISSUE_TITLE } from "../lib/idle_task_templates/dead_code_template.ts";
import { REPO_ROOT } from "./support/repo_root.ts";
import { openIdleTaskIssues } from "./support/open_idle_task_issues.ts";

function dataOf(
  result: { data?: unknown },
): RaiseBoyScoutIdleTasksResult | undefined {
  return result.data as RaiseBoyScoutIdleTasksResult | undefined;
}

const EMPTY_CONFIG = {} as unknown as WorkerConfig;

const labelOk = (): Promise<Result<void>> =>
  Promise.resolve({ ok: true, value: undefined });

const stableNow = () => new Date("2026-06-18T00:00:00.000Z");

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

Deno.test("raise-boy-scout-idle-tasks - no repos returns failure", async () => {
  const result = await raiseBoyScoutIdleTasksCommand.execute({}, EMPTY_CONFIG);
  assertEquals(result.success, false);
  assert(result.message.includes("No repos"));
});

Deno.test("raise-boy-scout-idle-tasks - honours --monitored-repos CSV", async () => {
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

Deno.test("raise-boy-scout-idle-tasks - falls back to config.repos", async () => {
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

Deno.test("raise-boy-scout-idle-tasks - an open idle task blocks the repo without --force", async () => {
  const { fn, created } = makeMockGh();
  const logs: string[] = [];
  const result = await raiseBoyScoutIdleTasksCommand.execute(
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

Deno.test("raise-boy-scout-idle-tasks - --force files past the gate and logs action=forced", async () => {
  const { fn, created } = makeMockGh();
  const logs: string[] = [];
  const result = await raiseBoyScoutIdleTasksCommand.execute(
    {
      "monitored-repos": "org/alpha",
      force: true,
      __testDeps: gatedDeps(fn, [UNRELATED_OPEN], logs),
    },
    EMPTY_CONFIG,
  );

  assertEquals(result.success, true);
  assertEquals(created.length, 4);
  assert(
    logs.includes("[idle-task] repo=org/alpha issue=1 action=forced"),
    `expected the forced line, got ${JSON.stringify(logs)}`,
  );
});

Deno.test("raise-boy-scout-idle-tasks - --force never duplicates an open canonical title", async () => {
  const { fn, created } = makeMockGh();
  const result = await raiseBoyScoutIdleTasksCommand.execute(
    {
      "monitored-repos": "org/alpha",
      force: "true",
      __testDeps: gatedDeps(fn, [DEAD_CODE_ISSUE_TITLE], []),
    },
    EMPTY_CONFIG,
  );

  assertEquals(result.success, true);
  assertEquals(created.length, 3);
  assertEquals(created.some((c) => c.title === DEAD_CODE_ISSUE_TITLE), false);
  assertEquals(dataOf(result)?.totalSkipped, 1);
});

Deno.test("raise-boy-scout-idle-tasks - an unknown flag is refused before any filing", async () => {
  const { fn, created } = makeMockGh();
  const result = await raiseBoyScoutIdleTasksCommand.execute(
    { "monitored-repos": "org/alpha", forse: true, __testDeps: testDeps(fn) },
    EMPTY_CONFIG,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--forse");
  assertStringIncludes(result.message, "--force");
  assertEquals(created.length, 0);
});

Deno.test("raise-boy-scout-idle-tasks - an unreadable --force is refused", async () => {
  const { fn, created } = makeMockGh();
  const result = await raiseBoyScoutIdleTasksCommand.execute(
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

Deno.test("raise-boy-scout-idle-tasks - help text documents --force", () => {
  assertStringIncludes(raiseBoyScoutIdleTasksCommand.description, "--force");
});
