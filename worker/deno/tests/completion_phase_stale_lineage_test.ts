/**
 * The completion phase runs the stale-lineage guard before it pushes
 * (Issue #534): a branch whose work the base already carries as a squash must
 * be rebased past that merge, never pushed into a PR that can only ever be
 * `CONFLICTING`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const BRANCH = "issue-514-mount-the-worker-checkout-read-only";
const MERGE_COMMIT = "fe2ad6d".padEnd(40, "0");

function stubClient(): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

/** True when these argv are the guard's merged-PR lookup. */
function isMergedPrLookup(args: string[]): boolean {
  return args[0] === "pr" && args[1] === "list" &&
    args.includes("number,mergeCommit");
}

/**
 * Run the completion phase against a clone that looks stale: a merged PR was
 * raised from the branch, its squash is on the base, and the branch tip does
 * not contain it. `dirty` leaves uncommitted changes so the rebase must refuse.
 */
async function runCompletion(options: { dirty: boolean }): Promise<{
  status: string;
  reason?: string;
  order: string[];
}> {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-514.md`,
    "## Summary\n\nRead-only checkout. Closes #514.\n",
  );
  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 514,
    issueTitle: "Mount the worker checkout read-only at /workspace",
    issueBody: "",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "vibe-worker",
    config: buildDefaultWorkerConfig(),
  };
  const state: PhaseState = {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const order: string[] = [];

  const deps = createMockDeps({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as never,
    github: {
      createClient: () => stubClient(),
      runGhCommand: (args: string[]) =>
        Promise.resolve(
          isMergedPrLookup(args)
            ? JSON.stringify([
              { number: 531, mergeCommit: { oid: MERGE_COMMIT } },
            ])
            : "https://github.com/stSoftwareAU/VibeCoder/pull/533",
        ),
    },
    git: {
      reconcileHeadToBranch: () =>
        Promise.resolve({
          ok: true as const,
          value: { action: "already-on-branch" as const, fromRef: BRANCH },
        }),
      pushUnpushedCommits: () => {
        order.push("push");
        return Promise.resolve({ ok: true as const, value: 1 });
      },
      runGitCommand: (args: string[]) => {
        const joined = args.join(" ");
        let code = 0;
        let stdout = "";
        if (args[0] === "rev-parse" && joined.includes("is-shallow")) {
          stdout = "false\n";
        } else if (args[0] === "rev-parse") {
          stdout = "a".repeat(40) + "\n";
        } else if (args[0] === "merge-base") {
          // The squash is on the base but not on this branch — the stale shape.
          code = args[args.length - 1] === BRANCH ? 1 : 0;
        } else if (args[0] === "ls-remote") {
          stdout = `${"b".repeat(40)}\trefs/heads/${BRANCH}\n`;
        } else if (args[0] === "status") {
          stdout = options.dirty ? " M docs/CONTAINMENT.md\n" : "";
        } else if (args[0] === "rev-list") {
          stdout = "1\n";
        }
        return Promise.resolve({
          ok: true as const,
          value: { code, stdout, stderr: "" },
        });
      },
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);
  await Deno.remove(repoPath, { recursive: true });
  return {
    status: result.status,
    ...(result.status === "failure" ? { reason: result.reason } : {}),
    order,
  };
}

Deno.test(
  "completion - a stale lineage that cannot be rebased safely stops before the push (Issue #534)",
  async () => {
    const run = await runCompletion({ dirty: true });
    assertEquals(run.status, "failure");
    assertStringIncludes(run.reason ?? "", "Issue #534");
    assertStringIncludes(run.reason ?? "", "#531");
    assert(
      !run.order.includes("push"),
      "a branch that would open a CONFLICTING PR must never be pushed",
    );
  },
);
