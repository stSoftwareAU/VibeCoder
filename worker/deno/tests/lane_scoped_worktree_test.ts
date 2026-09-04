/**
 * An issue slot works in its own tree, not the shared clone (Issue #923).
 *
 * Every issue slot took its working tree from `setupRepo(repo, workDir)`,
 * which resolves to `${WORK_DIR}/<repo>` for all of them, and which opens
 * with `reset --hard` + `clean -fd`. Two slots in one repository would
 * therefore have thrown away each other's work, so the pool refused to let
 * that happen: `run_core.ts` excludes from a slot's scan every repository a
 * sibling slot holds (Issue #4176).
 *
 * That exclusion is why a two-slot fleet has the throughput of one. Measured
 * on GRQ-23 over 47 minutes, with `s1` working VibeCoder#840:
 *
 * ```text
 * [s2] no eligible work: considered=1 eligible=0 skipped=1
 *   top-skips=dependency-blocked=1 — re-scanning in 30s while 1 sibling
 *   slot(s) work
 * ```
 *
 * Nine of the fleet's ten claimable issues were in VibeCoder and invisible
 * to `s2`; the one issue it could see was blocked. Seventy-four consecutive
 * scans, all correct, all useless.
 *
 * The fix is the mechanism Issue #394 already built for the maintenance
 * lane: a linked git worktree, which gives the lane its own `HEAD`, index
 * and checkout while sharing one object store. Sharing the object store is
 * the point — the work volume is a sparse image that only ever grows, so a
 * clone per slot would permanently multiply the checkout footprint of every
 * monitored repository.
 *
 * These tests pin the seam only. Relaxing the exclusion itself is a later
 * step, and must not happen before the Claude session store — still keyed
 * `(workDir, repo, milestone)` — is scoped too.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { workOnIssueSetupBranch } from "../lib/phases/setup_branch_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { laneWorktreePath } from "../lib/lane_worktree.ts";
import { stopHeartbeat } from "../lib/heartbeat.ts";

function buildState(): PhaseState {
  return {
    branchName: "",
    baseBranch: "main", // allow-hardcoded-branch — fixture default branch
    defaultBranch: "main", // allow-hardcoded-branch — fixture default branch
    repoPath: "",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

function buildContext(workDir: string, laneId?: string): IssueContext {
  return {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 923,
    issueTitle: "Only one slot can work a repository",
    issueBody: "",
    issueLabels: ["top-priority"],
    issueComments: "",
    githubUser: "vibe-worker",
    config: { ...buildDefaultWorkerConfig(), workDir },
    ...(laneId === undefined ? {} : { laneId }),
  };
}

/** Deps that record every lane id `setupRepo` is asked for. */
function depsRecordingLanes(seen: (string | undefined)[]) {
  return createMockDeps({
    git: {
      setupRepo: (_repo: string, workDir: string, laneId?: string) => {
        seen.push(laneId);
        return Promise.resolve({
          ok: true as const,
          value: laneId === undefined
            ? `${workDir}/VibeCoder`
            : laneWorktreePath(workDir, "stSoftwareAU/VibeCoder", laneId),
        });
      },
      createFeatureBranchFromBase: (branch: string) =>
        Promise.resolve({ ok: true as const, value: branch }),
    },
  });
}

/** Run the setup phase and return the tree it settled on. */
async function runSetup(
  workDir: string,
  laneId: string | undefined,
  seen: (string | undefined)[],
): Promise<string> {
  const ctx = buildContext(workDir, laneId);
  const state = buildState();
  await workOnIssueSetupBranch(ctx, state, depsRecordingLanes(seen));
  if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  return state.repoPath;
}

Deno.test("lane worktree - a slot's run asks for that slot's tree (Issue #923)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue923-lane-" });
  try {
    const seen: (string | undefined)[] = [];
    const repoPath = await runSetup(workDir, "s2", seen);
    assertEquals(seen, ["s2"]);
    assertEquals(
      repoPath,
      laneWorktreePath(workDir, "stSoftwareAU/VibeCoder", "s2"),
    );
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("lane worktree - two slots in one repository get disjoint trees (Issue #923)", async () => {
  // The property the repo-level exclusion existed to guarantee, now held by
  // the filesystem instead: neither slot can move the other's HEAD.
  const workDir = await Deno.makeTempDir({ prefix: "issue923-two-" });
  try {
    const seen: (string | undefined)[] = [];
    const first = await runSetup(workDir, "s1", seen);
    const second = await runSetup(workDir, "s2", seen);
    assertEquals(seen, ["s1", "s2"]);
    assertNotEquals(first, second);
    assertEquals(first.startsWith(workDir), true);
    assertEquals(second.startsWith(workDir), true);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("lane worktree - a run with no lane still uses the shared clone (Issue #923)", async () => {
  // The CLI single-issue path and the tests pass no lane, and must keep the
  // behaviour they have: `setupRepo` against `${WORK_DIR}/<repo>`.
  const workDir = await Deno.makeTempDir({ prefix: "issue923-none-" });
  try {
    const seen: (string | undefined)[] = [];
    const repoPath = await runSetup(workDir, undefined, seen);
    assertEquals(seen, [undefined]);
    assertEquals(repoPath, `${workDir}/VibeCoder`);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("lane worktree - a lane's tree never escapes the work root (Issue #923)", () => {
  // `laneId` reaches this from the slot pool, and a path segment that
  // escaped `${WORK_DIR}` would put a checkout somewhere the housekeeping
  // sweeps never look.
  const workDir = "/work";
  for (const lane of ["..", "", ".", "a/b", "a\\b"]) {
    let threw = false;
    try {
      laneWorktreePath(workDir, "stSoftwareAU/VibeCoder", lane);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `lane id "${lane}" must be refused`);
  }
  assertEquals(
    laneWorktreePath(workDir, "stSoftwareAU/VibeCoder", "s2").startsWith(
      `${workDir}/`,
    ),
    true,
  );
});
