/**
 * The host-disk gate on heavy builds (Issue #3178).
 *
 * GRQ-23, 2026-10-03: a launch started below its disk floor. The claim gate
 * correctly claimed nothing, and "maintenance continues" then ran a milestone
 * sync whose verification and two repair rounds built a large Rust workspace
 * into `/var/tmp/vibe-cargo-target` — 23 GB in 23 minutes — until the host
 * could not back the guest's writes and `/` went read-only.
 *
 * These tests pin the two halves of the fix: below the floor a maintenance
 * build is deferred with a line naming the floor, and the ephemeral cargo
 * root has a budget tied to host free space that is enforced — prune first,
 * refuse if still short — before a build starts.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  enforceEphemeralCargoBudget,
  type EphemeralTargetDir,
  heavyBuildDeferral,
  type HeavyBuildDiskReading,
  judgeHostDiskForBuild,
  registerHeavyBuildDiskProbe,
  releaseCheckoutTargetDirs,
} from "../lib/heavy_build_gate.ts";
import { cargoTargetDirForCheckout } from "../lib/ephemeral_build_cache.ts";
import {
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import {
  type MilestonePresyncDeps,
  presyncMilestoneBranch,
} from "../lib/milestone_presync.ts";

const GB = 1_073_741_824;
const ROOT = "/var/tmp/vibe-cargo-target";
const CHECKOUT = "/home/vibe/auto-issue-work/GRQ-AutoTrader";
const OTHER = "/home/vibe/auto-issue-work/worktrees/2/GRQ-Other";
const NOW = Date.parse("2026-10-03T22:30:00Z");

/** The GRQ-23 reading from the incident log. */
const LOW_DETAIL =
  "host (estimated from the launcher's reading 1 min ago) 38.8 GB free (8.4%) of 460.4 GB, floor 46.0 GB — below the floor";

function reading(
  overrides: Partial<HeavyBuildDiskReading> & {
    level?: "ok" | "low" | "unknown";
    free?: number;
  } = {},
): HeavyBuildDiskReading {
  const level = overrides.level ?? "ok";
  return {
    status: overrides.status ?? {
      level,
      availableBytes: overrides.free ?? 120 * GB,
      totalBytes: 460 * GB,
      source: "launch-baseline",
      detail: level === "low" ? LOW_DETAIL : "120.0 GB free, floor 46.0 GB",
    },
    floorBytes: "floorBytes" in overrides ? overrides.floorBytes : 46 * GB,
    trimRefused: overrides.trimRefused ?? true,
  };
}

/** An in-memory ephemeral root. */
function fakeRoot(dirs: EphemeralTargetDir[]) {
  const live = new Map(dirs.map((d) => [d.path, d]));
  const removed: string[] = [];
  return {
    removed,
    deps: {
      listTargetDirs: () => Promise.resolve([...live.values()]),
      removeDir: (path: string) => {
        live.delete(path);
        removed.push(path);
        return Promise.resolve();
      },
      nowMs: () => NOW,
    },
  };
}

// ---------------------------------------------------------------------------
// Below the floor: no build at all
// ---------------------------------------------------------------------------

Deno.test("judgeHostDiskForBuild - a host below its floor defers the build and names the floor", () => {
  const reason = judgeHostDiskForBuild(reading({ level: "low" }));
  assert(reason !== null, "below the floor must defer");
  assertStringIncludes(reason, "below the floor");
  assertStringIncludes(reason, "floor 46.0 GB");
  assertStringIncludes(reason, "Issue #3178");
});

Deno.test("judgeHostDiskForBuild - an ok or unknown reading never defers", () => {
  assertEquals(judgeHostDiskForBuild(reading({ level: "ok" })), null);
  // Unknown is the documented not-gating default (Issue #226): a blind probe
  // must not stop every build in the fleet.
  assertEquals(
    judgeHostDiskForBuild(reading({
      status: { level: "unknown", source: "none", detail: "blind" },
    })),
    null,
  );
});

// ---------------------------------------------------------------------------
// The ephemeral cargo root's budget
// ---------------------------------------------------------------------------

Deno.test("enforceEphemeralCargoBudget - under budget the build runs and nothing is pruned", async () => {
  const root = fakeRoot([
    { path: `${ROOT}/stale-aaaa`, bytes: 9 * GB, lastWriteMs: NOW - 3_600_000 },
  ]);
  const verdict = await enforceEphemeralCargoBudget({
    checkoutPath: CHECKOUT,
    hostFreeBytes: 120 * GB,
    floorBytes: 46 * GB,
    headroomBytes: 20 * GB,
    root: ROOT,
  }, root.deps);
  assertEquals(verdict.proceed, true);
  assertEquals(root.removed, []);
});

Deno.test("enforceEphemeralCargoBudget - over budget prunes idle checkouts' dirs, then runs once covered", async () => {
  const own = cargoTargetDirForCheckout(CHECKOUT, { root: ROOT });
  const busy = cargoTargetDirForCheckout(OTHER, { root: ROOT });
  const root = fakeRoot([
    // This checkout's own dir is its incremental cache — never pruned here.
    { path: own, bytes: 15 * GB, lastWriteMs: NOW - 3_600_000 },
    // Written a minute ago: another slot's build is in it.
    { path: busy, bytes: 12 * GB, lastWriteMs: NOW - 60_000 },
    {
      path: `${ROOT}/old-one-1111`,
      bytes: 8 * GB,
      lastWriteMs: NOW - 7_200_000,
    },
    {
      path: `${ROOT}/old-two-2222`,
      bytes: 6 * GB,
      lastWriteMs: NOW - 7_200_000,
    },
  ]);
  // 60 GB free, floor 46, headroom 20 → 6 GB short.
  const verdict = await enforceEphemeralCargoBudget({
    checkoutPath: CHECKOUT,
    hostFreeBytes: 60 * GB,
    floorBytes: 46 * GB,
    headroomBytes: 20 * GB,
    root: ROOT,
  }, root.deps);
  assertEquals(verdict.proceed, true, verdict.detail);
  // Largest idle first; the 8 GB dir alone covers the 6 GB shortfall.
  assertEquals(root.removed, [`${ROOT}/old-one-1111`]);
  assertEquals(verdict.prunedBytes, 8 * GB);
});

Deno.test("enforceEphemeralCargoBudget - still over budget after pruning refuses the build", async () => {
  const own = cargoTargetDirForCheckout(CHECKOUT, { root: ROOT });
  const root = fakeRoot([
    { path: own, bytes: 15 * GB, lastWriteMs: NOW - 3_600_000 },
    {
      path: `${ROOT}/old-one-1111`,
      bytes: 2 * GB,
      lastWriteMs: NOW - 7_200_000,
    },
  ]);
  const verdict = await enforceEphemeralCargoBudget({
    checkoutPath: CHECKOUT,
    hostFreeBytes: 50 * GB,
    floorBytes: 46 * GB,
    headroomBytes: 20 * GB,
    root: ROOT,
  }, root.deps);
  assertEquals(verdict.proceed, false);
  assertEquals(root.removed, [`${ROOT}/old-one-1111`]);
  assertStringIncludes(verdict.detail, "floor 46.0 GB");
  assertStringIncludes(verdict.detail, "headroom 20.0 GB");
  assertStringIncludes(verdict.detail, "Issue #3178");
});

Deno.test("enforceEphemeralCargoBudget - an unreadable root refuses rather than builds blind", async () => {
  const verdict = await enforceEphemeralCargoBudget({
    checkoutPath: CHECKOUT,
    hostFreeBytes: 50 * GB,
    floorBytes: 46 * GB,
    headroomBytes: 20 * GB,
    root: ROOT,
  }, {
    listTargetDirs: () => Promise.reject(new Error("EACCES")),
    removeDir: () => Promise.resolve(),
    nowMs: () => NOW,
  });
  assertEquals(verdict.proceed, false);
  assertStringIncludes(verdict.detail, "EACCES");
});

// ---------------------------------------------------------------------------
// heavyBuildDeferral — the one call a maintenance pass makes
// ---------------------------------------------------------------------------

Deno.test("heavyBuildDeferral - no registered probe (tests, ad hoc callers) never defers", async () => {
  registerHeavyBuildDiskProbe(undefined);
  assertEquals(await heavyBuildDeferral(CHECKOUT), null);
});

Deno.test("heavyBuildDeferral - below the floor defers without touching the root", async () => {
  let listed = 0;
  registerHeavyBuildDiskProbe(() => Promise.resolve(reading({ level: "low" })));
  try {
    const reason = await heavyBuildDeferral(CHECKOUT, {
      listTargetDirs: () => {
        listed++;
        return Promise.resolve([]);
      },
      removeDir: () => Promise.resolve(),
      nowMs: () => NOW,
    });
    assert(reason !== null);
    assertStringIncludes(reason, "floor 46.0 GB");
    assertEquals(listed, 0);
  } finally {
    registerHeavyBuildDiskProbe(undefined);
  }
});

Deno.test("heavyBuildDeferral - on a trimming runtime the budget is not consulted", async () => {
  registerHeavyBuildDiskProbe(() =>
    Promise.resolve(reading({ free: 47 * GB, trimRefused: false }))
  );
  try {
    assertEquals(
      await heavyBuildDeferral(CHECKOUT, {
        listTargetDirs: () => Promise.reject(new Error("must not be read")),
        removeDir: () => Promise.resolve(),
        nowMs: () => NOW,
      }),
      null,
    );
  } finally {
    registerHeavyBuildDiskProbe(undefined);
  }
});

Deno.test("heavyBuildDeferral - above the floor but over the cargo budget defers", async () => {
  registerHeavyBuildDiskProbe(() =>
    Promise.resolve(reading({ free: 48 * GB }))
  );
  try {
    const reason = await heavyBuildDeferral(CHECKOUT, fakeRoot([]).deps);
    assert(reason !== null, "2 GB above the floor cannot hold a build");
    assertStringIncludes(reason, "ephemeral cargo root");
  } finally {
    registerHeavyBuildDiskProbe(undefined);
  }
});

// ---------------------------------------------------------------------------
// Release when the pass finishes
// ---------------------------------------------------------------------------

Deno.test("releaseCheckoutTargetDirs - removes every account's dir for that checkout, and nothing else", async () => {
  const vibe = cargoTargetDirForCheckout(CHECKOUT, { root: ROOT });
  const agent = cargoTargetDirForCheckout(CHECKOUT, {
    root: ROOT,
    account: "agent",
  });
  const other = cargoTargetDirForCheckout(OTHER, { root: ROOT });
  const root = fakeRoot([
    { path: vibe, bytes: 10 * GB, lastWriteMs: NOW },
    { path: agent, bytes: 3 * GB, lastWriteMs: NOW },
    { path: other, bytes: 5 * GB, lastWriteMs: NOW },
  ]);
  const released = await releaseCheckoutTargetDirs(CHECKOUT, root.deps, ROOT);
  assertEquals(root.removed.sort(), [agent, vibe].sort());
  assertEquals(released.bytes, 13 * GB);
  assertEquals(released.errors, []);
});

// ---------------------------------------------------------------------------
// Regression: the milestone sync that ran on GRQ-23
// ---------------------------------------------------------------------------

function sweepDeps(
  overrides: Partial<MilestoneBranchSyncDeps>,
  synced: string[],
  logs: string[],
): MilestoneBranchSyncDeps {
  return {
    repos: ["stSoftwareAU/GRQ-AutoTrader"],
    ghCommandFn: (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("/milestones")) {
        return Promise.resolve(
          JSON.stringify([{ title: "2285 shares", number: 7 }]),
        );
      }
      if (key.includes("default_branch")) return Promise.resolve("main");
      if (key.includes("branches/milestone")) {
        return Promise.resolve("a".repeat(40));
      }
      return Promise.resolve("[]");
    },
    syncBranchFn: (_repo: string, milestoneBranch: string) => {
      synced.push(milestoneBranch);
      return Promise.resolve({
        ok: true as const,
        value: { message: `Synced ${milestoneBranch}` },
      });
    },
    log: (msg: string) => logs.push(msg),
    ...overrides,
  };
}

Deno.test("syncMilestoneBranches - below the host floor a sync needing verification is deferred, not run (Issue #3178)", async () => {
  const synced: string[] = [];
  const logs: string[] = [];
  const gateAsked: string[] = [];
  const result = await syncMilestoneBranches(sweepDeps(
    {
      heavyBuildGateFn: (repo: string) => {
        gateAsked.push(repo);
        return Promise.resolve(
          judgeHostDiskForBuild(reading({ level: "low" })),
        );
      },
    },
    synced,
    logs,
  ));
  assertEquals(synced, [], "the merge and its build must not run");
  assertEquals(gateAsked, ["stSoftwareAU/GRQ-AutoTrader"]);
  assert(result.ok);
  assertEquals(result.value.synced, 0);
  assertEquals(result.value.failed, 0, "a deferral is not a failure");
  assertEquals(result.value.skipped, 1);
  const line = logs.find((l) => l.includes("deferred"));
  assert(line !== undefined, `no deferral line in ${logs.join("\n")}`);
  assertStringIncludes(line, "floor 46.0 GB");
  assertStringIncludes(line, "Issue #3178");
});

Deno.test("syncMilestoneBranches - a host above its floor syncs as before, then releases the clone's build artefacts", async () => {
  const synced: string[] = [];
  const logs: string[] = [];
  const released: string[] = [];
  const result = await syncMilestoneBranches(sweepDeps(
    {
      heavyBuildGateFn: () => Promise.resolve(null),
      releaseBuildArtefactsFn: (repo: string) => {
        released.push(repo);
        return Promise.resolve();
      },
    },
    synced,
    logs,
  ));
  assert(result.ok);
  assertEquals(synced.length, 1);
  assertEquals(released, ["stSoftwareAU/GRQ-AutoTrader"]);
});

Deno.test("syncMilestoneBranches - a level branch is not deferred: there is nothing to build", async () => {
  const synced: string[] = [];
  const logs: string[] = [];
  let asked = 0;
  await syncMilestoneBranches(sweepDeps(
    {
      ghCommandFn: (args: string[]): Promise<string> => {
        const key = args.join(" ");
        if (key.includes("/milestones")) {
          return Promise.resolve(JSON.stringify([
            { title: "one", number: 1 },
            { title: "two", number: 2 },
          ]));
        }
        if (key.includes("default_branch")) return Promise.resolve("main");
        if (key.includes("branches/milestone")) {
          return Promise.resolve("a".repeat(40));
        }
        return Promise.resolve("[]");
      },
      behindCountFn: () => Promise.resolve({ ok: true as const, value: 0 }),
      heavyBuildGateFn: () => {
        asked++;
        return Promise.resolve("below the floor");
      },
    },
    synced,
    logs,
  ));
  assertEquals(asked, 0);
  assertEquals(synced.length, 2);
});

// ---------------------------------------------------------------------------
// The pre-cut sync takes the same gate
// ---------------------------------------------------------------------------

function presyncDeps(
  overrides: Partial<MilestonePresyncDeps>,
  synced: { count: number },
): MilestonePresyncDeps {
  return {
    countBehind: () => Promise.resolve({ ok: true as const, value: 3 }),
    defaultTipSha: () =>
      Promise.resolve({ ok: true as const, value: "d".repeat(40) }),
    milestoneTipSha: () =>
      Promise.resolve({ ok: true as const, value: "m".repeat(40) }),
    syncBranch: () => {
      synced.count++;
      return Promise.resolve({ ok: true as const, value: { message: "ok" } });
    },
    log: () => {},
    ...overrides,
  };
}

Deno.test("presyncMilestoneBranch - below the host floor a behind branch is deferred, not merged (Issue #3178)", async () => {
  const synced = { count: 0 };
  const result = await presyncMilestoneBranch(
    {
      repo: "owner/repo",
      milestoneBranch: "milestone/1-x",
      defaultBranch: "main",
      grant: { agentAllowed: true },
      nowMs: NOW,
    },
    presyncDeps({
      heavyBuildDeferral: () =>
        Promise.resolve(judgeHostDiskForBuild(reading({ level: "low" }))),
    }, synced),
  );
  assertEquals(result.status, "deferred");
  assertEquals(synced.count, 0);
  assertStringIncludes(result.detail, "floor 46.0 GB");
});

Deno.test("presyncMilestoneBranch - a clear gate merges as before", async () => {
  const synced = { count: 0 };
  const result = await presyncMilestoneBranch({
    repo: "owner/repo",
    milestoneBranch: "milestone/1-x",
    defaultBranch: "main",
    grant: { agentAllowed: true },
    nowMs: NOW,
  }, presyncDeps({ heavyBuildDeferral: () => Promise.resolve(null) }, synced));
  assertEquals(synced.count, 1);
  assertEquals(result.status, "synced");
});
