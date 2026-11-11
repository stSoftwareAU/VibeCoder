/**
 * Wiring tests for the base-merge gate in the CI-fix, PR-feedback and
 * spelling-fix processors (Issue #4943). Each processor merges the base into the
 * PR branch when GitHub reports `CONFLICTING`. The CI-fix processor also merges
 * when its failing check has the same failure on the merge base and passes on a
 * newer default-branch commit;
 * a behind-only PR with no such check, or an unreadable mergeability, must not
 * reach `syncFeatureBranchWithDefault`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import { BASE_REFRESH_COUNTERS_FILE } from "../lib/repair_base_merge_4943.ts";
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
): GitHubDeps["runGhCommand"] {
  return ((args: string[]) => {
    const isMergeableRead = args[0] === "pr" && args[1] === "view" &&
      args[args.indexOf("--json") + 1] === "mergeable";
    if (isMergeableRead) {
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
  gh?: GitHubDeps["runGhCommand"],
): Promise<{ syncCalls: string[][]; lines: string[] }> {
  const syncCalls: string[][] = [];
  const lines: string[] = [];
  const workDir = sharedWorkDir ?? await Deno.makeTempDir();
  const originalWarn = console.warn;
  console.warn = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  try {
    const deps = createMockDeps({
      github: {
        runGhCommand: gh ?? mergeableOnlyGh(read),
      },
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
  return { syncCalls, lines };
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

/** The base-refresh decision lines a run logged. */
const baseRefreshDecisionLines = (lines: string[]) =>
  lines.filter((line) => line.startsWith("[base-refresh]"));

/** What the default branch's run of the failing check shows (Issue #4943). */
type BaseRunState =
  | "green"
  | "red"
  | "no-run"
  | "unavailable"
  | "probe-throws"
  | "matching-historical-failure";

const CI_CHECK_RUN_ID = "123";
const BASE_RUN_ID = 901;
const BASE_SHA = "b".repeat(40);
const HEAD_SHA = "a".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);

/**
 * A gh runner for the CI-fix processor's base-fix probe (Issue #4943). It
 * answers the mergeable read with `mergeable`, the PR's failing check (run 123,
 * named like the processor's `check-name`) and its workflow, and the default
 * branch's run of that check as `base` describes. Any other call is rejected.
 */
function baseFixGh(
  mergeable: string,
  base: BaseRunState,
): GitHubDeps["runGhCommand"] {
  return (args: string[]) => {
    const endpoint = args[1] === "--allow-escape-sequences" ? args[2] : args[1];
    if (args[0] === "pr" && endpoint === "view") {
      if (args[args.indexOf("--json") + 1] === "headRefOid") {
        return Promise.resolve(JSON.stringify({ headRefOid: HEAD_SHA }));
      }
      return Promise.resolve(JSON.stringify({ mergeable }));
    }
    if (args[0] === "api") {
      if (endpoint === `repos/${REPO}/check-runs/${CI_CHECK_RUN_ID}`) {
        if (base === "probe-throws") {
          return Promise.reject(new Error("HTTP 502 from check-runs"));
        }
        return Promise.resolve(
          args[args.indexOf("--jq") + 1] === ".head_sha"
            ? `${HEAD_SHA}\n`
            : JSON.stringify({
              name: "test",
              app_slug: "github-actions",
              details_url: `https://github.com/${REPO}/actions/runs/900/job/1`,
            }),
        );
      }
      if (endpoint === `repos/${REPO}/check-runs/902`) {
        return Promise.resolve(
          JSON.stringify({
            name: "test",
            app_slug: "github-actions",
            details_url: `https://github.com/${REPO}/actions/runs/902/job/2`,
          }),
        );
      }
      if (
        endpoint === `repos/${REPO}/actions/jobs/1/logs` ||
        endpoint === `repos/${REPO}/actions/jobs/2/logs`
      ) {
        return Promise.resolve(
          "2026-11-01T10:00:00Z src/parser.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\n",
        );
      }
      if (
        endpoint === `repos/${REPO}/actions/runs/900` ||
        endpoint === `repos/${REPO}/actions/runs/${BASE_RUN_ID}`
      ) {
        return Promise.resolve(".github/workflows/ci.yml\n");
      }
      if (endpoint === `repos/${REPO}/commits/${DEFAULT_BRANCH}`) {
        return Promise.resolve(`${BASE_SHA}\n`);
      }
      if (endpoint === `repos/${REPO}/compare/${BASE_SHA}...${HEAD_SHA}`) {
        return Promise.resolve(`${MERGE_BASE_SHA}\n`);
      }
      if (endpoint === `repos/${REPO}/commits/${MERGE_BASE_SHA}`) {
        return Promise.resolve(
          args[args.indexOf("--jq") + 1] === ".sha"
            ? `${MERGE_BASE_SHA}\n`
            : `${"f".repeat(40)}\n`,
        );
      }
      if (
        endpoint ===
          `repos/${REPO}/commits/${MERGE_BASE_SHA}/check-runs?per_page=100`
      ) {
        const checkRuns = base === "matching-historical-failure"
          ? [{
            id: 902,
            name: "test",
            status: "completed",
            conclusion: "failure",
            head_sha: MERGE_BASE_SHA,
            app_slug: "github-actions",
            details_url: `https://github.com/${REPO}/actions/runs/902/job/2`,
          }]
          : [];
        return Promise.resolve(JSON.stringify({ check_runs: checkRuns }));
      }
      if (
        endpoint ===
          `repos/${REPO}/commits/${MERGE_BASE_SHA}/pulls?per_page=5`
      ) {
        return Promise.resolve("[]");
      }
      if (
        endpoint ===
          `repos/${REPO}/commits/${DEFAULT_BRANCH}/check-runs?per_page=100`
      ) {
        if (base === "unavailable") {
          return Promise.reject(new Error("HTTP 503 from check-runs"));
        }
        const checkRuns = base === "no-run" ? [] : [{
          id: BASE_RUN_ID,
          name: "test",
          status: "completed",
          conclusion: base === "red" ? "failure" : "success",
          head_sha: BASE_SHA,
          app_slug: "github-actions",
          details_url:
            `https://github.com/${REPO}/actions/runs/${BASE_RUN_ID}/job/2`,
        }];
        return Promise.resolve(JSON.stringify({ check_runs: checkRuns }));
      }
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };
}

Deno.test("pr-ci-processor does not sync a MERGEABLE PR when its failing check is green only on the current base (Issue #4943)", async () => {
  const { syncCalls, lines } = await runWith(
    "ci",
    mergeableJson("MERGEABLE"),
    undefined,
    baseFixGh("MERGEABLE", "green"),
  );
  const decisions = baseRefreshDecisionLines(lines);
  assertEquals(decisions.length, 1, lines.join("\n"));
  assertDecisionLine(
    decisions[0]!,
    "pr-ci-processor",
    "base-merge-skipped",
    /^GitHub reports mergeable MERGEABLE, not CONFLICTING;.*base-fix check unreadable: merge-base check is no-run, not red"/,
  );
  assertEquals(syncCalls, []);
});

Deno.test("pr-ci-processor merges the base when the same failure is red on the merge base and green on a newer base (Issue #4943)", async () => {
  const { syncCalls, lines } = await runWith(
    "ci",
    mergeableJson("MERGEABLE"),
    undefined,
    baseFixGh("MERGEABLE", "matching-historical-failure"),
  );
  const decisions = baseRefreshDecisionLines(lines);
  assertEquals(decisions.length, 1, lines.join("\n"));
  assertDecisionLine(
    decisions[0]!,
    "pr-ci-processor",
    "base-merge-allowed",
    /^check "test" failed with the same signature at /,
  );
  assertEquals(syncCalls, [[BRANCH, DEFAULT_BRANCH]]);
});

for (const base of ["red", "no-run", "unavailable", "probe-throws"] as const) {
  Deno.test(`pr-ci-processor does not sync the base for a MERGEABLE PR whose failing check reads ${base} on the base (Issue #4943)`, async () => {
    const { syncCalls, lines } = await runWith(
      "ci",
      mergeableJson("MERGEABLE"),
      undefined,
      baseFixGh("MERGEABLE", base),
    );
    const decisions = baseRefreshDecisionLines(lines);
    assertEquals(decisions.length, 1, lines.join("\n"));
    assertDecisionLine(
      decisions[0]!,
      "pr-ci-processor",
      "base-merge-skipped",
      /^GitHub reports mergeable MERGEABLE, not CONFLICTING; the base merge is left to the shared final-refresh owner \(Issue #4613\)/,
    );
    assertEquals(syncCalls, []);
  });
}

Deno.test("pr-ci-processor names the unreadable identity in the skip reason when the base-fix probe throws (Issue #4943)", async () => {
  const { syncCalls, lines } = await runWith(
    "ci",
    mergeableJson("MERGEABLE"),
    undefined,
    baseFixGh("MERGEABLE", "probe-throws"),
  );
  const decisions = baseRefreshDecisionLines(lines);
  assertEquals(decisions.length, 1, lines.join("\n"));
  assertMatch(
    decisions[0]!,
    /outcome=base-merge-skipped .*base-fix check unreadable: Failed to resolve identity of check run 123/,
  );
  assertEquals(syncCalls, []);
});

for (const processor of ["feedback", "spelling"] as const) {
  const label = processor === "feedback"
    ? "pr-feedback-processor"
    : "pr-spelling-processor";
  Deno.test(`${label} keeps its gate for a MERGEABLE PR whose failing check passes on the base (Issue #4943)`, async () => {
    const { syncCalls, lines } = await runWith(
      processor,
      mergeableJson("MERGEABLE"),
      undefined,
      baseFixGh("MERGEABLE", "green"),
    );
    const decisions = baseRefreshDecisionLines(lines);
    assertEquals(decisions.length, 1, lines.join("\n"));
    assertDecisionLine(
      decisions[0]!,
      label,
      "base-merge-skipped",
      /^GitHub reports mergeable MERGEABLE, not CONFLICTING; the base merge is left to the shared final-refresh owner \(Issue #4613\)" /,
    );
    assertEquals(syncCalls, []);
  });
}

for (const processor of ["ci", "feedback", "spelling"] as const) {
  const label = processor === "ci"
    ? "pr-ci-processor"
    : processor === "feedback"
    ? "pr-feedback-processor"
    : "pr-spelling-processor";
  const baseRefreshLines = (lines: string[]) =>
    lines.filter((line) => line.startsWith("[base-refresh]"));

  Deno.test(`${label} does not sync the base for a behind-only (MERGEABLE) PR (Issue #4943)`, async () => {
    const { syncCalls, lines } = await runWith(
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
    assertEquals(syncCalls, []);
  });

  Deno.test(`${label} syncs the base once for a CONFLICTING PR (Issue #4943)`, async () => {
    const { syncCalls, lines } = await runWith(
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
    assertEquals(syncCalls, [[BRANCH, DEFAULT_BRANCH]]);
  });

  Deno.test(`${label} does not sync the base when the mergeable read throws (Issue #4943)`, async () => {
    const { syncCalls, lines } = await runWith(
      processor,
      () => Promise.reject(new Error("gh pr view: HTTP 503")),
    );
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
      // The standalone command tallies its decisions durably beside the streak.
      const tally = JSON.parse(
        await Deno.readTextFile(`${workDir}/${BASE_REFRESH_COUNTERS_FILE}`),
      );
      assertEquals(tally.counters, {
        [`baseRefresh.base-merge-skipped.${label}`]: 3,
        "baseRefresh.repeatedMergeabilityUnknown": 1,
      });
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  });
}
