import { mergeOnlyBindings } from "../lib/milestone_merge_only.ts";
import { checkMergedTree } from "../lib/milestone_merge_gate.ts";
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
 * refuse if still short — before a build starts. A build still short after
 * pruning no longer defers the sync: the sync lands merge-only, without the
 * build (Issue #4326).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CARGO_BUILD_SKIPPED_FOR_MERGE,
  deferralSkipsCargoForMerge,
  enableInFlightHostDiskGate,
  enforceEphemeralCargoBudget,
  type EphemeralRootDeps,
  type EphemeralTargetDir,
  type HeavyBuildAdmission,
  heavyBuildAdmission,
  type HeavyBuildDiskReading,
  judgeHostDiskForBuild,
  parkInFlightBuild,
  registerHeavyBuildDiskProbe,
  releaseCheckoutTargetDirs,
} from "../lib/heavy_build_gate.ts";
import { cargoTargetDirForCheckout } from "../lib/ephemeral_build_cache.ts";
import {
  type MilestoneBranchSyncDeps,
  type SyncBranchOptions,
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

/**
 * A merge-only reason as `heavyBuildAdmission` builds it for the GRQ-23
 * figures: 55.3 GB free, a 46 GB floor, 25 GB headroom, nothing prunable
 * (Issue #4326).
 */
const BUDGET_REASON =
  "ephemeral cargo root over budget (55.3 GB free, floor 46.0 GB + headroom 25.0 GB) — pruned 0.0 GB of idle target dirs and 15.7 GB is still short, so cargo builds wait for CI (Issue #3178 budget; Issue #4326 skip); cargo builds wait for CI; Deno projects keep their normal checks (Issue #4326)";

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

Deno.test("in-flight gate parks both deferred and merge-only builds after admission changes (Issues #4326, #4360)", async () => {
  enableInFlightHostDiskGate(true);
  try {
    for (
      const current of [
        reading({ level: "low", free: 6 * GB }),
        reading({ free: 55.3 * GB }),
      ]
    ) {
      registerHeavyBuildDiskProbe(() => Promise.resolve(current));
      const parked = await parkInFlightBuild(CHECKOUT, fakeRoot([]).deps);
      assert(parked !== null);
      assertStringIncludes(parked, "Parked as infrastructure (Issue #4360).");
      assertStringIncludes(parked, "46.0 GB");
    }
    for (const current of [reading(), reading({ level: "unknown" })]) {
      registerHeavyBuildDiskProbe(() => Promise.resolve(current));
      assertEquals(await parkInFlightBuild(CHECKOUT, fakeRoot([]).deps), null);
    }
  } finally {
    enableInFlightHostDiskGate(false);
    registerHeavyBuildDiskProbe(undefined);
  }
});

/** The reason of an admission that is not a plain build. */
function reasonOf(admission: HeavyBuildAdmission): string {
  assert(
    admission.mode !== "build",
    `expected a deferral or merge-only admission, got ${admission.mode}`,
  );
  return admission.reason;
}

/** A defer admission for a reading below the floor. */
function deferAdmission(r: HeavyBuildDiskReading): HeavyBuildAdmission {
  const reason = judgeHostDiskForBuild(r);
  assert(reason !== null, "a reading below the floor must defer");
  return { mode: "defer", reason };
}

/** Admit a build in CHECKOUT against host reading `r` and ephemeral root `root`. */
async function admitWith(
  r: HeavyBuildDiskReading,
  root: EphemeralRootDeps,
): Promise<HeavyBuildAdmission> {
  registerHeavyBuildDiskProbe(() => Promise.resolve(r));
  try {
    return await heavyBuildAdmission(CHECKOUT, root);
  } finally {
    registerHeavyBuildDiskProbe(undefined);
  }
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

Deno.test("enforceEphemeralCargoBudget - above the floor, with nothing pruned, skips cargo so a merge can land (Issue #4326)", async () => {
  const root = fakeRoot([]);
  // 55 GB free sits between the 46 GB floor and the 71 GB floor-plus-headroom.
  const verdict = await enforceEphemeralCargoBudget({
    checkoutPath: CHECKOUT,
    hostFreeBytes: 55 * GB,
    floorBytes: 46 * GB,
    headroomBytes: 25 * GB,
    root: ROOT,
  }, root.deps);
  assertEquals(verdict.skipCargoBuild, true);
  assertEquals(verdict.proceed, false, "a real build is still not started");
  assertEquals(root.removed, [], "nothing was free to prune");
  assertEquals(deferralSkipsCargoForMerge(verdict.detail), true);
  assertStringIncludes(verdict.detail, CARGO_BUILD_SKIPPED_FOR_MERGE);
});

Deno.test("enforceEphemeralCargoBudget - below the floor does not skip cargo (Issue #4326)", async () => {
  const verdict = await enforceEphemeralCargoBudget({
    checkoutPath: CHECKOUT,
    hostFreeBytes: 40 * GB,
    floorBytes: 46 * GB,
    headroomBytes: 25 * GB,
    root: ROOT,
  }, fakeRoot([]).deps);
  assertEquals(verdict.skipCargoBuild, false);
  assertEquals(verdict.proceed, false);
  assertEquals(deferralSkipsCargoForMerge(verdict.detail), false);
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
// heavyBuildAdmission — the one call a maintenance pass makes (Issue #4326)
// ---------------------------------------------------------------------------

Deno.test("heavyBuildAdmission - no registered probe (tests, ad hoc callers) never defers", async () => {
  registerHeavyBuildDiskProbe(undefined);
  assertEquals(await heavyBuildAdmission(CHECKOUT), { mode: "build" });
});

Deno.test("heavyBuildAdmission - below the floor defers without touching the root", async () => {
  let listed = 0;
  registerHeavyBuildDiskProbe(() => Promise.resolve(reading({ level: "low" })));
  try {
    const admission = await heavyBuildAdmission(CHECKOUT, {
      listTargetDirs: () => {
        listed++;
        return Promise.resolve([]);
      },
      removeDir: () => Promise.resolve(),
      nowMs: () => NOW,
    });
    assertEquals(admission.mode, "defer");
    const reason = reasonOf(admission);
    assertStringIncludes(reason, "floor 46.0 GB");
    assertEquals(listed, 0);
  } finally {
    registerHeavyBuildDiskProbe(undefined);
  }
});

Deno.test("heavyBuildAdmission - on a trimming runtime the budget is not consulted", async () => {
  let listed = 0;
  registerHeavyBuildDiskProbe(() =>
    Promise.resolve(reading({ free: 47 * GB, trimRefused: false }))
  );
  try {
    assertEquals(
      await heavyBuildAdmission(CHECKOUT, {
        listTargetDirs: () => {
          listed++;
          return Promise.reject(new Error("must not be read"));
        },
        removeDir: () => Promise.resolve(),
        nowMs: () => NOW,
      }),
      { mode: "build" },
    );
    assertEquals(listed, 0, "the ephemeral root must be left alone");
  } finally {
    registerHeavyBuildDiskProbe(undefined);
  }
});

Deno.test("heavyBuildAdmission - a reading that is not ok builds without consulting the budget, however little it says is free (Issue #4326)", async () => {
  // 48 GB free is over budget (floor 46 + 25 headroom), so were the budget
  // read the answer would be merge-only. An `unknown` level is a blind probe,
  // which must never stop a build (Issue #226).
  let listed = 0;
  const watching: EphemeralRootDeps = {
    listTargetDirs: () => {
      listed++;
      return Promise.resolve([]);
    },
    removeDir: () => Promise.resolve(),
    nowMs: () => NOW,
  };
  const admission = await admitWith(
    reading({
      status: {
        level: "unknown",
        availableBytes: 48 * GB,
        totalBytes: 460 * GB,
        source: "none",
        detail: "blind",
      },
    }),
    watching,
  );
  assertEquals(admission, { mode: "build" });
  assertEquals(listed, 0, "the ephemeral root must be left alone");
});

Deno.test("heavyBuildAdmission - an ok reading that states no free space builds without consulting the budget (Issue #4326)", async () => {
  let listed = 0;
  const watching: EphemeralRootDeps = {
    listTargetDirs: () => {
      listed++;
      return Promise.resolve([]);
    },
    removeDir: () => Promise.resolve(),
    nowMs: () => NOW,
  };
  const admission = await admitWith(
    reading({
      status: {
        level: "ok",
        totalBytes: 460 * GB,
        source: "launch-baseline",
        detail: "free space not stated",
      },
    }),
    watching,
  );
  assertEquals(admission, { mode: "build" });
  assertEquals(listed, 0, "the ephemeral root must be left alone");
});

Deno.test("heavyBuildAdmission - above the floor but over the cargo budget lands merge-only, not deferred (Issue #4326)", async () => {
  registerHeavyBuildDiskProbe(() =>
    Promise.resolve(reading({ free: 48 * GB }))
  );
  try {
    const admission = await heavyBuildAdmission(CHECKOUT, fakeRoot([]).deps);
    assert(
      admission.mode !== "build",
      "2 GB above the floor cannot hold a build",
    );
    assertEquals(admission.mode, "merge-only");
    const reason = reasonOf(admission);
    assertStringIncludes(reason, "ephemeral cargo root");
    assertStringIncludes(reason, "floor 46.0 GB");
    assertStringIncludes(reason, "headroom 25.0 GB");
    assertStringIncludes(reason, "still short");
    assertStringIncludes(reason, "Issue #3178");
    assertStringIncludes(reason, "Issue #4326");
  } finally {
    registerHeavyBuildDiskProbe(undefined);
  }
});

// Issue #4326 acceptance: the host is above its floor, but a build would need
// 25 GB of headroom on top of it and nothing can be pruned to make room. The
// sync must land merge-only, and nothing may be removed to make room for it.
for (const freeGb of [50.9, 55.3, 55.8]) {
  Deno.test(`heavyBuildAdmission - ${freeGb} GB free against a 46 GB floor with nothing prunable lands merge-only (Issue #4326)`, async () => {
    const free = freeGb * GB;
    const floor = 46 * GB;
    // The host is above its floor, so this is the budget refusing, not the
    // floor deferring.
    assert(free - floor > 0, "the host must sit above its floor");
    const root = fakeRoot([]);
    const admission = await admitWith(reading({ free }), root.deps);
    assertEquals(admission.mode, "merge-only");
    assertStringIncludes(reasonOf(admission), "Issue #4326");
    assertEquals(root.removed, [], "nothing may be removed for the build");
  });
}

for (const freeGb of [50.9, 55.3, 55.8]) {
  Deno.test(`heavyBuildAdmission - ${freeGb} GB free with only this checkout's own and a recently written dir lands merge-only (Issue #4326)`, async () => {
    const own = cargoTargetDirForCheckout(CHECKOUT, { root: ROOT });
    const busy = cargoTargetDirForCheckout(OTHER, { root: ROOT });
    const root = fakeRoot([
      { path: own, bytes: 15 * GB, lastWriteMs: NOW - 3_600_000 },
      { path: busy, bytes: 12 * GB, lastWriteMs: NOW - 60_000 },
    ]);
    const admission = await admitWith(
      reading({ free: freeGb * GB }),
      root.deps,
    );
    assertEquals(admission.mode, "merge-only");
    assertStringIncludes(reasonOf(admission), "Issue #4326");
    assertEquals(root.removed, [], "neither dir may be pruned");
  });
}

Deno.test("heavyBuildAdmission - 55.3 GB free with an idle dir that covers the shortfall builds, pruning first (Issue #4326)", async () => {
  // 55.3 GB free against 46 + 25 GB needs 15.7 GB more; the idle dir covers it.
  const big = `${ROOT}/old-big-3333`;
  const root = fakeRoot([
    { path: big, bytes: 20 * GB, lastWriteMs: NOW - 7_200_000 },
  ]);
  const admission = await admitWith(reading({ free: 55.3 * GB }), root.deps);
  assertEquals(admission, { mode: "build" });
  assertEquals(root.removed, [big]);
});

Deno.test("heavyBuildAdmission - an unreadable root lands merge-only, neither deferred nor built blind (Issue #4326)", async () => {
  const admission = await admitWith(reading({ free: 50 * GB }), {
    listTargetDirs: () => Promise.reject(new Error("EACCES")),
    removeDir: () => Promise.resolve(),
    nowMs: () => NOW,
  });
  assertEquals(admission.mode, "merge-only");
  assertStringIncludes(reasonOf(admission), "EACCES");
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

Deno.test("releaseCheckoutTargetDirs - a root that cannot be listed is an error, not 'nothing built'", async () => {
  const released = await releaseCheckoutTargetDirs(CHECKOUT, {
    listTargetDirs: () =>
      Promise.reject(new Error("du timed out after 120000ms")),
    removeDir: () => Promise.resolve(),
    nowMs: () => NOW,
  }, ROOT);
  assertEquals(released.bytes, 0);
  assertEquals(released.errors, [`${ROOT}: du timed out after 120000ms`]);
});

Deno.test("releaseCheckoutTargetDirs - a missing root means nothing was built", async () => {
  const released = await releaseCheckoutTargetDirs(CHECKOUT, {
    listTargetDirs: () => Promise.reject(new Deno.errors.NotFound("no root")),
    removeDir: () => Promise.resolve(),
    nowMs: () => NOW,
  }, ROOT);
  assertEquals(released, { bytes: 0, errors: [] });
});

// ---------------------------------------------------------------------------
// Regression: the milestone sync that ran on GRQ-23
// ---------------------------------------------------------------------------

function sweepDeps(
  overrides: Partial<MilestoneBranchSyncDeps>,
  synced: string[],
  logs: string[],
  grants: SyncBranchOptions[] = [],
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
    syncBranchFn: (
      _repo: string,
      milestoneBranch: string,
      _defaultBranch: string,
      options: SyncBranchOptions,
    ) => {
      synced.push(milestoneBranch);
      grants.push(options);
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
          deferAdmission(reading({ level: "low" })),
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

Deno.test("syncMilestoneBranches - between the floor and headroom, with nothing to prune, the merge lands this cycle (Issue #4326)", async () => {
  const root = fakeRoot([]);
  const verdict = await enforceEphemeralCargoBudget({
    checkoutPath: CHECKOUT,
    hostFreeBytes: 55 * GB,
    floorBytes: 46 * GB,
    headroomBytes: 25 * GB,
    root: ROOT,
  }, root.deps);
  const synced: string[] = [];
  const logs: string[] = [];
  const result = await syncMilestoneBranches(sweepDeps(
    {
      heavyBuildGateFn: () =>
        Promise.resolve<HeavyBuildAdmission>({
          mode: "merge-only",
          reason: verdict.detail,
        }),
    },
    synced,
    logs,
  ));
  assert(result.ok);
  assertEquals(synced.length, 1, "the merge lands in this cycle");
  assertEquals(result.value.failed, 0);
  assertEquals(result.value.skipped, 0);
  assertEquals(root.removed, []);
  assert(
    logs.some((line) =>
      line.includes("Deno projects keep their normal checks")
    ),
    `no merge-only line in ${logs.join("\n")}`,
  );
});

Deno.test("syncMilestoneBranches - a host above its floor syncs as before, then releases the clone's build artefacts", async () => {
  const synced: string[] = [];
  const logs: string[] = [];
  const released: string[] = [];
  const result = await syncMilestoneBranches(sweepDeps(
    {
      heavyBuildGateFn: () =>
        Promise.resolve<HeavyBuildAdmission>({
          mode: "build",
        }),
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
        return Promise.resolve<HeavyBuildAdmission>({
          mode: "defer",
          reason: "below the floor",
        });
      },
    },
    synced,
    logs,
  ));
  assertEquals(asked, 0);
  assertEquals(synced.length, 2);
});

Deno.test("syncMilestoneBranches - over the cargo budget the sync lands without its build, carrying the reason (Issue #4326)", async () => {
  const synced: string[] = [];
  const logs: string[] = [];
  const grants: SyncBranchOptions[] = [];
  const result = await syncMilestoneBranches(sweepDeps(
    {
      heavyBuildGateFn: () =>
        Promise.resolve<HeavyBuildAdmission>({
          mode: "merge-only",
          reason: BUDGET_REASON,
        }),
    },
    synced,
    logs,
    grants,
  ));
  assert(result.ok);
  assertEquals(synced.length, 1, "the merge runs, without its build");
  assertEquals(result.value.synced, 1);
  assertEquals(result.value.skipped, 0);
  assertEquals(grants.map((g) => g.mergeOnly), [BUDGET_REASON]);
  const line = logs.find((l) => l.includes("[HOST_DISK_BUDGET]"));
  assert(line !== undefined, `no budget line in ${logs.join("\n")}`);
  assertStringIncludes(line, BUDGET_REASON);
});

Deno.test("syncMilestoneBranches - a build admission grants the sync with no merge-only reason (Issue #4326)", async () => {
  const synced: string[] = [];
  const logs: string[] = [];
  const grants: SyncBranchOptions[] = [];
  const result = await syncMilestoneBranches(sweepDeps(
    {
      heavyBuildGateFn: () =>
        Promise.resolve<HeavyBuildAdmission>({ mode: "build" }),
    },
    synced,
    logs,
    grants,
  ));
  assert(result.ok);
  assertEquals(synced.length, 1);
  assertEquals(grants.map((g) => "mergeOnly" in g), [false]);
});

Deno.test("syncMilestoneBranches - a merge-only sync keeps its reason when the agent rung is not offered (Issue #4326)", async () => {
  const synced: string[] = [];
  const logs: string[] = [];
  const grants: SyncBranchOptions[] = [];
  // Ten minutes of handler budget: enough to start the sync, too little for an
  // agent attempt after the default overhead and minimum (Issue #2215).
  const result = await syncMilestoneBranches(sweepDeps(
    {
      heavyBuildGateFn: () =>
        Promise.resolve<HeavyBuildAdmission>({
          mode: "merge-only",
          reason: BUDGET_REASON,
        }),
      deadlineEpochMs: Date.now() + 10 * 60_000,
      minMsPerMilestoneSync: 0,
    },
    synced,
    logs,
    grants,
  ));
  assert(result.ok);
  assertEquals(grants.map((g) => g.agentAllowed), [false]);
  assertEquals(grants.map((g) => g.mergeOnly), [BUDGET_REASON]);
  assertEquals(synced.length, 1);
});

// ---------------------------------------------------------------------------
// The pre-cut sync takes the same gate
// ---------------------------------------------------------------------------

function presyncDeps(
  overrides: Partial<MilestonePresyncDeps>,
  synced: { count: number; grants?: SyncBranchOptions[] },
  logs: string[] = [],
): MilestonePresyncDeps {
  return {
    countBehind: () => Promise.resolve({ ok: true as const, value: 3 }),
    defaultTipSha: () =>
      Promise.resolve({ ok: true as const, value: "d".repeat(40) }),
    milestoneTipSha: () =>
      Promise.resolve({ ok: true as const, value: "m".repeat(40) }),
    syncBranch: (grant: SyncBranchOptions) => {
      synced.count++;
      synced.grants?.push(grant);
      return Promise.resolve({ ok: true as const, value: { message: "ok" } });
    },
    log: (msg: string) => logs.push(msg),
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
      heavyBuildAdmission: () =>
        Promise.resolve(deferAdmission(reading({ level: "low" }))),
    }, synced),
  );
  assertEquals(result.status, "deferred");
  assertEquals(synced.count, 0);
  assertStringIncludes(result.detail, "floor 46.0 GB");
});

Deno.test("presyncMilestoneBranch - a clear gate merges as before", async () => {
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
      heavyBuildAdmission: () =>
        Promise.resolve<HeavyBuildAdmission>({ mode: "build" }),
    }, synced),
  );
  assertEquals(synced.count, 1);
  assertEquals(result.status, "synced");
});

Deno.test("presyncMilestoneBranch - over the cargo budget the merge lands without its build, carrying the reason (Issue #4326)", async () => {
  const synced = { count: 0, grants: [] as SyncBranchOptions[] };
  const logs: string[] = [];
  const result = await presyncMilestoneBranch(
    {
      repo: "owner/repo",
      milestoneBranch: "milestone/1-x",
      defaultBranch: "main",
      grant: { agentAllowed: true },
      nowMs: NOW,
    },
    presyncDeps(
      {
        heavyBuildAdmission: () =>
          Promise.resolve<HeavyBuildAdmission>({
            mode: "merge-only",
            reason: BUDGET_REASON,
          }),
      },
      synced,
      logs,
    ),
  );
  assertEquals(result.status, "synced");
  assertEquals(synced.count, 1);
  assertEquals(synced.grants.map((g) => g.mergeOnly), [BUDGET_REASON]);
  assert(
    logs.some((l) => l.includes("[HOST_DISK_BUDGET]")),
    `no budget line in ${logs.join("\n")}`,
  );
});

Deno.test("presyncMilestoneBranch - a build admission grants the merge with no merge-only reason (Issue #4326)", async () => {
  const synced = { count: 0, grants: [] as SyncBranchOptions[] };
  const result = await presyncMilestoneBranch(
    {
      repo: "owner/repo",
      milestoneBranch: "milestone/1-x",
      defaultBranch: "main",
      grant: { agentAllowed: true },
      nowMs: NOW,
    },
    presyncDeps({
      heavyBuildAdmission: () =>
        Promise.resolve<HeavyBuildAdmission>({ mode: "build" }),
    }, synced),
  );
  assertEquals(result.status, "synced");
  assertEquals(synced.grants.map((g) => "mergeOnly" in g), [false]);
});

Deno.test("merge-only admission keeps Deno checks and truthful logs in sweep and presync (PR #4343)", async () => {
  const tree = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tree}/deno.json`, "{}");
    let checks = 0;
    const sync = async (grant: SyncBranchOptions) => {
      const bindings = mergeOnlyBindings(grant.mergeOnly, undefined, {
        checkMergedTree: (dir, _runner, skip) =>
          checkMergedTree(dir, () => {
            checks++;
            return Promise.resolve({ code: 0, output: "" });
          }, skip),
      });
      assert(bindings);
      assertEquals((await bindings.mergeGate(tree)).status, "passed");
      return { ok: true as const, value: { message: "checked" } };
    };
    registerHeavyBuildDiskProbe(() =>
      Promise.resolve(reading({ free: 55.3 * GB, floorBytes: 46 * GB }))
    );
    const admit = () => heavyBuildAdmission(tree, fakeRoot([]).deps);
    const logs: string[] = [];
    await syncMilestoneBranches(sweepDeps(
      {
        heavyBuildGateFn: () => admit(),
        syncBranchFn: (_repo, _branch, _base, grant) => sync(grant),
      },
      [],
      logs,
    ));
    await presyncMilestoneBranch(
      {
        repo: "owner/repo",
        milestoneBranch: "milestone/1-x",
        defaultBranch: "main",
        grant: { agentAllowed: true },
        nowMs: NOW,
      },
      presyncDeps(
        {
          heavyBuildAdmission: () => admit(),
          syncBranch: sync,
        },
        { count: 0 },
        logs,
      ),
    );
    assertEquals(checks, 2);
    const budgetLogs = logs.filter((line) =>
      line.includes("[HOST_DISK_BUDGET]")
    );
    assertEquals(budgetLogs.length, 2);
    for (const line of budgetLogs) {
      assertStringIncludes(line, BUDGET_REASON);
      assertStringIncludes(line, "Deno projects keep their normal checks");
      assert(!line.includes("build is skipped"));
      assert(!line.includes("lands without"));
    }
  } finally {
    registerHeavyBuildDiskProbe(undefined);
    await Deno.remove(tree, { recursive: true });
  }
});
