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
  orderMilestonesByBehind,
  shouldSyncMilestone,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import type { AgentAttemptAnnouncement } from "../lib/milestone_sync_announcement.ts";
import type { RollbackOutcome } from "../lib/milestone_rollback.ts";
import { createMilestoneBranchName } from "../lib/git_branch.ts";
import { conflictEscalationKey } from "../lib/milestone_conflict_dedup.ts";
import { MilestoneConflictEscalation } from "../lib/milestone_conflict_triage.ts";
import { AGENT_RUN_ENDED_BY_WORKER } from "../lib/milestone_conflict_ladder.ts";
import { mergeGateFailureError } from "../lib/milestone_merge_gate.ts";
import { stuckSyncDiagnosticTitle } from "../lib/milestone_sync_diagnostic_closeout.ts";
import { GATE_WEDGE_DIAGNOSTIC_REPO } from "../lib/milestone_gate_wedge.ts";
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

// Issue #2607: the default branch resolves, so only the milestones call
// fails — that failure must surface, not become an empty success.
const mainBranch = () => Promise.resolve({ ok: true as const, value: "main" });

Deno.test("findActiveMilestoneBranches - a failing milestones call is ok:false (Issue #2607)", async () => {
  const ghFn = (_args: string[]): Promise<string> =>
    Promise.reject(new Error("HTTP 502: Bad Gateway"));

  const result = await findActiveMilestoneBranches(
    "owner/repo",
    ghFn,
    mainBranch,
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(
      result.error.message,
      "Could not list milestones for owner/repo",
    );
    assertStringIncludes(result.error.message, "HTTP 502: Bad Gateway");
  }
});

Deno.test("findActiveMilestoneBranches - unparseable milestones output is ok:false (Issue #2607)", async () => {
  const ghFn = (_args: string[]): Promise<string> =>
    Promise.resolve("<html>rate limited</html>");

  const result = await findActiveMilestoneBranches(
    "owner/repo",
    ghFn,
    mainBranch,
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(
      result.error.message,
      "Could not list milestones for owner/repo",
    );
  }
});

Deno.test("findActiveMilestoneBranches - a malformed milestones response is ok:false naming the field (Issue #2607)", async () => {
  const ghFn = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify([{ title: "M1" }]));

  const result = await findActiveMilestoneBranches(
    "owner/repo",
    ghFn,
    mainBranch,
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(
      result.error.message,
      "Malformed milestones response for owner/repo",
    );
    assertStringIncludes(result.error.message, "milestones[0].number");
  }
});

Deno.test("findActiveMilestoneBranches - a non-array milestones response is ok:false (Issue #2607)", async () => {
  const ghFn = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify({ message: "Not Found" }));

  const result = await findActiveMilestoneBranches(
    "owner/repo",
    ghFn,
    mainBranch,
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(
      result.error.message,
      "Malformed milestones response for owner/repo",
    );
    assertStringIncludes(result.error.message, "Expected array");
  }
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

Deno.test("shouldSyncMilestone - a moved milestone tip syncs even when the default tip is unchanged (Issue #2285)", () => {
  // PR #2284: a child landed on the milestone four seconds after the sync PR
  // was raised, and main did not move — the conflicting sync PR sat.
  const entry = {
    count: 0,
    escalated: false,
    lastSyncedDefaultSha: "sha-a",
    lastSyncedMilestoneSha: "ms-1",
  };
  assertEquals(shouldSyncMilestone(entry, "sha-a", "ms-1"), false);
  assertEquals(shouldSyncMilestone(entry, "sha-a", "ms-2"), true);
  assertEquals(shouldSyncMilestone(entry, "sha-b", "ms-1"), true);
});

Deno.test("shouldSyncMilestone - an unknown milestone tip, on either side, leaves the default-tip rule in charge (Issue #2285)", () => {
  // A ledger written before the milestone tip was recorded, or a caller that
  // read none: the rule is exactly the Issue #1776 one until a success
  // records the tip.
  const entry = { count: 0, escalated: false, lastSyncedDefaultSha: "sha-a" };
  assertEquals(shouldSyncMilestone(entry, "sha-a", undefined), false);
  assertEquals(shouldSyncMilestone(entry, "sha-a", "ms-1"), false);
  assertEquals(shouldSyncMilestone(entry, "sha-b", "ms-1"), true);
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

Deno.test("syncMilestoneBranches - a closed parent planning issue is commented on once and never reopened or labelled (Issues #1769, #2226)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2226-no-reopen-" });
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

    // Merge conflicts are the worker's to handle: no sync outcome asks a
    // person, so the closed planning issue stays closed and unlabelled.
    assertEquals(
      calls.filter((c) => c[0] === "issue" && c[1] === "reopen"),
      [],
      "never reopened",
    );
    assertEquals(
      calls.filter((c) => c.includes("--add-label")),
      [],
      "never labelled",
    );

    const comments = calls.filter((c) =>
      c[0] === "issue" && c[1] === "comment"
    );
    assertEquals(comments.length, 1, "a second cycle posts nothing");
    assertEquals(comments[0]![2], "1730");
    assert(
      !comments[0]!.join(" ").includes("Reopened by the milestone"),
      "no reopen preamble",
    );
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
/** The `merge-fallback` flag the stubbed `gh issue create` reports (#2311). */
const FLAG_ISSUE = 4242;

/** How the injected sync ends, for the ledger tests. */
type LedgerFailure =
  | "conflict"
  /** The agent ran out its own ceiling — a judged attempt (Issue #2305). */
  | "agent-timeout"
  /** The worker killed the run at the cycle deadline (Issues #1693, #2305). */
  | "agent-killed"
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
  /**
   * Commits this branch is behind the default branch (Issue #2309). Present
   * makes the pass measure and order by it.
   */
  behindBy?: number;
  /**
   * The scripted sync climbs the agent rung when it is offered one
   * (Issue #2309), so the announcement fires exactly as production's binding
   * fires it.
   */
  entersAgent?: boolean;
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
    case "agent-timeout":
      return {
        ok: false,
        error: new MilestoneConflictEscalation(
          "every rung left it undecided",
          [{ ...analysis, reason: "agent: agent timed out after 1800s" }],
          [],
          LEDGER_SHA,
        ),
      };
    case "agent-killed":
      return {
        ok: false,
        error: new MilestoneConflictEscalation(
          "every rung left it undecided",
          [{
            ...analysis,
            reason: `agent: ${AGENT_RUN_ENDED_BY_WORKER} (Issue #1693)`,
          }],
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
  /**
   * Milliseconds the clock moves on each sync (Issue #2309), so the per-branch
   * budget floor reads a cycle that is genuinely being spent.
   */
  advanceMsPerSync?: number;
  rollbacks?: string[];
  log?: (message: string) => void;
  /** Records the grant each milestone's sync was given. */
  grants?: Record<string, { allowed: boolean; seconds?: number }>;
  /** Milestone branches in the order the pass synced them (Issue #2309). */
  order?: string[];
  /** Announcements the pass posted (Issue #2309). */
  announcements?: AgentAttemptAnnouncement[];
  /** When set, the injected roll-back returns this outcome (Issue #1781). */
  rollbackOutcome?: RollbackOutcome;
}

/** Sync deps that charge the ledger, recording every gh argv. */
function ledgerDeps(
  calls: string[][],
  options: LedgerOptions,
): MilestoneBranchSyncDeps {
  /** The pass's clock; moved by each sync when the test asks for it. */
  let clock = options.nowMs ?? 0;
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
      if (key.startsWith("issue view") && key.includes("--json")) {
        return Promise.resolve(
          JSON.stringify({ state: "CLOSED", labels: [{ name: "idle-task" }] }),
        );
      }
      if (key.startsWith("issue view")) return Promise.resolve("OPEN");
      // The `merge-fallback` flag filer reads the new issue's number out of
      // `gh issue create`'s URL (Issues #2304, #2311).
      if (key.startsWith("issue create")) {
        return Promise.resolve(
          `https://github.com/owner/repo/issues/${FLAG_ISSUE}\n`,
        );
      }
      return Promise.resolve("[]");
    },
    syncBranchFn: async (
      _repo,
      milestoneBranch,
      _defaultBranch,
      syncOptions,
    ) => {
      if (options.grants) {
        options.grants[milestoneBranch] = {
          allowed: syncOptions?.agentAllowed ?? true,
          ...(syncOptions?.agentTimeoutSeconds !== undefined
            ? { seconds: syncOptions.agentTimeoutSeconds }
            : {}),
        };
      }
      options.order?.push(milestoneBranch);
      clock += options.advanceMsPerSync ?? 0;
      const milestone = options.milestones.find((m) =>
        m.branch === milestoneBranch
      )!;
      // The rung's own binding announces when it is entered (Issue #2309);
      // this stub stands in for it.
      if (milestone.entersAgent && syncOptions?.agentAllowed) {
        await syncOptions.onAgentRungEntered?.();
      }
      return ledgerOutcome(milestone.failure, milestoneBranch);
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
    deps.now = () => clock;
  }
  if (options.milestones.some((m) => m.behindBy !== undefined)) {
    deps.behindCountFn = (_repo, milestoneBranch) => {
      const behindBy = options.milestones.find((m) =>
        m.branch === milestoneBranch
      )?.behindBy;
      return Promise.resolve(
        behindBy === undefined
          ? { ok: false as const, error: new Error("no remote-tracking ref") }
          : { ok: true as const, value: behindBy },
      );
    };
  }
  if (options.announcements) {
    const posted = options.announcements;
    deps.hostFn = () => "worker-7";
    deps.announceAgentAttemptFn = (announcement) => {
      posted.push(announcement);
      return Promise.resolve(true);
    };
  }
  if (options.rollbacks || options.rollbackOutcome) {
    const seen = options.rollbacks;
    const outcome = options.rollbackOutcome;
    deps.rollbackFn = (request) => {
      seen?.push(
        `${request.repo}|${request.milestoneBranch}|${request.attempts}`,
      );
      return Promise.resolve(outcome);
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
    // A branch with its whole budget still in hand.
    await saveSyncStreaks(streakPath, {
      [`owner/repo|${LEDGER_BRANCH}`]: { count: 1, escalated: false },
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
    assertEquals(entry?.conflictAttempts, 1);
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
          `conflict attempt 1 of ${MILESTONE_CONFLICT_ATTEMPT_BUDGET} failed at rung agent`,
        )
      ),
      `no per-attempt line in: ${JSON.stringify(logs)}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - the same tip is tried again on the very next cycle (Issue #2305)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2305-no-cooldown-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const milestones: LedgerMilestone[] = [{
      title: LEDGER_TITLE,
      branch: LEDGER_BRANCH,
      failure: "conflict",
    }];

    // Cycle 1: the first conflict failure charges one of the two attempts.
    await syncMilestoneBranches(ledgerDeps([], {
      milestones,
      streakPath,
      nowMs: 10_000,
    }));
    assertEquals((await readLedger(streakPath))?.conflictAttempts, 1);

    // Cycle 2, ten seconds later, same tip: the old ledger paced this for
    // four hours. The second attempt runs now, and spends the budget.
    let attempts = 0;
    const rollbacks: string[] = [];
    const deps = ledgerDeps([], {
      milestones,
      streakPath,
      nowMs: 20_000,
      rollbacks,
    });
    const inner = deps.syncBranchFn;
    deps.syncBranchFn = (repo, branch, base, opts) => {
      attempts++;
      return inner(repo, branch, base, opts);
    };
    await syncMilestoneBranches(deps);
    assertEquals(attempts, 1, "no wait between the two attempts");
    assertEquals(
      (await readLedger(streakPath))?.conflictAttempts,
      MILESTONE_CONFLICT_ATTEMPT_BUDGET,
    );
    assertEquals(rollbacks, [
      `owner/repo|${LEDGER_BRANCH}|${MILESTONE_CONFLICT_ATTEMPT_BUDGET}`,
    ]);

    // Cycle 3: the budget is spent, so the branch belongs to the roll-back
    // and no third merge is attempted however far the tip has moved.
    let thirdAttempts = 0;
    const spentDeps = ledgerDeps([], {
      milestones,
      streakPath,
      defaultSha: MOVED_SHA,
      nowMs: 30_000,
    });
    const spentInner = spentDeps.syncBranchFn;
    spentDeps.syncBranchFn = (repo, branch, base, opts) => {
      thirdAttempts++;
      return spentInner(repo, branch, base, opts);
    };
    const spent = await syncMilestoneBranches(spentDeps);
    assertEquals(thirdAttempts, 0, "two runs per conflict, and no more");
    assertEquals(spent.ok && spent.value.skipped, 1);
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

Deno.test("syncMilestoneBranches - a killed attempt is concluded disrupted and the branch retried at once (Issue #2305)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2305-disrupt-rec-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    // Killed mid-merge against the tip the last failure saw. The old ledger
    // held this branch for the rest of its four-hour deferral.
    await saveSyncStreaks(streakPath, {
      [`owner/repo|${LEDGER_BRANCH}`]: {
        count: 1,
        escalated: false,
        attemptOpenedAt: new Date(5_000).toISOString(),
        lastAttempt: {
          at: new Date(1_000).toISOString(),
          outcome: "failed",
          reason: "conflict unresolved at rung agent",
          defaultSha: LEDGER_SHA,
        },
      },
    });

    let attempts = 0;
    const logs: string[] = [];
    const deps = ledgerDeps([], {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "conflict",
      }],
      streakPath,
      nowMs: 10_000,
      log: (m) => logs.push(m),
    });
    const inner = deps.syncBranchFn;
    deps.syncBranchFn = (repo, branch, base, opts) => {
      attempts++;
      return inner(repo, branch, base, opts);
    };
    await syncMilestoneBranches(deps);

    assert(
      logs.some((l) => l.includes("recorded as disrupted and not charged")),
      `the open marker was not concluded: ${JSON.stringify(logs)}`,
    );
    assertEquals(attempts, 1, "and the branch is handed straight back");
    const entry = await readLedger(streakPath);
    assertEquals(entry?.conflictAttempts, 1, "the kill itself charged nothing");
    assertEquals(entry?.lastAttempt?.outcome, "failed");
    assertEquals(entry?.attemptOpenedAt, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - an agent timeout is charged, a deadline kill is not (Issue #2305)", async () => {
  const charged = await Deno.makeTempDir({ prefix: "issue-2305-timeout-" });
  const uncharged = await Deno.makeTempDir({ prefix: "issue-2305-killed-" });
  try {
    // The agent ran out its own 30-minute ceiling: the rung was climbed and
    // the conflict beat it, so the attempt is a judged failure.
    const timeoutPath = milestoneSyncStreakPath(charged);
    await syncMilestoneBranches(ledgerDeps([], {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "agent-timeout",
      }],
      streakPath: timeoutPath,
      nowMs: 10_000,
    }));
    const timedOut = await readLedger(timeoutPath);
    assertEquals(timedOut?.conflictAttempts, 1, "a timed-out run is charged");
    assertEquals(timedOut?.lastAttempt?.outcome, "failed");

    // The worker killed the run at the cycle deadline: nothing about the
    // conflict was decided, so the branch keeps its budget.
    const killedPath = milestoneSyncStreakPath(uncharged);
    await syncMilestoneBranches(ledgerDeps([], {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "agent-killed",
      }],
      streakPath: killedPath,
      nowMs: 10_000,
    }));
    const killed = await readLedger(killedPath);
    assertEquals(killed?.conflictAttempts, 0, "a deadline kill is free");
    assertEquals(killed?.lastAttempt?.outcome, "disrupted");
  } finally {
    await Deno.remove(charged, { recursive: true });
    await Deno.remove(uncharged, { recursive: true });
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

// Issue #2309 replaced this test's subject. It used to assert the per-cycle
// latch — "only one milestone gets the agent rung in a cycle" — which is the
// behaviour the issue removes: the second conflicting branch was refused by a
// latch while the cycle still held budget for it. The bound that remains is
// the budget floor, asserted by the pair below.
Deno.test("syncMilestoneBranches - every conflicting branch gets the agent rung while the budget covers one (Issue #2309)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2309-agent-" });
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
    assertEquals(
      grants[second]?.allowed,
      true,
      "the second behind branch is refused by the floor, never by a latch",
    );

    // Both climbed the rung they were offered, so both are answerable for it.
    assertEquals((await readLedger(streakPath))?.conflictAttempts, 1);
    assertEquals(
      (await readLedger(streakPath, second))?.conflictAttempts,
      1,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a deadline covering two runs grants both, and only the conflicting one logs the deferral (Issue #2309)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2309-two-runs-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const grants: Record<string, { allowed: boolean; seconds?: number }> = {};
    const lines: string[] = [];
    // A bounded cycle wide enough for two whole runs — the case the issue
    // names, which an unbounded pass cannot exercise.
    const agentRunMs = DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT;
    const start = 10_000;
    await syncMilestoneBranches(ledgerDeps([], {
      milestones: [
        { title: LEDGER_TITLE, branch: LEDGER_BRANCH, failure: "conflict" },
        { title: SECOND_TITLE, branch: SECOND_BRANCH, failure: "conflict" },
      ],
      streakPath,
      nowMs: start,
      advanceMsPerSync: agentRunMs,
      deadlineEpochMs: start +
        2 * (agentRunMs + DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS),
      agentTimeoutMs: agentRunMs,
      grants,
      log: (message) => lines.push(message),
    }));

    assertEquals(grants[LEDGER_BRANCH]?.allowed, true);
    assertEquals(
      grants[SECOND_BRANCH]?.allowed,
      true,
      "a deadline that covers two runs grants two",
    );
    // Both climbed a rung they were offered, so neither was deferred.
    assertEquals(
      lines.filter((line) => line.includes("agent deferred: cycle budget")),
      [],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a clean merge late in the cycle is not reported as a deferred agent (Issue #2309)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2309-clean-late-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const grants: Record<string, { allowed: boolean; seconds?: number }> = {};
    const lines: string[] = [];
    const agentRunMs = DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT;
    const start = 10_000;
    await syncMilestoneBranches(ledgerDeps([], {
      milestones: [
        // The first branch conflicts and spends the cycle's one run; the
        // second merges cleanly with no rung left — and asked for none.
        { title: LEDGER_TITLE, branch: LEDGER_BRANCH, failure: "conflict" },
        { title: SECOND_TITLE, branch: SECOND_BRANCH, failure: "success" },
      ],
      streakPath,
      nowMs: start,
      advanceMsPerSync: agentRunMs,
      deadlineEpochMs: start + agentRunMs +
        DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS,
      agentTimeoutMs: agentRunMs,
      grants,
      log: (message) => lines.push(message),
    }));

    assertEquals(grants[SECOND_BRANCH]?.allowed, false);
    // Nothing collided, so there was nothing to defer: reporting one would
    // send a reader looking for a conflict that never happened.
    assertEquals(
      lines.filter((line) => line.includes("agent deferred: cycle budget")),
      [],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - the second branch is refused only once the deadline no longer covers a run (Issue #2309)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2309-floor-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const grants: Record<string, { allowed: boolean; seconds?: number }> = {};
    const lines: string[] = [];
    // The cycle holds one agent run plus its overhead, and the first branch
    // spends it: a moving clock is what the floor reads, not a latch.
    const agentRunMs = DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT;
    const start = 10_000;
    const deadlineEpochMs = start + agentRunMs +
      DEFAULT_CONFLICT_ATTEMPT_OVERHEAD_MS;
    await syncMilestoneBranches(ledgerDeps([], {
      milestones: [
        { title: LEDGER_TITLE, branch: LEDGER_BRANCH, failure: "conflict" },
        { title: SECOND_TITLE, branch: SECOND_BRANCH, failure: "conflict" },
      ],
      streakPath,
      nowMs: start,
      // The first branch spends the run the cycle could cover.
      advanceMsPerSync: agentRunMs,
      deadlineEpochMs,
      agentTimeoutMs: agentRunMs,
      grants,
      log: (message) => lines.push(message),
    }));

    assertEquals(grants[LEDGER_BRANCH]?.allowed, true);
    assertEquals(grants[SECOND_BRANCH]?.allowed, false);
    // The refused branch conflicted, so the refusal is said out loud once.
    const deferrals = lines.filter((line) =>
      line.includes("agent deferred: cycle budget")
    );
    assertEquals(deferrals.length, 1);
    assertStringIncludes(deferrals[0]!, SECOND_BRANCH);
    const deferred = await readLedger(streakPath, SECOND_BRANCH);
    assertEquals(deferred?.conflictAttempts, 0);
    assertEquals(deferred?.lastAttempt?.outcome, "not-charged");
    assertEquals(deferred?.lastAttempt?.reason, "agent deferred: cycle budget");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a repository's branches are synced longest behind first (Issue #2309)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2309-order-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const order: string[] = [];
    await syncMilestoneBranches(ledgerDeps([], {
      milestones: [
        // Listed least-behind first, so only the measurement can order them.
        {
          title: LEDGER_TITLE,
          branch: LEDGER_BRANCH,
          failure: "success",
          behindBy: 1,
        },
        {
          title: SECOND_TITLE,
          branch: SECOND_BRANCH,
          failure: "success",
          behindBy: 5,
        },
      ],
      streakPath,
      nowMs: 10_000,
      order,
    }));

    assertEquals(order, [SECOND_BRANCH, LEDGER_BRANCH]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a branch already at the default tip is not measured (Issue #2309)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2309-cheap-path-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    // The ledger already records this branch against the current tip, so it
    // takes the cadence guard's cheap path — its order cannot matter.
    await Deno.writeTextFile(
      streakPath,
      JSON.stringify({
        [`owner/repo|${LEDGER_BRANCH}`]: {
          count: 0,
          escalated: false,
          lastSyncedDefaultSha: LEDGER_SHA,
        },
      }),
    );
    const measured: string[] = [];
    const deps = ledgerDeps([], {
      milestones: [
        {
          title: LEDGER_TITLE,
          branch: LEDGER_BRANCH,
          failure: "success",
          behindBy: 0,
        },
        {
          title: SECOND_TITLE,
          branch: SECOND_BRANCH,
          failure: "success",
          behindBy: 5,
        },
      ],
      streakPath,
      nowMs: 10_000,
    });
    const measure = deps.behindCountFn!;
    deps.behindCountFn = (repo, milestoneBranch, defaultBranch) => {
      measured.push(milestoneBranch);
      return measure(repo, milestoneBranch, defaultBranch);
    };

    await syncMilestoneBranches(deps);

    // An idle branch must not cost a fetch every cycle to order a pass that
    // is about to skip it.
    assertEquals(measured, [SECOND_BRANCH]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a measurement that fails or throws still syncs both branches (Issue #2309)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2309-unmeasured-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const order: string[] = [];
    const lines: string[] = [];
    const deps = ledgerDeps([], {
      milestones: [
        // Both measurable on paper, so the harness wires a measurement in;
        // the override below is what actually answers.
        {
          title: LEDGER_TITLE,
          branch: LEDGER_BRANCH,
          failure: "success",
          behindBy: 1,
        },
        {
          title: SECOND_TITLE,
          branch: SECOND_BRANCH,
          failure: "success",
          behindBy: 5,
        },
      ],
      streakPath,
      nowMs: 10_000,
      order,
      log: (message) => lines.push(message),
    });
    // One branch's count comes back as a failed Result, the other's throws —
    // the two ways a production measurement can refuse to answer.
    deps.behindCountFn = (_repo, milestoneBranch) => {
      if (milestoneBranch === LEDGER_BRANCH) {
        return Promise.resolve({
          ok: false as const,
          error: new Error("no remote-tracking ref"),
        });
      }
      throw new Error("unsafe ref refused");
    };

    await syncMilestoneBranches(deps);

    // Ordering must never be the reason a branch is not synced.
    assertEquals(order.length, 2);
    assertEquals(order.includes(LEDGER_BRANCH), true);
    assertEquals(order.includes(SECOND_BRANCH), true);
    const warnings = lines.filter((line) =>
      line.startsWith("WARNING: Could not measure how far")
    );
    assertEquals(warnings.length, 2);
    assertEquals(
      warnings.some((line) => line.includes("no remote-tracking ref")),
      true,
    );
    assertEquals(
      warnings.some((line) => line.includes("unsafe ref refused")),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("orderMilestonesByBehind - sorts by behind count and keeps the listing order otherwise (Issue #2309)", () => {
  const milestone = (branch: string) => ({
    milestoneTitle: branch,
    milestoneNumber: 1,
    milestoneBranch: branch,
    defaultBranch: "main",
  });
  const ordered = orderMilestonesByBehind([
    { milestone: milestone("a"), behindBy: 1 },
    { milestone: milestone("b"), behindBy: 5 },
    // Unmeasurable sorts as level — usually a branch the pass skips anyway.
    { milestone: milestone("c") },
    { milestone: milestone("d"), behindBy: 0 },
    { milestone: milestone("e"), behindBy: 5 },
  ]);
  assertEquals(ordered.map((m) => m.milestoneBranch), [
    "b",
    "e",
    "a",
    "c",
    "d",
  ]);
});

Deno.test("syncMilestoneBranches - an entered agent rung is announced once, naming host and start time (Issue #2309)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2309-announce-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const announcements: AgentAttemptAnnouncement[] = [];
    const logs: string[] = [];
    await syncMilestoneBranches(ledgerDeps([], {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "conflict",
        entersAgent: true,
      }],
      streakPath,
      nowMs: 10_000,
      announcements,
      log: (message) => logs.push(message),
    }));

    assertEquals(announcements.length, 1);
    assertEquals(announcements[0]?.host, "worker-7");
    assertEquals(announcements[0]?.milestoneBranch, LEDGER_BRANCH);
    assertEquals(
      announcements[0]?.startedAt,
      new Date(10_000).toISOString(),
      "the ledger's attemptOpenedAt is what the announcement names",
    );
    assert(
      logs.some((l) =>
        l.includes("agent rung running") && l.includes("worker-7")
      ),
      "the running attempt is logged as well as posted",
    );

    // The same opened attempt is never announced twice — the ledger records
    // which one was announced, so a later cycle reading it posts nothing.
    const announced = await readLedger(streakPath);
    assertEquals(announced?.announcedAttemptAt, new Date(10_000).toISOString());
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a merge the rules settle announces nothing (Issue #2309)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2309-quiet-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const announcements: AgentAttemptAnnouncement[] = [];
    await syncMilestoneBranches(ledgerDeps([], {
      milestones: [
        // Offered the rung, never enters it: the rules settled the merge.
        { title: LEDGER_TITLE, branch: LEDGER_BRANCH, failure: "success" },
      ],
      streakPath,
      nowMs: 10_000,
      announcements,
    }));

    assertEquals(announcements, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - an attempt already announced is not announced again (Issue #2309)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2309-once-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const openedAt = new Date(10_000).toISOString();
    // The ledger carries an attempt this host opened and announced, which a
    // kill left open; the next cycle re-enters the rung for it.
    await saveSyncStreaks(streakPath, {
      [`owner/repo|${LEDGER_BRANCH}`]: {
        count: 0,
        escalated: false,
        attemptOpenedAt: openedAt,
        announcedAttemptAt: openedAt,
      },
    });
    const announcements: AgentAttemptAnnouncement[] = [];
    await syncMilestoneBranches(ledgerDeps([], {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "conflict",
        entersAgent: true,
      }],
      streakPath,
      // The open attempt concludes `disrupted` and a new one opens at this
      // very instant, so the announcement key is unchanged.
      nowMs: 10_000,
      announcements,
    }));

    assertEquals(announcements, []);
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
      // Four minutes of handler budget start a rules-only sync (Issue #2215
      // stops a pass under three) but cannot cover an agent run plus its
      // overhead, so the rung is refused before it is started (Issue #1693).
      deadlineEpochMs: 250_000,
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

Deno.test("syncMilestoneBranches - the last concluded failure hands off to the roll-back exactly once (Issue #1778)", async () => {
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
  // Twenty-four minutes: twenty for the agent, four for everything the
  // resolution does around it. Cutting the budget to two runs (Issue #2305)
  // did not move it.
  assertEquals(need, 24 * 60 * 1000);
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

Deno.test("conflictAttemptDue - only an open attempt holds the branch back (Issue #2305)", () => {
  const concluded: SyncStreakEntry = {
    count: 1,
    escalated: false,
    conflictAttempts: 1,
    lastAttempt: {
      at: new Date(1_000).toISOString(),
      outcome: "failed",
      reason: "conflict unresolved at rung agent",
      defaultSha: LEDGER_SHA,
    },
  };
  // A failure a second old is due again: there is no wait left to serve.
  assertEquals(conflictAttemptDue(concluded), true);
  assertEquals(
    conflictAttemptDue({
      ...concluded,
      attemptOpenedAt: new Date(2_000).toISOString(),
    }),
    false,
  );
  assertEquals(conflictAttemptDue(undefined), true);
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

Deno.test("judgeSyncFailure - an agent timeout is charged, a worker kill is disrupted (Issue #2305)", () => {
  const escalation = (reason: string) =>
    new MilestoneConflictEscalation(
      "undecided",
      [{
        path: "a.ts",
        reason,
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

  // Its own ceiling: the rung was climbed and the conflict beat it.
  const timedOut = judgeSyncFailure(
    escalation("agent: agent timed out after 1800s"),
    true,
  );
  assertEquals(timedOut.outcome, "failed");
  assertEquals(timedOut.rung, "agent");

  // The handler deadline: nothing was judged, so nothing is charged.
  const killed = judgeSyncFailure(
    escalation(`agent: ${AGENT_RUN_ENDED_BY_WORKER} (Issue #1693)`),
    true,
  );
  assertEquals(killed.outcome, "disrupted");
  assertStringIncludes(killed.reason, "ended by the worker");
});

Deno.test("syncMilestoneBranches - a resolution the gate refused is not charged and, once it repeats, is reported as a worker diagnostic (Issues #1778, #2388)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1778-resgate-" });
  try {
    const streakPath = milestoneSyncStreakPath(dir);
    const calls: string[][] = [];
    // Two cycles. Issue #2388 changed what they produce: the first refusal is
    // only a verdict and reports nothing, the second is the same verdict on
    // the same conflict from the same default tip — a wedge — and that is
    // what is reported, once, as a worker diagnostic in VibeCoder rather than
    // as a needs-human comment on a sibling issue of the milestone.
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
    // The wedge is keyed on the conflict itself (Issue #1786), so a default
    // tip that moves every few minutes is not a new refusal.
    assertEquals(
      entry?.gateRefusal?.conflictKey,
      conflictEscalationKey({
        milestoneBranch: LEDGER_BRANCH,
        files: ["worker/deno/lib/scan_content.ts"],
      }),
    );
    // Tracked apart from `gateEscalated`, so the Issue #974 refusal of the
    // merged tree cannot suppress this one, or the reverse.
    assertEquals(entry?.gateEscalated, false);

    // The refusal repeated, so the ledger concludes it (Issue #2388) — which
    // is what stops the milestone's issues being claimed and dropped.
    assertEquals(entry?.gateRefusal?.count, 2);
    assertEquals(entry?.gateRefusal?.reported, true);

    // Nothing is commented on any issue of the monitored repository: a
    // conflict is the worker's to resolve, never a human's.
    assertEquals(
      calls.filter((c) => c[0] === "issue" && c[1] === "comment").length,
      0,
    );
    const filed = calls.filter((c) =>
      c[0] === "issue" && c[1] === "create" &&
      c[c.indexOf("--repo") + 1] === GATE_WEDGE_DIAGNOSTIC_REPO
    );
    assertEquals(filed.length, 1, "reported once, not every cycle");
    const body = filed[0]![filed[0]!.indexOf("--body") + 1] ?? "";
    // Both halves: what the gate said, and the two sides that produced it.
    assertStringIncludes(body, "TS2304");
    assertStringIncludes(body, "worker/deno/lib/scan_content.ts");
    // …plus what a gate fixer needs: the repository, the milestone and the
    // count the diagnostic exists to surface.
    assertStringIncludes(body, "owner/repo");
    assertStringIncludes(body, LEDGER_BRANCH);
    assertStringIncludes(body, "refused the same resolution 2 time(s)");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a successful roll-back resets the ledger and re-queues the child (Issue #1781)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1781-ok-" });
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
    const events: string[] = [];
    const deps = ledgerDeps(calls, {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "conflict",
      }],
      streakPath,
      nowMs: 10_000,
      rollbackOutcome: {
        merged: true,
        reverted: [{
          prNumber: 12,
          sha: LEDGER_SHA,
          headRefName: "issue-45-child",
          title: "Child",
        }],
      },
    });
    deps.emitSelfHealEvent = (event) => {
      events.push(event.action);
      return Promise.resolve(true);
    };
    await syncMilestoneBranches(deps);

    const entry = await readLedger(streakPath);
    assertEquals(entry?.conflictAttempts, 0, "the budget is refilled");
    assertEquals(entry?.rollbacks, 1);
    assertEquals(entry?.revertedShas, [LEDGER_SHA]);
    assertEquals(entry?.revertedPrs, [12]);
    assert(events.includes("rolled_back"));
    assert(
      events.includes("fallback_flagged"),
      `no fallback_flagged event: ${JSON.stringify(events)}`,
    );
    assert(
      calls.some((c) =>
        c[0] === "issue" && c[1] === "reopen" && c.includes("45")
      ),
      "the reverted child is reopened",
    );
    assert(
      calls.some((c) =>
        c[0] === "issue" && c[1] === "comment" &&
        (c[c.length - 1] ?? "").includes("vibe-milestone-rollback")
      ),
      "the marker is posted",
    );

    // Issue #2311: exactly one `merge-fallback` flag, and the notice links it.
    const flags = calls.filter((c) =>
      c[0] === "issue" && c[1] === "create" && c.includes("merge-fallback")
    );
    assertEquals(flags.length, 1, "exactly one merge-fallback issue is filed");
    const flagBody = flags[0]![flags[0]!.indexOf("--body") + 1] ?? "";
    assertStringIncludes(flagBody, LEDGER_BRANCH);
    assertStringIncludes(flagBody, "### Agent runs");
    assertStringIncludes(flagBody, "conflict unresolved at rung agent");
    assert(
      calls.some((c) =>
        c[0] === "issue" && c[1] === "comment" &&
        (c[c.length - 1] ?? "").includes(`merge-fallback\` flag #${FLAG_ISSUE}`)
      ),
      "the roll-back notice links the flag",
    );
    assert(
      !calls.some((c) => c.includes("needs-human")),
      "a conflict outcome never writes needs-human",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a roll-back that could not merge files the flag, asks no human, and is re-armed when the default tip moves (Issues #1781, #2311)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-1781-fail-" });
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
    const outcome: RollbackOutcome = {
      merged: false,
      reverted: [],
      reason: "nothing left to revert",
    };
    const deps = ledgerDeps(calls, {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "conflict",
      }],
      streakPath,
      nowMs: 10_000,
      rollbackOutcome: outcome,
    });
    await syncMilestoneBranches(deps);

    const comments = calls.filter((c) =>
      c[0] === "issue" && c[1] === "comment"
    );
    assertEquals(comments.length, 1, "exactly one comment");
    const notice = comments[0]![comments[0]!.length - 1] ?? "";
    assertStringIncludes(notice, `merge-fallback\` flag #${FLAG_ISSUE}`);
    assert(
      !calls.some((c) => c.includes("needs-human")),
      `a roll-back that could not merge reached a human: ${
        JSON.stringify(calls.filter((c) => c.includes("needs-human")))
      }`,
    );
    assertEquals(
      calls.filter((c) =>
        c[0] === "issue" && c[1] === "create" && c.includes("merge-fallback")
      ).length,
      1,
      "exactly one merge-fallback issue is filed",
    );
    const spent = await readLedger(streakPath);
    assertEquals(spent?.escalated, false, "no needs-human streak to record");
    assertEquals(
      spent?.conflictAttempts,
      MILESTONE_CONFLICT_ATTEMPT_BUDGET,
      "a failed roll-back does not refill the budget",
    );
    assertEquals(
      spent?.fallbackDefaultSha,
      LEDGER_SHA,
      "the tip this fallback answered for is recorded",
    );

    // The same tip: the branch is still the fallback's, and nothing repeats.
    const same: string[][] = [];
    await syncMilestoneBranches(ledgerDeps(same, {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "conflict",
      }],
      streakPath,
      nowMs: 100_000,
      rollbackOutcome: outcome,
    }));
    assertEquals(
      same.filter((c) => c[0] === "issue" && c[1] === "comment").length,
      0,
      "an unmoved default branch is not tried again",
    );

    // The default branch moves: two more runs, and the same flag collects
    // whatever they find (Issue #2311).
    const later: string[][] = [];
    let attempts = 0;
    const again = ledgerDeps(later, {
      milestones: [{
        title: LEDGER_TITLE,
        branch: LEDGER_BRANCH,
        failure: "conflict",
      }],
      streakPath,
      nowMs: 200_000,
      defaultSha: MOVED_SHA,
      rollbackOutcome: outcome,
    });
    const inner = again.syncBranchFn;
    again.syncBranchFn = (repo, branch, base, opts) => {
      attempts++;
      return inner(repo, branch, base, opts);
    };
    await syncMilestoneBranches(again);
    assertEquals(attempts, 1, "the moved tip re-arms the two-run budget");
    assertEquals(
      (await readLedger(streakPath))?.conflictAttempts,
      1,
      "and the re-armed budget starts from one spent run",
    );
    assert(
      !later.some((c) => c.includes("needs-human")),
      "the re-attempt still asks no human",
    );
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

// Issue #2309: this test asserted the other half of the removed latch — a
// merge that failed after the agent ran left the cycle's one grant spent, so
// the next branch was refused. With the latch gone the deadline is the only
// thing that refuses a rung, and an unbounded pass refuses none.
Deno.test("syncMilestoneBranches - a merge that failed after the agent ran does not deny the next branch (Issue #2309)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2309-leak-" });
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
      true,
      "an unbounded pass has no budget reason to refuse the second rung",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncMilestoneBranches - a clean merge leaves the next branch its own rung (Issue #2309)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2309-clean-" });
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

    // Nothing collided on the first branch, and the conflicting branch is
    // judged on the budget it has, not on what another branch was offered.
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

// ---------------------------------------------------------------------------
// Lane lease and cross-host claim (Issue #2030)
// ---------------------------------------------------------------------------

Deno.test("syncMilestoneBranches - a repository an issue slot holds is deferred, and a granted lease is released (Issue #2030)", async () => {
  const logs: string[] = [];
  const released: string[] = [];
  const synced: string[] = [];
  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/held", "owner/free"],
    ghCommandFn: (args: string[]) => {
      const key = args.join(" ");
      if (key.includes("/milestones")) {
        return Promise.resolve(JSON.stringify([{ title: "v1.0", number: 1 }]));
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("branches/milestone")) {
        return Promise.resolve("milestone/v1-0");
      }
      return Promise.resolve("[]");
    },
    syncBranchFn: (repo: string, branch: string) => {
      synced.push(`${repo}:${branch}`);
      return Promise.resolve({ ok: true as const, value: { message: "ok" } });
    },
    leaseRepoFn: (repo: string) =>
      repo === "owner/held" ? null : { release: () => released.push(repo) },
    log: (msg: string) => logs.push(msg),
  };
  const result = await syncMilestoneBranches(deps);
  assert(result.ok);
  assertEquals(synced, ["owner/free:milestone/v1-0"]);
  assertEquals(released, ["owner/free"]);
  assert(
    logs.some((l) =>
      l.includes("owner/held") && l.includes("issue slot holds its clone")
    ),
  );
});

Deno.test("syncMilestoneBranches - a branch another host claimed is skipped without a sync; a claimed one syncs and releases (Issue #2030)", async () => {
  const logs: string[] = [];
  const synced: string[] = [];
  const releasedClaims: string[] = [];
  const deps: MilestoneBranchSyncDeps = {
    repos: ["owner/repo"],
    ghCommandFn: (args: string[]) => {
      const key = args.join(" ");
      if (key.includes("/milestones")) {
        return Promise.resolve(JSON.stringify([
          { title: "held", number: 1 },
          { title: "free", number: 2 },
        ]));
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("branches/milestone")) return Promise.resolve("exists");
      return Promise.resolve("[]");
    },
    syncBranchFn: (_repo: string, branch: string) => {
      synced.push(branch);
      return Promise.resolve({ ok: true as const, value: { message: "ok" } });
    },
    claimSyncFn: (_repo: string, branch: string) =>
      Promise.resolve(
        branch === "milestone/held"
          ? {
            kind: "held-elsewhere" as const,
            ref: "refs/vibe/sync-claims/milestone/held",
            ageMs: 5 * 60_000,
          }
          : {
            kind: "claimed" as const,
            ref: "refs/vibe/sync-claims/milestone/free",
            tookOverStale: false,
          },
      ),
    releaseSyncClaimFn: (_repo: string, branch: string) => {
      releasedClaims.push(branch);
      return Promise.resolve();
    },
    log: (msg: string) => logs.push(msg),
  };
  const result = await syncMilestoneBranches(deps);
  assert(result.ok);
  assertEquals(synced, ["milestone/free"]);
  assertEquals(releasedClaims, ["milestone/free"]);
  assertEquals(result.value.skipped, 1);
  assert(logs.some((l) => l.includes("another host claimed 'milestone/held'")));
});
