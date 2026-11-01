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
import { renderPreprReviewRequest } from "../lib/prepr_review_record.ts";

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
): Promise<string[][]> {
  resetAnnouncedDraftsForTest();
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
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
      return Promise.resolve(JSON.stringify({
        state: "OPEN",
        baseRefName: "main",
        headRefOid: "a".repeat(40),
        mergeable: "MERGEABLE",
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
    if (args[0] === "api" && args[1]?.includes("/rules/branches/")) {
      return Promise.resolve(
        JSON.stringify([[{
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "gate" }] },
        }]]),
      );
    }
    if (args[0] === "api" && args[1]?.includes("/branches/")) {
      return Promise.resolve(
        JSON.stringify({
          protection: {
            enabled: false,
            required_status_checks: { contexts: [], checks: [] },
          },
        }),
      );
    }
    if (args[0] === "api" && args[1]?.includes("/check-runs?")) {
      return Promise.resolve(
        JSON.stringify([{
          check_runs: [{
            name: "gate",
            status: "completed",
            conclusion: "success",
          }],
        }]),
      );
    }
    if (args[0] === "api" && args[1]?.includes("/status?")) {
      return Promise.resolve(JSON.stringify([{ statuses: [] }]));
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

  const workDir = await Deno.makeTempDir({ prefix: "auto-merge-disarm-" });
  try {
    const { deps } = await createProductionRunCoreDeps({
      repoDir: workDir,
      workDir,
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
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
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

// Armed and behind, so the sweep takes the branch-update path rather than the
// real merge ladder (which is not behind this seam).
for (
  const [name, labels, comments] of [
    ["a PR with no label or record", [], "[]"],
    ["a PR still carrying the retired standing-violation label", [
      "standing-violation",
    ], "[]"],
    ["a PR with an open pre-PR review record", [], OPEN_RECORD],
  ] as const
) {
  Deno.test(`Issue #4291: production ensureAutoMerge keeps ${name} armed and sweeps it`, async () => {
    const calls = await sweepOnePr(
      { armed: true, labels: [...labels], behind: true },
      comments,
    );
    assertEquals(calls.filter(isDisarm), [], JSON.stringify(calls));
    assert(
      calls.some((c) => c.join(" ").includes("update-branch")),
      "the PR was swept normally (branch update requested)",
    );
  });
}
