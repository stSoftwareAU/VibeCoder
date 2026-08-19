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
  type MilestoneBranchSyncDeps,
  shouldSyncMilestone,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";

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
      return { ok: true as const, value: `Synced ${milestoneBranch}` };
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
    syncBranchFn: async () => ({ ok: true as const, value: "done" }),
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
      return { ok: true as const, value: "synced" };
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
    syncBranchFn: async () => ({ ok: true as const, value: "synced" }),
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
      return { ok: true as const, value: "synced" };
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
      return { ok: true as const, value: "synced" };
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
    syncBranchFn: async () => ({ ok: true as const, value: "synced" }),
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
      return { ok: true as const, value: `Synced ${milestoneBranch}` };
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
      return { ok: true as const, value: `Synced ${milestoneBranch}` };
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
