/**
 * Wiring tests for the base-merge gate in the CI-fix and PR-feedback
 * processors (Issue #4943). Each processor merges the base into the PR branch
 * only when GitHub reports the PR `CONFLICTING`; a behind-only PR, or an
 * unreadable mergeability, must not reach `syncFeatureBranchWithDefault`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { prCiProcessorCommand } from "../commands/pr_ci_processor.ts";
import { prFeedbackProcessorCommand } from "../commands/pr_feedback_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubDeps, GitDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const REPO = "owner/repo";
const PR_NUMBER = 12;
const BRANCH = "feature-branch";
const DEFAULT_BRANCH = "main";

/** Answer only `pr view <n> --json mergeable`; any other gh call fails. */
function mergeableOnlyGh(
  read: () => Promise<string>,
  reads: string[][],
): GitHubDeps["runGhCommand"] {
  return ((args: string[]) => {
    const isMergeableRead = args[0] === "pr" && args[1] === "view" &&
      args[args.indexOf("--json") + 1] === "mergeable";
    if (isMergeableRead) {
      reads.push(args);
      return read();
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  }) as unknown as GitHubDeps["runGhCommand"];
}

/**
 * Run one processor operation with a recording sync stub. The sync stub is
 * the only route into the base merge, so its call count is the gate's effect.
 */
async function runWith(
  processor: "ci" | "feedback",
  read: () => Promise<string>,
): Promise<{ syncCalls: string[][]; mergeableReads: string[][] }> {
  const syncCalls: string[][] = [];
  const mergeableReads: string[][] = [];
  const workDir = await Deno.makeTempDir();
  const originalLog = console.log;
  console.log = () => {};
  try {
    const deps = createMockDeps({
      github: { runGhCommand: mergeableOnlyGh(read, mergeableReads) },
      git: {
        setupRepo: () =>
          Promise.resolve(
            { ok: true as const, value: workDir },
          ) as ReturnType<GitDeps["setupRepo"]>,
        getRepoDefaultBranch: () =>
          Promise.resolve(
            { ok: true as const, value: DEFAULT_BRANCH },
          ) as ReturnType<GitDeps["getRepoDefaultBranch"]>,
        syncFeatureBranchWithDefault: ((branch: string, base: string) => {
          syncCalls.push([branch, base]);
          return Promise.resolve({ ok: true as const, value: "synced" });
        }) as unknown as GitDeps["syncFeatureBranchWithDefault"],
      },
      claude: {
        // Fails fast: no agent run is ever started from this test.
        runClaudeWithRetry: (() =>
          Promise.resolve({
            ok: false,
            error: new Error("agent disabled in wiring test"),
          })) as never,
      },
    });
    const config = { ...buildDefaultWorkerConfig(), workDir };
    if (processor === "ci") {
      await prCiProcessorCommand.execute(
        {
          operation: "process",
          repo: REPO,
          "pr-number": String(PR_NUMBER),
          "branch-name": BRANCH,
          "check-run-id": "123",
          "check-name": "test",
          "encoded-annotations": btoa("[]"),
        },
        config,
        deps,
      );
    } else {
      await prFeedbackProcessorCommand.execute(
        {
          operation: "process",
          repo: REPO,
          "pr-number": String(PR_NUMBER),
          "branch-name": BRANCH,
          "comment-type": "review",
          "comment-id": "77",
          "comment-body": "please tidy this",
        },
        config,
        deps,
      );
    }
  } finally {
    console.log = originalLog;
    await Deno.remove(workDir, { recursive: true });
  }
  return { syncCalls, mergeableReads };
}

const mergeableJson = (mergeable: string) =>
  () => Promise.resolve(JSON.stringify({ mergeable }));

for (const processor of ["ci", "feedback"] as const) {
  const label = processor === "ci" ? "pr-ci-processor" : "pr-feedback-processor";

  Deno.test(`${label} does not sync the base for a behind-only (MERGEABLE) PR (Issue #4943)`, async () => {
    const { syncCalls, mergeableReads } = await runWith(
      processor,
      mergeableJson("MERGEABLE"),
    );
    // Positive control: the gate was reached, so the absent sync is the gate.
    assertEquals(mergeableReads.length, 1, "mergeable read reached the gate");
    assertEquals(syncCalls, []);
  });

  Deno.test(`${label} syncs the base once for a CONFLICTING PR (Issue #4943)`, async () => {
    const { syncCalls, mergeableReads } = await runWith(
      processor,
      mergeableJson("CONFLICTING"),
    );
    assertEquals(mergeableReads.length, 1, "mergeable read reached the gate");
    assertEquals(syncCalls, [[BRANCH, DEFAULT_BRANCH]]);
  });

  Deno.test(`${label} does not sync the base when the mergeable read throws (Issue #4943)`, async () => {
    const { syncCalls, mergeableReads } = await runWith(
      processor,
      () => Promise.reject(new Error("gh pr view: HTTP 503")),
    );
    assertEquals(mergeableReads.length, 1, "mergeable read reached the gate");
    assertEquals(syncCalls, []);
  });
}
