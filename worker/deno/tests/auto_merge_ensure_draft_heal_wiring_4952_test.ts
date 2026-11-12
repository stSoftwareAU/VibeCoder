/**
 * Production wiring for the orphaned-draft self-heal (Issue #4952).
 *
 * The sweep's own tests inject `readyOrphanedDraft`, so they cannot show that
 * `run_core_production_deps.ts` wires it. This drives the real `ensureAutoMerge`
 * with a recording `gh` runner (`autoMergeGhCommandFn`) over one fleet-author
 * draft with no hold marker and no live claim, and asserts that `gh pr ready`
 * was issued for it. Removing the `readyOrphanedDraft` wiring turns this red.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { resetAnnouncedDraftsForTest } from "../lib/auto_merge_sweep.ts";

const REPO = "org/repo-a";
const WORKER_USER = "worker-bot";
const PR_NUMBER = 7;
const HEAD_SHA = "b".repeat(40);
const BODY = "Fleet draft with no hold marker.";

/** Run the production `ensureAutoMerge` over one orphaned fleet draft. */
async function sweepOrphanedDraft(): Promise<string[][]> {
  resetAnnouncedDraftsForTest();
  const calls: string[][] = [];
  let ready = false;
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      return Promise.resolve(JSON.stringify([{
        number: PR_NUMBER,
        title: "Orphaned fleet draft",
        baseRefName: "main",
        headRefName: "issue-7-orphaned",
        isDraft: true,
      }]));
    }
    if (args[0] === "pr" && args[1] === "view") {
      // The self-heal's read: `--json body,isDraft,headRefName`.
      if (args.some((arg) => arg === "body,isDraft,headRefName")) {
        return Promise.resolve(JSON.stringify({
          body: BODY,
          isDraft: !ready,
          headRefName: "issue-7-orphaned",
        }));
      }
      // The ready-and-await-CI head read: `--json headRefOid,isDraft`.
      if (args.some((arg) => arg === "headRefOid,isDraft")) {
        return Promise.resolve(
          JSON.stringify({ headRefOid: HEAD_SHA, isDraft: !ready }),
        );
      }
      // End this wiring test after readiness; merging is a separate contract.
      return Promise.resolve(JSON.stringify({
        state: ready ? "CLOSED" : "OPEN",
        isDraft: !ready,
        baseRefName: "main",
        headRefOid: HEAD_SHA,
        mergeable: "MERGEABLE",
        autoMergeRequest: null,
        mergeStateStatus: "CLEAN",
        reviewDecision: "",
        labels: [],
      }));
    }
    if (args[0] === "pr" && args[1] === "ready") {
      ready = true;
      return Promise.resolve("");
    }
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(
        JSON.stringify({ state: "OPEN", assignees: [] }),
      );
    }
    if (args[0] === "api" && args[1] === "graphql") {
      return Promise.resolve(JSON.stringify({
        data: {
          repository: {
            defaultBranchRef: { name: "main" },
            pullRequest: {
              headRefName: "issue-7-orphaned",
              baseRefName: "main",
              autoMergeRequest: null,
              timelineItems: { nodes: [] },
            },
          },
        },
      }));
    }
    if (
      args[0] === "api" &&
      args.some((arg) => arg.includes("/check-runs?"))
    ) {
      // One new check run once the PR is ready-for-review.
      return Promise.resolve(
        JSON.stringify(ready ? [{ id: 2, conclusion: null }] : []),
      );
    }
    // Anything else (merge, comments, branch update): succeed with no output.
    return Promise.resolve("");
  };

  const workDir = await Deno.makeTempDir({
    prefix: "auto-merge-draft-heal-wiring-",
  });
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

Deno.test("Issue #4952: production ensureAutoMerge readies an orphaned fleet draft via gh pr ready", async () => {
  const calls = await sweepOrphanedDraft();
  assertEquals(
    calls.filter((c) => c[0] === "pr" && c[1] === "ready"),
    [["pr", "ready", String(PR_NUMBER), "--repo", REPO]],
    `the orphaned draft must be readied by the production wiring: ${
      JSON.stringify(calls)
    }`,
  );
});
