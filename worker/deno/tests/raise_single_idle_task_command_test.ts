/**
 * Tests for the `raise-single-idle-task` command's flag handling (Issue #2753).
 *
 * Covers:
 *   - an open idle task blocks the repo without --force;
 *   - --force files past the gate and logs action=forced;
 *   - an unknown or unreadable flag is refused before any filing;
 *   - the help text documents --force.
 *
 * All dependencies are injected so the tests never touch the network; the
 * real body builders read prompts from this checkout via `rootDir`.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { raiseSingleIdleTaskCommand } from "../commands/raise_single_idle_task.ts";
import { DOCUMENTATION_AUDIT_ISSUE_TITLE } from "../lib/idle_task_templates/documentation_audit_template.ts";
import type { Result, WorkerConfig } from "../types.ts";
import { REPO_ROOT } from "./support/repo_root.ts";
import { openIdleTaskIssues } from "./support/open_idle_task_issues.ts";

const EMPTY_CONFIG = {} as unknown as WorkerConfig;

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

/** Test deps reporting `openTitles` as the repo's open idle-task issues. */
function testDeps(
  fn: (args: string[]) => Promise<string>,
  openTitles: readonly string[] = [],
  logs: string[] = [],
) {
  return {
    ghCommandFn: fn,
    ensureLabelFn: (): Promise<Result<void>> =>
      Promise.resolve({ ok: true, value: undefined }),
    findOpenIdleTaskIssuesFn: () =>
      Promise.resolve(openIdleTaskIssues(openTitles)),
    nowFn: () => new Date("2026-07-10T00:00:00.000Z"),
    rootDir: REPO_ROOT,
    log: (line: string) => logs.push(line),
  };
}

const BASE_ARGS = { template: "documentation-audit", repo: "org/alpha" };

Deno.test("raise-single-idle-task - an open idle task blocks the repo without --force", async () => {
  const { fn, created } = makeMockGh();
  const logs: string[] = [];
  const result = await raiseSingleIdleTaskCommand.execute(
    { ...BASE_ARGS, __testDeps: testDeps(fn, ["Some other idle task"], logs) },
    EMPTY_CONFIG,
  );

  assertEquals(result.success, true);
  assertEquals(created.length, 0);
  assertEquals(logs.some((l) => l.includes("action=forced")), false);
});

Deno.test("raise-single-idle-task - --force files past the gate and logs action=forced", async () => {
  const { fn, created } = makeMockGh();
  const logs: string[] = [];
  const result = await raiseSingleIdleTaskCommand.execute(
    {
      ...BASE_ARGS,
      force: true,
      __testDeps: testDeps(fn, ["Some other idle task"], logs),
    },
    EMPTY_CONFIG,
  );

  assertEquals(result.success, true);
  assertEquals(created.length, 1);
  assertEquals(created[0]!.title, DOCUMENTATION_AUDIT_ISSUE_TITLE);
  assert(
    logs.includes("[idle-task] repo=org/alpha issue=1 action=forced"),
    `expected the forced line, got ${JSON.stringify(logs)}`,
  );
});

Deno.test("raise-single-idle-task - an unknown flag is refused before any filing", async () => {
  const { fn, created } = makeMockGh();
  const result = await raiseSingleIdleTaskCommand.execute(
    { ...BASE_ARGS, forse: true, __testDeps: testDeps(fn) },
    EMPTY_CONFIG,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--forse");
  assertStringIncludes(result.message, "--force");
  assertEquals(created.length, 0);
});

Deno.test("raise-single-idle-task - an unreadable --force is refused", async () => {
  const { fn, created } = makeMockGh();
  const result = await raiseSingleIdleTaskCommand.execute(
    { ...BASE_ARGS, force: "maybe", __testDeps: testDeps(fn) },
    EMPTY_CONFIG,
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--force");
  assertEquals(created.length, 0);
});

Deno.test("raise-single-idle-task - help text documents --force", () => {
  assertStringIncludes(raiseSingleIdleTaskCommand.description, "--force");
});
