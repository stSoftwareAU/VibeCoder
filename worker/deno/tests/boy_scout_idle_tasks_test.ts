/**
 * Tests for the Boy Scout idle-task raiser (Issue #2933).
 *
 * Covers:
 *   - the canonical Boy Scout template-name set;
 *   - empty repo list -> error Result;
 *   - happy path -> each repo seeds exactly the four Boy Scout wrappers (the
 *     template filter excludes the other six);
 *   - idempotent -> already-open wrappers are skipped;
 *   - per-repo error isolation -> a failing repo never aborts the sweep;
 *   - partial progress (Issue #3862) -> a partly-failed repo still reports the
 *     wrappers it filed, and an off-allowlist repo aborts before any gh call.
 *
 * All dependencies are injected so the tests never touch the network. The real
 * template body builders resolve cwd-relative prompt paths, so the seeding
 * tests run with cwd at the repo root.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

import {
  BOY_SCOUT_TEMPLATE_NAMES,
  raiseBoyScoutIdleTasks,
} from "../lib/boy_scout_idle_tasks.ts";
import { DEAD_CODE_ISSUE_TITLE } from "../lib/idle_task_templates/dead_code_template.ts";
import { DOC_COVERAGE_ISSUE_TITLE } from "../lib/idle_task_templates/doc_coverage_template.ts";
import { FORMAT_DRIFT_ISSUE_TITLE } from "../lib/idle_task_templates/format_drift_template.ts";
import { DEPRECATED_API_ISSUE_TITLE } from "../lib/idle_task_templates/deprecated_api_template.ts";
import {
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
} from "../lib/write_repo_allowlist.ts";
import type { Result } from "../types.ts";
import { withRepoRootCwd } from "./support/repo_prompts.ts";

const BOY_SCOUT_TITLES = [
  DEAD_CODE_ISSUE_TITLE,
  DOC_COVERAGE_ISSUE_TITLE,
  FORMAT_DRIFT_ISSUE_TITLE,
  DEPRECATED_API_ISSUE_TITLE,
];

const labelOk = (): Promise<Result<void>> =>
  Promise.resolve({ ok: true, value: undefined });

const stableNow = () => new Date("2026-06-18T00:00:00.000Z");

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

Deno.test("BOY_SCOUT_TEMPLATE_NAMES - holds the four Boy Scout slugs", () => {
  assertEquals(
    [...BOY_SCOUT_TEMPLATE_NAMES].sort(),
    ["dead-code", "deprecated-api", "doc-coverage", "format-drift"],
  );
});

Deno.test("raiseBoyScoutIdleTasks - empty repo list returns error", async () => {
  const result = await raiseBoyScoutIdleTasks({ repos: [] });
  assertEquals(result.ok, false);
});

Deno.test("raiseBoyScoutIdleTasks - seeds exactly the four Boy Scout wrappers per repo", async () => {
  await withRepoRootCwd(async () => {
    const { fn, created } = makeMockGh();
    const repos = ["org/alpha", "org/beta"];
    const result = await raiseBoyScoutIdleTasks({
      repos,
      ghCommandFn: fn,
      ensureLabelFn: labelOk,
      findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
      nowFn: stableNow,
    });

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.totalCreated, 8); // 4 per repo x 2 repos
    assertEquals(result.value.totalSkipped, 0);
    assertEquals(result.value.failedRepos, 0);

    // Only Boy Scout titles were filed — none of the other six templates.
    for (const c of created) {
      assert(
        BOY_SCOUT_TITLES.includes(c.title),
        `unexpected title filed: ${c.title}`,
      );
    }
    // Each repo got all four.
    for (const repo of repos) {
      const titles = created.filter((c) => c.repo === repo).map((c) => c.title);
      assertEquals(titles.sort(), [...BOY_SCOUT_TITLES].sort());
    }
  });
});

Deno.test("raiseBoyScoutIdleTasks - skips wrappers already open", async () => {
  await withRepoRootCwd(async () => {
    const { fn, created } = makeMockGh();
    const result = await raiseBoyScoutIdleTasks({
      repos: ["org/alpha"],
      ghCommandFn: fn,
      ensureLabelFn: labelOk,
      findExistingWrapperTitlesFn: () =>
        Promise.resolve(new Set<string>(BOY_SCOUT_TITLES)),
      nowFn: stableNow,
    });

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.totalCreated, 0);
    assertEquals(result.value.totalSkipped, 4);
    assertEquals(created.length, 0);
  });
});

Deno.test("raiseBoyScoutIdleTasks - a failing repo never aborts the sweep", async () => {
  await withRepoRootCwd(async () => {
    const { fn, created } = makeMockGh({ failRepos: new Set(["org/alpha"]) });
    const result = await raiseBoyScoutIdleTasks({
      repos: ["org/alpha", "org/beta"],
      ghCommandFn: fn,
      ensureLabelFn: labelOk,
      findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
      nowFn: stableNow,
    });

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.failedRepos, 1);
    const alpha = result.value.repos.find((r) => r.repo === "org/alpha");
    const beta = result.value.repos.find((r) => r.repo === "org/beta");
    assert(alpha?.error !== undefined);
    assertEquals(beta?.error, undefined);
    assertEquals(beta?.created.length, 4);
    // beta still got its four wrappers despite alpha failing.
    assertEquals(created.filter((c) => c.repo === "org/beta").length, 4);
  });
});

// ---------------------------------------------------------------------------
// Partial progress and preflight abort (Issue #3862)
// ---------------------------------------------------------------------------

Deno.test("raiseBoyScoutIdleTasks - a partly-failed repo still reports what it filed", async () => {
  await withRepoRootCwd(async () => {
    // Fail only the second of org/alpha's four Boy Scout creates.
    let alphaCreates = 0;
    const fn = (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "create") {
        const repoIdx = args.indexOf("--repo");
        const repo = repoIdx >= 0 ? args[repoIdx + 1]! : "";
        if (repo === "org/alpha" && ++alphaCreates === 2) {
          return Promise.reject(new Error("gh issue create exploded"));
        }
        return Promise.resolve("https://github.com/org/repo/issues/1\n");
      }
      return Promise.resolve("[]");
    };

    const result = await raiseBoyScoutIdleTasks({
      repos: ["org/alpha"],
      ghCommandFn: fn,
      ensureLabelFn: labelOk,
      findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
      nowFn: stableNow,
    });

    assert(result.ok);
    if (!result.ok) return;

    const alpha = result.value.repos.find((r) => r.repo === "org/alpha");
    assert(alpha?.error !== undefined);
    assertEquals(alpha?.created.length, BOY_SCOUT_TITLES.length - 1);
    assertEquals(alpha?.failed?.length, 1);
    assertEquals(alpha?.terminal, false);
    // The remaining templates were still attempted.
    assertEquals(alphaCreates, BOY_SCOUT_TITLES.length);
  });
});

Deno.test("raiseBoyScoutIdleTasks - an off-allowlist repo aborts in preflight without gh calls", async () => {
  const { fn, created } = makeMockGh();
  seedWriteRepoAllowlist("org/beta");
  try {
    const result = await withRepoRootCwd(() =>
      raiseBoyScoutIdleTasks({
        repos: ["org/alpha", "org/beta"],
        ghCommandFn: fn,
        ensureLabelFn: labelOk,
        findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
        nowFn: stableNow,
      })
    );

    assert(result.ok);
    if (!result.ok) return;

    const alpha = result.value.repos.find((r) => r.repo === "org/alpha");
    assertEquals(alpha?.terminal, true);
    assert(alpha?.error?.includes("org/alpha"));
    assertEquals(created.filter((c) => c.repo === "org/alpha").length, 0);
    assertEquals(
      created.filter((c) => c.repo === "org/beta").length,
      BOY_SCOUT_TITLES.length,
    );
  } finally {
    resetWriteRepoAllowlist();
  }
});
