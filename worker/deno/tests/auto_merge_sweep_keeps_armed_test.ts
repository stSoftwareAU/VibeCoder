/**
 * The production auto-merge sweep never disarms a fleet PR (Issue #4291).
 *
 * The CI quality gate is the only merge gate, so neither the retired
 * `standing-violation` label nor an unresolved pre-PR review record may
 * disarm a PR. The sweep's own tests drive it through injected seams, so they
 * cannot show what `run_core_production_deps.ts` really wires. This drives the
 * real `ensureAutoMerge` with a recording `gh` runner (`autoMergeGhCommandFn`)
 * and asserts on the argv.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { resetAnnouncedDraftsForTest } from "../lib/auto_merge_sweep.ts";
import {
  BRANCH_REFRESH_REFUSAL_FILE,
  BRANCH_REFRESH_REFUSAL_MARKER,
} from "../lib/branch_refresh_refusal_streak.ts";
import { renderPreprReviewRequest } from "../lib/prepr_review_record.ts";

import { strictRefreshFixture } from "./support/strict_refresh_fixture.ts";

const REPO = "org/repo-a";
const WORKER_USER = "worker-bot";
const PR_NUMBER = 42;

/**
 * Run the production `ensureAutoMerge` over one open PR whose live read says
 * `autoMergeRequest` is `armed`, carries `labels` and is `behind` its base.
 * Returns every `gh` argv the sweep issued.
 */
async function sweepOnePr(
  live: { armed: boolean; labels: string[]; behind: boolean },
  comments = "[]",
  mergeabilityReadings: Array<string | null> = [],
  workDir?: string,
): Promise<string[][]> {
  resetAnnouncedDraftsForTest();
  const refresh = strictRefreshFixture(REPO, "main", WORKER_USER);
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (
      args[0] === "api" &&
      args.some((arg) => arg.includes(BRANCH_REFRESH_REFUSAL_MARKER))
    ) {
      return Promise.resolve("[]");
    }
    if (
      (args[0] === "api" && args[1] !== "graphql" &&
        !args[1]?.endsWith("/comments")) ||
      (args[0] === "issue" && args[1] === "comment")
    ) {
      return refresh.gh(args);
    }
    if (args[0] === "pr" && args[1] === "list") {
      return Promise.resolve(JSON.stringify([{
        number: PR_NUMBER,
        title: "A change",
        baseRefName: "main",
        headRefName: "issue-1-change",
        isDraft: false,
      }]));
    }
    if (args[0] === "pr" && args[1] === "view") {
      const mergeable = mergeabilityReadings.length
        ? mergeabilityReadings.shift()
        : "MERGEABLE";
      return Promise.resolve(JSON.stringify({
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
        headRefOid: "a".repeat(40),
        mergeable,
        autoMergeRequest: live.armed
          ? { enabledAt: "2026-01-01T00:00:00Z" }
          : null,
        mergeStateStatus: live.behind ? "BEHIND" : "CLEAN",
        reviewDecision: "",
        labels: live.labels.map((name) => ({ name })),
      }));
    }
    if (args[0] === "api" && args[1] === "graphql") {
      return Promise.resolve(JSON.stringify({
        data: {
          repository: {
            defaultBranchRef: { name: "main" },
            pullRequest: {
              headRefName: "issue-1-change",
              baseRefName: "main",
              autoMergeRequest: live.armed
                ? { enabledAt: "2026-01-01T00:00:00Z" }
                : null,
              timelineItems: { nodes: [] },
            },
          },
        },
      }));
    }
    if (
      args[0] === "api" &&
      args.some((arg) => typeof arg === "string" && arg.endsWith("/comments"))
    ) {
      return Promise.resolve(comments);
    }
    // Branch update, disarm and anything else: succeed with no output.
    return Promise.resolve("");
  };

  const ownedWorkDir = workDir ??
    await Deno.makeTempDir({ prefix: "auto-merge-disarm-" });
  try {
    const { deps } = await createProductionRunCoreDeps({
      repoDir: ownedWorkDir,
      workDir: ownedWorkDir,
      githubUser: WORKER_USER,
      logger: createLogger({ write: () => {} }),
      config: {
        ...buildDefaultWorkerConfig(),
        workDir,
        repos: [REPO],
        allowedAuthors: [WORKER_USER],
        fleetPrAuthors: [],
      },
      autoMergeGhCommandFn: gh,
    });
    const result = await deps.ensureAutoMerge!();
    assert(result.ok, "the sweep itself must succeed");
  } finally {
    if (!workDir) {
      await Deno.remove(ownedWorkDir, { recursive: true }).catch(() =>
        undefined
      );
    }
  }
  return calls;
}

const DISARM = [
  "pr",
  "merge",
  String(PR_NUMBER),
  "--repo",
  REPO,
  "--disable-auto",
];

function isDisarm(args: string[]): boolean {
  return JSON.stringify(args) === JSON.stringify(DISARM);
}

const OPEN_RECORD = JSON.stringify([{
  author: WORKER_USER,
  body: renderPreprReviewRequest([{
    file: "src/balance.ts",
    line: 42,
    problem: "rounding drops the final cent",
  }]),
}]);

// Armed and behind, so the sweep evaluates its branch-refresh policy rather
// than the real merge ladder (which is not behind this seam).
for (
  const [name, labels, comments] of [
    ["a PR with no label or record", [], "[]"],
    ["a PR still carrying the retired standing-violation label", [
      "standing-violation",
    ], "[]"],
    ["a PR with an open pre-PR review record", [], OPEN_RECORD],
  ] as const
) {
  Deno.test(`Issue #4291: production ensureAutoMerge keeps ${name} armed and evaluates refresh policy`, async () => {
    const calls = await sweepOnePr(
      { armed: true, labels: [...labels], behind: true },
      comments,
    );
    assertEquals(calls.filter(isDisarm), [], JSON.stringify(calls));
    assert(
      calls.some((c) =>
        c.includes("PUT") && c.some((arg) => arg.endsWith("/update-branch"))
      ),
      `the eligible armed PR requested a branch refresh: ${
        JSON.stringify(calls)
      }`,
    );
  });
}

Deno.test("production ensureAutoMerge persists and escalates a repeated transient refresh refusal (Issue #4831)", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "auto-merge-refresh-escalation-",
  });
  try {
    await Deno.writeTextFile(
      `${workDir}/${BRANCH_REFRESH_REFUSAL_FILE}`,
      JSON.stringify({
        [`${REPO}#${PR_NUMBER}`]: {
          reason: "mergeability-unknown",
          streak: 1,
          lastSeenAtMs: Date.now(),
          notified: false,
        },
      }),
    );
    const calls = await sweepOnePr(
      { armed: true, labels: [], behind: true },
      "[]",
      ["MERGEABLE", "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN"],
      workDir,
    );
    assert(
      calls.some((args) => args[0] === "pr" && args[1] === "comment"),
      "production ensureAutoMerge must post the held-PR diagnostic",
    );
    const state = JSON.parse(
      await Deno.readTextFile(`${workDir}/${BRANCH_REFRESH_REFUSAL_FILE}`),
    );
    assertEquals(state[`${REPO}#${PR_NUMBER}`].notified, true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

import { requestReadyBranchUpdate } from "../lib/required_branch_checks_4613.ts";

for (const scenario of ["owned", "awaiting-review", "ready"]) {
  Deno.test(`production stall-repair behind refresh honours shared policy: ${scenario}`, async () => {
    const workDir = await Deno.makeTempDir();
    const refresh = strictRefreshFixture(REPO, "main", WORKER_USER);
    try {
      if (scenario === "owned") {
        const first = await requestReadyBranchUpdate(
          REPO,
          10,
          refresh.gh,
          "main",
          refresh.head,
          async () => {},
          { fleetAuthors: [WORKER_USER] },
        );
        assert(first.ok);
      }
      if (scenario === "awaiting-review") {
        refresh.state.decision = "REVIEW_REQUIRED";
      }
      const before = refresh.calls.filter((args) =>
        args.includes("PUT")
      ).length;
      let syncResult: { ok: true } | { ok: false; error: Error } | undefined;
      const { deps } = await createProductionRunCoreDeps({
        repoDir: workDir,
        workDir,
        githubUser: WORKER_USER,
        logger: createLogger({ write: () => {} }),
        config: {
          ...buildDefaultWorkerConfig(),
          workDir,
          repos: [REPO],
          fleetPrAuthors: [WORKER_USER],
        },
        stallRepairGhCommandFn: refresh.gh,
        stallRepairPassFn: async (options) => {
          const result = await options.repair.syncBranch({
            repo: REPO,
            prNumber: 11,
            headRefName: "feature",
            baseRefName: "main",
          });
          syncResult = result;
          return { ok: true, value: [] };
        },
      });
      assert((await deps.scanBlockingPrStalls!()).ok);
      assert(
        syncResult,
        "the stall pass must invoke its production sync callback",
      );
      assertEquals(syncResult.ok, scenario === "ready");
      if (!syncResult.ok) {
        assert(
          syncResult.error.message.includes(
            scenario === "owned"
              ? "base refresh owned by"
              : "PR no longer ready",
          ),
          syncResult.error.message,
        );
      }
      assertEquals(
        refresh.calls.filter((args) => args.includes("PUT")).length - before,
        scenario === "ready" ? 1 : 0,
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  });
}
