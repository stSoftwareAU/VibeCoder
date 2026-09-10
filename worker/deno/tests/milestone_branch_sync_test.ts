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
  conflictAttemptDue,
  failedConflictRung,
  findActiveMilestoneBranches,
  grantAgentRun,
  judgeSyncFailure,
  type MilestoneBranchSyncDeps,
  shouldSyncMilestone,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import { createMilestoneBranchName } from "../lib/git_branch.ts";
import { MilestoneConflictEscalation } from "../lib/milestone_conflict_triage.ts";
import { mergeGateFailureError } from "../lib/milestone_merge_gate.ts";
import { stuckSyncDiagnosticTitle } from "../lib/milestone_sync_diagnostic_closeout.ts";
import {
  loadSyncStreaks,
  MILESTONE_CONFLICT_ATTEMPT_BUDGET,
  milestoneSyncStreakPath,
  saveSyncStreaks,
  type SyncStreakEntry,
} from "../lib/milestone_sync_streak.ts";
import {
  DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS,
  DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT,
} from "../lib/merge_conflict_drain.ts";

// ============================================================================
// findActiveMilestoneBranches
// ============================================================================

Deno.test("findActiveMilestoneBranches - returns every open milestone (Issue #1776)", async () => {
  const closedQueries: string[][] = [];
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
      closedQueries.push([...args]);
      return JSON.stringify([
        { number: 10, title: "ten", milestone: { title: "v1.0" } },
      ]);
    }
    return "[]";
  };

  const result = await findActiveMilestoneBranches("owner/repo", ghFn);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 2);
    assertEquals(result.value[0]!.milestoneTitle, "v1.0");
    assertEquals(result.value[0]!.milestoneBranch, "milestone/v1-0");
    assertEquals(result.value[0]!.defaultBranch, "main");
    assertEquals(result.value[1]!.milestoneTitle, "v2.0");
  }
  // The closed-issue query is gone entirely (Issue #1776): it decided which
  // milestones had "started", and every open milestone drifts regardless.
  assertEquals(closedQueries.length, 0);
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

Deno.test("findActiveMilestoneBranches - includes a milestone with zero closed issues (Issue #1776)", async () => {
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
    // Nothing closed yet, and it still drifts against a default branch
    // taking ~27 commits a day.
    assertEquals(result.value.length, 1);
    assertEquals(result.value[0]!.milestoneBranch, "milestone/empty-milestone");
    assertEquals(result.value[0]!.defaultBranch, "Develop");
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

Deno.test("shouldSyncMilestone - a branch with no ledger entry syncs (Issue #1776)", () => {
  assertEquals(shouldSyncMilestone(undefined, "sha-a"), true);
});

Deno.test("shouldSyncMilestone - the recorded tip is the one tip that skips (Issue #1776)", () => {
  const entry = { count: 0, escalated: false, lastSyncedDefaultSha: "sha-a" };
  assertEquals(shouldSyncMilestone(entry, "sha-a"), false);
  assertEquals(shouldSyncMilestone(entry, "sha-b"), true);
});

Deno.test("shouldSyncMilestone - a failed branch carrying no tip still syncs (Issue #1776)", () => {
  // Only a success records a tip, so a branch that has only ever failed has
  // none — and is tried again rather than waiting anything out.
  assertEquals(
    shouldSyncMilestone({ count: 2, escalated: false }, "sha-a"),
    true,
  );
});

Deno.test("shouldSyncMilestone - an unreadable tip never reads as unchanged (Issue #1776)", () => {
  const entry = { count: 0, escalated: false, lastSyncedDefaultSha: "sha-a" };
  assertEquals(shouldSyncMilestone(entry, undefined), true);
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
  };

  const result = await syncMilestoneBranches(deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.synced, 2);
  }
  assertEquals(syncedMilestones.length, 2);
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

// ============================================================================
// The conflict attempt ledger the sync charges (Issue #1778)
// ============================================================================

const LEDGER_TITLE = "#1730 Ledger";
const SECOND_TITLE = "#1731 Second";
const LEDGER_BRANCH = createMilestoneBranchName(LEDGER_TITLE);
const SECOND_BRANCH = createMilestoneBranchName(SECOND_TITLE);
const LEDGER_SHA = "a".repeat(40);
const MOVED_SHA = "b".repeat(40);

/** How the injected sync ends, for the ledger tests. */
type LedgerFailure =
  | "conflict"
  | "gate"
  | "resolution-gate"
  | "ruleset"
  | "plain"
  | "success";

/** One milestone's scripted outcome for a ledger cycle. */
interface LedgerMilestone {
  title: string;
  branch: string;
  failure: LedgerFailure;
}

/** The failing (or succeeding) sync outcome one ledger milestone produces. */
function ledgerOutcome(
  failure: LedgerFailure,
  branch: string,
): Awaited<ReturnType<MilestoneBranchSyncDeps["syncBranchFn"]>> {
  const analysis = {
    path: "worker/deno/lib/scan_content.ts",
    reason: "agent: it left 1 path(s) unmerged: worker/deno/lib/scan.ts",
    oursExports: ["a"],
    theirsExports: ["b"],
    oursTests: [],
    theirsTests: [],
    onlyOursTests: [],
    onlyTheirsTests: [],
  };
  switch (failure) {
    case "conflict":
      return {
        ok: false,
        error: new MilestoneConflictEscalation(
          "every rung left it undecided",
          [analysis],
          [],
          LEDGER_SHA,
        ),
      };
    case "resolution-gate":
      return {
        ok: false,
        error: new MilestoneConflictEscalation(
          "the resolution did not verify",
          [analysis],
          [],
          LEDGER_SHA,
          "TS2304: Cannot find name 'foo'",
        ),
      };
    case "gate":
      return {
        ok: false,
        error: mergeGateFailureError(branch, "main", {
          status: "failed",
          detail: "the merged tree does not type-check",
          output: "TS2304",
        }),
      };
    case "ruleset":
      return {
        ok: false,
        error: new Error(
          "! [remote rejected] main -> main (protected branch hook declined)\n" +
            "GH006: Protected branch update failed",
        ),
      };
    case "plain":
      return {
        ok: false,
        error: new Error("refusing to merge unrelated histories"),
      };
    case "success":
      return { ok: true, value: { message: "already up to date" } };
  }
}

/** Options for {@link ledgerDeps}. */
interface LedgerOptions {
  milestones: LedgerMilestone[];
  streakPath: string;
  defaultSha?: string;
  deadlineEpochMs?: number;
  agentTimeoutMs?: number;
  nowMs?: number;
  rollbacks?: string[];
  log?: (message: string) => void;
  /** Records the grant each milestone's sync was given. */
  grants?: Record<string, { allowed: boolean; seconds?: number }>;
}

/** Sync deps that charge the ledger, recording every gh argv. */
function ledgerDeps(
  calls: string[][],
  options: LedgerOptions,
): MilestoneBranchSyncDeps {
  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: (args: string[]): Promise<string> => {
      calls.push([...args]);
      const key = args.join(" ");
      if (key.includes("repos/owner/repo/milestones")) {
        return Promise.resolve(
          JSON.stringify(
            options.milestones.map((m, i) => ({
              title: m.title,
              number: i + 1,
            })),
          ),
        );
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("branches/milestone")) {
        return Promise.resolve(args[2]!.split("/").slice(-2).join("/"));
      }
      if (key.startsWith("issue view")) return Promise.resolve("OPEN");
      return Promise.resolve("[]");
    },
    syncBranchFn: (_repo, milestoneBranch, _defaultBranch, syncOptions) => {
      if (options.grants) {
        options.grants[milestoneBranch] = {
          allowed: syncOptions?.agentAllowed ?? true,
          ...(syncOptions?.agentTimeoutSeconds !== undefined
            ? { seconds: syncOptions.agentTimeoutSeconds }
            : {}),
        };
      }
      const milestone = options.milestones.find((m) =>
        m.branch === milestoneBranch
      )!;
      return Promise.resolve(ledgerOutcome(milestone.failure, milestoneBranch));
    },
    defaultTipShaFn: () =>
      Promise.resolve({
        ok: true as const,
        value: options.defaultSha ?? LEDGER_SHA,
      }),
    log: options.log ?? (() => undefined),
    streakPath: options.streakPath,
  };
  if (options.deadlineEpochMs !== undefined) {
    deps.deadlineEpochMs = options.deadlineEpochMs;
  }
  if (options.agentTimeoutMs !== undefined) {
    deps.agentTimeoutMs = options.agentTimeoutMs;
  }
  if (options.nowMs !== undefined) {
    const at = options.nowMs;
    deps.now = () => at;
  }
  if (options.rollbacks) {
    const seen = options.rollbacks;
    deps.rollbackFn = (request) => {
      seen.push(
        `${request.repo}|${request.milestoneBranch}|${request.attempts}`,
      );
      return Promise.resolve();
    };
  }
  return deps;
}

/** gh calls that would reach a human: a comment, a label or a new issue. */
const humanFacingCalls = (calls: string[][]): string[][] =>
  calls.filter((c) =>
    (c[0] === "issue" && (c[1] === "comment" || c[1] === "create")) ||
    (c[0] === "issue" && c[1] === "edit") ||
    c[0] === "label"
  );

/** The one ledger entry these tests write. */
async function readLedger(
  streakPath: string,
  branch = LEDGER_BRANCH,
): Promise<SyncStreakEntry | undefined> {
  const streaks = await loadSyncStreaks(streakPath);
  return streaks[`owner/repo|${branch}`];
}

Deno.test("syncMilestoneBranches - a conflict failure charges one attempt and posts nothing (Issue #1778)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1778-charge-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    // One prior concluded failure, its cooldown already passed.
    await saveSyncStreaks(streakPath, {
      [`owner/repo|${LEDGER_BRANCH}`]: {
        count: 1,
        escalated: false,
        conflictAttempts: 1,
        lastAttempt: {
          at: new Date(1_000).toISOString(),
          outcome: "failed",
          reason: "conflict unresolved at rung agent",
          defaultSha: LEDGER_SHA,
        },
        deferUntil: new Date(2_000).toISOString(),
      },
    });

    const calls: string[][] = [];
    const logs: string[] = [];
    const result = await syncMilestoneBranches(ledgerDeps(calls, {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "conflict",
      }],
      streakPath,
      nowMs: 10_000,
      log: (m) => logs.push(m),
    }));

    assertEquals(result.ok, true);
    const entry = await readLedger(streakPath);
    assertEquals(entry?.conflictAttempts, 2);
    assert(entry?.deferUntil !== undefined, "a failure must pace the next try");
    assertEquals(entry?.lastAttempt?.outcome, "failed");
    assertEquals(entry?.attemptOpenedAt, undefined);
    // Nothing reaches a human while an automatic attempt remains.
    assertEquals(
      humanFacingCalls(calls).length,
      0,
      `posted: ${JSON.stringify(humanFacingCalls(calls))}`,
    );
    assert(
      logs.some((l) =>
        l.includes(
          `conflict attempt 2 of ${MILESTONE_CONFLICT_ATTEMPT_BUDGET} failed at rung agent`,
        )
      ),
      `no per-attempt line in: ${JSON.stringify(logs)}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - the same tip waits out the cooldown and a moved tip does not (Issue #1778)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1778-pace-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const milestones: LedgerMilestone[] = [{
      title: LEDGER_TITLE,
      branch: LEDGER_BRANCH,
      failure: "conflict",
    }];

    // Cycle 1: the first conflict failure, which sets the cooldown.
    const logs: string[] = [];
    await syncMilestoneBranches(ledgerDeps([], {
      milestones,
      streakPath,
      nowMs: 10_000,
    }));
    assertEquals((await readLedger(streakPath))?.conflictAttempts, 1);

    // Cycle 2: same tip, still inside the cooldown — no merge is attempted.
    let attempts = 0;
    const deps = ledgerDeps([], {
      milestones,
      streakPath,
      nowMs: 20_000,
      log: (m) => logs.push(m),
    });
    const inner = deps.syncBranchFn;
    deps.syncBranchFn = (repo, branch, base, opts) => {
      attempts++;
      return inner(repo, branch, base, opts);
    };
    const paced = await syncMilestoneBranches(deps);
    assertEquals(attempts, 0);
    assertEquals(paced.ok && paced.value.skipped, 1);
    assertEquals((await readLedger(streakPath))?.conflictAttempts, 1);
    assert(
      logs.some((l) => l.includes("skipped: conflict attempt not due until")),
      `no pacing line in: ${JSON.stringify(logs)}`,
    );

    // Cycle 3: the default tip has moved, so the conflict in front of the
    // branch is a different one and it is attempted at once.
    let movedAttempts = 0;
    const movedDeps = ledgerDeps([], {
      milestones,
      streakPath,
      defaultSha: MOVED_SHA,
      nowMs: 30_000,
    });
    const movedInner = movedDeps.syncBranchFn;
    movedDeps.syncBranchFn = (repo, branch, base, opts) => {
      movedAttempts++;
      return movedInner(repo, branch, base, opts);
    };
    await syncMilestoneBranches(movedDeps);
    assertEquals(movedAttempts, 1);
    assertEquals((await readLedger(streakPath))?.conflictAttempts, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - an attempt a kill left open reads as disrupted and is not charged (Issue #1778)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1778-disrupted-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    // A run killed mid-merge: the open marker is on disk, nothing concluded.
    await saveSyncStreaks(streakPath, {
      [`owner/repo|${LEDGER_BRANCH}`]: {
        count: 1,
        escalated: false,
        conflictAttempts: 1,
        attemptOpenedAt: new Date(5_000).toISOString(),
      },
    });

    const logs: string[] = [];
    await syncMilestoneBranches(ledgerDeps([], {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "success",
      }],
      streakPath,
      nowMs: 10_000,
      log: (m) => logs.push(m),
    }));

    // The successful sync zeroes the ledger, so the disrupted conclusion is
    // asserted where it is visible: the attempt was never charged, and the
    // conclusion said so out loud.
    const entry = await readLedger(streakPath);
    assertEquals(entry?.conflictAttempts, 0);
    assertEquals(entry?.attemptOpenedAt, undefined);
    assert(
      logs.some((l) => l.includes("recorded as disrupted and not charged")),
      `the open attempt was not concluded: ${JSON.stringify(logs)}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a killed attempt persists as disrupted and the cooldown still stands (Issue #1778)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1778-disrupt-rec-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    // Killed mid-merge inside a live cooldown, against the tip that set it.
    await saveSyncStreaks(streakPath, {
      [`owner/repo|${LEDGER_BRANCH}`]: {
        count: 1,
        escalated: false,
        conflictAttempts: 1,
        attemptOpenedAt: new Date(5_000).toISOString(),
        lastAttempt: {
          at: new Date(1_000).toISOString(),
          outcome: "failed",
          reason: "conflict unresolved at rung agent",
          defaultSha: LEDGER_SHA,
        },
        deferUntil: new Date(100_000).toISOString(),
      },
    });

    let attempts = 0;
    const deps = ledgerDeps([], {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "conflict",
      }],
      streakPath,
      nowMs: 10_000,
    });
    const inner = deps.syncBranchFn;
    deps.syncBranchFn = (repo, branch, base, opts) => {
      attempts++;
      return inner(repo, branch, base, opts);
    };
    await syncMilestoneBranches(deps);

    // The open marker is concluded first, then the still-live cooldown holds
    // the branch back — so the disrupted conclusion is what is on disk.
    assertEquals(attempts, 0, "the cooldown had not passed");
    const entry = await readLedger(streakPath);
    assertEquals(entry?.lastAttempt?.outcome, "disrupted");
    assertEquals(entry?.conflictAttempts, 1, "a kill charges nothing");
    assertEquals(entry?.attemptOpenedAt, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a disrupted attempt is concluded, not charged, when the next attempt also fails (Issue #1778)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1778-disrupt2-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    await saveSyncStreaks(streakPath, {
      [`owner/repo|${LEDGER_BRANCH}`]: {
        count: 1,
        escalated: false,
        attemptOpenedAt: new Date(5_000).toISOString(),
      },
    });

    await syncMilestoneBranches(ledgerDeps([], {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "ruleset",
      }],
      streakPath,
      nowMs: 10_000,
    }));

    const entry = await readLedger(streakPath);
    // The disrupted attempt charged nothing, and so did the ruleset refusal.
    assertEquals(entry?.conflictAttempts, 0);
    assertEquals(entry?.lastAttempt?.outcome, "not-charged");
    assertEquals(entry?.lastAttempt?.reason, "push rejected by ruleset");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - only one milestone gets the agent rung in a cycle (Issue #1778)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1778-agent-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const second = SECOND_BRANCH;
    const grants: Record<string, { allowed: boolean; seconds?: number }> = {};
    await syncMilestoneBranches(ledgerDeps([], {
      milestones: [
        { title: LEDGER_TITLE, branch: LEDGER_BRANCH, failure: "conflict" },
        { title: SECOND_TITLE, branch: second, failure: "conflict" },
      ],
      streakPath,
      nowMs: 10_000,
      grants,
    }));

    assertEquals(grants[LEDGER_BRANCH]?.allowed, true);
    assertEquals(grants[second]?.allowed, false);

    // The branch that was allowed the agent spends an attempt; the one that
    // ran rules-only is not answerable for a rung it never climbed.
    assertEquals((await readLedger(streakPath))?.conflictAttempts, 1);
    const deferred = await readLedger(streakPath, second);
    assertEquals(deferred?.conflictAttempts, 0);
    assertEquals(deferred?.lastAttempt?.outcome, "not-charged");
    assertEquals(deferred?.lastAttempt?.reason, "agent deferred: cycle budget");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - too little of the cycle left denies the agent to every branch (Issue #1778)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1778-deadline-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const grants: Record<string, { allowed: boolean; seconds?: number }> = {};
    await syncMilestoneBranches(ledgerDeps([], {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "conflict",
      }],
      streakPath,
      nowMs: 10_000,
      // A minute of handler budget cannot cover an agent run plus its
      // overhead, so the rung is refused before it is started (Issue #1693).
      deadlineEpochMs: 70_000,
      agentTimeoutMs: DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT,
      grants,
    }));

    assertEquals(grants[LEDGER_BRANCH]?.allowed, false);
    const entry = await readLedger(streakPath);
    assertEquals(entry?.conflictAttempts, 0);
    assertEquals(entry?.lastAttempt?.reason, "agent deferred: cycle budget");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - the third concluded failure hands off to the roll-back exactly once (Issue #1778)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1778-exhausted-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    await saveSyncStreaks(streakPath, {
      [`owner/repo|${LEDGER_BRANCH}`]: {
        count: 2,
        escalated: false,
        conflictAttempts: MILESTONE_CONFLICT_ATTEMPT_BUDGET - 1,
      },
    });

    const calls: string[][] = [];
    const rollbacks: string[] = [];
    await syncMilestoneBranches(ledgerDeps(calls, {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "conflict",
      }],
      streakPath,
      nowMs: 10_000,
      rollbacks,
    }));

    assertEquals(rollbacks, [
      `owner/repo|${LEDGER_BRANCH}|${MILESTONE_CONFLICT_ATTEMPT_BUDGET}`,
    ]);
    assertEquals(
      humanFacingCalls(calls).length,
      0,
      `posted: ${JSON.stringify(humanFacingCalls(calls))}`,
    );
    assertEquals(
      (await readLedger(streakPath))?.conflictAttempts,
      MILESTONE_CONFLICT_ATTEMPT_BUDGET,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a refused merge gate is not charged and keeps its escalation (Issue #1778)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1778-gate-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const calls: string[][] = [];
    await syncMilestoneBranches(ledgerDeps(calls, {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "gate",
      }],
      streakPath,
      nowMs: 10_000,
    }));

    const entry = await readLedger(streakPath);
    assertEquals(entry?.conflictAttempts, 0);
    assertEquals(entry?.lastAttempt?.outcome, "not-charged");
    assertEquals(entry?.gateEscalated, true);
    // Today's escalation stands for a gate refusal — it is not a conflict.
    assert(
      calls.some((c) => c[0] === "issue" && c[1] === "comment"),
      "the merge-gate escalation must still be posted",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The pure helpers the sync pass spends
// ---------------------------------------------------------------------------

Deno.test("grantAgentRun - an unbounded pass allows the rung and shrinks nothing (Issue #1778)", () => {
  assertEquals(grantAgentRun({ nowMs: 0 }), { agentAllowed: true });
  assertEquals(
    grantAgentRun({ nowMs: 0, agentTimeoutMs: 60_000 }),
    { agentAllowed: true },
  );
});

Deno.test("grantAgentRun - the drain's floor decides whether a rung starts (Issue #1778)", () => {
  const need = DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT +
    DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS;
  assertEquals(
    grantAgentRun({ nowMs: 0, deadlineEpochMs: need }).agentAllowed,
    true,
  );
  assertEquals(
    grantAgentRun({ nowMs: 0, deadlineEpochMs: need - 1 }).agentAllowed,
    false,
  );
  // The floor is the drain's, not the configured agent timeout: gating on a
  // 60-minute `claudeTimeout` would refuse the rung on nearly every cycle and
  // silently disable the ladder's last rung.
  assertEquals(
    grantAgentRun({
      nowMs: 0,
      deadlineEpochMs: need,
      agentTimeoutMs: 60 * 60 * 1000,
    }).agentAllowed,
    true,
  );
});

Deno.test("grantAgentRun - the grant never exceeds the budget that is left (Issue #1778)", () => {
  const overhead = DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS;
  // 30 minutes of agent budget left, a 60-minute configured timeout: the
  // agent is promised the 30 minutes it can actually have.
  assertEquals(
    grantAgentRun({
      nowMs: 0,
      deadlineEpochMs: 30 * 60 * 1000 + overhead,
      agentTimeoutMs: 60 * 60 * 1000,
    }),
    { agentAllowed: true, agentTimeoutSeconds: 30 * 60 },
  );
  // Plenty of budget: the configured timeout stands, un-inflated.
  assertEquals(
    grantAgentRun({
      nowMs: 0,
      deadlineEpochMs: 4 * 60 * 60 * 1000,
      agentTimeoutMs: 60 * 60 * 1000,
    }),
    { agentAllowed: true, agentTimeoutSeconds: 60 * 60 },
  );
});

Deno.test("conflictAttemptDue - an unreadable tip is never read as a moved one (Issue #1778)", () => {
  const entry: SyncStreakEntry = {
    count: 1,
    escalated: false,
    lastAttempt: {
      at: new Date(1_000).toISOString(),
      outcome: "failed",
      reason: "conflict unresolved at rung agent",
      defaultSha: LEDGER_SHA,
    },
    deferUntil: new Date(100_000).toISOString(),
  };
  // A tip git could not read must not hand the branch straight back.
  assertEquals(conflictAttemptDue(entry, undefined, 10_000), false);
  assertEquals(conflictAttemptDue(entry, LEDGER_SHA, 10_000), false);
  assertEquals(conflictAttemptDue(entry, MOVED_SHA, 10_000), true);
  assertEquals(conflictAttemptDue(entry, LEDGER_SHA, 200_000), true);
  assertEquals(conflictAttemptDue(undefined, LEDGER_SHA, 0), true);
});

Deno.test("failedConflictRung - names the rung the escalation reports (Issue #1778)", () => {
  assertEquals(
    failedConflictRung(["agent: it left 1 path(s) unmerged"]),
    "agent",
  );
  assertEquals(
    failedConflictRung([
      "both sides rewrote it — and no resolution agent was available to this sync (Issue #1777)",
    ]),
    "rules",
  );
  assertEquals(failedConflictRung(["rival designs"]), "triage");
});

Deno.test("judgeSyncFailure - only an unresolved conflict is charged (Issue #1778)", () => {
  const conflict = new MilestoneConflictEscalation(
    "undecided",
    [{
      path: "a.ts",
      reason: "agent: it left 1 path(s) unmerged",
      oursExports: [],
      theirsExports: [],
      oursTests: [],
      theirsTests: [],
      onlyOursTests: [],
      onlyTheirsTests: [],
    }],
    [],
    LEDGER_SHA,
  );
  assertEquals(judgeSyncFailure(conflict, true).outcome, "failed");
  assertEquals(judgeSyncFailure(conflict, true).rung, "agent");
  assertEquals(judgeSyncFailure(conflict, false).outcome, "not-charged");
  assertEquals(
    judgeSyncFailure(conflict, false).reason,
    "agent deferred: cycle budget",
  );

  const gated = new MilestoneConflictEscalation(
    "the resolution did not verify",
    [],
    [],
    LEDGER_SHA,
    "TS2304",
  );
  assertEquals(judgeSyncFailure(gated, true).outcome, "not-charged");

  assertEquals(
    judgeSyncFailure(
      mergeGateFailureError("milestone/x", "main", {
        status: "failed",
        detail: "no",
        output: "",
      }) as Error,
      true,
    ).outcome,
    "not-charged",
  );

  const ruleset = judgeSyncFailure(
    new Error("GH006: Protected branch update failed"),
    true,
  );
  assertEquals(ruleset.outcome, "not-charged");
  assertEquals(ruleset.reason, "push rejected by ruleset");

  const plain = judgeSyncFailure(
    new Error("refusing to merge unrelated histories"),
    true,
  );
  assertEquals(plain.outcome, "not-charged");
  assertStringIncludes(plain.reason, "unrelated histories");
});

Deno.test("syncMilestoneBranches - a resolution the gate refused is not charged and still reports both halves (Issue #1778)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1778-resgate-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const calls: string[][] = [];
    // Two cycles: the report goes out once, not every cycle.
    for (let cycle = 0; cycle < 2; cycle++) {
      await syncMilestoneBranches(ledgerDeps(calls, {
        milestones: [{
          title: LEDGER_TITLE,
          branch: LEDGER_BRANCH,
          failure: "resolution-gate",
        }],
        streakPath,
        nowMs: 10_000 + cycle * 1_000,
      }));
    }

    const entry = await readLedger(streakPath);
    // A gate refusal is not a conflict the budget can retry its way out of.
    assertEquals(entry?.conflictAttempts, 0);
    assertEquals(entry?.lastAttempt?.outcome, "not-charged");
    // Its own dedup key — sharing `gateEscalated` would let the Issue #974
    // refusal of the merged tree suppress this report, and the reverse.
    assertEquals(entry?.analysisEscalatedSha, LEDGER_SHA);
    assertEquals(entry?.gateEscalated, false);

    const comments = calls.filter((c) =>
      c[0] === "issue" && c[1] === "comment"
    );
    assertEquals(comments.length, 1, "reported once, not every cycle");
    const body = comments[0]![comments[0]!.length - 1] ?? "";
    // Both halves: what the gate said, and the two sides that produced it.
    assertStringIncludes(body, "TS2304");
    assertStringIncludes(body, "worker/deno/lib/scan_content.ts");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - the default roll-back says the hand-off is not wired and posts nothing (Issue #1778)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1778-default-rb-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    await saveSyncStreaks(streakPath, {
      [`owner/repo|${LEDGER_BRANCH}`]: {
        count: 2,
        escalated: false,
        conflictAttempts: MILESTONE_CONFLICT_ATTEMPT_BUDGET - 1,
      },
    });

    const calls: string[][] = [];
    const logs: string[] = [];
    // No `rollbackFn` injected: this is the production default today.
    await syncMilestoneBranches(ledgerDeps(calls, {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "conflict",
      }],
      streakPath,
      nowMs: 10_000,
      log: (m) => logs.push(m),
    }));

    assert(
      logs.some((l) =>
        l.includes("budget exhausted: roll-back not yet available")
      ),
      `no hand-off line in: ${JSON.stringify(logs)}`,
    );
    assertEquals(
      humanFacingCalls(calls).length,
      0,
      `posted: ${JSON.stringify(humanFacingCalls(calls))}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a ledger that cannot be persisted is said out loud (Issue #1778)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1778-persist-" });
  try {
    // A directory where the ledger file must go: every write fails.
    const streakPath = milestoneSyncStreakPath(dir);
    await Deno.mkdir(streakPath);

    const logs: string[] = [];
    const result = await syncMilestoneBranches(ledgerDeps([], {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "conflict",
      }],
      streakPath,
      nowMs: 10_000,
      log: (m) => logs.push(m),
    }));

    // The sweep still finishes — one repo's other milestones are not lost
    // over a write — and the failure is reported rather than swallowed.
    assertEquals(result.ok, true);
    assert(
      logs.some((l) =>
        l.includes("Could not persist the milestone sync ledger")
      ),
      `the write failure was swallowed: ${JSON.stringify(logs)}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a branch past its budget is not merged again (Issue #1778)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1778-spent-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    await saveSyncStreaks(streakPath, {
      [`owner/repo|${LEDGER_BRANCH}`]: {
        count: 3,
        escalated: false,
        conflictAttempts: MILESTONE_CONFLICT_ATTEMPT_BUDGET,
      },
    });

    const rollbacks: string[] = [];
    const logs: string[] = [];
    let attempts = 0;
    const deps = ledgerDeps([], {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "conflict",
      }],
      streakPath,
      nowMs: 10_000,
      rollbacks,
      log: (m) => logs.push(m),
    });
    const inner = deps.syncBranchFn;
    deps.syncBranchFn = (repo, branch, base, opts) => {
      attempts++;
      return inner(repo, branch, base, opts);
    };
    const result = await syncMilestoneBranches(deps);

    // No merge, no fourth charge, and no second hand-off: the branch belongs
    // to the roll-back now.
    assertEquals(attempts, 0);
    assertEquals(rollbacks, []);
    assertEquals(result.ok && result.value.skipped, 1);
    assertEquals(
      (await readLedger(streakPath))?.conflictAttempts,
      MILESTONE_CONFLICT_ATTEMPT_BUDGET,
    );
    assert(
      logs.some((l) => l.includes("the conflict budget is spent")),
      `no spent-budget line in: ${JSON.stringify(logs)}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a merge that fails after the agent ran keeps the grant spent (Issue #1778)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1778-leak-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const grants: Record<string, { allowed: boolean; seconds?: number }> = {};
    // The first branch fails with a plain error — the shape `git_pull.ts`
    // returns when the resolution was made and the commit or the guards then
    // refused it, i.e. after the agent has already run.
    await syncMilestoneBranches(ledgerDeps([], {
      milestones: [
        { title: LEDGER_TITLE, branch: LEDGER_BRANCH, failure: "plain" },
        { title: SECOND_TITLE, branch: SECOND_BRANCH, failure: "conflict" },
      ],
      streakPath,
      nowMs: 10_000,
      grants,
    }));

    assertEquals(grants[LEDGER_BRANCH]?.allowed, true);
    assertEquals(
      grants[SECOND_BRANCH]?.allowed,
      false,
      "a second agent run in one cycle is the bound this exists to hold",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a clean merge refunds the grant to the next branch (Issue #1778)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1778-refund-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const grants: Record<string, { allowed: boolean; seconds?: number }> = {};
    await syncMilestoneBranches(ledgerDeps([], {
      milestones: [
        { title: LEDGER_TITLE, branch: LEDGER_BRANCH, failure: "success" },
        { title: SECOND_TITLE, branch: SECOND_BRANCH, failure: "conflict" },
      ],
      streakPath,
      nowMs: 10_000,
      grants,
    }));

    // Nothing collided on the first branch, so no rung was climbed and the
    // conflicting branch still gets the cycle's agent.
    assertEquals(grants[LEDGER_BRANCH]?.allowed, true);
    assertEquals(grants[SECOND_BRANCH]?.allowed, true);
    assertEquals(
      await readLedger(streakPath, SECOND_BRANCH).then((e) =>
        e?.conflictAttempts
      ),
      1,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
