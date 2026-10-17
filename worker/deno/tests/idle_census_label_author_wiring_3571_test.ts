/**
 * Production wiring for the claim scan's label-author gate in the census
 * (Issue #3571).
 *
 * The claim scan refuses an issue whose priority label an untrusted author
 * added (`label-author-not-allowed`), but the census counted it claimable, so
 * a refused backlog raised a false `inversion_signal`. The fix is one
 * production wiring in `run_core_production_deps.ts`: precompute the
 * untrusted-label issues through `censusUntrustedLabelIssues` and pass them
 * into `buildIdleDecisionCensus`. Every other test drives the pure census with
 * hand-built input, so only this one drives the real
 * `createProductionRunCoreDeps`, with a stub `gh` that returns only the
 * `--json` fields requested and a timeline shaped like `gh api`'s.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { TIMELINE_BATCH_SIZE } from "../lib/timeline_batch.ts";

const REPO = "org/label-author-fixture";
const WORKER_USER = "worker-bot";
const BOT = "github-actions[bot]";
const ALICE = "alice";
const ISSUE = 3571;

/** The one issue's fields, keyed by gh field name. */
const FIXTURE_FIELDS: Record<string, unknown> = {
  number: ISSUE,
  title: "Top-priority issue added by a bot",
  labels: [{ name: "top-priority" }],
  assignees: [],
  body: "",
  subIssuesSummary: { total: 0, completed: 0 },
};

/**
 * Mirrors real `gh issue list --json <fields>` (only requested fields) and
 * real `gh api repos/<repo>/issues/<n>/timeline`, whose `labeled` event
 * carries the adder in `actor.login`.
 */
function stubGhFor(adder: string): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
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
      args[0] === "api" &&
      (args[1] ?? "").includes(`/issues/${ISSUE}/timeline`)
    ) {
      return Promise.resolve(JSON.stringify([{
        id: 1,
        event: "labeled",
        label: { name: "top-priority" },
        actor: { login: adder },
        created_at: "2026-01-01T00:00:00Z",
      }]));
    }
    return Promise.resolve("[]");
  };
}

/**
 * Run the idle audit and then the filing census for one cycle, with the
 * timeline's `labeled` add made by `adder` and `trusted` as the per-repo
 * trusted list, and return the census line for the repo.
 *
 * Trust reaches production the way it does in a cycle: the resolver is
 * injected through `resolveTrustedAuthors`, and `refreshTrustedAuthors` writes
 * it through `applyTrustSnapshot`, so `trustedAuthorsFor` sees it.
 */
async function censusLine(
  adder: string,
  trusted: string[],
): Promise<string> {
  const workDir = await Deno.makeTempDir({ prefix: "label-author-wiring-" });
  try {
    const lines: string[] = [];
    const byRepo = new Map([[
      REPO,
      { allowedAuthors: trusted, authorisedCommenters: trusted },
    ]]);
    const { deps } = await createProductionRunCoreDeps({
      repoDir: workDir,
      workDir,
      githubUser: WORKER_USER,
      logger: createLogger({ write: (line: string) => lines.push(line) }),
      config: {
        ...buildDefaultWorkerConfig(),
        repos: [REPO],
        workDir,
      },
      resolveTrustedAuthors: () => Promise.resolve({ ok: true, byRepo }),
      idleDetectGhCommandFn: stubGhFor(adder),
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
    const line = lines.find((l) =>
      l.includes("[idle-census]") && l.includes(`repo=${REPO}`)
    );
    assert(line !== undefined, "the census logged no line for the repo");
    return line;
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test(
  "production deps - a top-priority add by an untrusted bot is claim_refused, not claimable (Issue #3571)",
  async () => {
    const line = await censusLine(BOT, [ALICE]);
    assert(line.includes("claim_refused=1"), line);
    assert(line.includes("top_priority=0"), line);
    assert(line.includes("inversion_signal=false"), line);
  },
);

Deno.test(
  "production deps - the same top-priority add by a trusted author stays claimable (Issue #3571 negative control)",
  async () => {
    const line = await censusLine(ALICE, [ALICE]);
    assert(line.includes("claim_refused=0"), line);
    assert(line.includes("top_priority=1"), line);
  },
);

Deno.test(
  "production deps - census batches only eligible timelines and reuses them until the iteration resets (PR #3963)",
  async () => {
    const workDir = await Deno.makeTempDir({ prefix: "census-batch-wiring-" });
    const eligible = Array.from({ length: 30 }, (_, index) => ({
      ...FIXTURE_FIELDS,
      number: index + 1,
      labels: [{ name: "low-priority" }],
    }));
    const issues = [
      ...eligible,
      { ...eligible[0], number: 101, assignees: [{ login: "someone" }] },
      {
        ...eligible[0],
        number: 102,
        labels: [{ name: "low-priority" }, { name: "needs-revision" }],
      },
      { ...eligible[0], number: 103, labels: [{ name: "idle-task" }] },
    ];
    const batchNumbers: number[][] = [];
    const restTimelines: string[][] = [];
    const lines: string[] = [];
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        const requested = (args[args.indexOf("--json") + 1] ?? "").split(",");
        return Promise.resolve(
          JSON.stringify(issues.map((issue) =>
            Object.fromEntries(
              Object.entries(issue).filter(([field]) =>
                requested.includes(field)
              ),
            )
          )),
        );
      }
      if (args[0] === "api" && args[1] === "graphql") {
        const query = args.find((arg) => arg.startsWith("query=")) ?? "";
        const entries = [...query.matchAll(/(n\d+): issue\(number: (\d+)\)/g)];
        batchNumbers.push(entries.map((match) => Number(match[2])));
        return Promise.resolve(JSON.stringify({
          data: {
            repository: Object.fromEntries(entries.map((match) => [match[1], {
              timelineItems: {
                nodes: [{
                  __typename: "LabeledEvent",
                  createdAt: "2026-01-01T00:00:00Z",
                  label: { name: "low-priority" },
                  actor: { login: ALICE },
                }],
              },
            }])),
          },
        }));
      }
      if (args[0] === "api" && (args[1] ?? "").includes("/timeline")) {
        restTimelines.push(args);
        return Promise.resolve(JSON.stringify([{
          event: "labeled",
          label: { name: "low-priority" },
          actor: { login: ALICE },
          created_at: "2026-01-01T00:00:00Z",
        }]));
      }
      return Promise.resolve("[]");
    };
    const byRepo = new Map([[
      REPO,
      { allowedAuthors: [ALICE], authorisedCommenters: [ALICE] },
    ]]);
    const { deps, cleanup } = await createProductionRunCoreDeps({
      repoDir: workDir,
      workDir,
      githubUser: WORKER_USER,
      logger: createLogger({ write: (line: string) => lines.push(line) }),
      config: { ...buildDefaultWorkerConfig(), repos: [REPO], workDir },
      resolveTrustedAuthors: () => Promise.resolve({ ok: true, byRepo }),
      idleDetectGhCommandFn: ghFn,
    });
    try {
      assertEquals((await deps.refreshTrustedAuthors!()).ok, true);
      await deps.runIdleDetectAudit!({
        tick: 1,
        scanFoundClaimable: false,
        scanExcludedRepos: [],
      });
      const census = () =>
        deps.runIdleDecisionCensus!({
          decisionPoint: "filing",
          claimScanCompleted: true,
          claimedRepos: [],
          scanExcludedRepos: [],
        });
      await census();
      assertEquals(
        restTimelines,
        [],
        "healthy batching needs no REST timelines",
      );
      assertEquals(
        batchNumbers.length,
        Math.ceil(eligible.length / TIMELINE_BATCH_SIZE),
      );
      assertEquals(batchNumbers.flat(), eligible.map((issue) => issue.number));
      assert(
        lines.some((line) => line.includes("low_priority=30")),
        lines.join("\n"),
      );
      assert(
        lines.some((line) => line.includes("claim_refused=0")),
        lines.join("\n"),
      );
      await census();
      assertEquals(
        batchNumbers.length,
        Math.ceil(eligible.length / TIMELINE_BATCH_SIZE),
        "same iteration reuses the shared registry",
      );
      assertEquals(restTimelines, []);
      deps.resetIterationCaches!();
      await census();
      assertEquals(
        batchNumbers.length,
        2 * Math.ceil(eligible.length / TIMELINE_BATCH_SIZE),
        "a new iteration refreshes trusted timelines",
      );
      assertEquals(
        batchNumbers.flat(),
        [...eligible, ...eligible].map((issue) => issue.number),
      );
      assertEquals(restTimelines, []);
    } finally {
      cleanup();
      await Deno.remove(workDir, { recursive: true });
    }
  },
);
