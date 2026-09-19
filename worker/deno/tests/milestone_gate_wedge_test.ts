/**
 * A resolution-gate refusal that cannot change must conclude (Issue #2388).
 *
 * A gate refusal concludes `not-charged`, so the branch's conflict budget is
 * never spent and nothing ever ends: one milestone was claimed and dropped
 * ~150 times in a day rebuilding the identical resolution for the identical
 * refusal. These tests drive the real ledger transitions, the real pre-cut
 * sync and the real diagnostic filer.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  clearGateRefusal,
  GATE_REFUSAL_WEDGE_THRESHOLD,
  gateWedgeTipsMoved,
  isGateWedged,
  isSameGateRefusal,
  loadSyncStreaks,
  markGateRefusalReported,
  milestoneSyncStreakPath,
  recordGateRefusal,
  resetConflictLedgerOnSuccess,
  saveSyncStreaks,
  type SyncStreakEntry,
  type SyncStreaks,
} from "../lib/milestone_sync_streak.ts";
import {
  milestonePacedUntil,
  presyncMilestoneBranch,
  presyncMilestoneOnceForArming,
  resetMilestoneArmSyncMemo,
} from "../lib/milestone_presync.ts";
import type {
  IssueRunPresyncArgs,
  MilestonePresyncDeps,
} from "../lib/milestone_presync.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { Logger } from "../types.ts";
import { MilestoneConflictEscalation } from "../lib/milestone_conflict_triage.ts";
import {
  buildGateWedgeDiagnosticBody,
  GATE_WEDGE_DIAGNOSTIC_REPO,
  gateWedgeDiagnosticTitle,
  reportGateWedge,
} from "../lib/milestone_gate_wedge.ts";

const REPO = "owner/repo";
const MILESTONE_TITLE = "#2298 worker deno lib: merge conflicts";
const MILESTONE = "milestone/2298-worker-deno-lib-merge-conflicts";
const DEFAULT_BRANCH = "main";
const DEFAULT_SHA = "d".repeat(40);
const MILESTONE_SHA = "m".repeat(40);
const GATE_VERDICT = "no test:unit/test task, Cargo.toml or quality.sh under " +
  "'/work/repo' — nothing ran the cases";
const NOW = Date.parse("2026-09-18T12:00:00.000Z");

/** The refusal the ledger counts repeats of. */
const REFUSAL = {
  conflictKey: `${MILESTONE}@${MILESTONE_SHA.slice(0, 12)}:lib/foo_test.ts`,
  reason: GATE_VERDICT,
  defaultSha: DEFAULT_SHA,
  milestoneSha: MILESTONE_SHA,
};

const EMPTY: SyncStreakEntry = { count: 0, escalated: false };

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  skipReason: () => {},
  timing: () => {},
  scanSummary: () => {},
  workerSummary: () => {},
};

// ---------------------------------------------------------------------------
// The ledger transition
// ---------------------------------------------------------------------------

Deno.test("recordGateRefusal - the same refusal twice wedges the branch", () => {
  const once = recordGateRefusal(EMPTY, REFUSAL, NOW);
  assertEquals(once.gateRefusal?.count, 1);
  assertEquals(
    isGateWedged(once),
    false,
    "one refusal is a verdict, not a wedge",
  );

  const twice = recordGateRefusal(once, REFUSAL, NOW + 3_600_000);
  assertEquals(twice.gateRefusal?.count, GATE_REFUSAL_WEDGE_THRESHOLD);
  assertEquals(isGateWedged(twice), true);
  assertEquals(twice.gateRefusal?.at, new Date(NOW + 3_600_000).toISOString());
});

Deno.test("recordGateRefusal - a moved default tip is a different merge, so the count restarts", () => {
  const once = recordGateRefusal(EMPTY, REFUSAL, NOW);
  const moved = recordGateRefusal(
    once,
    { ...REFUSAL, defaultSha: "e".repeat(40) },
    NOW + 1,
  );
  assertEquals(moved.gateRefusal?.count, 1);
  assertEquals(isGateWedged(moved), false);
});

Deno.test("recordGateRefusal - a different gate verdict restarts the count", () => {
  const once = recordGateRefusal(EMPTY, REFUSAL, NOW);
  const different = recordGateRefusal(
    once,
    { ...REFUSAL, reason: "deno task test failed (exit 1)" },
    NOW + 1,
  );
  assertEquals(different.gateRefusal?.count, 1);
});

Deno.test("recordGateRefusal - a repeat keeps the reported flag so one diagnostic is filed", () => {
  const wedged = markGateRefusalReported(
    recordGateRefusal(recordGateRefusal(EMPTY, REFUSAL, NOW), REFUSAL, NOW + 1),
  );
  assertEquals(wedged.gateRefusal?.reported, true);
  const again = recordGateRefusal(wedged, REFUSAL, NOW + 2);
  assertEquals(again.gateRefusal?.count, 3);
  assertEquals(again.gateRefusal?.reported, true);
});

Deno.test("isSameGateRefusal - all three of conflict, verdict and default tip must match", () => {
  const record = recordGateRefusal(EMPTY, REFUSAL, NOW).gateRefusal!;
  assert(isSameGateRefusal(record, REFUSAL));
  assert(!isSameGateRefusal(record, { ...REFUSAL, conflictKey: "other" }));
  assert(!isSameGateRefusal(undefined, REFUSAL));
});

Deno.test("gateWedgeTipsMoved - either side moving lifts the hold; an unreadable tip does not", () => {
  const wedged = recordGateRefusal(
    recordGateRefusal(EMPTY, REFUSAL, NOW),
    REFUSAL,
    NOW + 1,
  );
  assertEquals(
    gateWedgeTipsMoved(wedged, {
      defaultSha: DEFAULT_SHA,
      milestoneSha: MILESTONE_SHA,
    }),
    false,
  );
  assertEquals(
    gateWedgeTipsMoved(wedged, {
      defaultSha: "f".repeat(40),
      milestoneSha: MILESTONE_SHA,
    }),
    true,
    "the default branch moved",
  );
  assertEquals(
    gateWedgeTipsMoved(wedged, {
      defaultSha: DEFAULT_SHA,
      milestoneSha: "a".repeat(40),
    }),
    true,
    "a child PR moved the milestone branch",
  );
  assertEquals(
    gateWedgeTipsMoved(wedged, { defaultSha: DEFAULT_SHA }),
    false,
    "a tip nobody could read is not evidence that it moved",
  );
});

Deno.test("resetConflictLedgerOnSuccess - a landed sync drops the wedge", () => {
  const wedged = recordGateRefusal(
    recordGateRefusal(EMPTY, REFUSAL, NOW),
    REFUSAL,
    NOW + 1,
  );
  assertEquals(resetConflictLedgerOnSuccess(wedged).gateRefusal, undefined);
  assertEquals(clearGateRefusal(wedged).gateRefusal, undefined);
});

Deno.test("loadSyncStreaks - the wedge survives a round trip and a malformed one is dropped", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-2388-ledger-" });
  try {
    const path = milestoneSyncStreakPath(dir);
    const key = `${REPO}|${MILESTONE}`;
    const wedged = recordGateRefusal(
      recordGateRefusal(EMPTY, REFUSAL, NOW),
      REFUSAL,
      NOW + 1,
    );
    await saveSyncStreaks(path, { [key]: wedged });
    const loaded = await loadSyncStreaks(path);
    assertEquals(loaded[key]?.gateRefusal?.count, 2);
    assertEquals(loaded[key]?.gateRefusal?.reason, GATE_VERDICT);

    await Deno.writeTextFile(
      path,
      JSON.stringify({
        [key]: { count: 0, escalated: false, gateRefusal: { count: "two" } },
      }),
    );
    assertEquals((await loadSyncStreaks(path))[key]?.gateRefusal, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The selector: a wedged milestone stops being claimed
// ---------------------------------------------------------------------------

Deno.test("milestonePacedUntil - a wedged gate holds the milestone's issues back", () => {
  const key = `${REPO}|${MILESTONE}`;
  const once: SyncStreaks = {
    [key]: recordGateRefusal(EMPTY, REFUSAL, NOW),
  };
  assertEquals(
    milestonePacedUntil(once, REPO, MILESTONE_TITLE),
    undefined,
    "one refusal still leaves the ladder something to try",
  );

  const wedged: SyncStreaks = {
    [key]: recordGateRefusal(once[key]!, REFUSAL, NOW + 1),
  };
  const paced = milestonePacedUntil(wedged, REPO, MILESTONE_TITLE);
  assert(paced !== undefined, "a wedged gate must pace the children");
  assertStringIncludes(paced, "refused the same resolution 2 times");
  assertStringIncludes(paced, GATE_VERDICT);
});

// ---------------------------------------------------------------------------
// The pre-cut sync: one attempt per milestone, and none at all once wedged
// ---------------------------------------------------------------------------

/** Injected git work for the pre-cut sync. */
function deps(
  overrides: Partial<MilestonePresyncDeps> & { behindBy?: number } = {},
): MilestonePresyncDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    countBehind: overrides.countBehind ??
      (() => Promise.resolve({ ok: true as const, value: 155 })),
    defaultTipSha: overrides.defaultTipSha ??
      (() => Promise.resolve({ ok: true as const, value: DEFAULT_SHA })),
    milestoneTipSha: overrides.milestoneTipSha ??
      (() => Promise.resolve({ ok: true as const, value: MILESTONE_SHA })),
    syncBranch: overrides.syncBranch ??
      (() =>
        Promise.resolve({ ok: true as const, value: { message: "merged" } })),
    log: (message: string) => logs.push(message),
  };
}

/** A gate refusal exactly as the resolution gate raises one. */
function gateRefusal(
  defaultSha = DEFAULT_SHA,
  milestoneSha = MILESTONE_SHA,
): MilestoneConflictEscalation {
  return new MilestoneConflictEscalation(
    "the merge gate refused the resolution",
    [],
    [{
      path: "lib/foo_test.ts",
      case: "test-union",
      action: "union",
      reason: "the milestone side is a union of both",
    }],
    defaultSha,
    GATE_VERDICT,
    milestoneSha,
  );
}

/** A ledger file in a temp work directory. */
async function ledger(entries: SyncStreaks = {}) {
  const workDir = await Deno.makeTempDir({ prefix: "issue-2388-presync-" });
  const path = milestoneSyncStreakPath(workDir);
  if (Object.keys(entries).length > 0) await saveSyncStreaks(path, entries);
  return {
    path,
    cleanup: () => Deno.remove(workDir, { recursive: true }).catch(() => {}),
  };
}

Deno.test("presyncMilestoneBranch - a gate refusal is counted on the ledger", async () => {
  const fx = await ledger();
  try {
    const result = await presyncMilestoneBranch({
      repo: REPO,
      milestoneBranch: MILESTONE,
      defaultBranch: DEFAULT_BRANCH,
      streakPath: fx.path,
      grant: { agentAllowed: true },
      nowMs: NOW,
    }, deps({
      syncBranch: () =>
        Promise.resolve({ ok: false as const, error: gateRefusal() }),
    }));

    assertEquals(result.status, "deferred");
    const entry = (await loadSyncStreaks(fx.path))[`${REPO}|${MILESTONE}`];
    assertEquals(entry?.gateRefusal?.count, 1);
    assertEquals(entry?.gateRefusal?.reason, GATE_VERDICT);
    assertEquals(entry?.gateRefusal?.defaultSha, DEFAULT_SHA);
    // The refusal is still not charged to the conflict budget — the wedge
    // record, not the budget, is what concludes it.
    assertEquals(entry?.conflictAttempts ?? 0, 0);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("presyncMilestoneBranch - the second identical refusal wedges it and the third runs no merge", async () => {
  const fx = await ledger();
  try {
    let merges = 0;
    const run = (nowMs: number) =>
      presyncMilestoneBranch({
        repo: REPO,
        milestoneBranch: MILESTONE,
        defaultBranch: DEFAULT_BRANCH,
        streakPath: fx.path,
        grant: { agentAllowed: true },
        nowMs,
      }, deps({
        syncBranch: () => {
          merges++;
          return Promise.resolve({ ok: false as const, error: gateRefusal() });
        },
      }));

    await run(NOW);
    await run(NOW + 3_600_000);
    assertEquals(merges, 2);

    const third = await run(NOW + 7_200_000);
    assertEquals(third.status, "deferred");
    assertEquals(merges, 2, "a wedged gate rebuilds nothing");
    assertStringIncludes(
      third.detail,
      "refused the same resolution 2 times and neither",
    );
    assertStringIncludes(third.detail, GATE_VERDICT);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("presyncMilestoneBranch - a moved default tip lifts the wedge and the ladder tries again", async () => {
  const fx = await ledger();
  try {
    let merges = 0;
    const run = (nowMs: number, defaultSha: string) =>
      presyncMilestoneBranch({
        repo: REPO,
        milestoneBranch: MILESTONE,
        defaultBranch: DEFAULT_BRANCH,
        streakPath: fx.path,
        grant: { agentAllowed: true },
        nowMs,
      }, deps({
        defaultTipSha: () =>
          Promise.resolve({ ok: true as const, value: defaultSha }),
        syncBranch: () => {
          merges++;
          return Promise.resolve({
            ok: false as const,
            error: gateRefusal(defaultSha),
          });
        },
      }));

    await run(NOW, DEFAULT_SHA);
    await run(NOW + 1000, DEFAULT_SHA);
    assertEquals(merges, 2);

    // The default branch moved on: a different merge, so it is tried.
    const moved = "9".repeat(40);
    await run(NOW + 2000, moved);
    assertEquals(merges, 3);
    const entry = (await loadSyncStreaks(fx.path))[`${REPO}|${MILESTONE}`];
    assertEquals(entry?.gateRefusal?.count, 1);
    assertEquals(entry?.gateRefusal?.defaultSha, moved);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("presyncMilestoneBranch - a landed sync clears the wedge", async () => {
  const wedged = recordGateRefusal(
    recordGateRefusal(EMPTY, REFUSAL, NOW),
    REFUSAL,
    NOW + 1,
  );
  const fx = await ledger({ [`${REPO}|${MILESTONE}`]: wedged });
  try {
    // A moved milestone tip lifts the hold; this attempt then lands.
    const result = await presyncMilestoneBranch({
      repo: REPO,
      milestoneBranch: MILESTONE,
      defaultBranch: DEFAULT_BRANCH,
      streakPath: fx.path,
      grant: { agentAllowed: true },
      nowMs: NOW + 2,
    }, deps({
      milestoneTipSha: () =>
        Promise.resolve({ ok: true as const, value: "7".repeat(40) }),
    }));

    assertEquals(result.status, "synced");
    const entry = (await loadSyncStreaks(fx.path))[`${REPO}|${MILESTONE}`];
    assertEquals(entry?.gateRefusal, undefined);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("presyncMilestoneOnceForArming - three issues of one milestone in one run share one refused attempt", async () => {
  resetMilestoneArmSyncMemo();
  const workDir = await Deno.makeTempDir({ prefix: "issue-2388-memo-" });
  try {
    let syncs = 0;
    const args = {
      repo: REPO,
      milestoneTitle: MILESTONE_TITLE,
      milestoneBranch: MILESTONE,
      defaultBranch: DEFAULT_BRANCH,
      cwd: workDir,
      workDir,
      config: { ...buildDefaultWorkerConfig(), workDir },
      logger: silentLogger,
      countCommitsAheadFn: () =>
        Promise.resolve({ ok: true as const, value: 155 }),
      syncMilestoneBranchFn: (() => {
        syncs++;
        return Promise.resolve({ ok: false as const, error: gateRefusal() });
      }) as unknown as IssueRunPresyncArgs["syncMilestoneBranchFn"],
      runGitCommandFn: () =>
        Promise.resolve({
          ok: true as const,
          value: { code: 0, stdout: MILESTONE_SHA, stderr: "" },
        }),
    } satisfies IssueRunPresyncArgs;

    // One milestone, three issues claimed in the same run.
    const results = await Promise.all([
      presyncMilestoneOnceForArming(args),
      presyncMilestoneOnceForArming(args),
      presyncMilestoneOnceForArming(args),
    ]);

    for (const result of results) assertEquals(result.status, "deferred");
    assertEquals(syncs, 1, "one attempt per milestone per run, not per issue");
  } finally {
    resetMilestoneArmSyncMemo();
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// The diagnostic: filed in VibeCoder, never as a needs-human sibling comment
// ---------------------------------------------------------------------------

const REPORT = {
  repo: REPO,
  milestoneBranch: MILESTONE,
  defaultBranch: DEFAULT_BRANCH,
  milestoneTitle: MILESTONE_TITLE,
  refusal: { ...REFUSAL, count: 2, at: new Date(NOW).toISOString() },
};

Deno.test("buildGateWedgeDiagnosticBody - names the repository, milestone, verdict and count", () => {
  const body = buildGateWedgeDiagnosticBody(REPORT);
  assertStringIncludes(body, REPO);
  assertStringIncludes(body, MILESTONE);
  assertStringIncludes(body, MILESTONE_TITLE);
  assertStringIncludes(body, GATE_VERDICT);
  assertStringIncludes(body, "refused the same resolution 2 time(s)");
  assertStringIncludes(body, "milestone_resolution_gate.ts");
  assertEquals(
    body.includes("needs a human"),
    false,
    "a conflict is never a human's to resolve",
  );
});

Deno.test("reportGateWedge - files one diagnostic in VibeCoder when none is open", async () => {
  const calls: string[][] = [];
  const filed = await reportGateWedge(REPORT, {
    ghCommandFn: (args) => {
      calls.push(args);
      if (args[1] === "list") return Promise.resolve("[]");
      return Promise.resolve("https://github.com/x/y/issues/9");
    },
    log: () => {},
    dedupAuthors: { fleetAuthors: ["vibe-coder"] },
  });

  assertEquals(filed, true);
  const create = calls.find((a) => a[0] === "issue" && a[1] === "create")!;
  assert(create !== undefined, "the diagnostic is created");
  assertEquals(create[create.indexOf("--repo") + 1], GATE_WEDGE_DIAGNOSTIC_REPO);
  assertEquals(
    create[create.indexOf("--title") + 1],
    gateWedgeDiagnosticTitle(REPO, MILESTONE),
  );
  assertEquals(create[create.indexOf("--label") + 1], "bug");
  // Never the monitored repository, and never a sibling issue in it.
  assertEquals(calls.some((a) => a.includes(REPO)), false);
});

Deno.test("reportGateWedge - appends to the open diagnostic instead of filing a second", async () => {
  const calls: string[][] = [];
  const filed = await reportGateWedge(REPORT, {
    ghCommandFn: (args) => {
      calls.push(args);
      if (args[1] === "list") {
        return Promise.resolve(JSON.stringify([{
          number: 4242,
          title: gateWedgeDiagnosticTitle(REPO, MILESTONE),
          author: { login: "vibe-coder" },
        }]));
      }
      return Promise.resolve("");
    },
    log: () => {},
    dedupAuthors: { fleetAuthors: ["vibe-coder"] },
  });

  assertEquals(filed, true);
  assertEquals(calls.some((a) => a[1] === "create"), false);
  const comment = calls.find((a) => a[1] === "comment")!;
  assertEquals(comment[2], "4242");
});

Deno.test("reportGateWedge - a refused write reports not-filed so the next cycle retries", async () => {
  const filed = await reportGateWedge(REPORT, {
    ghCommandFn: (args) =>
      args[1] === "list"
        ? Promise.resolve("[]")
        : Promise.reject(new Error("gh: 403")),
    log: () => {},
    dedupAuthors: { fleetAuthors: ["vibe-coder"] },
  });
  assertEquals(filed, false);
});
