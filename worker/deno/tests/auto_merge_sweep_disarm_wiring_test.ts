/**
 * The production factory wires the auto-merge sweep's disarm (Issue #3517).
 *
 * The sweep's own tests inject `disarmAutoMerge`, so they cannot show that
 * `run_core_production_deps.ts` hands the sweep a disarm that really issues
 * `gh pr merge --disable-auto`. This drives the real `ensureAutoMerge` with a
 * recording `gh` runner (`autoMergeGhCommandFn`) and asserts on the argv.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { resetAnnouncedDraftsForTest } from "../lib/auto_merge_sweep.ts";

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

Deno.test("Issue #3517: production ensureAutoMerge disarms an armed standing-violation PR", async () => {
  const calls = await sweepOnePr({
    armed: true,
    labels: ["standing-violation"],
    behind: false,
  });
  assertEquals(calls.filter(isDisarm).length, 1, JSON.stringify(calls));
  const arms = calls.filter((c) =>
    c[0] === "pr" && c[1] === "merge" && !c.includes("--disable-auto")
  );
  assertEquals(arms, [], "a standing-violation PR must never be armed");
});

Deno.test("Issue #3517: production ensureAutoMerge does not disarm a PR without the label", async () => {
  // Armed and behind, so the sweep takes the branch-update path rather than
  // the real merge ladder (which is not behind this seam).
  const calls = await sweepOnePr({ armed: true, labels: [], behind: true });
  assertEquals(calls.filter(isDisarm), [], JSON.stringify(calls));
  assert(
    calls.some((c) => c.join(" ").includes("update-branch")),
    "the unlabelled PR was swept normally (branch update requested)",
  );
});
