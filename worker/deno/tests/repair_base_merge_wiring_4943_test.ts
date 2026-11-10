/**
 * Wiring tests for the base-merge gate in the CI-fix, PR-feedback and
 * spelling-fix processors (Issue #4943). Each processor merges the base into the PR branch
 * only when GitHub reports the PR `CONFLICTING`; a behind-only PR, or an
 * unreadable mergeability, must not reach `syncFeatureBranchWithDefault`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import { readBranchRefreshRefusals } from "../lib/branch_refresh_refusal_streak.ts";
import { prCiProcessorCommand } from "../commands/pr_ci_processor.ts";
import { prFeedbackProcessorCommand } from "../commands/pr_feedback_processor.ts";
import { prSpellingProcessorCommand } from "../commands/pr_spelling_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitDeps, GitHubDeps } from "../lib/issue_worker_wiring.ts";
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
  processor: "ci" | "feedback" | "spelling",
  read: () => Promise<string>,
  sharedWorkDir?: string,
): Promise<
  { syncCalls: string[][]; mergeableReads: string[][]; lines: string[] }
> {
  const syncCalls: string[][] = [];
  const mergeableReads: string[][] = [];
  const lines: string[] = [];
  const workDir = sharedWorkDir ?? await Deno.makeTempDir();
  const originalWarn = console.warn;
  console.warn = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
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
    } else if (processor === "spelling") {
      await prSpellingProcessorCommand.execute(
        {
          operation: "process",
          repo: REPO,
          "pr-number": String(PR_NUMBER),
          "branch-name": BRANCH,
          "check-run-id": "123",
          "check-name": "spelling",
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
    console.warn = originalWarn;
    if (sharedWorkDir === undefined) {
      await Deno.remove(workDir, { recursive: true });
    }
  }
  return { syncCalls, mergeableReads, lines };
}

/** Assert the one decision line a processor logs, with every field named. */
function assertDecisionLine(
  line: string,
  source: string,
  outcome: string,
  reason: RegExp,
): void {
  const prefix =
    `[base-refresh] source=${source} outcome=${outcome} repo=owner/repo pr=#${PR_NUMBER} base=${DEFAULT_BRANCH} owner=none reason="`;
  assert(line.startsWith(prefix), `${line} should start with ${prefix}`);
  const rest = line.slice(prefix.length);
  assertMatch(rest, reason);
  assertEquals(rest.search(reason), 0, `reason should open ${rest}`);
}

const mergeableJson = (mergeable: string) => () =>
  Promise.resolve(JSON.stringify({ mergeable }));

for (const processor of ["ci", "feedback", "spelling"] as const) {
  const label = processor === "ci"
    ? "pr-ci-processor"
    : processor === "feedback"
    ? "pr-feedback-processor"
    : "pr-spelling-processor";
  const baseRefreshLines = (lines: string[]) =>
    lines.filter((line) => line.startsWith("[base-refresh]"));

  Deno.test(`${label} does not sync the base for a behind-only (MERGEABLE) PR (Issue #4943)`, async () => {
    const { syncCalls, mergeableReads, lines } = await runWith(
      processor,
      mergeableJson("MERGEABLE"),
    );
    const decisions = baseRefreshLines(lines);
    assertEquals(decisions.length, 1, lines.join("\n"));
    assertDecisionLine(
      decisions[0]!,
      label,
      "base-merge-skipped",
      /GitHub reports mergeable/,
    );
    // Positive control: the gate was reached, so the absent sync is the gate.
    assertEquals(mergeableReads.length, 1, "mergeable read reached the gate");
    assertEquals(syncCalls, []);
  });

  Deno.test(`${label} syncs the base once for a CONFLICTING PR (Issue #4943)`, async () => {
    const { syncCalls, mergeableReads, lines } = await runWith(
      processor,
      mergeableJson("CONFLICTING"),
    );
    const decisions = baseRefreshLines(lines);
    assertEquals(decisions.length, 1, lines.join("\n"));
    assertDecisionLine(
      decisions[0]!,
      label,
      "base-merge-allowed",
      /genuine conflict/,
    );
    assertEquals(mergeableReads.length, 1, "mergeable read reached the gate");
    assertEquals(syncCalls, [[BRANCH, DEFAULT_BRANCH]]);
  });

  Deno.test(`${label} does not sync the base when the mergeable read throws (Issue #4943)`, async () => {
    const { syncCalls, mergeableReads, lines } = await runWith(
      processor,
      () => Promise.reject(new Error("gh pr view: HTTP 503")),
    );
    assertEquals(mergeableReads.length, 1, "mergeable read reached the gate");
    assertEquals(syncCalls, []);
    const decisions = baseRefreshLines(lines);
    assertEquals(decisions.length, 1, lines.join("\n"));
    assertDecisionLine(
      decisions[0]!,
      label,
      "base-merge-skipped",
      /mergeability unreadable: gh pr view: HTTP 503/,
    );
  });

  Deno.test(`${label} counts consecutive UNKNOWN reads in the #4831 refusal state and clears them on a known read (Issue #4943)`, async () => {
    const workDir = await Deno.makeTempDir();
    try {
      for (const expected of [1, 2]) {
        const { syncCalls } = await runWith(
          processor,
          mergeableJson("UNKNOWN"),
          workDir,
        );
        assertEquals(syncCalls, [], "an UNKNOWN read never merges the base");
        const state = await readBranchRefreshRefusals(workDir);
        assertEquals(
          state.get(`${REPO}#${PR_NUMBER}`)?.streak,
          expected,
        );
      }
      await runWith(processor, mergeableJson("MERGEABLE"), workDir);
      assertEquals(
        (await readBranchRefreshRefusals(workDir)).has(`${REPO}#${PR_NUMBER}`),
        false,
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  });
}
