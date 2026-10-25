/**
 * A merge-only admission reaches the sync as merge-only gates and agent
 * (Issue #4326).
 *
 * These drive the real `presyncMilestoneBranchForIssueRun` and record the three
 * bindings its `syncBranch` hands `syncMilestoneBranchFn`: the merge gate, the
 * resolution gate and the agent. On a cargo tree an admission of merge-only
 * must give the merge-only gates and agent; an admission to build must give
 * none of them and the real bound agent. The recorded gates are the call
 * site's own argument list, so the assertions state what the presync passes.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type IssueRunPresyncArgs,
  presyncMilestoneBranchForIssueRun,
} from "../lib/milestone_presync.ts";
import type { HeavyBuildAdmission } from "../lib/heavy_build_gate.ts";
import type { MergeGateFn } from "../lib/milestone_merge_gate.ts";
import type { MilestoneConflictAgentFn } from "../lib/milestone_conflict_ladder.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { Logger } from "../types.ts";

const REPO = "owner/repo";
const MILESTONE = "milestone/4326-merge-only-presync";
const DEFAULT_BRANCH = "main";
const CARGO_TOML = '[package]\nname = "fixture"\nversion = "0.0.0"\n';
const REASON =
  "ephemeral cargo root over budget (55.3 GB free, floor 46.0 GB + headroom " +
  "25.0 GB) — pruned 0.0 GB of idle target dirs and 15.7 GB is still short, " +
  "so cargo builds wait for CI (Issue #3178 budget; Issue #4326 skip); cargo " +
  "builds wait for CI; Deno projects keep their normal checks (Issue #4326)";

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

/** The three bindings the presync's sync received, in its argument order. */
interface RecordedBindings {
  mergeGate: MergeGateFn | undefined;
  resolutionGate: MergeGateFn | undefined;
  agentFn: MilestoneConflictAgentFn | undefined;
}

/**
 * A `syncMilestoneBranchFn` that records the bindings it is called with (the
 * fifth, sixth and seventh positional arguments) and reports a clean merge.
 */
function recordingSync(): {
  fn: IssueRunPresyncArgs["syncMilestoneBranchFn"];
  calls: RecordedBindings[];
} {
  const calls: RecordedBindings[] = [];
  const fn = ((...args: unknown[]) => {
    calls.push({
      mergeGate: args[4] as MergeGateFn | undefined,
      resolutionGate: args[5] as MergeGateFn | undefined,
      agentFn: args[6] as MilestoneConflictAgentFn | undefined,
    });
    return Promise.resolve({ ok: true as const, value: { message: "merged" } });
  }) as unknown as IssueRunPresyncArgs["syncMilestoneBranchFn"];
  return { fn, calls };
}

/** The real agent's runner, counting runs; a run is refused, never made. */
function agentSpy(): {
  fn: IssueRunPresyncArgs["runAgentFn"];
  runs: { count: number };
} {
  const runs = { count: 0 };
  const fn = (() => {
    runs.count++;
    return Promise.resolve({
      ok: false as const,
      error: new Error("stub agent run"),
    });
  }) as unknown as IssueRunPresyncArgs["runAgentFn"];
  return { fn, runs };
}

/** A temp tree holding a Cargo project, so the gates decide from it. */
async function cargoTree(): Promise<string> {
  const tree = await Deno.makeTempDir({ prefix: "issue-4326-presync-tree-" });
  await Deno.writeTextFile(`${tree}/Cargo.toml`, CARGO_TOML);
  return tree;
}

/** Runs the real presync for one admission, with every git read injected. */
function runPresync(
  admission: HeavyBuildAdmission,
  tree: string,
  workDir: string,
  sync: IssueRunPresyncArgs["syncMilestoneBranchFn"],
  runAgentFn: IssueRunPresyncArgs["runAgentFn"],
) {
  return presyncMilestoneBranchForIssueRun(
    {
      repo: REPO,
      milestoneTitle: "#4326 Merge-only presync",
      milestoneBranch: MILESTONE,
      defaultBranch: DEFAULT_BRANCH,
      cwd: tree,
      workDir,
      config: { ...buildDefaultWorkerConfig(), workDir },
      logger: silentLogger,
      countCommitsAheadFn: () =>
        Promise.resolve({ ok: true as const, value: 2 }),
      heavyBuildAdmissionFn: () => Promise.resolve(admission),
      syncMilestoneBranchFn: sync,
      runAgentFn,
      runGitCommandFn: () =>
        Promise.resolve({
          ok: true as const,
          value: { code: 0, stdout: "a".repeat(40), stderr: "" },
        }),
    } satisfies IssueRunPresyncArgs,
  );
}

Deno.test("presync - a merge-only admission hands the sync the merge-only gates and agent on a cargo tree (Issue #4326)", async () => {
  const tree = await cargoTree();
  const workDir = await Deno.makeTempDir({
    prefix: "issue-4326-presync-work-",
  });
  try {
    const sync = recordingSync();
    const agent = agentSpy();
    const result = await runPresync(
      { mode: "merge-only", reason: REASON },
      tree,
      workDir,
      sync.fn,
      agent.fn,
    );

    assertEquals(result.status, "synced");
    assertEquals(sync.calls.length, 1, "the sync ran once");
    const { mergeGate, resolutionGate, agentFn } = sync.calls[0]!;
    assert(mergeGate !== undefined, "a merge-only sync hands its merge gate");
    assert(
      resolutionGate !== undefined,
      "a merge-only sync hands its resolution gate",
    );
    assert(agentFn !== undefined, "a merge-only sync hands its agent");

    // The gates decide from the tree they are handed, so a cargo tree's
    // conflict-free merge is skipped and its resolution lands unverified.
    const merged = await mergeGate(tree);
    assertEquals(merged.status, "skipped");
    const resolved = await resolutionGate(tree);
    assertEquals(resolved.status, "skipped");
    assertEquals(resolved.landUnverified, true);

    // A cargo tree withholds the granted agent. The real agent is never run.
    const outcome = await agentFn({
      conflictedFiles: ["src/lib.rs"],
      milestoneBranch: MILESTONE,
      defaultBranch: DEFAULT_BRANCH,
      workDir: tree,
    });
    assert(!outcome.ok, "a cargo tree withholds the granted agent");
    assertStringIncludes(
      outcome.error.message,
      "cargo budget withheld the agent",
    );
    assertEquals(agent.runs.count, 0, "the real agent was never run");
  } finally {
    await Deno.remove(tree, { recursive: true }).catch(() => {});
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("presync - a build admission hands the sync no merge-only gates and the real agent (Issue #4326)", async () => {
  const tree = await cargoTree();
  const workDir = await Deno.makeTempDir({
    prefix: "issue-4326-presync-work-",
  });
  try {
    const sync = recordingSync();
    const agent = agentSpy();
    const result = await runPresync(
      { mode: "build" },
      tree,
      workDir,
      sync.fn,
      agent.fn,
    );

    assertEquals(result.status, "synced");
    assertEquals(sync.calls.length, 1, "the sync ran once");
    const { mergeGate, resolutionGate, agentFn } = sync.calls[0]!;
    assertEquals(mergeGate, undefined, "a build hands no merge-only gate");
    assertEquals(
      resolutionGate,
      undefined,
      "a build hands no merge-only resolution gate",
    );
    assert(agentFn !== undefined, "a build hands the real bound agent");

    // The real bound agent runs: the spy is reached, and its refusal comes
    // back as an agent failure, not as the merge-only provider stub.
    const outcome = await agentFn({
      conflictedFiles: ["src/lib.rs"],
      milestoneBranch: MILESTONE,
      defaultBranch: DEFAULT_BRANCH,
      workDir: tree,
    });
    assertEquals(agent.runs.count, 1, "the real bound agent ran once");
    assert(!outcome.ok, "the spy's refusal comes back as a failure");
    assertStringIncludes(outcome.error.message, "stub agent run");
  } finally {
    await Deno.remove(tree, { recursive: true }).catch(() => {});
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
});
