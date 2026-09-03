/**
 * Tests for the single-template idle-task raiser (Issue #3320).
 *
 * The raiser seeds exactly one named idle-task template's wrapper into one or
 * more named target repos — the deterministic, "pinned target" one-off that
 * lets an operator trigger a specific scan (e.g. `documentation-audit` against
 * private-repo-14) without waiting for the random idle-task filer to happen to pick
 * that template and repo.
 *
 * Covers:
 *   - empty repo list -> error Result;
 *   - unknown template name -> error Result (fail loud, never a silent no-op);
 *   - happy path -> each repo seeds exactly the one named wrapper (the filter
 *     excludes the other twelve);
 *   - idempotent -> an already-open wrapper is skipped;
 *   - per-repo error isolation -> a failing repo never aborts the sweep;
 *   - partial progress (Issue #3862) -> a failed repo reports the per-template
 *     failure, and an off-allowlist repo aborts before any gh call.
 *
 * All dependencies are injected so the tests never touch the network. The real
 * template body builders resolve cwd-relative prompt paths, so the seeding
 * tests run with cwd at the repo root.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

import { raiseSingleIdleTask } from "../lib/raise_single_idle_task.ts";
import { DOCUMENTATION_AUDIT_ISSUE_TITLE } from "../lib/idle_task_templates/documentation_audit_template.ts";
import { SECURITY_SCAN_ISSUE_TITLE } from "../lib/idle_task_templates/security_scan_template.ts";
import {
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
} from "../lib/write_repo_allowlist.ts";
import type { Result } from "../types.ts";
import { withRepoRootCwd } from "./support/repo_prompts.ts";

const labelOk = (): Promise<Result<void>> =>
  Promise.resolve({ ok: true, value: undefined });

const stableNow = () => new Date("2026-07-10T00:00:00.000Z");

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

Deno.test("raiseSingleIdleTask - empty repo list returns error", async () => {
  const result = await raiseSingleIdleTask({
    template: "documentation-audit",
    repos: [],
  });
  assertEquals(result.ok, false);
});

Deno.test("raiseSingleIdleTask - unknown template name fails loud", async () => {
  const { fn, created } = makeMockGh();
  const result = await raiseSingleIdleTask({
    template: "not-a-real-template",
    repos: ["org/alpha"],
    ghCommandFn: fn,
    ensureLabelFn: labelOk,
    findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
    nowFn: stableNow,
  });
  assertEquals(result.ok, false);
  // Nothing was filed — the failure is loud, not a silent empty result.
  assertEquals(created.length, 0);
});

Deno.test("raiseSingleIdleTask - seeds exactly the one named wrapper per repo", async () => {
  await withRepoRootCwd(async () => {
    const { fn, created } = makeMockGh();
    const repos = ["org/alpha", "org/beta"];
    const result = await raiseSingleIdleTask({
      template: "documentation-audit",
      repos,
      ghCommandFn: fn,
      ensureLabelFn: labelOk,
      findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
      nowFn: stableNow,
    });

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.template, "documentation-audit");
    assertEquals(result.value.totalCreated, 2); // 1 per repo x 2 repos
    assertEquals(result.value.totalSkipped, 0);
    assertEquals(result.value.failedRepos, 0);

    // Only the documentation-audit wrapper was filed — none of the other twelve.
    for (const c of created) {
      assertEquals(c.title, DOCUMENTATION_AUDIT_ISSUE_TITLE);
    }
    assertEquals(created.length, 2);
  });
});

Deno.test("raiseSingleIdleTask - honours a different template name", async () => {
  await withRepoRootCwd(async () => {
    const { fn, created } = makeMockGh();
    const result = await raiseSingleIdleTask({
      template: "security-scan",
      repos: ["org/alpha"],
      ghCommandFn: fn,
      ensureLabelFn: labelOk,
      findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
      nowFn: stableNow,
    });

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(created.length, 1);
    assertEquals(created[0]!.title, SECURITY_SCAN_ISSUE_TITLE);
  });
});

Deno.test("raiseSingleIdleTask - skips a wrapper already open", async () => {
  await withRepoRootCwd(async () => {
    const { fn, created } = makeMockGh();
    const result = await raiseSingleIdleTask({
      template: "documentation-audit",
      repos: ["org/alpha"],
      ghCommandFn: fn,
      ensureLabelFn: labelOk,
      findExistingWrapperTitlesFn: () =>
        Promise.resolve(new Set<string>([DOCUMENTATION_AUDIT_ISSUE_TITLE])),
      nowFn: stableNow,
    });

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.totalCreated, 0);
    assertEquals(result.value.totalSkipped, 1);
    assertEquals(created.length, 0);
  });
});

Deno.test("raiseSingleIdleTask - a failing repo never aborts the sweep", async () => {
  await withRepoRootCwd(async () => {
    const { fn, created } = makeMockGh({ failRepos: new Set(["org/alpha"]) });
    const result = await raiseSingleIdleTask({
      template: "documentation-audit",
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
    assertEquals(beta?.created.length, 1);
    assertEquals(created.filter((c) => c.repo === "org/beta").length, 1);
  });
});

// ---------------------------------------------------------------------------
// Partial progress and preflight abort (Issue #3862)
// ---------------------------------------------------------------------------

Deno.test("raiseSingleIdleTask - an off-allowlist repo aborts in preflight without gh calls", async () => {
  const { fn, created } = makeMockGh();
  seedWriteRepoAllowlist("org/beta");
  try {
    const result = await withRepoRootCwd(() =>
      raiseSingleIdleTask({
        template: "documentation-audit",
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
    // The allowed repo still got its wrapper.
    assertEquals(created.filter((c) => c.repo === "org/beta").length, 1);
    assertEquals(result.value.totalCreated, 1);
  } finally {
    resetWriteRepoAllowlist();
  }
});

Deno.test("raiseSingleIdleTask - a failed repo reports the failure per template", async () => {
  await withRepoRootCwd(async () => {
    const { fn } = makeMockGh({ failRepos: new Set(["org/alpha"]) });
    const result = await raiseSingleIdleTask({
      template: "documentation-audit",
      repos: ["org/alpha"],
      ghCommandFn: fn,
      ensureLabelFn: labelOk,
      findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
      nowFn: stableNow,
    });

    assert(result.ok);
    if (!result.ok) return;

    const alpha = result.value.repos.find((r) => r.repo === "org/alpha");
    assertEquals(alpha?.created.length, 0);
    assertEquals(alpha?.failed?.length, 1);
    assertEquals(alpha?.failed?.[0]?.template, "documentation-audit");
    assertEquals(alpha?.terminal, false);
  });
});
