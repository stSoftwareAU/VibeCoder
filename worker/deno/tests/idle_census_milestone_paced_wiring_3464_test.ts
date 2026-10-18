/**
 * Production wiring for the milestone-pacing hold in the census (Issue #3464).
 *
 * The claim scan skips every issue of a milestone the persisted pacing
 * ledger holds (`milestone-behind`, Issue #1780), but the census counted them
 * claimable, so a persistently paced milestone raised a false
 * `inversion_signal` every cycle. The fix is one production wiring in
 * `run_core_production_deps.ts`: load the ledger from the path the scan reads
 * and union the paced issues into `runLocalHolds`. Every other test drives
 * the pure census with hand-built input, so only this one drives the real
 * `createProductionRunCoreDeps`, with a stub `gh` that returns only the
 * `--json` fields requested (CODING-STANDARDS.md "A stub mirrors the real
 * callee's contract").
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMilestoneBranchName } from "../lib/git_branch.ts";
import { MILESTONE_CONFLICT_ATTEMPT_BUDGET } from "../lib/milestone_sync_streak.ts";
import {
  milestoneSyncStreakPath,
  saveSyncStreaks,
  syncStreakKey,
  type SyncStreaks,
} from "../lib/milestone_sync_streak.ts";

const REPO = "org/paced-milestone-fixture";
const WORKER_USER = "worker-bot";
const MILESTONE = "Paced Milestone";
const TRUSTED = "alice";

/** The one issue's fields, keyed by gh field name. */
const FIXTURE_FIELDS: Record<string, unknown> = {
  number: 3464,
  title: "Issue in a paced milestone",
  labels: [{ name: "work-on" }],
  assignees: [],
  milestone: { title: MILESTONE },
  body: "",
  subIssuesSummary: { total: 0, completed: 0 },
};

/**
 * Mirrors real `gh issue list --json <fields>`: only requested fields. The
 * timeline answers with a `work-on` add by the trusted author (Issue #3571).
 */
function stubGh(args: string[]): Promise<string> {
  if (args[0] === "issue" && args[1] === "list") {
    const requested = new Set(
      (args[args.indexOf("--json") + 1] ?? "").split(","),
    );
    const row: Record<string, unknown> = {};
    for (const field of Object.keys(FIXTURE_FIELDS)) {
      if (requested.has(field)) row[field] = FIXTURE_FIELDS[field];
    }
    return Promise.resolve(JSON.stringify([row]));
  }
  if (
    args[0] === "api" && /\/issues\/(\d+)\/timeline/.test(args[1] ?? "")
  ) {
    return Promise.resolve(JSON.stringify([{
      id: 1,
      event: "labeled",
      label: { name: "work-on" },
      actor: { login: TRUSTED },
      created_at: "2026-01-01T00:00:00Z",
    }]));
  }
  return Promise.resolve("[]");
}

/** Run both idle instruments for one cycle, optionally with a paced ledger. */
async function idleLines(paced: boolean): Promise<string[]> {
  const workDir = await Deno.makeTempDir({ prefix: "idle-paced-wiring-" });
  try {
    if (paced) {
      const streaks: SyncStreaks = {
        [syncStreakKey(REPO, createMilestoneBranchName(MILESTONE))]: {
          count: 2,
          escalated: false,
          conflictAttempts: MILESTONE_CONFLICT_ATTEMPT_BUDGET,
        },
      };
      await saveSyncStreaks(milestoneSyncStreakPath(workDir), streaks);
    }
    const lines: string[] = [];
    const { deps } = await createProductionRunCoreDeps({
      repoDir: workDir,
      workDir,
      githubUser: WORKER_USER,
      logger: createLogger({ write: (line: string) => lines.push(line) }),
      config: { ...buildDefaultWorkerConfig(), repos: [REPO], workDir },
      // Issue #3571: the census models the label-author gate, so trust the adder.
      resolveTrustedAuthors: () =>
        Promise.resolve({
          ok: true,
          byRepo: new Map([[
            REPO,
            { allowedAuthors: [TRUSTED], authorisedCommenters: [TRUSTED] },
          ]]),
        }),
      idleDetectGhCommandFn: stubGh,
    });
    assertEquals((await deps.refreshTrustedAuthors!()).ok, true);
    await deps.runIdleDetectAudit!({
      tick: 1,
      scanFoundClaimable: false,
      scanExcludedRepos: [],
    });
    await deps.runIdleDecisionCensus!({
      decisionPoint: "filing",
      claimScanCompleted: true,
      claimedRepos: [],
      scanExcludedRepos: [],
    });
    return lines;
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

function repoLine(lines: string[]): string {
  const line = lines.find((l) =>
    l.includes("[idle-census]") && l.includes(`repo=${REPO}`)
  );
  assert(line !== undefined, "the census logged no line for the repo");
  return line;
}

Deno.test(
  "production deps - the census holds a paced milestone's issue as run_local_hold, not claimable (Issue #3464)",
  async () => {
    const line = repoLine(await idleLines(true));
    assert(line.includes("claim_refused=0"), line);
    assert(line.includes("run_local_hold=1"), line);
    assert(line.includes("work_on=0"), line);
    assert(!line.includes("inversion_signal=true"), line);
  },
);

Deno.test(
  "production deps - without a ledger entry the same issue is claimable (Issue #3464 negative control)",
  async () => {
    const line = repoLine(await idleLines(false));
    assert(line.includes("claim_refused=0"), line);
    assert(line.includes("run_local_hold=0"), line);
    assert(line.includes("work_on=1"), line);
  },
);
