/**
 * The production factory hands the idle-detect audit the fleet's occupancy
 * set (Issue #1050).
 *
 * `classifyIssues` can model the claim scan's `milestone-occupied` gate
 * perfectly and still make no difference to a running worker, because the
 * option that switches it on is supplied by
 * `run_core_production_deps.ts` and by nothing else. That was exactly the
 * shape of the ten-day fleet-wide idle-task drought: the gate existed, the
 * account set did not reach it, and every test passed because each one
 * handed the audit its own set directly.
 *
 * So these tests drive the real `createProductionRunCoreDeps`, call the real
 * `runIdleDetectAudit` dep it builds, and assert on the verdict — with a
 * stubbed `gh` so the probe costs no network call. Delete the
 * `pushCapableAuthors` line from the factory and the first test fails.
 *
 * Both directions, because the account set can be wrong in two ways
 * (Issue #1064): too narrow (the worker's own login — the #1050 defect) and
 * too wide (`allowed_authors`, a permission list holding humans — the #1064
 * defect, where a human's assignment parked a whole work stream). The second
 * test fails if the factory ever hands over `config.allowedAuthors`.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

const REPO = "org/idle-audit-fixture";
const WORKER_USER = "worker-bot";
/** A sibling Vibe Coder — `fleet_pr_authors`, so its work occupies a stream. */
const SIBLING = "sibling-bot";
/** A trusted human — `allowed_authors` only. Never occupies (Issue #1064). */
const HUMAN = "human-dev";

/** 24 unassigned `work-on` issues, plus one held by `heldBy`. */
function fixtureIssues(heldBy: string | null): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let n = 100; n < 124; n++) {
    rows.push({
      number: n,
      title: `Backlog ${n}`,
      labels: [{ name: "work-on" }],
      assignees: [],
      milestone: null,
      body: "",
    });
  }
  if (heldBy !== null) {
    rows.push({
      number: 99,
      title: "Already being worked on",
      labels: [],
      assignees: [{ login: heldBy }],
      milestone: null,
      body: "",
    });
  }
  return rows;
}

/**
 * A `gh` stub for the audit's three probes: the issue list answers from the
 * fixture, and both PR probes answer empty so no PR gate fires.
 */
function makeGh(
  heldBy: string | null,
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve(JSON.stringify(fixtureIssues(heldBy)));
    }
    return Promise.resolve("[]");
  };
}

function fixtureConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: [REPO],
    // A permission list that legitimately holds a human, exactly as the
    // fleet's own `.config.json` does.
    allowedAuthors: [HUMAN, WORKER_USER],
    fleetPrAuthors: [SIBLING],
  };
}

/** The audit's fleet-wide claimable total for one cycle, via the factory. */
async function auditTotalVia(heldBy: string | null): Promise<number> {
  const workDir = await Deno.makeTempDir({ prefix: "idle-audit-wiring-" });
  try {
    const { deps } = await createProductionRunCoreDeps({
      repoDir: workDir,
      workDir,
      githubUser: WORKER_USER,
      logger: createLogger({ write: () => {} }),
      config: fixtureConfig(),
      idleDetectGhCommandFn: makeGh(heldBy),
    });
    const result = await deps.runIdleDetectAudit!({
      tick: 1,
      scanFoundClaimable: false,
      scanExcludedRepos: [],
    });
    return result?.claimableTotal ?? -1;
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test(
  "production deps - the audit is given the fleet set, so a sibling's stream is occupied (Issue #1050)",
  async () => {
    // The scan refuses all 24 as `milestone-occupied`. If the factory does
    // not pass `pushCapableAuthors`, the audit sees only its own login,
    // counts 24, and suppresses the idle-task filer on unclaimable work.
    assertEquals(await auditTotalVia(SIBLING), 0);
  },
);

Deno.test(
  "production deps - a human's assignment is not the fleet's, so the backlog stays claimable (Issue #1064)",
  async () => {
    // `human-dev` is in `allowed_authors` and not in `fleet_pr_authors`.
    // There is no scheduling between humans and Vibe Coders, so the scan
    // claims this backlog and the audit must agree. Handing the permission
    // list to the audit would report 0 here and file an idle task beside 24
    // claimable issues.
    assertEquals(await auditTotalVia(HUMAN), 24);
  },
);

Deno.test(
  "production deps - an empty stream leaves the whole backlog claimable",
  async () => {
    assertEquals(await auditTotalVia(null), 24);
  },
);
