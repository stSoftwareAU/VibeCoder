/**
 * Tests for milestone branch sync logic (Issue #1238).
 *
 * Periodically merges the default branch into active milestone branches
 * to reduce drift and avoid conflicts on the final summary PR.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  findActiveMilestoneBranches,
  type GhCommandFn,
  type MilestoneBranchSyncDeps,
  shouldSyncMilestone,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import {
  milestoneActivityPath,
  type MilestoneActivityState,
} from "../lib/milestone_activity_gate.ts";
import { MilestoneConflictEscalation } from "../lib/milestone_conflict_triage.ts";
import { mergeGateFailureError } from "../lib/milestone_merge_gate.ts";
import { stuckSyncDiagnosticTitle } from "../lib/milestone_sync_diagnostic_closeout.ts";
import { milestoneSyncStreakPath } from "../lib/milestone_sync_streak.ts";

// ============================================================================
// findActiveMilestoneBranches
// ============================================================================

Deno.test("findActiveMilestoneBranches - returns milestones with at least one closed issue", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("repos/owner/repo/milestones")) {
      return JSON.stringify([
        { title: "v1.0", number: 1 },
        { title: "v2.0", number: 2 },
      ]);
    }
    if (key.includes("repos/owner/repo") && key.includes("default_branch")) {
      return "main";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      // Issue #1908: single closed batch, milestone tags filtered locally.
      return JSON.stringify([
        { number: 10, title: "ten", milestone: { title: "v1.0" } },
      ]);
    }
    return "[]";
  };

  const result = await findActiveMilestoneBranches("owner/repo", ghFn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 1);
    assertEquals(result.value[0]!.milestoneTitle, "v1.0");
    assertEquals(result.value[0]!.milestoneBranch, "milestone/v1-0");
    assertEquals(result.value[0]!.defaultBranch, "main");
  }
});

Deno.test("findActiveMilestoneBranches - returns empty when no milestones exist", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("repos/owner/repo/milestones")) {
      return "[]";
    }
    if (key.includes("repos/owner/repo") && key.includes("default_branch")) {
      return "main";
    }
    return "[]";
  };

  const result = await findActiveMilestoneBranches("owner/repo", ghFn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 0);
  }
});

Deno.test(
  "findActiveMilestoneBranches - skips idle-task milestones (Issue #2125)",
  async () => {
    // The security-scan template files findings as standalone issues
    // — its `idle-task: <template>` milestone never has a branch.
    // Iterating it burns a useless branch-existence check every cycle.
    const issueListCalls: string[][] = [];
    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return JSON.stringify([
          { title: "idle-task: security-scan", number: 4 },
          { title: "v3.0", number: 5 },
        ]);
      }
      if (key.includes("repos/owner/repo") && key.includes("default_branch")) {
        return "main";
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        issueListCalls.push([...args]);
        // The v3.0 lookup wins one closed issue; the idle-task milestone
        // should never reach this branch.
        return JSON.stringify([
          { number: 12, title: "real work", milestone: { title: "v3.0" } },
        ]);
      }
      return "[]";
    };

    const result = await findActiveMilestoneBranches("owner/repo", ghFn);
    assertEquals(result.ok, true);
    if (result.ok) {
      // Only `v3.0` survives — the idle-task milestone is filtered out
      // before the closed-issue lookup.
      assertEquals(result.value.length, 1);
      assertEquals(result.value[0]!.milestoneTitle, "v3.0");
    }
    // Defence in depth: the closed-issue lookup was NOT made for the
    // idle-task milestone (it would have been if the filter missed).
    // We expect at most one closed-issue lookup (the v3.0 one).
    assertEquals(issueListCalls.length <= 1, true);
  },
);

Deno.test("findActiveMilestoneBranches - skips milestones with zero closed issues", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("repos/owner/repo/milestones")) {
      return JSON.stringify([{ title: "empty-milestone", number: 1 }]);
    }
    if (key.includes("repos/owner/repo") && key.includes("default_branch")) {
      return "Develop";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return "[]";
    }
    return "[]";
  };

  const result = await findActiveMilestoneBranches("owner/repo", ghFn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 0);
  }
});

Deno.test("findActiveMilestoneBranches - handles API failure gracefully", async () => {
  const ghFn = async (_args: string[]): Promise<string> => {
    throw new Error("API unavailable");
  };

  const result = await findActiveMilestoneBranches("owner/repo", ghFn);
  assertEquals(result.ok, false);
});

// ============================================================================
// findActiveMilestoneBranches — REST closed_issues gate (Issue #1488)
// ============================================================================

/**
 * Build a gh stub whose milestone payload carries REST counts, and which
 * records every closed-issue (GraphQL) query it is asked for.
 */
function makeGatedGhFn(
  milestones: Array<{ title: string; number: number; closed_issues?: number }>,
  closedIssues: Array<{ number: number; title: string; milestone: string }>,
): { ghFn: GhCommandFn; closedQueries: string[][] } {
  const closedQueries: string[][] = [];
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("repos/owner/repo/milestones")) {
      return JSON.stringify(milestones);
    }
    if (key.includes("repos/owner/repo") && key.includes("default_branch")) {
      return "main";
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      closedQueries.push([...args]);
      return JSON.stringify(
        closedIssues.map((i) => ({
          number: i.number,
          title: i.title,
          milestone: { title: i.milestone },
        })),
      );
    }
    return "[]";
  };
  return { ghFn, closedQueries };
}

Deno.test("findActiveMilestoneBranches - zero REST closed_issues skips the query (Issue #1488)", async () => {
  const { ghFn, closedQueries } = makeGatedGhFn(
    [{ title: "v1.0", number: 1, closed_issues: 0 }],
    [],
  );
  const state: MilestoneActivityState = { observations: {}, dirty: false };

  const result = await findActiveMilestoneBranches(
    "owner/repo",
    ghFn,
    undefined,
    undefined,
    state,
  );

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.length, 0);
  // The expensive half was never reached.
  assertEquals(closedQueries.length, 0);
});

Deno.test("findActiveMilestoneBranches - unchanged closed_issues reuses the verdict (Issue #1488)", async () => {
  const { ghFn, closedQueries } = makeGatedGhFn(
    [{ title: "v1.0", number: 1, closed_issues: 2 }],
    [{ number: 10, title: "ten", milestone: "v1.0" }],
  );
  const state: MilestoneActivityState = {
    observations: { "owner/repo|1": { closedIssues: 2, active: true } },
    dirty: false,
  };

  const result = await findActiveMilestoneBranches(
    "owner/repo",
    ghFn,
    undefined,
    undefined,
    state,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 1);
    assertEquals(result.value[0]!.milestoneTitle, "v1.0");
  }
  assertEquals(closedQueries.length, 0);
});

Deno.test("findActiveMilestoneBranches - a gained closed issue re-queries (Issue #1488)", async () => {
  const { ghFn, closedQueries } = makeGatedGhFn(
    [{ title: "v1.0", number: 1, closed_issues: 3 }],
    [{ number: 10, title: "ten", milestone: "v1.0" }],
  );
  const state: MilestoneActivityState = {
    observations: { "owner/repo|1": { closedIssues: 2, active: true } },
    dirty: false,
  };

  const result = await findActiveMilestoneBranches(
    "owner/repo",
    ghFn,
    undefined,
    undefined,
    state,
  );

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.length, 1);
  assertEquals(closedQueries.length, 1);
  assertEquals(state.observations["owner/repo|1"], {
    closedIssues: 3,
    active: true,
  });
  assertEquals(state.dirty, true);
});

Deno.test("findActiveMilestoneBranches - a lost closed issue re-queries (Issue #1488)", async () => {
  // The milestone's only closed issue was reopened: the REST count fell,
  // and the cached "active" verdict must not stand.
  const { ghFn, closedQueries } = makeGatedGhFn(
    [{ title: "v1.0", number: 1, closed_issues: 1 }],
    [], // no closed issues left
  );
  const state: MilestoneActivityState = {
    observations: { "owner/repo|1": { closedIssues: 2, active: true } },
    dirty: false,
  };

  const result = await findActiveMilestoneBranches(
    "owner/repo",
    ghFn,
    undefined,
    undefined,
    state,
  );

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.length, 0);
  assertEquals(closedQueries.length, 1);
  assertEquals(state.observations["owner/repo|1"], {
    closedIssues: 1,
    active: false,
  });
});

Deno.test("findActiveMilestoneBranches - first observation queries and records (Issue #1488)", async () => {
  const { ghFn, closedQueries } = makeGatedGhFn(
    [{ title: "v1.0", number: 1, closed_issues: 2 }],
    [{ number: 10, title: "ten", milestone: "v1.0" }],
  );
  const state: MilestoneActivityState = { observations: {}, dirty: false };

  const result = await findActiveMilestoneBranches(
    "owner/repo",
    ghFn,
    undefined,
    undefined,
    state,
  );

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.length, 1);
  assertEquals(closedQueries.length, 1);
  assertEquals(state.observations["owner/repo|1"], {
    closedIssues: 2,
    active: true,
  });
});

Deno.test("findActiveMilestoneBranches - a REST payload without counts still queries (Issue #1488)", async () => {
  // Older/partial payloads carry no `closed_issues`; the gate must fail
  // open rather than skip a milestone it cannot judge.
  const { ghFn, closedQueries } = makeGatedGhFn(
    [{ title: "v1.0", number: 1 }],
    [{ number: 10, title: "ten", milestone: "v1.0" }],
  );
  const state: MilestoneActivityState = { observations: {}, dirty: false };

  const result = await findActiveMilestoneBranches(
    "owner/repo",
    ghFn,
    undefined,
    undefined,
    state,
  );

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.length, 1);
  assertEquals(closedQueries.length, 1);
  assertEquals(state.observations, {});
});

Deno.test("syncMilestoneBranches - a second cycle with unchanged milestones issues no closed-issue query (Issue #1488)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { ghFn, closedQueries } = makeGatedGhFn(
      [{ title: "v1.0", number: 1, closed_issues: 2 }],
      [{ number: 10, title: "ten", milestone: "v1.0" }],
    );
    const makeDeps = (): MilestoneBranchSyncDeps => ({
      repos: ["owner/repo"],
      ghCommandFn: async (args: string[]) => {
        if (args.join(" ").includes("repos/owner/repo/branches/")) {
          return "milestone/v1-0";
        }
        return await ghFn(args);
      },
      syncBranchFn: () =>
        Promise.resolve({
          ok: true as const,
          value: { message: "up to date" },
        }),
      log: () => {},
      cooldownSeconds: 0,
      lastSyncTimes: new Map(),
      activityPath: milestoneActivityPath(dir),
    });

    const first = await syncMilestoneBranches(makeDeps());
    assertEquals(first.ok, true);
    if (first.ok) assertEquals(first.value.synced, 1);
    assertEquals(closedQueries.length, 1);

    // Second cycle: nothing changed, so the expensive half is skipped —
    // and the branch still syncs.
    const second = await syncMilestoneBranches(makeDeps());
    assertEquals(second.ok, true);
    if (second.ok) assertEquals(second.value.synced, 1);
    assertEquals(closedQueries.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a milestone that gains a closed issue syncs on the next cycle (Issue #1488)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let closedCount = 0;
    let closed: Array<{ number: number; title: string; milestone: string }> =
      [];
    const closedQueries: string[][] = [];
    const ghCommandFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return JSON.stringify([
          { title: "v1.0", number: 1, closed_issues: closedCount },
        ]);
      }
      if (key.includes("repos/owner/repo/branches/")) return "milestone/v1-0";
      if (key.includes("repos/owner/repo") && key.includes("default_branch")) {
        return "main";
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        closedQueries.push([...args]);
        return JSON.stringify(
          closed.map((i) => ({
            number: i.number,
            title: i.title,
            milestone: { title: i.milestone },
          })),
        );
      }
      return "[]";
    };
    const makeDeps = (): MilestoneBranchSyncDeps => ({
      repos: ["owner/repo"],
      ghCommandFn,
      syncBranchFn: () =>
        Promise.resolve({ ok: true as const, value: { message: "merged" } }),
      log: () => {},
      cooldownSeconds: 0,
      lastSyncTimes: new Map(),
      activityPath: milestoneActivityPath(dir),
    });

    // Cycle 1: nothing completed yet — no query, nothing to sync.
    const first = await syncMilestoneBranches(makeDeps());
    assertEquals(first.ok, true);
    if (first.ok) assertEquals(first.value.synced, 0);
    assertEquals(closedQueries.length, 0);

    // Cycle 2: an issue was completed — the count moved, so the pass
    // re-queries and the branch syncs.
    closedCount = 1;
    closed = [{ number: 10, title: "ten", milestone: "v1.0" }];
    const second = await syncMilestoneBranches(makeDeps());
    assertEquals(second.ok, true);
    if (second.ok) assertEquals(second.value.synced, 1);
    assertEquals(closedQueries.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a milestone that loses its last closed issue stops syncing on the next cycle (Issue #1488)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let closedCount = 1;
    let closed = [{ number: 10, title: "ten", milestone: "v1.0" }];
    const closedQueries: string[][] = [];
    const ghCommandFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return JSON.stringify([
          { title: "v1.0", number: 1, closed_issues: closedCount },
        ]);
      }
      if (key.includes("repos/owner/repo/branches/")) return "milestone/v1-0";
      if (key.includes("repos/owner/repo") && key.includes("default_branch")) {
        return "main";
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        closedQueries.push([...args]);
        return JSON.stringify(
          closed.map((i) => ({
            number: i.number,
            title: i.title,
            milestone: { title: i.milestone },
          })),
        );
      }
      return "[]";
    };
    const makeDeps = (): MilestoneBranchSyncDeps => ({
      repos: ["owner/repo"],
      ghCommandFn,
      syncBranchFn: () =>
        Promise.resolve({ ok: true as const, value: { message: "merged" } }),
      log: () => {},
      cooldownSeconds: 0,
      lastSyncTimes: new Map(),
      activityPath: milestoneActivityPath(dir),
    });

    // Cycle 1: one closed issue — active, and it syncs.
    const first = await syncMilestoneBranches(makeDeps());
    assertEquals(first.ok, true);
    if (first.ok) assertEquals(first.value.synced, 1);
    assertEquals(closedQueries.length, 1);

    // Cycle 2: the issue was reopened, so the REST count fell. The cached
    // "active" verdict must not stand — the pass re-queries and finds the
    // milestone inactive.
    closedCount = 0;
    closed = [];
    const second = await syncMilestoneBranches(makeDeps());
    assertEquals(second.ok, true);
    if (second.ok) assertEquals(second.value.synced, 0);
    // A zero count is answered by the cheap call alone — still one query.
    assertEquals(closedQueries.length, 1);

    // Cycle 3: it is closed again, but under a different count than the
    // one last recorded, so the verdict is recomputed and it syncs.
    closedCount = 2;
    closed = [{ number: 10, title: "ten", milestone: "v1.0" }];
    const third = await syncMilestoneBranches(makeDeps());
    assertEquals(third.ok, true);
    if (third.ok) assertEquals(third.value.synced, 1);
    assertEquals(closedQueries.length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// shouldSyncMilestone
// ============================================================================

Deno.test("shouldSyncMilestone - returns true when no recent sync", () => {
  const lastSyncTimes = new Map<string, number>();
  const result = shouldSyncMilestone("owner/repo", "v1.0", lastSyncTimes, 3600);
  assertEquals(result, true);
});

Deno.test("shouldSyncMilestone - returns false when synced recently", () => {
  const lastSyncTimes = new Map<string, number>();
  const now = Date.now();
  lastSyncTimes.set("owner/repo|v1.0", now - 1000); // 1 second ago
  const result = shouldSyncMilestone("owner/repo", "v1.0", lastSyncTimes, 3600);
  assertEquals(result, false);
});

Deno.test("shouldSyncMilestone - returns true when cooldown has elapsed", () => {
  const lastSyncTimes = new Map<string, number>();
  const now = Date.now();
  lastSyncTimes.set("owner/repo|v1.0", now - 3601 * 1000); // Over 1 hour ago
  const result = shouldSyncMilestone("owner/repo", "v1.0", lastSyncTimes, 3600);
  assertEquals(result, true);
});

Deno.test("shouldSyncMilestone - different milestones tracked independently", () => {
  const lastSyncTimes = new Map<string, number>();
  const now = Date.now();
  lastSyncTimes.set("owner/repo|v1.0", now - 100); // recent
  const result = shouldSyncMilestone("owner/repo", "v2.0", lastSyncTimes, 3600);
  assertEquals(result, true); // v2.0 not synced yet
});

// ============================================================================
// syncMilestoneBranches (orchestration)
// ============================================================================

Deno.test("syncMilestoneBranches - syncs active milestones across repos", async () => {
  const logs: string[] = [];
  const syncedMilestones: string[] = [];

  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return JSON.stringify([{ title: "v1.0", number: 1 }]);
      }
      if (key.includes("repos/owner/repo") && key.includes("default_branch")) {
        return "main";
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        // Issue #1908: closed-batch payload tagged with milestone for local filter.
        return JSON.stringify([{
          number: 10,
          title: "ten",
          milestone: { title: "v1.0" },
        }]);
      }
      if (key.includes("branches/milestone")) {
        return "milestone/v1-0";
      }
      return "[]";
    },
    syncBranchFn: async (
      _repo: string,
      milestoneBranch: string,
      _defaultBranch: string,
    ) => {
      syncedMilestones.push(milestoneBranch);
      return {
        ok: true as const,
        value: { message: `Synced ${milestoneBranch}` },
      };
    },
    log: (msg: string) => logs.push(msg),
    cooldownSeconds: 3600,
    lastSyncTimes: new Map(),
  };

  const result = await syncMilestoneBranches(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.synced, 1);
    assertEquals(result.value.skipped, 0);
    assertEquals(result.value.failed, 0);
  }
  assertEquals(syncedMilestones.length, 1);
  assertEquals(syncedMilestones[0], "milestone/v1-0");
});

Deno.test("syncMilestoneBranches - skips milestones on cooldown", async () => {
  const logs: string[] = [];
  const lastSyncTimes = new Map<string, number>();
  lastSyncTimes.set("owner/repo|v1.0", Date.now() - 100); // recently synced

  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return JSON.stringify([{ title: "v1.0", number: 1 }]);
      }
      if (key.includes("repos/owner/repo") && key.includes("default_branch")) {
        return "main";
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        // Issue #1908: closed-batch payload tagged with milestone for local filter.
        return JSON.stringify([{
          number: 10,
          title: "ten",
          milestone: { title: "v1.0" },
        }]);
      }
      return "[]";
    },
    syncBranchFn: async () => {
      throw new Error("Should not be called");
    },
    log: (msg: string) => logs.push(msg),
    cooldownSeconds: 3600,
    lastSyncTimes,
  };

  const result = await syncMilestoneBranches(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.synced, 0);
    assertEquals(result.value.skipped, 1);
  }
});

Deno.test("syncMilestoneBranches - handles sync failure gracefully", async () => {
  const logs: string[] = [];

  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return JSON.stringify([{ title: "v1.0", number: 1 }]);
      }
      if (key.includes("repos/owner/repo") && key.includes("default_branch")) {
        return "main";
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        // Issue #1908: closed-batch payload tagged with milestone for local filter.
        return JSON.stringify([{
          number: 10,
          title: "ten",
          milestone: { title: "v1.0" },
        }]);
      }
      if (key.includes("branches/milestone")) {
        return "milestone/v1-0";
      }
      return "[]";
    },
    syncBranchFn: async () => {
      return { ok: false as const, error: new Error("Merge conflict") };
    },
    log: (msg: string) => logs.push(msg),
    cooldownSeconds: 3600,
    lastSyncTimes: new Map(),
  };

  const result = await syncMilestoneBranches(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.synced, 0);
    assertEquals(result.value.failed, 1);
  }
  // Should log a warning about the failure
  const hasWarning = logs.some((l) =>
    l.includes("WARNING") || l.includes("failed")
  );
  assertEquals(hasWarning, true);
});

Deno.test("syncMilestoneBranches - returns empty result for no repos", async () => {
  const deps: MilestoneBranchSyncDeps = {
    repos: [],
    ghCommandFn: async () => "[]",
    syncBranchFn: async () => ({
      ok: true as const,
      value: { message: "done" },
    }),
    log: () => {},
    cooldownSeconds: 3600,
    lastSyncTimes: new Map(),
  };

  const result = await syncMilestoneBranches(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.synced, 0);
    assertEquals(result.value.skipped, 0);
    assertEquals(result.value.failed, 0);
  }
});

Deno.test("syncMilestoneBranches - handles multiple repos", async () => {
  const syncedMilestones: string[] = [];

  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo1", "owner/repo2"],
    ghCommandFn: async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("/milestones")) {
        return JSON.stringify([{ title: "v1.0", number: 1 }]);
      }
      if (key.includes("default_branch")) {
        return "main";
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        // Issue #1908: closed-batch payload tagged with milestone for local filter.
        return JSON.stringify([{
          number: 10,
          title: "ten",
          milestone: { title: "v1.0" },
        }]);
      }
      if (key.includes("branches/milestone")) {
        return "milestone/v1-0";
      }
      return "[]";
    },
    syncBranchFn: async (
      repo: string,
      milestoneBranch: string,
      _defaultBranch: string,
    ) => {
      syncedMilestones.push(`${repo}:${milestoneBranch}`);
      return { ok: true as const, value: { message: "synced" } };
    },
    log: () => {},
    cooldownSeconds: 3600,
    lastSyncTimes: new Map(),
  };

  const result = await syncMilestoneBranches(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.synced, 2);
  }
  assertEquals(syncedMilestones.length, 2);
});

Deno.test("syncMilestoneBranches - updates lastSyncTimes after successful sync", async () => {
  const lastSyncTimes = new Map<string, number>();

  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return JSON.stringify([{ title: "v1.0", number: 1 }]);
      }
      if (key.includes("repos/owner/repo") && key.includes("default_branch")) {
        return "main";
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        // Issue #1908: closed-batch payload tagged with milestone for local filter.
        return JSON.stringify([{
          number: 10,
          title: "ten",
          milestone: { title: "v1.0" },
        }]);
      }
      if (key.includes("branches/milestone")) {
        return "milestone/v1-0";
      }
      return "[]";
    },
    syncBranchFn: async () => ({
      ok: true as const,
      value: { message: "synced" },
    }),
    log: () => {},
    cooldownSeconds: 3600,
    lastSyncTimes,
  };

  // Issue #2434: bracket the call with test-captured clock readings and assert
  // the recorded timestamp falls within that window, rather than comparing a
  // wall-clock `elapsed` against a fixed 5s budget (which depends on machine
  // speed and CI load). This stays correct however long the call took.
  const before = Date.now();
  await syncMilestoneBranches(deps);
  const after = Date.now();
  assertEquals(lastSyncTimes.has("owner/repo|v1.0"), true);
  const syncTime = lastSyncTimes.get("owner/repo|v1.0")!;
  assert(
    syncTime >= before && syncTime <= after,
    `sync timestamp ${syncTime} should be within [${before}, ${after}]`,
  );
});

Deno.test("syncMilestoneBranches - does not update lastSyncTimes on failure", async () => {
  const lastSyncTimes = new Map<string, number>();

  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return JSON.stringify([{ title: "v1.0", number: 1 }]);
      }
      if (key.includes("repos/owner/repo") && key.includes("default_branch")) {
        return "main";
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        // Issue #1908: closed-batch payload tagged with milestone for local filter.
        return JSON.stringify([{
          number: 10,
          title: "ten",
          milestone: { title: "v1.0" },
        }]);
      }
      if (key.includes("branches/milestone")) {
        return "milestone/v1-0";
      }
      return "[]";
    },
    syncBranchFn: async () => ({
      ok: false as const,
      error: new Error("conflict"),
    }),
    log: () => {},
    cooldownSeconds: 3600,
    lastSyncTimes,
  };

  await syncMilestoneBranches(deps);
  assertEquals(lastSyncTimes.has("owner/repo|v1.0"), false);
});

Deno.test("syncMilestoneBranches - continues processing after one repo fails", async () => {
  const syncedMilestones: string[] = [];
  let callCount = 0;

  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/fail-repo", "owner/good-repo"],
    ghCommandFn: async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("owner/fail-repo/milestones")) {
        throw new Error("API error for fail-repo");
      }
      if (key.includes("/milestones")) {
        return JSON.stringify([{ title: "v1.0", number: 1 }]);
      }
      if (key.includes("default_branch")) {
        return "main";
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        // Issue #1908: closed-batch payload tagged with milestone for local filter.
        return JSON.stringify([{
          number: 10,
          title: "ten",
          milestone: { title: "v1.0" },
        }]);
      }
      if (key.includes("branches/milestone")) {
        return "milestone/v1-0";
      }
      return "[]";
    },
    syncBranchFn: async (repo: string, branch: string) => {
      callCount++;
      syncedMilestones.push(`${repo}:${branch}`);
      return { ok: true as const, value: { message: "synced" } };
    },
    log: () => {},
    cooldownSeconds: 3600,
    lastSyncTimes: new Map(),
  };

  const result = await syncMilestoneBranches(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.synced, 1);
  }
  assertEquals(callCount, 1);
});

// ============================================================================
// Issue #1509 — defaultBranchFn injection
// ============================================================================

Deno.test("findActiveMilestoneBranches - uses injected defaultBranchFn when provided", async () => {
  let branchCalls = 0;

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("api repos/owner/repo --jq .default_branch")) {
      throw new Error("direct default_branch gh call should not occur");
    }
    if (key.includes("repos/owner/repo/milestones")) {
      return JSON.stringify([{ title: "v1.0", number: 1 }]);
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      // Issue #1908: closed-batch payload tagged with milestone for local filter.
      return JSON.stringify([{
        number: 10,
        title: "ten",
        milestone: { title: "v1.0" },
      }]);
    }
    return "[]";
  };

  const result = await findActiveMilestoneBranches(
    "owner/repo",
    ghFn,
    (repo) => {
      branchCalls++;
      return Promise.resolve({ ok: true as const, value: `main-${repo}` });
    },
  );

  assertEquals(result.ok, true);
  assertEquals(branchCalls, 1);
  if (result.ok) {
    assertEquals(result.value.length, 1);
    assertEquals(result.value[0]!.defaultBranch, "main-owner/repo");
  }
});

Deno.test("syncMilestoneBranches - uses injected defaultBranchFn when provided", async () => {
  let branchCalls = 0;
  const syncedMilestones: string[] = [];

  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("api repos/owner/repo --jq .default_branch")) {
        throw new Error("direct default_branch gh call should not occur");
      }
      if (key.includes("repos/owner/repo/milestones")) {
        return JSON.stringify([{ title: "v1.0", number: 1 }]);
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        // Issue #1908: closed-batch payload tagged with milestone for local filter.
        return JSON.stringify([{
          number: 10,
          title: "ten",
          milestone: { title: "v1.0" },
        }]);
      }
      if (key.includes("branches/milestone")) {
        return "milestone/v1-0";
      }
      return "[]";
    },
    defaultBranchFn: () => {
      branchCalls++;
      return Promise.resolve({ ok: true as const, value: "main" });
    },
    syncBranchFn: async (_repo, branch) => {
      syncedMilestones.push(branch);
      return { ok: true as const, value: { message: "synced" } };
    },
    log: () => {},
    cooldownSeconds: 3600,
    lastSyncTimes: new Map(),
  };

  const result = await syncMilestoneBranches(deps);
  assertEquals(result.ok, true);
  assertEquals(branchCalls, 1);
  assertEquals(syncedMilestones, ["milestone/v1-0"]);
});

Deno.test("syncMilestoneBranches - skips repo when defaultBranchFn errors", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/milestones")) {
      throw new Error("should not be called when default branch unavailable");
    }
    return "[]";
  };

  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: ghFn,
    defaultBranchFn: () =>
      Promise.resolve({ ok: false as const, error: new Error("network down") }),
    syncBranchFn: async () => ({
      ok: true as const,
      value: { message: "synced" },
    }),
    log: () => {},
    cooldownSeconds: 3600,
    lastSyncTimes: new Map(),
  };

  const result = await syncMilestoneBranches(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.synced, 0);
    assertEquals(result.value.failed, 0);
  }
});

Deno.test("syncMilestoneBranches - skips milestone branch that does not exist on remote", async () => {
  const logs: string[] = [];

  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return JSON.stringify([{ title: "v1.0", number: 1 }]);
      }
      if (key.includes("repos/owner/repo") && key.includes("default_branch")) {
        return "main";
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        // Issue #1908: closed-batch payload tagged with milestone for local filter.
        return JSON.stringify([{
          number: 10,
          title: "ten",
          milestone: { title: "v1.0" },
        }]);
      }
      if (key.includes("branches/milestone")) {
        throw new Error("Not found");
      }
      return "[]";
    },
    syncBranchFn: async () => {
      throw new Error("Should not be called");
    },
    log: (msg: string) => logs.push(msg),
    cooldownSeconds: 3600,
    lastSyncTimes: new Map(),
  };

  const result = await syncMilestoneBranches(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.synced, 0);
    assertEquals(result.value.skipped, 1);
  }
});

Deno.test("syncMilestoneBranches - skips repo when localCloneExistsFn returns false (Issue #1519)", async () => {
  const logs: string[] = [];
  const ghCalls: string[] = [];

  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/cloned", "owner/not-cloned"],
    ghCommandFn: async (args: string[]): Promise<string> => {
      ghCalls.push(args.join(" "));
      const key = args.join(" ");
      if (
        key.includes("repos/owner/cloned/milestones") ||
        key.includes("repos/owner/not-cloned/milestones")
      ) {
        return JSON.stringify([{ title: "v1.0", number: 1 }]);
      }
      if (key.includes("default_branch")) {
        return "main";
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        // Issue #1908: closed-batch payload tagged with milestone for local filter.
        return JSON.stringify([{
          number: 10,
          title: "ten",
          milestone: { title: "v1.0" },
        }]);
      }
      if (key.includes("branches/milestone")) {
        return "milestone/v1-0";
      }
      return "[]";
    },
    localCloneExistsFn: async (repo: string) => repo === "owner/cloned",
    syncBranchFn: async (
      repo: string,
      milestoneBranch: string,
      _defaultBranch: string,
    ) => {
      if (repo === "owner/not-cloned") {
        throw new Error("syncBranchFn must not run for uncloned repo");
      }
      return {
        ok: true as const,
        value: { message: `Synced ${milestoneBranch}` },
      };
    },
    log: (msg: string) => logs.push(msg),
    cooldownSeconds: 3600,
    lastSyncTimes: new Map(),
  };

  const result = await syncMilestoneBranches(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.synced, 1);
    assertEquals(result.value.failed, 0);
  }

  const hasSkipLog = logs.some((l) =>
    l.includes("owner/not-cloned") && l.includes("no local clone")
  );
  assertEquals(
    hasSkipLog,
    true,
    `expected skip log for uncloned repo, got: ${logs.join(" | ")}`,
  );

  const touchedNotCloned = ghCalls.some((c) => c.includes("owner/not-cloned"));
  assertEquals(
    touchedNotCloned,
    false,
    "no gh calls should target the uncloned repo",
  );
});

// ---------------------------------------------------------------------------
// Ghost branches and honest failures (Issue #4260)
// ---------------------------------------------------------------------------

Deno.test("syncMilestoneBranches - an empty branch-probe answer reads as missing, not as present (Issue #4260)", async () => {
  // A runGh-style ghCommandFn returns "" on failure instead of throwing —
  // the ghost milestone/69 branch kept being "synced" three cycles running
  // because the empty probe answer passed the existence check.
  const logs: string[] = [];
  const syncedMilestones: string[] = [];

  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return JSON.stringify([{ title: "v1.0", number: 1 }]);
      }
      if (key.includes("repos/owner/repo") && key.includes("default_branch")) {
        return "main";
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        return JSON.stringify([{
          number: 10,
          title: "ten",
          milestone: { title: "v1.0" },
        }]);
      }
      if (key.includes("branches/milestone")) {
        return ""; // deleted branch, swallowed failure — must read as missing
      }
      return "[]";
    },
    syncBranchFn: async (
      _repo: string,
      milestoneBranch: string,
      _defaultBranch: string,
    ) => {
      syncedMilestones.push(milestoneBranch);
      return {
        ok: true as const,
        value: { message: `Synced ${milestoneBranch}` },
      };
    },
    log: (msg: string) => logs.push(msg),
    cooldownSeconds: 3600,
    lastSyncTimes: new Map(),
  };

  const result = await syncMilestoneBranches(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.synced, 0);
    assertEquals(result.value.skipped, 1);
  }
  assertEquals(
    syncedMilestones.length,
    0,
    "a branch whose probe answered empty must never be synced",
  );
});

Deno.test("syncMilestoneBranches - a failed sync emits a self-heal event when wired (Issue #4260)", async () => {
  const events: string[] = [];

  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return JSON.stringify([{ title: "v1.0", number: 1 }]);
      }
      if (key.includes("repos/owner/repo") && key.includes("default_branch")) {
        return "main";
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        return JSON.stringify([{
          number: 10,
          title: "ten",
          milestone: { title: "v1.0" },
        }]);
      }
      if (key.includes("branches/milestone")) {
        return "milestone/v1-0";
      }
      return "[]";
    },
    syncBranchFn: async () => ({
      ok: false as const,
      error: new Error("refusing to merge unrelated histories"),
    }),
    emitSelfHealEvent: (event) => {
      events.push(`${event.action}:${event.reason}`);
      return Promise.resolve(true);
    },
    log: () => undefined,
    cooldownSeconds: 3600,
    lastSyncTimes: new Map(),
  };

  const result = await syncMilestoneBranches(deps);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.failed, 1);
  assertEquals(events.length, 1);
  assertStringIncludes(events[0]!, "sync_failed");
  assertStringIncludes(events[0]!, "unrelated histories");
});

// ============================================================================
// Escalations comment on an existing issue — never file one (Issue #1769)
// ============================================================================

/** How the injected sync fails, per escalation path. */
type FailureKind = "plain" | "gate" | "analysis";

/** Options for {@link escalationDeps}. */
interface EscalationOptions {
  /** Milestone title — a leading `#NNN` is the parent planning issue. */
  milestoneTitle: string;
  /** How the sync fails; omitted means it succeeds with a conflict. */
  failure?: FailureKind;
  /** The milestone's open children. */
  children?: { number: number; title: string }[];
  /** Whether the parent planning issue reads as closed. */
  parentClosed?: boolean;
  /** Make every `issue comment` call throw. */
  commentFails?: boolean;
  streakPath?: string;
  log?: (message: string) => void;
}

const ESCALATION_BRANCH = "milestone/1769-escalations";
const ESCALATION_DEFAULT_SHA = "d".repeat(40);

/** The failing (or conflicting) sync outcome for one escalation path. */
function escalationOutcome(
  options: EscalationOptions,
): ReturnType<MilestoneBranchSyncDeps["syncBranchFn"]> {
  if (options.failure === "gate") {
    return Promise.resolve({
      ok: false as const,
      error: mergeGateFailureError(ESCALATION_BRANCH, "main", {
        status: "failed",
        detail: "the merged tree does not type-check",
        output: "TS2304: Cannot find name 'foo'",
      }),
    });
  }
  if (options.failure === "analysis") {
    return Promise.resolve({
      ok: false as const,
      error: new MilestoneConflictEscalation(
        "two designs for the same problem",
        [{
          path: "worker/deno/lib/scan_content.ts",
          reason: "both sides rewrote it",
          oursExports: ["a"],
          theirsExports: ["b"],
          oursTests: [],
          theirsTests: [],
          onlyOursTests: [],
          onlyTheirsTests: [],
        }],
        [],
        ESCALATION_DEFAULT_SHA,
      ),
    });
  }
  if (options.failure === "plain") {
    return Promise.resolve({
      ok: false as const,
      error: new Error("refusing to merge unrelated histories"),
    });
  }
  return Promise.resolve({
    ok: true as const,
    value: {
      message: "merged with conflicts",
      conflict: {
        files: ["worker/deno/lib/scan_content.ts"],
        milestoneSha: "e".repeat(40),
        defaultSha: ESCALATION_DEFAULT_SHA,
        resolution: "theirs" as const,
      },
    },
  });
}

/** Sync deps for the escalation-destination tests, recording every argv. */
function escalationDeps(
  calls: string[][],
  options: EscalationOptions,
): MilestoneBranchSyncDeps {
  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: (args: string[]): Promise<string> => {
      calls.push([...args]);
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return Promise.resolve(
          JSON.stringify([{ title: options.milestoneTitle, number: 5 }]),
        );
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("issue list") && key.includes("--state closed")) {
        return Promise.resolve(
          JSON.stringify([{
            number: 10,
            title: "t",
            milestone: { title: options.milestoneTitle },
          }]),
        );
      }
      if (key.startsWith("issue view")) {
        return Promise.resolve(options.parentClosed ? "CLOSED" : "OPEN");
      }
      if (key.includes("issues?milestone=")) {
        return Promise.resolve(JSON.stringify(options.children ?? []));
      }
      if (key.startsWith("issue list")) return Promise.resolve("[]");
      if (key.startsWith("issue comment") && options.commentFails) {
        return Promise.reject(new Error("404 not found"));
      }
      if (key.includes("branches/milestone")) {
        return Promise.resolve(ESCALATION_BRANCH);
      }
      return Promise.resolve("");
    },
    syncBranchFn: () => escalationOutcome(options),
    log: options.log ?? (() => undefined),
    cooldownSeconds: 0,
    lastSyncTimes: new Map(),
  };
  if (options.streakPath) deps.streakPath = options.streakPath;
  return deps;
}

const escalationCreateCalls = (calls: string[][]): string[][] =>
  calls.filter((c) => c[0] === "issue" && c[1] === "create");

Deno.test("syncMilestoneBranches - no escalation path ever files an issue (Issue #1769)", async () => {
  // Every escalation shape, on a milestone with no parent planning issue and
  // no open children — the state that used to file one issue per branch.
  for (
    const failure of [
      undefined,
      "plain",
      "gate",
      "analysis",
    ] as (FailureKind | undefined)[]
  ) {
    const dir = await Deno.makeTempDir({ prefix: "issue-1769-create-" });
    try {
      const calls: string[][] = [];
      const streakPath = milestoneSyncStreakPath(dir);
      // Three cycles: the plain-failure escalation only fires at the streak
      // threshold, so a single cycle would not reach it.
      for (let cycle = 0; cycle < 3; cycle++) {
        await syncMilestoneBranches(escalationDeps(calls, {
          milestoneTitle: "Escalations with no parent",
          ...(failure ? { failure } : {}),
          children: [],
          streakPath,
        }));
      }
      assertEquals(
        escalationCreateCalls(calls).length,
        0,
        `failure '${failure ?? "conflict"}' filed an issue; gh calls: ${
          JSON.stringify(calls)
        }`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("syncMilestoneBranches - a streak escalation with nowhere to go is recorded as escalated (Issue #1769)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1769-none-" });
  try {
    const calls: string[][] = [];
    const logs: string[] = [];
    const streakPath = milestoneSyncStreakPath(dir);
    for (let cycle = 0; cycle < 4; cycle++) {
      await syncMilestoneBranches(escalationDeps(calls, {
        milestoneTitle: "Escalations with no parent",
        failure: "plain",
        children: [],
        streakPath,
        log: (m) => logs.push(m),
      }));
    }

    assertEquals(escalationCreateCalls(calls).length, 0);
    assertEquals(
      logs.filter((l) => l.includes("no open children")).length,
      1,
      `one log line, not one per cycle; logs: ${JSON.stringify(logs)}`,
    );
    const streaks = JSON.parse(await Deno.readTextFile(streakPath));
    assertEquals(
      Object.values(streaks).map((e) =>
        (e as { escalated: boolean }).escalated
      ),
      [true],
      "the streak is marked escalated so the line is not repeated",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a closed parent planning issue is reopened and commented on once (Issue #1769)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1769-reopen-" });
  try {
    const calls: string[][] = [];
    const streakPath = milestoneSyncStreakPath(dir);
    for (let cycle = 0; cycle < 2; cycle++) {
      await syncMilestoneBranches(escalationDeps(calls, {
        milestoneTitle: "#1730 Resolve merge conflicts",
        failure: "gate",
        parentClosed: true,
        streakPath,
      }));
    }

    assertEquals(
      calls.filter((c) => c[0] === "issue" && c[1] === "reopen").map((c) =>
        c[2]
      ),
      ["1730"],
      "reopened once, on the first cycle only",
    );
    const labels = calls
      .filter((c) => c.includes("--add-label"))
      .map((c) => c[c.indexOf("--add-label") + 1]);
    assertEquals(labels, ["needs-human"], "no pickup label is ever added");

    const comments = calls.filter((c) =>
      c[0] === "issue" && c[1] === "comment"
    );
    assertEquals(comments.length, 1, "a second cycle posts nothing");
    assertEquals(comments[0]![2], "1730");
    assertStringIncludes(comments[0]!.join(" "), "Reopened by the milestone");
    assertEquals(escalationCreateCalls(calls).length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a comment that throws leaves the streak unescalated (Issue #1769)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1769-throw-" });
  try {
    const calls: string[][] = [];
    const streakPath = milestoneSyncStreakPath(dir);
    for (let cycle = 0; cycle < 4; cycle++) {
      await syncMilestoneBranches(escalationDeps(calls, {
        milestoneTitle: "#1730 Resolve merge conflicts",
        failure: "plain",
        commentFails: true,
        streakPath,
      }));
    }

    const streaks = JSON.parse(await Deno.readTextFile(streakPath));
    assertEquals(
      Object.values(streaks).map((e) =>
        (e as { escalated: boolean }).escalated
      ),
      [false],
      "an escalation that did not go out is not marked done",
    );
    assert(
      calls.filter((c) => c[0] === "issue" && c[1] === "comment").length > 1,
      "and it is retried on the next cycle",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a successful sync closes the branch's own diagnostics (Issue #1769)", async () => {
  const calls: string[][] = [];
  const stuckTitle = stuckSyncDiagnosticTitle("milestone/v1-0");
  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: (args: string[]): Promise<string> => {
      calls.push([...args]);
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return Promise.resolve(JSON.stringify([{ title: "v1.0", number: 1 }]));
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("issue list") && key.includes("--state closed")) {
        return Promise.resolve(
          JSON.stringify([{
            number: 10,
            title: "t",
            milestone: { title: "v1.0" },
          }]),
        );
      }
      if (key.startsWith("issue list")) {
        const search = args[args.indexOf("--search") + 1] ?? "";
        return Promise.resolve(
          search.includes("stuck")
            ? JSON.stringify([{
              number: 1754,
              title: stuckTitle,
              author: { login: "vibe-coder" },
              body: "",
            }, {
              number: 4242,
              title: stuckTitle,
              author: { login: "passer-by" },
              body: "",
            }])
            : "[]",
        );
      }
      if (key.includes("branches/milestone")) return Promise.resolve("ok");
      return Promise.resolve("");
    },
    syncBranchFn: () =>
      Promise.resolve({ ok: true as const, value: { message: "merged" } }),
    log: () => undefined,
    cooldownSeconds: 0,
    lastSyncTimes: new Map(),
    dedupAuthors: { fleetAuthors: ["vibe-coder"] },
  };

  const result = await syncMilestoneBranches(deps);
  assert(result.ok);
  assertEquals(result.value.synced, 1);

  const closes = calls.filter((c) => c[0] === "issue" && c[1] === "close");
  assertEquals(closes.map((c) => c[2]), ["1754"], "only the fleet's own issue");
  assertStringIncludes(
    closes[0]![closes[0]!.indexOf("--comment") + 1] ?? "",
    "milestone/v1-0",
  );
});
