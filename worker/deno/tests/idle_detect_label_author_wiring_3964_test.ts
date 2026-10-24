/**
 * Production wiring for the claim scan's label-author gate in the idle-detect
 * audit (Issue #4213).
 *
 * The audit must compute the untrusted-label set through the same closure the
 * census uses (`censusUntrustedLabelIssues` via `timelineBatchRegistry`) and
 * pass it to `auditClaimableState`. An issue whose `top-priority` label an
 * untrusted author added then logs `claimable=0 reason=label_author_not_allowed`
 * and raises no `mis_classification` alert. A per-issue REST timeline read is
 * the wrong path: the audit and the census share one batched read per
 * iteration.
 *
 * Australian English spelling throughout (behaviour).
 */

import { assert, assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const REPO = "org/idle-detect-label-author";
const WORKER_USER = "worker-bot";
const BOT = "github-actions[bot]";
const ALICE = "alice";
const ISSUE = 4213;

const FIXTURE_FIELDS: Record<string, unknown> = {
  number: ISSUE,
  title: "Top-priority issue added by a bot",
  labels: [{ name: "top-priority" }],
  assignees: [],
  body: "",
  subIssuesSummary: { total: 0, completed: 0 },
};

interface Wiring {
  lines: string[];
  batchNumbers: number[][];
  restTimelines: string[][];
  deps: Awaited<ReturnType<typeof createProductionRunCoreDeps>>["deps"];
  cleanup: () => void;
  workDir: string;
}

/**
 * Real `createProductionRunCoreDeps` with a stub `gh` that mirrors
 * `gh issue list --json` and the timeline batch the registry sends. A REST
 * `…/issues/N/timeline` answer is also stubbed, so a fallback to that path
 * would still classify the adder and the assertion on `restTimelines` is
 * what catches it.
 */
async function start(adder: string, trusted: string[]): Promise<Wiring> {
  const workDir = await Deno.makeTempDir({
    prefix: "idle-detect-label-author-",
  });
  const lines: string[] = [];
  const batchNumbers: number[][] = [];
  const restTimelines: string[][] = [];
  const ghFn = (args: string[]): Promise<string> => {
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
    if (args[0] === "api" && args[1] === "graphql") {
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      const entries = [...query.matchAll(/(n\d+): issue\(number: (\d+)\)/g)];
      if (entries.length > 0) {
        batchNumbers.push(entries.map((match) => Number(match[2])));
      }
      return Promise.resolve(JSON.stringify({
        data: {
          repository: Object.fromEntries(entries.map((match) => [match[1], {
            timelineItems: {
              nodes: [{
                __typename: "LabeledEvent",
                createdAt: "2026-01-01T00:00:00Z",
                label: { name: "top-priority" },
                actor: { login: adder },
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
        label: { name: "top-priority" },
        actor: { login: adder },
        created_at: "2026-01-01T00:00:00Z",
      }]));
    }
    return Promise.resolve("[]");
  };
  const byRepo = new Map([[
    REPO,
    { allowedAuthors: trusted, authorisedCommenters: trusted },
  ]]);
  const { deps, cleanup } = await createProductionRunCoreDeps({
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
    idleDetectGhCommandFn: ghFn,
  });
  assertEquals((await deps.refreshTrustedAuthors!()).ok, true);
  return { lines, batchNumbers, restTimelines, deps, cleanup, workDir };
}

async function finish(wiring: Wiring): Promise<void> {
  wiring.cleanup();
  await Deno.remove(wiring.workDir, { recursive: true });
}

function auditLine(lines: string[]): string {
  const line = lines.find((entry) =>
    entry.includes("[idle-detect]") && entry.includes(`repo=${REPO}`) &&
    entry.includes("claimable=")
  );
  assert(
    line !== undefined,
    `no idle-detect line for the repo:\n${lines.join("\n")}`,
  );
  return line;
}

Deno.test(
  "production deps - an untrusted top-priority add is label_author_not_allowed and the census reuses the batch (Issue #4213)",
  async () => {
    const wiring = await start(BOT, [ALICE]);
    try {
      await wiring.deps.runIdleDetectAudit!({
        tick: 1,
        scanFoundClaimable: false,
        scanExcludedRepos: [],
      });
      const line = auditLine(wiring.lines);
      assert(line.includes("claimable=0"), line);
      assert(line.includes("reason=label_author_not_allowed"), line);
      assert(
        !wiring.lines.some((entry) =>
          entry.includes("ALERT mis_classification")
        ),
        wiring.lines.join("\n"),
      );
      assertEquals(wiring.restTimelines, []);
      assertEquals(wiring.batchNumbers.flat(), [ISSUE]);
      const afterAudit = wiring.batchNumbers.flat().length;
      await wiring.deps.runIdleDecisionCensus!({
        decisionPoint: "filing",
        claimScanCompleted: true,
        claimedRepos: [],
        scanExcludedRepos: [],
      });
      assertEquals(
        wiring.batchNumbers.flat().length,
        afterAudit,
        "the census reuses the audit's timeline batch in the same iteration",
      );
      assertEquals(wiring.restTimelines, []);
    } finally {
      await finish(wiring);
    }
  },
);

Deno.test(
  "production deps - a trusted top-priority add stays claimable (Issue #4213 negative control)",
  async () => {
    const wiring = await start(ALICE, [ALICE]);
    try {
      await wiring.deps.runIdleDetectAudit!({
        tick: 1,
        scanFoundClaimable: false,
        scanExcludedRepos: [],
      });
      const line = auditLine(wiring.lines);
      assert(line.includes("claimable=1"), line);
      assertEquals(wiring.restTimelines, []);
    } finally {
      await finish(wiring);
    }
  },
);
