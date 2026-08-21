/**
 * Tests for branch_cleanup.ts — Stale branch cleanup (Issue #468, #912).
 *
 * Uses injectable gh command function for testability.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  cleanupMergedPrBranches,
  cleanupOrphanedLocalBranches,
  cleanupStaleRemoteBranches,
  findOpenPrNumber,
} from "../lib/branch_cleanup.ts";
import { IssueCache } from "../lib/issue_cache.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock gh command function. */
function createMockGh(responses: Record<string, string | Error> = {}) {
  const calls: string[][] = [];

  const ghCommandFn = async (args: string[]): Promise<string> => {
    calls.push(args);
    const argsStr = args.join(" ");

    for (const [pattern, response] of Object.entries(responses)) {
      if (argsStr.includes(pattern)) {
        if (response instanceof Error) throw response;
        return response;
      }
    }

    return "";
  };

  return { ghCommandFn, calls };
}

// ---------------------------------------------------------------------------
// cleanupMergedPrBranches
// ---------------------------------------------------------------------------

Deno.test("branch cleanup - cleanupMergedPrBranches returns zero counts for empty repos", async () => {
  const result = await cleanupMergedPrBranches([], "testuser");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.deletedCount, 0);
    assertEquals(result.value.skippedCount, 0);
  }
});

Deno.test("branch cleanup - cleanupMergedPrBranches deletes merged branches", async () => {
  // Issue #1787: cleanupMergedPrBranches now reads through
  // `fetchMergedPRsByUser`, which expects JSON output from
  // `gh pr list --json number,title,headRefName`.
  const { ghCommandFn, calls } = createMockGh({
    "--state merged": JSON.stringify([
      { number: 1, title: "Fix issue 1", headRefName: "issue-1-fix" },
      { number: 2, title: "Update issue 2", headRefName: "issue-2-update" },
    ]),
    // findOpenPrNumber without cache uses the legacy
    // `--jq ".[0].number"` path; `null` represents the no-PR case.
    "--state open": "",
    "git/ref/heads/issue-1": '{"ref": "refs/heads/issue-1-fix"}',
    "git/ref/heads/issue-2": '{"ref": "refs/heads/issue-2-update"}',
    "-X DELETE": "", // Successful deletion
  });

  const result = await cleanupMergedPrBranches(
    ["org/repo"],
    "testuser",
    { ghCommandFn },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.deletedCount, 2);
    assertEquals(result.value.skippedCount, 0);
  }

  // Verify deletion was called
  const deleteCalls = calls.filter((c) => c.join(" ").includes("-X DELETE"));
  assertEquals(deleteCalls.length, 2);
});

Deno.test("branch cleanup - cleanupMergedPrBranches skips branches with open PRs", async () => {
  const { ghCommandFn } = createMockGh({
    // Issue #1787: merged-PR fetch is now JSON-shaped.
    "--state merged": JSON.stringify([
      { number: 1, title: "Fix issue 1", headRefName: "issue-1-fix" },
    ]),
    // findOpenPrNumber without cache still uses the legacy
    // `--jq ".[0].number"` path that returns a bare number.
    "--state open": "42",
    "git/ref/heads/": '{"ref": "refs/heads/issue-1-fix"}',
  });

  const result = await cleanupMergedPrBranches(
    ["org/repo"],
    "testuser",
    { ghCommandFn },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.deletedCount, 0);
    assertEquals(result.value.skippedCount, 1);
  }
});

Deno.test("branch cleanup - cleanupMergedPrBranches handles gh errors gracefully", async () => {
  const { ghCommandFn } = createMockGh({
    "--state merged": new Error("API rate limit exceeded"),
  });

  const result = await cleanupMergedPrBranches(
    ["org/repo"],
    "testuser",
    { ghCommandFn },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.deletedCount, 0);
    assertEquals(result.value.skippedCount, 0);
  }
});

Deno.test("branch cleanup - cleanupMergedPrBranches never deletes a milestone branch", async () => {
  // Issue #3913: a milestone summary PR's head branch is the long-lived
  // `milestone/<slug>` collection branch. GitHub's delete_branch_on_merge
  // already removes it when the summary PR merges, so the only way this scan
  // can still see it is when the branch was recreated for the milestone's
  // remaining open children — deleting it there strands those children and
  // auto-closes any child PR based on it.
  const milestoneBranch = "milestone/3872-security-scan-overflow";
  const { ghCommandFn, calls } = createMockGh({
    "--state merged": JSON.stringify([
      { number: 3896, title: "Milestone: #3872", headRefName: milestoneBranch },
    ]),
    "--state open": "",
    "git/ref/heads/": `{"ref": "refs/heads/${milestoneBranch}"}`,
    "-X DELETE": "",
  });

  const result = await cleanupMergedPrBranches(
    ["org/repo"],
    "testuser",
    { ghCommandFn },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.deletedCount, 0);
    assertEquals(result.value.skippedCount, 1);
  }

  const deleteCalls = calls.filter((c) => c.join(" ").includes("-X DELETE"));
  assertEquals(deleteCalls.length, 0);
});

Deno.test("branch cleanup - cleanupMergedPrBranches still deletes issue branches alongside a protected one", async () => {
  // Issue #3913: the milestone guard must skip only the protected branch —
  // ordinary `issue-*` branches in the same batch are still cleaned up.
  const { ghCommandFn, calls } = createMockGh({
    "--state merged": JSON.stringify([
      { number: 1, title: "Fix issue 1", headRefName: "issue-1-fix" },
      { number: 2, title: "Milestone: #3872", headRefName: "milestone/3872-x" },
    ]),
    "--state open": "",
    "git/ref/heads/": '{"ref": "refs/heads/issue-1-fix"}',
    "-X DELETE": "",
  });

  const result = await cleanupMergedPrBranches(
    ["org/repo"],
    "testuser",
    { ghCommandFn },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.deletedCount, 1);
    assertEquals(result.value.skippedCount, 1);
  }

  const deleteCalls = calls.filter((c) => c.join(" ").includes("-X DELETE"));
  assertEquals(deleteCalls.length, 1);
  assertEquals(deleteCalls[0]?.join(" ").includes("issue-1-fix"), true);
});

Deno.test("branch cleanup - cleanupMergedPrBranches keeps a branch an open PR is based on", async () => {
  // Issue #3931: deleting a branch that open PRs are stacked on makes GitHub
  // close them — that is how PR #3928 died when milestone/3872-… vanished.
  // The head-only guard (Issue #386) never saw it.
  const { ghCommandFn, calls } = createMockGh({
    "--state merged": JSON.stringify([
      { number: 1, title: "Fix issue 1", headRefName: "issue-1-fix" },
    ]),
    // Ordered before the generic "--state open" key so the base query wins.
    "--base issue-1-fix": "3928",
    "--state open": "",
    "git/ref/heads/": '{"ref": "refs/heads/issue-1-fix"}',
    "-X DELETE": "",
  });

  const result = await cleanupMergedPrBranches(
    ["org/repo"],
    "testuser",
    { ghCommandFn },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.deletedCount, 0);
    assertEquals(result.value.skippedCount, 1);
  }
  assertEquals(
    calls.filter((c) => c.join(" ").includes("-X DELETE")).length,
    0,
  );
});

Deno.test("branch cleanup - cleanupMergedPrBranches keeps the branch when the safety query fails", async () => {
  // Issue #3931/#3234: an unreadable check is not permission to delete.
  const { ghCommandFn, calls } = createMockGh({
    "--state merged": JSON.stringify([
      { number: 1, title: "Fix issue 1", headRefName: "issue-1-fix" },
    ]),
    "--state open": new Error("API rate limit exceeded"),
    "git/ref/heads/": '{"ref": "refs/heads/issue-1-fix"}',
    "-X DELETE": "",
  });

  const result = await cleanupMergedPrBranches(
    ["org/repo"],
    "testuser",
    { ghCommandFn },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.deletedCount, 0);
    assertEquals(result.value.skippedCount, 1);
  }
  assertEquals(
    calls.filter((c) => c.join(" ").includes("-X DELETE")).length,
    0,
  );
});

// ---------------------------------------------------------------------------
// cleanupOrphanedLocalBranches
// ---------------------------------------------------------------------------

Deno.test("branch cleanup - cleanupOrphanedLocalBranches handles non-git directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "non-git-test-" });
  try {
    const result = await cleanupOrphanedLocalBranches("main", { cwd: dir });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.deletedCount, 0);
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// cleanupStaleRemoteBranches
// ---------------------------------------------------------------------------

Deno.test("branch cleanup - cleanupStaleRemoteBranches returns zero for empty repos", async () => {
  const result = await cleanupStaleRemoteBranches([], "testuser");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.deletedCount, 0);
    assertEquals(result.value.skippedCount, 0);
  }
});

Deno.test("branch cleanup - cleanupStaleRemoteBranches deletes branches for merged PRs", async () => {
  const { ghCommandFn } = createMockGh({
    "repos/org/repo/branches": "issue-1-fix\nissue-2-update\n",
    "--state open": "", // No open PRs
    "--state merged": "42", // Merged PR exists
    "-X DELETE": "", // Successful deletion
  });

  const result = await cleanupStaleRemoteBranches(
    ["org/repo"],
    "testuser",
    { ghCommandFn },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.deletedCount, 2);
    assertEquals(result.value.skippedCount, 0);
  }
});

Deno.test("branch cleanup - cleanupStaleRemoteBranches skips branches with open PRs", async () => {
  const { ghCommandFn } = createMockGh({
    "repos/org/repo/branches": "issue-1-fix\n",
    "--state open": "42", // Open PR exists
  });

  const result = await cleanupStaleRemoteBranches(
    ["org/repo"],
    "testuser",
    { ghCommandFn },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.deletedCount, 0);
    assertEquals(result.value.skippedCount, 1);
  }
});

Deno.test("branch cleanup - cleanupStaleRemoteBranches keeps a branch a stacked PR is based on", async () => {
  // Issue #3931: an `issue-*` branch can be the base of a stacked child PR
  // just as a milestone branch can — deleting it closes that PR.
  const { ghCommandFn, calls } = createMockGh({
    "repos/org/repo/branches": "issue-1-fix\n",
    "--base issue-1-fix": "77",
    "--state open": "",
    "--state merged": "42",
    "-X DELETE": "",
  });

  const result = await cleanupStaleRemoteBranches(
    ["org/repo"],
    "testuser",
    { ghCommandFn },
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.deletedCount, 0);
    assertEquals(result.value.skippedCount, 1);
  }
  assertEquals(
    calls.filter((c) => c.join(" ").includes("-X DELETE")).length,
    0,
  );
});

// ---------------------------------------------------------------------------
// Issue #1787: cache-routed paths
// ---------------------------------------------------------------------------

async function makeTempCache(): Promise<
  { cache: IssueCache; cleanup: () => Promise<void> }
> {
  const dir = await Deno.makeTempDir({ prefix: "branch-cache-" });
  const cache = new IssueCache(dir);
  return {
    cache,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => undefined),
  };
}

Deno.test("branch cleanup - findOpenPrNumber routes through cache when provided", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const calls: string[][] = [];
    const ghFn = async (args: string[]): Promise<string> => {
      calls.push(args);
      return JSON.stringify([
        {
          number: 99,
          title: "Open",
          baseRefName: "main",
          headRefName: "issue-99",
          body: "",
          url: "https://github.com/o/r/pull/99",
        },
      ]);
    };
    const first = await findOpenPrNumber("o/r", "issue-99", ghFn, cache);
    const second = await findOpenPrNumber("o/r", "issue-99", ghFn, cache);
    assertEquals(first, "99");
    assertEquals(second, "99");
    // Only one network call — second is served from cache.
    assertEquals(calls.length, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("branch cleanup - findOpenPrNumber returns null when no head match in cache", async () => {
  // Issue #1796: refactored to use `fetchPRsByBranch` — gh applies the
  // `--head` filter server-side, so the realistic mock for "no PR for
  // this branch" is an empty list rather than a non-matching PR.
  const { cache, cleanup } = await makeTempCache();
  try {
    const ghFn = async (_args: string[]): Promise<string> => "[]";
    const result = await findOpenPrNumber("o/r", "issue-99", ghFn, cache);
    assertEquals(result, null);
  } finally {
    await cleanup();
  }
});

Deno.test("branch cleanup - cleanupMergedPrBranches with cache reuses fetchMergedPRsByUser cache", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let mergedListCalls = 0;
    const ghFn = async (args: string[]): Promise<string> => {
      const argsStr = args.join(" ");
      if (argsStr.includes("--state merged") && argsStr.includes("--author")) {
        mergedListCalls++;
        return JSON.stringify([
          { number: 1, title: "Fix", headRefName: "issue-1" },
        ]);
      }
      if (argsStr.includes("--state open")) return JSON.stringify([]); // cache-routed
      if (argsStr.includes("git/ref/heads")) {
        return JSON.stringify({ ref: "refs/heads/issue-1" });
      }
      if (argsStr.includes("-X DELETE")) return "";
      return "";
    };

    // First invocation populates the cache.
    await cleanupMergedPrBranches(["org/repo"], "testuser", {
      ghCommandFn: ghFn,
      cache,
    });
    // Second invocation reuses the cached merged-PR list.
    await cleanupMergedPrBranches(["org/repo"], "testuser", {
      ghCommandFn: ghFn,
      cache,
    });

    assertEquals(
      mergedListCalls,
      1,
      "merged-PR list should be cached across invocations",
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// GraphQL-budget fixes (Issue #4255): ref probe first, sweep watermark
// ---------------------------------------------------------------------------

/**
 * Run a test body with WORK_DIR pointed at a throwaway directory so
 * emitSelfHealEventAuto cannot forge events into the production
 * self-heal log (Issue #4250).
 */
async function withSandboxedWorkDir(
  body: (tempDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const oldWorkDir = Deno.env.get("WORK_DIR");
  Deno.env.set("WORK_DIR", tempDir);
  try {
    await body(tempDir);
  } finally {
    if (oldWorkDir === undefined) Deno.env.delete("WORK_DIR");
    else Deno.env.set("WORK_DIR", oldWorkDir);
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("branch cleanup - a missing branch is skipped before any open-PR assessment (Issue #4255)", async () => {
  await withSandboxedWorkDir(async () => {
    // The ref probe 404s: the branch was deleted on an earlier cycle. The
    // two-GraphQL-call assessment must never run for it.
    const { ghCommandFn, calls } = createMockGh({
      "--state merged": JSON.stringify([
        { number: 7, title: "Fix issue 7", headRefName: "issue-7-fix" },
      ]),
      "git/ref/heads/issue-7-fix": new Error("HTTP 404: Not Found"),
    });

    const result = await cleanupMergedPrBranches(
      ["org/repo"],
      "testuser",
      { ghCommandFn },
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.deletedCount, 0);
      assertEquals(result.value.skippedCount, 0);
      assertEquals(result.value.skippedMissingCount, 1);
      assertEquals(result.value.assessedCount, 0);
    }
    const assessmentCalls = calls.filter((c) =>
      c.join(" ").includes("--state open")
    );
    assertEquals(
      assessmentCalls.length,
      0,
      "no GraphQL open-PR assessment may run for a branch that is already gone",
    );
  });
});

Deno.test("branch cleanup - the ref probe runs before the assessment for a live branch (Issue #4255)", async () => {
  await withSandboxedWorkDir(async () => {
    const { ghCommandFn, calls } = createMockGh({
      "--state merged": JSON.stringify([
        { number: 8, title: "Fix issue 8", headRefName: "issue-8-fix" },
      ]),
      "--state open": "",
      "git/ref/heads/issue-8-fix": '{"ref": "refs/heads/issue-8-fix"}',
      "-X DELETE": "",
    });

    const result = await cleanupMergedPrBranches(
      ["org/repo"],
      "testuser",
      { ghCommandFn },
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.deletedCount, 1);
      assertEquals(result.value.assessedCount, 1);
      assertEquals(result.value.skippedMissingCount, 0);
    }
    const probeIndex = calls.findIndex((c) =>
      c.join(" ").includes("git/ref/heads/issue-8-fix")
    );
    const assessIndex = calls.findIndex((c) =>
      c.join(" ").includes("--state open")
    );
    assert(probeIndex >= 0 && assessIndex >= 0, "both calls must happen");
    assert(
      probeIndex < assessIndex,
      "the cheap REST existence probe must precede the GraphQL assessment",
    );
  });
});

Deno.test("branch cleanup - the sweep watermark suppresses per-branch calls on the next cycle (Issue #4255)", async () => {
  await withSandboxedWorkDir(async (tempDir) => {
    const watermarkPath = `${tempDir}/merged_sweep_watermarks.json`;
    const responses = {
      "--state merged": JSON.stringify([
        { number: 5, title: "Fix issue 5", headRefName: "issue-5-fix" },
      ]),
      "--state open": "",
      "git/ref/heads/issue-5-fix": '{"ref": "refs/heads/issue-5-fix"}',
      "-X DELETE": "",
    };

    const first = createMockGh(responses);
    const r1 = await cleanupMergedPrBranches(["org/repo"], "testuser", {
      ghCommandFn: first.ghCommandFn,
      watermarkPath,
    });
    assertEquals(r1.ok, true);
    if (r1.ok) assertEquals(r1.value.deletedCount, 1);

    // Same 30-PR window next cycle: everything is at or below the
    // watermark, so the only call is the merged-PR list itself.
    const second = createMockGh(responses);
    const r2 = await cleanupMergedPrBranches(["org/repo"], "testuser", {
      ghCommandFn: second.ghCommandFn,
      watermarkPath,
    });
    assertEquals(r2.ok, true);
    if (r2.ok) {
      assertEquals(r2.value.deletedCount, 0);
      assertEquals(r2.value.skippedMissingCount, 0);
      assertEquals(r2.value.assessedCount, 0);
    }
    assertEquals(
      second.calls.length,
      1,
      "the second cycle must issue only the merged-PR list call",
    );
  });
});

Deno.test("branch cleanup - an unsafe skip holds the watermark back so the branch is revisited (Issue #4255)", async () => {
  await withSandboxedWorkDir(async (tempDir) => {
    const watermarkPath = `${tempDir}/merged_sweep_watermarks.json`;
    const responses = {
      "--state merged": JSON.stringify([
        { number: 10, title: "Fix issue 10", headRefName: "issue-10-fix" },
        { number: 12, title: "Fix issue 12", headRefName: "issue-12-fix" },
      ]),
      // issue-10-fix is still the head of open PR 42 — unsafe to delete.
      "--head issue-10-fix": "42",
      "--state open": "",
      "git/ref/heads/issue-10-fix": '{"ref": "refs/heads/issue-10-fix"}',
      "git/ref/heads/issue-12-fix": '{"ref": "refs/heads/issue-12-fix"}',
      "-X DELETE": "",
    };

    const first = createMockGh(responses);
    const r1 = await cleanupMergedPrBranches(["org/repo"], "testuser", {
      ghCommandFn: first.ghCommandFn,
      watermarkPath,
    });
    assertEquals(r1.ok, true);
    if (r1.ok) {
      assertEquals(r1.value.deletedCount, 1);
      assertEquals(r1.value.skippedCount, 1);
    }

    const marks = JSON.parse(await Deno.readTextFile(watermarkPath));
    assertEquals(
      marks["org/repo"],
      9,
      "the watermark must sit below the unsafe PR so it is reconsidered",
    );
  });
});

Deno.test("branch cleanup - a corrupt watermark file is treated as empty (Issue #4255)", async () => {
  await withSandboxedWorkDir(async (tempDir) => {
    const watermarkPath = `${tempDir}/merged_sweep_watermarks.json`;
    await Deno.writeTextFile(watermarkPath, "{not json");

    const { ghCommandFn } = createMockGh({
      "--state merged": JSON.stringify([
        { number: 3, title: "Fix issue 3", headRefName: "issue-3-fix" },
      ]),
      "--state open": "",
      "git/ref/heads/issue-3-fix": '{"ref": "refs/heads/issue-3-fix"}',
      "-X DELETE": "",
    });
    const result = await cleanupMergedPrBranches(["org/repo"], "testuser", {
      ghCommandFn,
      watermarkPath,
    });
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.deletedCount, 1);

    const marks = JSON.parse(await Deno.readTextFile(watermarkPath));
    assertEquals(marks["org/repo"], 3, "the sweep must recover and re-persist");
  });
});

// ---------------------------------------------------------------------------
// Worktree `+` marker parsing and event aggregation (Issue #4306)
// ---------------------------------------------------------------------------

async function runCleanupGit(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string }> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const out = await cmd.output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
}

Deno.test("branch cleanup - worktree '+' marker never becomes a branch name, and only real deletions are counted (Issue #4306)", async () => {
  const { setSelfHealEventsWorkDir } = await import(
    "../lib/self_heal_events.ts"
  );
  const tmp = await Deno.makeTempDir({ prefix: "branch_cleanup_4306_" });
  const eventsDir = `${tmp}/events`;
  setSelfHealEventsWorkDir(eventsDir);
  try {
    // Bare origin plus a seeded clone.
    const origin = `${tmp}/origin`;
    const clone = `${tmp}/clone`;
    await Deno.mkdir(origin, { recursive: true });
    await runCleanupGit(["init", "--bare", "-b", "main"], origin);
    await runCleanupGit(["clone", origin, clone], tmp);
    await Deno.writeTextFile(`${clone}/f.txt`, "x\n");
    await runCleanupGit(["add", "f.txt"], clone);
    await runCleanupGit(["commit", "-m", "seed"], clone);
    await runCleanupGit(["push", "origin", "main"], clone);

    // Two branches pushed then deleted on the remote: one plain, one
    // checked out in a linked worktree (shows as `+ name` in branch -vv).
    for (const b of ["feat-gone", "wt-gone"]) {
      await runCleanupGit(["branch", b, "main"], clone);
      await runCleanupGit(["push", "-u", "origin", b], clone);
    }
    await runCleanupGit(["worktree", "add", `${tmp}/wt`, "wt-gone"], clone);
    await runCleanupGit(["push", "origin", ":feat-gone"], clone);
    await runCleanupGit(["push", "origin", ":wt-gone"], clone);

    const result = await cleanupOrphanedLocalBranches("main", { cwd: clone });
    assert(result.ok);
    // Only the plain branch is deletable; the worktree-checked-out one
    // fails its delete and must not be counted.
    assertEquals(result.value.deletedCount, 1);

    const branches = (await runCleanupGit(["branch"], clone)).stdout;
    assert(!branches.includes("feat-gone"), branches);
    assert(branches.includes("wt-gone"), branches);

    // One aggregated event naming the real branch — never a literal `+`.
    const journal = await Deno.readTextFile(
      `${eventsDir}/logs/self-heal.jsonl`,
    );
    const events = journal.trim().split("\n").map((l) => JSON.parse(l));
    assertEquals(events.length, 1);
    assertStringIncludes(events[0].reason, "deleted 1 local branch");
    assertStringIncludes(events[0].reason, "feat-gone");
    assert(!/branch \+/.test(journal), journal);
  } finally {
    setSelfHealEventsWorkDir(undefined);
    await Deno.remove(tmp, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("branch cleanup - orphaned deletions aggregate to one summary event (Issue #4306)", async () => {
  const { setSelfHealEventsWorkDir } = await import(
    "../lib/self_heal_events.ts"
  );
  const tmp = await Deno.makeTempDir({ prefix: "branch_cleanup_4306_" });
  const eventsDir = `${tmp}/events`;
  setSelfHealEventsWorkDir(eventsDir);
  try {
    const origin = `${tmp}/origin`;
    const clone = `${tmp}/clone`;
    await Deno.mkdir(origin, { recursive: true });
    await runCleanupGit(["init", "--bare", "-b", "main"], origin);
    await runCleanupGit(["clone", origin, clone], tmp);
    await Deno.writeTextFile(`${clone}/f.txt`, "x\n");
    await runCleanupGit(["add", "f.txt"], clone);
    await runCleanupGit(["commit", "-m", "seed"], clone);
    await runCleanupGit(["push", "origin", "main"], clone);

    for (const b of ["gone-1", "gone-2", "gone-3"]) {
      await runCleanupGit(["branch", b, "main"], clone);
      await runCleanupGit(["push", "-u", "origin", b], clone);
      await runCleanupGit(["push", "origin", `:${b}`], clone);
    }

    const result = await cleanupOrphanedLocalBranches("main", { cwd: clone });
    assert(result.ok);
    assertEquals(result.value.deletedCount, 3);

    const journal = await Deno.readTextFile(
      `${eventsDir}/logs/self-heal.jsonl`,
    );
    const events = journal.trim().split("\n").map((l) => JSON.parse(l));
    // Three deletions, ONE event.
    assertEquals(events.length, 1);
    assertStringIncludes(events[0].reason, "deleted 3 local branch(es)");
  } finally {
    setSelfHealEventsWorkDir(undefined);
    await Deno.remove(tmp, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("branch cleanup - a gone-upstream branch -d refuses is force-deleted once its tip is a week old, kept while young (Issue #228)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "branch_cleanup_228_" });
  try {
    const origin = `${tmp}/origin`;
    const clone = `${tmp}/clone`;
    await Deno.mkdir(origin, { recursive: true });
    await runCleanupGit(["init", "--bare", "-b", "main"], origin);
    await runCleanupGit(["clone", origin, clone], tmp);
    await Deno.writeTextFile(`${clone}/f.txt`, "x\n");
    await runCleanupGit(["add", "f.txt"], clone);
    await runCleanupGit(["commit", "-m", "seed"], clone);
    await runCleanupGit(["push", "origin", "main"], clone);

    // Two "squash-merged" branches: a commit main does not contain, upstream
    // deleted. One tip is 30 days old, the other is fresh.
    const makeGone = async (name: string, committedAt: string) => {
      await runCleanupGit(["checkout", "-b", name, "main"], clone);
      await Deno.writeTextFile(`${clone}/${name}.txt`, "y\n");
      await runCleanupGit(["add", `${name}.txt`], clone);
      // Inherit the environment (HOME, PATH, the harness's git identity):
      // `env` replaces it wholesale, and a bare git on CI exits 128.
      const commit = new Deno.Command("git", {
        args: [
          "-c",
          "user.name=branch-cleanup-test",
          "-c",
          "user.email=branch-cleanup-test@example.invalid",
          "commit",
          "-m",
          name,
        ],
        cwd: clone,
        env: {
          ...Deno.env.toObject(),
          GIT_COMMITTER_DATE: committedAt,
          GIT_AUTHOR_DATE: committedAt,
        },
        stdout: "null",
        stderr: "piped",
      });
      const out = await commit.output();
      assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
      await runCleanupGit(["push", "-u", "origin", name], clone);
      await runCleanupGit(["checkout", "main"], clone);
      await runCleanupGit(["push", "origin", `:${name}`], clone);
    };
    // Git's own `@<epoch>` date form: parsed identically by every git
    // version (an ISO string with fractional seconds is not).
    const nowEpoch = Math.floor(Date.now() / 1000);
    await makeGone("old-squashed", `@${nowEpoch - 30 * 86400}`);
    await makeGone("young-unmerged", `@${nowEpoch - 3600}`);

    const result = await cleanupOrphanedLocalBranches("main", { cwd: clone }, {
      forceDeleteAgeDays: 7,
      nowFn: () => nowEpoch,
    });
    assert(result.ok);
    const branches = (await runCleanupGit(["branch"], clone)).stdout;
    assertEquals(result.value.deletedCount, 1, branches);
    assertEquals(result.value.skippedCount, 1, branches);
    assert(!branches.includes("old-squashed"), branches);
    assert(branches.includes("young-unmerged"), branches);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => undefined);
  }
});
