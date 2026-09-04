/**
 * Tests for the all-idle-tasks raiser (Issue #3196).
 *
 * Covers:
 *   - empty repo list -> error Result;
 *   - happy path -> each repo seeds all ten canonical idle-task wrappers;
 *   - idempotent -> already-open wrappers are skipped;
 *   - per-repo error isolation -> a failing repo never aborts the sweep;
 *   - partial progress (Issue #3862) -> a partly-failed repo still reports the
 *     wrappers it filed, and an off-allowlist repo aborts before any gh call.
 *
 * All dependencies are injected so the tests never touch the network. The real
 * template body builders read `prompts/<scan>/prompt.md`, so the seeding
 * tests name this checkout with the builders' `rootDir` seam (Issue #1024)
 * rather than moving the process's working directory.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

import { raiseAllIdleTasks } from "../lib/raise_all_idle_tasks.ts";
import { IDLE_TASK_WRAPPER_TITLES } from "../lib/idle_task_backfill.ts";
import {
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
} from "../lib/write_repo_allowlist.ts";
import type { Result } from "../types.ts";
import { REPO_ROOT } from "./support/repo_root.ts";

const ALL_TITLES = [...IDLE_TASK_WRAPPER_TITLES];

const labelOk = (): Promise<Result<void>> =>
  Promise.resolve({ ok: true, value: undefined });

const stableNow = () => new Date("2026-07-03T00:00:00.000Z");

/**
 * Mock gh that records `issue create` calls and returns no open wrappers by
 * default. `failRepos` makes `issue create` throw for any repo whose slug
 * appears in a create call's `--repo` value.
 */
function makeMockGh(opts: { failRepos?: Set<string> } = {}) {
  const created: { repo: string; title: string }[] = [];
  const fn = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "create") {
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1]! : "";
      if (opts.failRepos?.has(repo)) {
        return Promise.reject(new Error("gh issue create exploded"));
      }
      const titleIdx = args.indexOf("--title");
      created.push({ repo, title: args[titleIdx + 1]! });
      return Promise.resolve("https://github.com/org/repo/issues/1\n");
    }
    return Promise.resolve("[]");
  };
  return { fn, created };
}

Deno.test("raiseAllIdleTasks - empty repo list returns error", async () => {
  const result = await raiseAllIdleTasks({ repos: [] });
  assertEquals(result.ok, false);
});

Deno.test("raiseAllIdleTasks - seeds all ten canonical wrappers per repo", async () => {
  const { fn, created } = makeMockGh();
  const repos = ["org/alpha", "org/beta"];
  const result = await raiseAllIdleTasks({
    repos,
    ghCommandFn: fn,
    ensureLabelFn: labelOk,
    findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
    nowFn: stableNow,
    rootDir: REPO_ROOT,
  });

  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.value.totalCreated, ALL_TITLES.length * repos.length);
  assertEquals(result.value.totalSkipped, 0);
  assertEquals(result.value.failedRepos, 0);

  // Every filed title is a canonical wrapper title.
  for (const c of created) {
    assert(
      ALL_TITLES.includes(c.title),
      `unexpected title filed: ${c.title}`,
    );
  }
  // Each repo got the complete set of ten.
  for (const repo of repos) {
    const titles = created.filter((c) => c.repo === repo).map((c) => c.title);
    assertEquals(titles.sort(), [...ALL_TITLES].sort());
  }
});

Deno.test("raiseAllIdleTasks - skips wrappers already open", async () => {
  const { fn, created } = makeMockGh();
  const result = await raiseAllIdleTasks({
    repos: ["org/alpha"],
    ghCommandFn: fn,
    ensureLabelFn: labelOk,
    findExistingWrapperTitlesFn: () =>
      Promise.resolve(new Set<string>(ALL_TITLES)),
    nowFn: stableNow,
    rootDir: REPO_ROOT,
  });

  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.value.totalCreated, 0);
  assertEquals(result.value.totalSkipped, ALL_TITLES.length);
  assertEquals(created.length, 0);
});

Deno.test("raiseAllIdleTasks - a failing repo never aborts the sweep", async () => {
  const { fn, created } = makeMockGh({ failRepos: new Set(["org/alpha"]) });
  const result = await raiseAllIdleTasks({
    repos: ["org/alpha", "org/beta"],
    ghCommandFn: fn,
    ensureLabelFn: labelOk,
    findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
    nowFn: stableNow,
    rootDir: REPO_ROOT,
  });

  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.value.failedRepos, 1);
  const alpha = result.value.repos.find((r) => r.repo === "org/alpha");
  const beta = result.value.repos.find((r) => r.repo === "org/beta");
  assert(alpha?.error !== undefined);
  assertEquals(beta?.error, undefined);
  assertEquals(beta?.created.length, ALL_TITLES.length);
  // beta still got its full set despite alpha failing.
  assertEquals(
    created.filter((c) => c.repo === "org/beta").length,
    ALL_TITLES.length,
  );
});

// ---------------------------------------------------------------------------
// Partial progress and preflight abort (Issue #3862)
// ---------------------------------------------------------------------------

Deno.test("raiseAllIdleTasks - a partly-failed repo still reports what it filed", async () => {
  // Fail only the third create in org/alpha; the rest of that repo's
  // templates — and org/beta — must still be attempted.
  let alphaCreates = 0;
  const fn = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "create") {
      const repoIdx = args.indexOf("--repo");
      const repo = repoIdx >= 0 ? args[repoIdx + 1]! : "";
      if (repo === "org/alpha" && ++alphaCreates === 3) {
        return Promise.reject(new Error("gh issue create exploded"));
      }
      return Promise.resolve("https://github.com/org/repo/issues/1\n");
    }
    return Promise.resolve("[]");
  };

  const result = await raiseAllIdleTasks({
    repos: ["org/alpha", "org/beta"],
    ghCommandFn: fn,
    ensureLabelFn: labelOk,
    findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
    nowFn: stableNow,
    rootDir: REPO_ROOT,
  });

  assert(result.ok);
  if (!result.ok) return;

  const alpha = result.value.repos.find((r) => r.repo === "org/alpha");
  assert(alpha?.error !== undefined, "alpha must be reported as failed");
  // Partial progress survives: everything but the one failed template.
  assertEquals(alpha?.created.length, ALL_TITLES.length - 1);
  assertEquals(alpha?.failed?.length, 1);
  assertEquals(alpha?.terminal, false);
  assertEquals(result.value.failedRepos, 1);
  // beta is untouched by alpha's failure.
  const beta = result.value.repos.find((r) => r.repo === "org/beta");
  assertEquals(beta?.created.length, ALL_TITLES.length);
});

Deno.test("raiseAllIdleTasks - an off-allowlist repo aborts in preflight without gh calls", async () => {
  const { fn, created } = makeMockGh();
  seedWriteRepoAllowlist("org/beta");
  try {
    const result = await raiseAllIdleTasks({
      repos: ["org/alpha", "org/beta"],
      ghCommandFn: fn,
      ensureLabelFn: labelOk,
      findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
      nowFn: stableNow,
      rootDir: REPO_ROOT,
    });

    assert(result.ok);
    if (!result.ok) return;

    const alpha = result.value.repos.find((r) => r.repo === "org/alpha");
    assertEquals(alpha?.terminal, true);
    assert(alpha?.error?.includes("org/alpha"));
    // No wrapper was ever attempted against the blocked repo.
    assertEquals(created.filter((c) => c.repo === "org/alpha").length, 0);
    // The allowed repo still got its full set.
    assertEquals(
      created.filter((c) => c.repo === "org/beta").length,
      ALL_TITLES.length,
    );
  } finally {
    resetWriteRepoAllowlist();
  }
});
