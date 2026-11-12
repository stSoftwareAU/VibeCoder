/**
 * Call-site tests for the production callers of requestReadyBranchUpdate
 * (Issue #4943). Each test drives one caller through its real entry point and
 * asserts the `source=` token on the `[base-refresh]` decision line, so that
 * reverting or changing that caller's source argument turns the test red.
 *
 * Not covered here: merge_block_escalation.ts's default updater. It reads the
 * fleet identity from CONFIG_PATH and GITHUB_USER, and handleMergeAttempt
 * offers no seam for author or config options, so a test would have to mutate
 * Deno.env (see tests/parallel_safety_cap_test.ts, Issue #880).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { strictRefreshFixture } from "./support/strict_refresh_fixture.ts";
import { updateBranch } from "../../../.claude/skills/review-fleet-prs/scripts/branch_update.ts";
import { fix } from "../commands/fleet_pr_babysitter.ts";
import { BASE_REFRESH_COUNTERS_FILE } from "../lib/repair_base_merge_4943.ts";

/** Run `fn` and return the `[base-refresh]` lines it wrote to console.warn. */
async function captureBaseRefreshLines<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const value = await fn();
    return {
      value,
      lines: lines.filter((line) => line.startsWith("[base-refresh]")),
    };
  } finally {
    console.warn = original;
  }
}

/**
 * The default ownership path waits 3 s for GitHub's eventual consistency
 * (pr_branch_lock.ts) and retries with backoff. The fixture is consistent by
 * construction, so those waits only cost wall-clock time, and two of them
 * would push this file past the unit-test budget (Issue #2642). Run timers at
 * zero delay for the duration of `fn`, then restore them.
 */
async function withInstantTimers<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.setTimeout;
  // The sleeps on these paths are `setTimeout(resolve, ms)`; nothing else.
  globalThis.setTimeout =
    ((handler: () => void, _ms?: number) =>
      original(handler, 0)) as typeof setTimeout;
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = original;
  }
}

// review-fleet-prs/scripts/branch_update.ts: updateBranch
// (source "review-fleet-prs").
Deno.test("review-fleet-prs branch update logs source=review-fleet-prs", async () => {
  const fleet = strictRefreshFixture();
  const auditDir = await Deno.makeTempDir({ prefix: "base_refresh_4943_" });
  try {
    const { value, lines } = await withInstantTimers(() =>
      captureBaseRefreshLines(() =>
        updateBranch(
          {
            repo: "owner/repo",
            number: 10,
            headSha: fleet.head,
            baseRefName: "main",
          },
          fleet.gh,
          { fleetAuthors: ["VibeCoderST"] },
          undefined,
          { auditDir, runId: "base-refresh-4943-test" },
        )
      )
    );
    assertEquals(lines.length, 1);
    assertStringIncludes(
      lines[0]!,
      "[base-refresh] source=review-fleet-prs outcome=refresh-requested repo=owner/repo pr=#10 ",
    );
    assertEquals(value, { updated: true });
  } finally {
    await Deno.remove(auditDir, { recursive: true });
  }
});

/** A PR the babysitter sees as behind its base, with CI green. */
const BEHIND_PR = {
  state: "OPEN",
  number: 1,
  title: "fix",
  author: { login: "fleet" },
  headRefName: "feature",
  headRefOid: "abc",
  baseRefName: "main",
  isCrossRepository: false,
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "BEHIND",
  reviewDecision: null,
  statusCheckRollup: [{ conclusion: "SUCCESS" }],
};

// commands/fleet_pr_babysitter.ts: fix()'s behind path (source
// "babysitter-behind", counterDir = deps.baseRefreshCounterDir, which only the
// production entry point sets; the test injects a temp dir).
Deno.test("babysitter behind path logs source=babysitter-behind and persists its tally in the state dir", async () => {
  const fleet = strictRefreshFixture();
  const stateDir = await Deno.makeTempDir({
    prefix: "base_refresh_4943_babysitter_",
  });
  const initial = { ...BEHIND_PR, headRefOid: fleet.head };
  let updated = false;
  const gh = async (args: string[]) => {
    if (
      args[0] === "pr" && args[1] === "view" &&
      args.at(-1)?.includes("statusCheckRollup")
    ) {
      return JSON.stringify({
        ...initial,
        headRefOid: updated ? "d".repeat(40) : fleet.head,
      });
    }
    if (args.includes("PUT")) updated = true;
    return await fleet.gh(args);
  };
  try {
    const { lines } = await captureBaseRefreshLines(() =>
      fix(
        "owner/repo",
        initial,
        ["VibeCoderST"],
        "VibeCoderST",
        { appId: "1", installationId: "1", privateKeyPath: "/unused" },
        "/unused",
        gh,
        async () => {},
        3,
        {
          armAutoMerge: async () => {},
          stateDir,
          baseRefreshCounterDir: stateDir,
        },
      )
    );
    assertEquals(updated, true);
    assertEquals(lines.length, 1);
    assertStringIncludes(
      lines[0]!,
      "[base-refresh] source=babysitter-behind outcome=refresh-requested repo=owner/repo pr=#1 base=main ",
    );
    const counters = JSON.parse(
      await Deno.readTextFile(`${stateDir}/${BASE_REFRESH_COUNTERS_FILE}`),
    ).counters;
    assertEquals(
      counters["baseRefresh.refresh-requested.babysitter-behind"],
      1,
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

const LANE_REPO = "org/repo-a";
const LANE_WORKER = "worker-bot";

// lib/run_core_production_deps.ts: the merge-block-repair lane's syncBranch
// (source "merge-block-repair"), reached through the production stall pass as
// auto_merge_sweep_keeps_armed_test.ts reaches it.
Deno.test("production merge-block repair lane logs source=merge-block-repair", async () => {
  const refresh = strictRefreshFixture(LANE_REPO, "main", LANE_WORKER);
  const workDir = await Deno.makeTempDir({
    prefix: "base_refresh_4943_repair_",
  });
  try {
    let syncResult: { ok: true } | { ok: false; error: Error } | undefined;
    const { lines } = await withInstantTimers(() =>
      captureBaseRefreshLines(async () => {
        const { deps } = await createProductionRunCoreDeps({
          repoDir: workDir,
          workDir,
          githubUser: LANE_WORKER,
          logger: createLogger({ write: () => {} }),
          config: {
            ...buildDefaultWorkerConfig(),
            workDir,
            repos: [LANE_REPO],
            fleetPrAuthors: [LANE_WORKER],
          },
          stallRepairGhCommandFn: refresh.gh,
          stallRepairPassFn: async (options) => {
            const result = await options.repair.syncBranch({
              repo: LANE_REPO,
              prNumber: 11,
              headRefName: "feature",
              baseRefName: "main",
            });
            syncResult = result;
            return { ok: true, value: [] };
          },
        });
        assert((await deps.scanBlockingPrStalls!()).ok);
      })
    );
    assert(
      syncResult,
      "the stall pass must invoke its production sync callback",
    );
    assertEquals(syncResult.ok, true);
    assertEquals(lines.length, 1);
    assertStringIncludes(
      lines[0]!,
      "[base-refresh] source=merge-block-repair outcome=refresh-requested repo=org/repo-a pr=#11 base=main ",
    );
    // Issue #4943: the in-process lane persists its tally in the work
    // directory, so it survives the per-cycle reset of the in-memory counters.
    const persisted = JSON.parse(
      await Deno.readTextFile(`${workDir}/${BASE_REFRESH_COUNTERS_FILE}`),
    ) as { counters: Record<string, number> };
    assertEquals(
      persisted.counters["baseRefresh.refresh-requested.merge-block-repair"],
      1,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
