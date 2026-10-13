/**
 * Production wiring for the nice-derived poll cadence (Issue #3667).
 *
 * The cadence itself is covered by `repo_poll_cadence_test.ts`; what is
 * worth asserting here is the composition: the factory's once-per-cycle
 * pick reads each repo's `nice` from `.config.json`, the per-repo Priority
 * 1.x passes then poll only the picked repos (PR feedback is the seam), a
 * burst latch since the last pick holds the low-priority tier, and a
 * factory that is never asked to pick polls every repo — fail open.
 *
 * Uses Australian English throughout (behaviour, prioritised, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { findPrCommentsToFix } from "../lib/pr_maintenance.ts";
import {
  clearPrimaryQuotaLatch,
  latchPrimaryQuota,
} from "../lib/primary_quota_latch.ts";
import type { RepoPollSelection } from "../lib/repo_poll_cadence.ts";

const REPOS = ["org/priority", "org/default", "org/low", "org/parked"];

/** Production deps over a fleet with one repo in each `nice` tier. */
async function withCadenceDeps(
  fn: (ctx: {
    select: () => RepoPollSelection;
    feedbackRepos: () => Promise<string[]>;
    lines: string[];
  }) => Promise<void>,
): Promise<void> {
  const lines: string[] = [];
  let scanned: string[] = [];
  const scan: typeof findPrCommentsToFix = (options) => {
    scanned = [...options.repos];
    return Promise.resolve({ ok: true, value: null });
  };
  const { deps, cleanup } = await createProductionRunCoreDeps({
    repoDir: "/tmp/test-repo-poll-cadence",
    workDir: "/tmp/test-work-poll-cadence",
    githubUser: "host-bot",
    logger: createLogger({ write: (line: string) => lines.push(line) }),
    config: buildDefaultWorkerConfig({
      repos: REPOS,
      repoConfig: {
        "org/priority": { nice: -10 },
        "org/low": { nice: 10 },
        "org/parked": { nice: 99 },
      },
    }),
    findPrCommentsToFix: scan,
  });
  try {
    await fn({
      select: () => deps.selectCyclePollRepos!() as RepoPollSelection,
      feedbackRepos: async () => {
        await deps.findAndProcessPrFeedback!();
        return scanned;
      },
      lines,
    });
  } finally {
    cleanup();
    clearPrimaryQuotaLatch();
  }
}

Deno.test("poll cadence wiring - before the first pick every repo is polled (fail open) (Issue #3667)", async () => {
  await withCadenceDeps(async ({ feedbackRepos }) => {
    assertEquals(await feedbackRepos(), REPOS);
  });
});

Deno.test("poll cadence wiring - the PR-feedback pass polls only the cycle's pick, by nice (Issue #3667)", async () => {
  await withCadenceDeps(async ({ select, feedbackRepos, lines }) => {
    const polled = new Map<string, number>(REPOS.map((r) => [r, 0]));
    for (let cycle = 0; cycle < 30; cycle++) {
      const selection = select();
      const scanned = await feedbackRepos();
      assertEquals(scanned, selection.due, "the pass sees exactly the pick");
      for (const repo of scanned) polled.set(repo, polled.get(repo)! + 1);
    }
    assertEquals(polled.get("org/priority"), 30, "nice -10 every cycle");
    assertEquals(polled.get("org/default"), 30, "no nice set is nice 0");
    assertEquals(polled.get("org/low"), 10, "nice 10 every 3rd cycle");
    assertEquals(polled.get("org/parked"), 3, "nice 99 every 10th cycle");
    assert(
      lines.some((l) => l.includes("poll-cadence: polling")),
      "an off-cadence cycle names what it deferred",
    );
  });
});

Deno.test("poll cadence wiring - a burst latch since the last pick holds due low-priority repos (Issue #3667)", async () => {
  await withCadenceDeps(async ({ select, lines }) => {
    // Find a cycle on which org/low falls due, then replay with a burst.
    let cycle = 0;
    while (!select().due.includes("org/low")) cycle++;
    assert(cycle < 3);
    select(); // org/low just polled
    select();
    const now = Math.floor(Date.now() / 1000);
    latchPrimaryQuota(now + 60, now, "secondary");
    const held = select();
    assert(!held.due.includes("org/low"), "held by the burst");
    assert(held.due.includes("org/priority"), "priority repos are never held");
    assert(held.burstHeld);
    assert(lines.some((l) => l.includes("burst limit")));
    assert(select().due.includes("org/low"), "polled once the burst passes");
  });
});
