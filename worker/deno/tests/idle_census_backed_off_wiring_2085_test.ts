/**
 * The production factory tells both idle instruments which repositories this
 * host has backed off (Issue #2085).
 *
 * The census can model the back-off perfectly and still make no difference to
 * a running worker, because the set that switches it on is supplied by
 * `run_core_production_deps.ts` and by nothing else — the same shape as the
 * `pushCapableAuthors` defect of Issue #1050, and the reason
 * `idle_census_repo_backed_off_2085_test.ts` alone cannot pin this fix.
 *
 * `findNextIssue` unions `backedOffRepos()` into `findOldestIssue`'s
 * `excludeRepos`, so a backed-off repository is skipped before any collector
 * runs — but that union is computed inside the scan and is not part of
 * `scanExcludedRepos`. So these tests seed the durable fast-failure sidecar
 * exactly as a previous process would have, drive the real
 * `createProductionRunCoreDeps`, call the real `runIdleDetectAudit` and
 * `runIdleDecisionCensus` deps it builds, and assert on the lines they log.
 *
 * Every probe routes through a stubbed `gh`: the audit runs first and warms
 * the iteration-scoped issue/PR caches the census then reads, so neither
 * instrument costs a network call.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { recordRepoFastFailure } from "../lib/repo_fast_failure_tracker.ts";

const REPO = "org/backed-off-fixture";
const WORKER_USER = "worker-bot";

/** Eight unassigned `low-priority` issues — the shape of the incident. */
function fixtureIssues(): Array<Record<string, unknown>> {
  return [149, 147, 145, 144, 143, 142, 141, 140].map((n) => ({
    number: n,
    title: `Backlog ${n}`,
    labels: [{ name: "low-priority" }],
    assignees: [],
    milestone: null,
    body: "",
  }));
}

/** Issue list from the fixture; every PR probe answers empty. */
function stubGh(args: string[]): Promise<string> {
  if (args[0] === "issue" && args[1] === "list") {
    return Promise.resolve(JSON.stringify(fixtureIssues()));
  }
  return Promise.resolve("[]");
}

/** Seed the sidecar exactly as a previous worker process would have. */
async function seedBackOff(workDir: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  for (const offset of [300, 200, 100]) {
    const recorded = await recordRepoFastFailure({
      workDir,
      nowSeconds: () => now - offset,
      repo: REPO,
      failure: {
        phase: "setup",
        message: "quality.sh: line 3: deno: command not found",
        issueNumber: 149,
        elapsedSeconds: 9,
      },
    });
    assert(recorded.ok, recorded.ok ? "" : recorded.error.message);
  }
}

/**
 * Run both idle instruments for one cycle against a work directory that
 * either does or does not carry the back-off, and return every logged line.
 */
async function idleLinesWith(backedOff: boolean): Promise<string[]> {
  const workDir = await Deno.makeTempDir({ prefix: "idle-backoff-wiring-" });
  try {
    if (backedOff) await seedBackOff(workDir);
    const lines: string[] = [];
    const { deps } = await createProductionRunCoreDeps({
      repoDir: workDir,
      workDir,
      githubUser: WORKER_USER,
      logger: createLogger({ write: (line: string) => lines.push(line) }),
      config: { ...buildDefaultWorkerConfig(), repos: [REPO], workDir },
      idleDetectGhCommandFn: stubGh,
    });
    // The audit first, so its stubbed probes warm the shared issue and PR
    // caches the census reads — the production ordering, and what keeps this
    // test offline.
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

Deno.test(
  "production deps - the census is told the repo this host backed off (Issue #2085)",
  async () => {
    const lines = await idleLinesWith(true);
    const repoLine = lines.find((l) =>
      l.includes("[idle-census]") && l.includes(`repo=${REPO}`)
    );
    assert(repoLine !== undefined, "the census logged no line for the repo");
    // The backlog is real, so the idle-task filer stays suppressed.
    assert(repoLine.includes("low_priority=8"), repoLine);
    assert(repoLine.includes("inversion_signal=true"), repoLine);
    // But the claim scan was never shown the repository.
    assert(repoLine.includes("scanned=false"), repoLine);
    assert(repoLine.includes("skip_reason=repo_backed_off"), repoLine);
    assert(
      lines.some((l) => l.includes("NOTE inversion_repo_backed_off")),
      "the back-off was not named in a note",
    );
  },
);

Deno.test(
  "production deps - a backed-off repo raises no mis_classification ALERT (Issue #2085)",
  async () => {
    const lines = await idleLinesWith(true);
    assertEquals(
      lines.filter((l) => l.includes("ALERT mis_classification")),
      [],
      "the scan never looked at the repo, so it disagreed about nothing",
    );
  },
);

Deno.test(
  "production deps - without a back-off the repo still reads as scanned (Issue #2085)",
  async () => {
    const lines = await idleLinesWith(false);
    const repoLine = lines.find((l) =>
      l.includes("[idle-census]") && l.includes(`repo=${REPO}`)
    );
    assert(repoLine !== undefined, "the census logged no line for the repo");
    assert(repoLine.includes("scanned=true"), repoLine);
    assert(repoLine.includes("skip_reason=scanned"), repoLine);
    assert(
      !lines.some((l) => l.includes("NOTE inversion_repo_backed_off")),
      "a healthy repo must not be reported as backed off",
    );
    // The pre-#2085 behaviour for a genuinely scanned repo is unchanged:
    // the census escalates, and the audit disagrees with the scan.
    assert(lines.some((l) => l.includes("ALERT inversion")), "no inversion");
    assert(
      lines.some((l) => l.includes("ALERT mis_classification")),
      "a scanned repo's disagreement is still reported",
    );
  },
);
