/**
 * The production factory tells both idle instruments which repositories the
 * host has the disk floor but not the cargo build headroom for (Issue #4751,
 * building on #4540).
 *
 * The census and the idle-detect audit must read the same set the claim scan
 * drops, or a cargo repository alerts as `scanned=true` with no "what the
 * claim scan did with it" section — the invisibility #4751 names. The
 * census's resolver is pinned by `idle_census_repo_cargo_deferred_4751_test.ts`
 * alone, and that cannot show the production loop hands it the set, the same
 * shape as Issue #2085 (see `idle_census_backed_off_wiring_2085_test.ts`).
 *
 * So these tests inject `cargoClaimDeferredReposFn` (the real function reads
 * the host disk), drive the real `createProductionRunCoreDeps`, call the real
 * `runIdleDetectAudit` and `runIdleDecisionCensus` deps it builds, and assert
 * on the lines they log. Every probe routes through a stubbed `gh`, so neither
 * instrument costs a network call.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const DEFERRED = "org/cargo-deferred-fixture";
const CLEAR = "org/cargo-clear-fixture";
const REPOS = [DEFERRED, CLEAR];
const WORKER_USER = "worker-bot";
const TRUSTED = "alice";

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

/**
 * Issue list from the fixture for every repository; every PR probe answers
 * empty. The timeline answers with a `low-priority` add by the trusted author
 * (Issue #3571).
 */
function stubGh(args: string[]): Promise<string> {
  if (args[0] === "issue" && args[1] === "list") {
    return Promise.resolve(JSON.stringify(fixtureIssues()));
  }
  if (
    args[0] === "api" && /\/issues\/(\d+)\/timeline/.test(args[1] ?? "")
  ) {
    return Promise.resolve(JSON.stringify([{
      id: 1,
      event: "labeled",
      label: { name: "low-priority" },
      actor: { login: TRUSTED },
      created_at: "2026-01-01T00:00:00Z",
    }]));
  }
  return Promise.resolve("[]");
}

interface IdleRun {
  /** The work directory the factory was given; clone paths sit under it. */
  workDir: string;
  /** Every line the census and the audit logged. */
  lines: string[];
  /** Each call the injected seam received, with the clone path it mapped. */
  seamCalls: Array<{ repos: string[]; clonePaths: string[] }>;
}

/**
 * Run both idle instruments for one cycle while the injected seam reports
 * `cargoDeferred` as the repositories the host cannot build yet.
 */
async function idleRunWith(
  cargoDeferred: ReadonlyMap<string, string>,
): Promise<IdleRun> {
  const workDir = await Deno.makeTempDir({ prefix: "idle-cargo-wiring-" });
  try {
    const lines: string[] = [];
    const seamCalls: IdleRun["seamCalls"] = [];
    const trust = {
      allowedAuthors: [TRUSTED],
      authorisedCommenters: [TRUSTED],
    };
    const { deps } = await createProductionRunCoreDeps({
      repoDir: workDir,
      workDir,
      githubUser: WORKER_USER,
      logger: createLogger({ write: (line: string) => lines.push(line) }),
      config: { ...buildDefaultWorkerConfig(), repos: REPOS, workDir },
      // Issue #3571: the census models the label-author gate, so trust the adder.
      resolveTrustedAuthors: () =>
        Promise.resolve({
          ok: true,
          byRepo: new Map([
            [DEFERRED, trust],
            [CLEAR, trust],
          ]),
        }),
      idleDetectGhCommandFn: stubGh,
      graphqlQuotaProbe: () =>
        Promise.resolve({
          ok: false,
          error: new Error("fixture quota unavailable"),
        }),
      cargoClaimDeferredReposFn: (repos, cloneDirFor) => {
        seamCalls.push({
          repos: [...repos],
          clonePaths: repos.map((repo) => cloneDirFor(repo)),
        });
        return Promise.resolve(
          seamCalls.length === 1 ? new Map(cargoDeferred) : new Map(),
        );
      },
    });
    assertEquals((await deps.refreshTrustedAuthors!()).ok, true);
    // Keep the real finder offline while exercising its cargo gate.
    assertEquals(
      (await deps.findNextIssue({ excludeRepos: new Set(REPOS) })).ok,
      true,
    );
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
    return { workDir, lines, seamCalls };
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

/** The census line for `repo`, which must exist. */
function censusLineFor(lines: readonly string[], repo: string): string {
  const line = lines.find((l) =>
    l.includes("[idle-census]") && l.includes(`repo=${repo} `)
  );
  assert(line !== undefined, `the census logged no line for ${repo}`);
  return line;
}

/** Every repository named on a `mis_classification` ALERT line. */
function misClassifiedRepos(lines: readonly string[]): string[] {
  return lines
    .filter((l) => l.includes("ALERT mis_classification"))
    .flatMap((l) => {
      const [list = ""] = (l.split("repos=")[1] ?? "").split(" ");
      return list.split(",");
    });
}

Deno.test(
  "production deps - the census reads a cargo-deferred repo as not scanned (Issue #4751)",
  async () => {
    const { workDir, lines, seamCalls } = await idleRunWith(
      new Map([[DEFERRED, "host has 10 GB free, needs 25 GB cargo headroom"]]),
    );
    // Positive control: the seam is asked about the work directory's clone of
    // each repository, under the same name the claim scan maps it to.
    assertEquals(seamCalls.length, 1, "only the scan reads the volatile gate");
    const [firstCall] = seamCalls;
    assert(firstCall !== undefined, "the seam was never called");
    assertEquals(firstCall.repos, REPOS);
    assertEquals(firstCall.clonePaths, [
      `${workDir}/cargo-deferred-fixture`,
      `${workDir}/cargo-clear-fixture`,
    ]);

    const repoLine = censusLineFor(lines, DEFERRED);
    // The backlog is real, so the idle-task filer stays suppressed.
    assert(repoLine.includes("low_priority=8"), repoLine);
    assert(repoLine.includes("claim_refused=0"), repoLine);
    assert(repoLine.includes("inversion_signal=true"), repoLine);
    // But the claim scan was never shown the repository.
    assert(repoLine.includes("scanned=false"), repoLine);
    assert(repoLine.includes("skip_reason=repo_cargo_deferred"), repoLine);
    assert(
      lines.some((l) =>
        l.includes("NOTE inversion_repo_cargo_deferred") &&
        l.includes(`repos=${DEFERRED} `)
      ),
      "the cargo deferral was not named in a note",
    );
  },
);

Deno.test(
  "production deps - a cargo-deferred repo raises no mis_classification ALERT (Issue #4751)",
  async () => {
    const { lines } = await idleRunWith(
      new Map([[DEFERRED, "host has 10 GB free, needs 25 GB cargo headroom"]]),
    );
    assert(
      !misClassifiedRepos(lines).includes(DEFERRED),
      "the claim scan never looked at the repo, so it disagreed about nothing",
    );
  },
);

Deno.test(
  "production deps - a repo outside the cargo set stays scanned (Issue #4751)",
  async () => {
    const { lines } = await idleRunWith(
      new Map([[DEFERRED, "host has 10 GB free, needs 25 GB cargo headroom"]]),
    );
    const clearLine = censusLineFor(lines, CLEAR);
    assert(clearLine.includes("scanned=true"), clearLine);
    assert(clearLine.includes("skip_reason=scanned"), clearLine);
    // The other repository is still an honest disagreement, so its alert stays.
    assert(
      misClassifiedRepos(lines).includes(CLEAR),
      "a scanned repo's disagreement is still reported",
    );
  },
);

Deno.test(
  "production deps - without a cargo deferral the repo still reads as scanned (Issue #4751)",
  async () => {
    const { lines } = await idleRunWith(new Map());
    const repoLine = censusLineFor(lines, DEFERRED);
    assert(repoLine.includes("claim_refused=0"), repoLine);
    assert(repoLine.includes("scanned=true"), repoLine);
    assert(repoLine.includes("skip_reason=scanned"), repoLine);
    assert(
      !lines.some((l) => l.includes("inversion_repo_cargo_deferred")),
      "a repo with the cargo headroom must not be reported as deferred",
    );
    // The pre-#4751 behaviour for a genuinely scanned repo is unchanged:
    // the census escalates, and the audit disagrees with the scan.
    assert(lines.some((l) => l.includes("ALERT inversion")), "no inversion");
    assert(
      misClassifiedRepos(lines).includes(DEFERRED),
      "a scanned repo's disagreement is still reported",
    );
  },
);
