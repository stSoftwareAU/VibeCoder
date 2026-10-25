/**
 * The milestone sweep's own sync binding hands a merge-only grant the
 * merge-only gates and agent (Issue #4326).
 *
 * Drives `syncMilestoneBranchForSweep`, the function the sweep's `syncBranchFn`
 * calls, and records the three bindings it hands the sync (its fifth, sixth
 * and seventh positional arguments). On a cargo tree a grant carrying a
 * merge-only reason must give the merge-only gates and agent; a grant without
 * one must give none of them and the real bound agent. Mirrors
 * `milestone_presync_merge_only_4326_test.ts`, which pins the pre-cut sync's.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { syncMilestoneBranchForSweep } from "../lib/run_core_production_deps.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { MergeGateFn } from "../lib/milestone_merge_gate.ts";
import type { MilestoneConflictAgentFn } from "../lib/milestone_conflict_ladder.ts";
import type { SyncBranchOptions } from "../lib/milestone_branch_sync.ts";
import type { Logger } from "../types.ts";

const CARGO_TOML = '[package]\nname = "fixture"\nversion = "0.0.0"\n';
const REASON = "ephemeral cargo root over budget (test reading) (Issue #4326)";
const MILESTONE = "milestone/4326-merge-only-sweep";

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

interface Recorded {
  cwd: string | undefined;
  repo: string | undefined;
  mergeGate: MergeGateFn | undefined;
  resolutionGate: MergeGateFn | undefined;
  agentFn: MilestoneConflictAgentFn | undefined;
}

/** A sync that records the arguments the sweep hands it. */
function recordingSync() {
  const calls: Recorded[] = [];
  const fn = ((...args: unknown[]) => {
    calls.push({
      cwd: (args[2] as { cwd?: string }).cwd,
      repo: args[3] as string | undefined,
      mergeGate: args[4] as MergeGateFn | undefined,
      resolutionGate: args[5] as MergeGateFn | undefined,
      agentFn: args[6] as MilestoneConflictAgentFn | undefined,
    });
    return Promise.resolve({ ok: true as const, value: { message: "merged" } });
  }) as unknown as NonNullable<
    Parameters<typeof syncMilestoneBranchForSweep>[0]["syncFn"]
  >;
  return { fn, calls };
}

/** A runner for the real agent that counts runs and refuses each. */
function agentSpy() {
  const runs = { count: 0 };
  const fn = (() => {
    runs.count++;
    return Promise.resolve({
      ok: false as const,
      error: new Error("stub agent run"),
    });
  }) as unknown as NonNullable<
    Parameters<typeof syncMilestoneBranchForSweep>[0]["runAgent"]
  >;
  return { fn, runs };
}

/** A work directory holding `repo` with a Cargo project, as the sweep reads it. */
async function workDirWithCargoRepo(): Promise<string> {
  const workDir = await Deno.makeTempDir({ prefix: "issue-4326-sweep-" });
  await Deno.mkdir(`${workDir}/repo`);
  await Deno.writeTextFile(`${workDir}/repo/Cargo.toml`, CARGO_TOML);
  return workDir;
}

function run(
  workDir: string,
  syncOptions: SyncBranchOptions,
  sync: ReturnType<typeof recordingSync>,
  agent: ReturnType<typeof agentSpy>,
) {
  return syncMilestoneBranchForSweep({
    repo: "owner/repo",
    milestoneBranch: MILESTONE,
    defaultBranch: "main",
    syncOptions,
    workDir,
    config: { ...buildDefaultWorkerConfig(), workDir },
    logger: silentLogger,
    syncFn: sync.fn,
    runAgent: agent.fn,
  });
}

Deno.test("sweep sync - a merge-only grant hands the sync the merge-only gates and agent on a cargo tree (Issue #4326)", async () => {
  const workDir = await workDirWithCargoRepo();
  try {
    const sync = recordingSync();
    const agent = agentSpy();
    const result = await run(
      workDir,
      { agentAllowed: true, mergeOnly: REASON },
      sync,
      agent,
    );

    assert(result.ok, "the sync's result is returned");
    assertEquals(sync.calls.length, 1, "the sync ran once");
    const { cwd, repo, mergeGate, resolutionGate, agentFn } = sync.calls[0]!;
    assertEquals(cwd, `${workDir}/repo`);
    assertEquals(repo, "owner/repo");
    assert(mergeGate !== undefined, "a merge-only grant hands its merge gate");
    assert(
      resolutionGate !== undefined,
      "a merge-only grant hands its resolution gate",
    );
    assert(agentFn !== undefined, "a merge-only grant hands its agent");

    const merged = await mergeGate(`${workDir}/repo`);
    assertEquals(merged.status, "skipped");
    assertStringIncludes(merged.detail, REASON);
    const resolved = await resolutionGate(`${workDir}/repo`);
    assertEquals(resolved.status, "skipped");
    assertEquals(resolved.landUnverified, true);

    const outcome = await agentFn({
      conflictedFiles: ["src/lib.rs"],
      milestoneBranch: MILESTONE,
      defaultBranch: "main",
      workDir: `${workDir}/repo`,
    });
    assert(!outcome.ok, "a cargo tree withholds the granted agent");
    assertStringIncludes(
      outcome.error.message,
      "cargo budget withheld the agent",
    );
    assertStringIncludes(outcome.error.message, REASON);
    assertEquals(agent.runs.count, 0, "the real agent was never run");
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("sweep sync - a grant without a merge-only reason hands the sync no merge-only gates and the real agent (Issue #4326)", async () => {
  const workDir = await workDirWithCargoRepo();
  try {
    const sync = recordingSync();
    const agent = agentSpy();
    await run(workDir, { agentAllowed: true }, sync, agent);

    assertEquals(sync.calls.length, 1, "the sync ran once");
    const { mergeGate, resolutionGate, agentFn } = sync.calls[0]!;
    assertEquals(mergeGate, undefined, "a build hands no merge-only gate");
    assertEquals(resolutionGate, undefined, "a build hands no resolution gate");
    assert(agentFn !== undefined, "a build hands the real bound agent");

    const outcome = await agentFn({
      conflictedFiles: ["src/lib.rs"],
      milestoneBranch: MILESTONE,
      defaultBranch: "main",
      workDir: `${workDir}/repo`,
    });
    assertEquals(agent.runs.count, 1, "the real bound agent ran once");
    assert(!outcome.ok, "the spy's refusal comes back as a failure");
    assertStringIncludes(outcome.error.message, "stub agent run");
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
});
