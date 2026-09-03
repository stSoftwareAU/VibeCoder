/**
 * Tests for the `create-all-idle-task-wrappers` command (Issue #2870).
 *
 * Covers:
 *   - missing-repo — no `--repo` arg returns a failure result without filing;
 *   - happy-path — a clean repo seeds all ten wrappers and reports the count;
 *   - idempotent — a repo with wrappers already open skips them;
 *   - helper-error — a gh failure surfaces as a failed CommandResult;
 *   - outcome table (Issue #3862) — the per-template table is printed on both
 *     the success and the failure path, and the partial outcome is returned.
 *
 * All dependencies are injected so the tests never touch the network. The
 * real template body builders resolve cwd-relative prompt paths, so the
 * happy-path test runs with cwd at the repo root.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

import { createAllIdleTaskWrappersCommand } from "../commands/create_all_idle_task_wrappers.ts";
import type { CreateAllIdleTaskWrappersResult } from "../lib/create_all_idle_task_wrappers.ts";
import { IDLE_TASK_WRAPPER_TITLES } from "../lib/idle_task_backfill.ts";
import type { Result, WorkerConfig } from "../types.ts";
import { withRepoRootCwd } from "./support/repo_prompts.ts";

/** Narrow the non-generic CommandResult.data to the helper's result shape. */
function dataOf(
  result: { data?: unknown },
): CreateAllIdleTaskWrappersResult | undefined {
  return result.data as CreateAllIdleTaskWrappersResult | undefined;
}

// A minimal config — the command does not read any field from it.
const EMPTY_CONFIG = {} as unknown as WorkerConfig;

const labelOk = (): Promise<Result<void>> =>
  Promise.resolve({ ok: true, value: undefined });

const stableNow = () => new Date("2026-06-16T00:00:00.000Z");

interface GhCall {
  args: string[];
}

/** Collect `gh issue create` calls; everything else returns an empty array. */
function makeMockGh(opts: { createThrows?: boolean } = {}) {
  const calls: GhCall[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    if (args[0] === "issue" && args[1] === "create") {
      if (opts.createThrows) {
        return Promise.reject(new Error("gh issue create exploded"));
      }
      return Promise.resolve(
        "https://github.com/org/private-repo-13/issues/1\n",
      );
    }
    return Promise.resolve("[]");
  };
  return { fn, calls };
}

Deno.test("create-all-idle-task-wrappers - missing --repo returns failure", async () => {
  const result = await createAllIdleTaskWrappersCommand.execute(
    {},
    EMPTY_CONFIG,
  );
  assertEquals(result.success, false);
  assert(result.message.includes("--repo"));
});

Deno.test("create-all-idle-task-wrappers - clean repo seeds all ten wrappers", async () => {
  await withRepoRootCwd(async () => {
    const { fn, calls } = makeMockGh();
    const result = await createAllIdleTaskWrappersCommand.execute(
      {
        repo: "stSoftwareAU/private-repo-14",
        __testDeps: {
          ghCommandFn: fn,
          ensureLabelFn: labelOk,
          findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
          nowFn: stableNow,
          log: () => {},
        },
      },
      EMPTY_CONFIG,
    );

    assertEquals(result.success, true);
    assertEquals(
      dataOf(result)?.created.length,
      IDLE_TASK_WRAPPER_TITLES.length,
    );
    assertEquals(dataOf(result)?.skipped.length, 0);

    // Every filed title is a member of the canonical allowlist.
    const created = calls.filter(
      (c) => c.args[0] === "issue" && c.args[1] === "create",
    );
    assertEquals(created.length, IDLE_TASK_WRAPPER_TITLES.length);
    for (const call of created) {
      const i = call.args.indexOf("--title");
      assert(i >= 0);
      assert(IDLE_TASK_WRAPPER_TITLES.includes(call.args[i + 1]!));
    }
  });
});

Deno.test("create-all-idle-task-wrappers - skips wrappers already open", async () => {
  await withRepoRootCwd(async () => {
    const { fn } = makeMockGh();
    const allOpen = new Set<string>(IDLE_TASK_WRAPPER_TITLES);
    const result = await createAllIdleTaskWrappersCommand.execute(
      {
        repo: "stSoftwareAU/private-repo-14",
        __testDeps: {
          ghCommandFn: fn,
          ensureLabelFn: labelOk,
          findExistingWrapperTitlesFn: () => Promise.resolve(allOpen),
          nowFn: stableNow,
          log: () => {},
        },
      },
      EMPTY_CONFIG,
    );

    assertEquals(result.success, true);
    assertEquals(dataOf(result)?.created.length, 0);
    assertEquals(
      dataOf(result)?.skipped.length,
      IDLE_TASK_WRAPPER_TITLES.length,
    );
  });
});

Deno.test("create-all-idle-task-wrappers - gh failure surfaces as failed result", async () => {
  await withRepoRootCwd(async () => {
    const { fn } = makeMockGh({ createThrows: true });
    const result = await createAllIdleTaskWrappersCommand.execute(
      {
        repo: "stSoftwareAU/private-repo-14",
        __testDeps: {
          ghCommandFn: fn,
          ensureLabelFn: labelOk,
          findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
          nowFn: stableNow,
          log: () => {},
        },
      },
      EMPTY_CONFIG,
    );

    assertEquals(result.success, false);
    assert(result.message.includes("gh issue create failed"));
  });
});

// ---------------------------------------------------------------------------
// Per-template outcome table (Issue #3862)
// ---------------------------------------------------------------------------

Deno.test("create-all-idle-task-wrappers - prints the outcome table on success", async () => {
  await withRepoRootCwd(async () => {
    const { fn } = makeMockGh();
    const lines: string[] = [];
    const result = await createAllIdleTaskWrappersCommand.execute(
      {
        repo: "stSoftwareAU/private-repo-14",
        __testDeps: {
          ghCommandFn: fn,
          ensureLabelFn: labelOk,
          findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
          nowFn: stableNow,
          log: (line: string) => lines.push(line),
        },
      },
      EMPTY_CONFIG,
    );

    assertEquals(result.success, true);
    const table = lines.filter((l) => l.includes("outcome table"));
    assertEquals(table.length, 1);
    // One `created` row per canonical wrapper.
    const createdRows = lines.filter((l) => / created /.test(l));
    assertEquals(createdRows.length, IDLE_TASK_WRAPPER_TITLES.length);
  });
});

Deno.test("create-all-idle-task-wrappers - prints the outcome table and exits non-zero on failure", async () => {
  await withRepoRootCwd(async () => {
    const { fn } = makeMockGh({ createThrows: true });
    const lines: string[] = [];
    const result = await createAllIdleTaskWrappersCommand.execute(
      {
        repo: "stSoftwareAU/private-repo-14",
        __testDeps: {
          ghCommandFn: fn,
          ensureLabelFn: labelOk,
          findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
          nowFn: stableNow,
          log: (line: string) => lines.push(line),
        },
      },
      EMPTY_CONFIG,
    );

    assertEquals(result.success, false);
    assert(
      lines.some((l) => l.includes("outcome table")),
      "the table must be printed on the failure path too",
    );
    const failedRows = lines.filter((l) => / failed /.test(l));
    assertEquals(failedRows.length, IDLE_TASK_WRAPPER_TITLES.length);
    assert(
      failedRows.every((l) => l.includes("exploded")),
      "each failed row must carry its reason",
    );
    // The partial outcome is still returned to the caller.
    assertEquals(
      dataOf(result)?.failed?.length,
      IDLE_TASK_WRAPPER_TITLES.length,
    );
  });
});
