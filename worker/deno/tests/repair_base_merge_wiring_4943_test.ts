/**
 * Wiring tests for the base-merge gate in the CI-fix, PR-feedback and
 * spelling-fix processors (Issue #4943). Each processor merges the base into the
 * PR branch when GitHub reports `CONFLICTING`. The CI-fix processor also merges
 * when its failing check has the same failure on the merge base and passes on a
 * newer default-branch commit;
 * a behind-only PR with no such check, or an unreadable mergeability, must not
 * publish an unrelated base advance.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import { BASE_REFRESH_COUNTERS_FILE } from "../lib/repair_base_merge_4943.ts";
import { readBranchRefreshRefusals } from "../lib/branch_refresh_refusal_streak.ts";
import { processCiFailure } from "../lib/pr_ci_processor.ts";
import { processPrFeedback } from "../lib/pr_feedback_processor.ts";
import { processSpellingFailure } from "../lib/pr_spelling_processor.ts";
import { prCiProcessorCommand } from "../commands/pr_ci_processor.ts";
import { prFeedbackProcessorCommand } from "../commands/pr_feedback_processor.ts";
import { prSpellingProcessorCommand } from "../commands/pr_spelling_processor.ts";
import {
  createDefaultDeps,
  createMockDeps,
} from "../lib/issue_worker_wiring.ts";
import type { GitDeps, GitHubDeps } from "../lib/issue_worker_wiring.ts";
import { cloneGitFixture, seedGitRemote } from "./support/git_fixture.ts";
import { git as gitResult, gitOk } from "./support/git_repo_fixture.ts";
import { baseFixGh, CI_CHECK_RUN_ID } from "./support/repair_base_checks.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const REPO = "owner/repo";
const PR_NUMBER = 12;
const BRANCH = "feature-branch";
const DEFAULT_BRANCH = "main";

/**
 * Run a successful repair against a real bare remote. Git operations, final
 * commit/push and push verification use production adapters; only GitHub and
 * the agent service are replaced. Inspect the published tree and ancestry.
 */
async function runWith(
  processor: "ci" | "feedback" | "spelling",
  read: () => Promise<string>,
  sharedWorkDir?: string,
  gh?: GitHubDeps["runGhCommand"],
  options: { library?: boolean; rejectPush?: boolean } = {},
): Promise<
  {
    publishedBase: boolean;
    lines: string[];
    beforeSha: string;
    remoteHead: string;
  }
> {
  const root = await Deno.makeTempDir();
  const clone = `${root}/clone`;
  const git = async (args: string[], cwd = clone) =>
    (await gitOk(args, cwd)).trim();
  const upstream = await seedGitRemote(root, "main", [
    { branch: "main", subject: "seed", files: { "README.md": "seed\n" } },
    {
      branch: BRANCH,
      parent: 1,
      subject: "feature",
      files: { "feature.txt": "feature\n" },
    },
    {
      branch: "main",
      parent: 1,
      subject: "base advances",
      files: { "base-only.txt": "unrelated base advance\n" },
    },
  ]);
  await cloneGitFixture(upstream, clone, { checkout: BRANCH });
  const baseSha = await git(["rev-parse", "origin/main"]);
  const beforeSha = await git(["rev-parse", "HEAD"], clone);
  if (options.rejectPush) {
    const hook = `${upstream}/hooks/pre-receive`;
    await Deno.writeTextFile(hook, "#!/bin/sh\nexit 1\n");
    await Deno.chmod(hook, 0o755);
  }
  let publishedBase = false;
  let remoteHead = "";
  const lines: string[] = [];
  const comments: Array<
    { id: number; body: string; created_at: string; author: string }
  > = [];
  const workDir = sharedWorkDir ?? await Deno.makeTempDir();
  const originalWarn = console.warn;
  console.warn = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  try {
    const deps = createMockDeps({
      github: {
        runGhCommand: async (args: string[]) => {
          const fields = args[args.indexOf("--json") + 1];
          if (isPrLiveStateRead(args)) {
            return JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE" });
          }
          if (
            args[0] === "pr" && args[1] === "view" && fields === "baseRefName"
          ) return DEFAULT_BRANCH;
          if (
            args[0] === "pr" && args[1] === "view" && fields === "mergeable"
          ) return read();
          if (args.some((arg) => arg.includes("/rules/branches/"))) return "[]";
          if (
            (args[0] === "pr" || args[0] === "issue") && args[1] === "comment"
          ) {
            const id = comments.length + 1;
            comments.push({
              id,
              body: args[args.indexOf("--body") + 1]!,
              created_at: new Date().toISOString(),
              author: "fixture",
            });
            return `https://github.com/${REPO}/issues/${PR_NUMBER}#issuecomment-${id}`;
          }
          if (args.some((arg) => arg.includes("/comments"))) {
            return JSON.stringify(comments);
          }
          if (
            args[0] === "label" || args[0] === "issue" || args[1] === "merge"
          ) return "";
          if (gh) return gh(args);
          return "";
        },
      },
      git: {
        ...createDefaultDeps().git,
        setupRepo: () =>
          Promise.resolve(
            { ok: true as const, value: clone },
          ) as ReturnType<GitDeps["setupRepo"]>,
        getRepoDefaultBranch: () =>
          Promise.resolve(
            { ok: true as const, value: DEFAULT_BRANCH },
          ) as ReturnType<GitDeps["getRepoDefaultBranch"]>,
      },
      claude: {
        runClaudeWithRetry: (async () => {
          await Deno.writeTextFile(
            `${clone}/repair.txt`,
            "substantive repair\n",
          );
          return {
            ok: true,
            value: { output: "Fixed the defect", exitCode: 0, timedOut: false },
          };
        }) as never,
      },
    });
    deps.logger.warn = (message) => lines.push(message);
    deps.logger.error = (message, context) =>
      lines.push(`${message} ${JSON.stringify(context)}`);
    deps.logger.info = (message, context) =>
      lines.push(`${message} ${JSON.stringify(context)}`);
    const config = {
      ...buildDefaultWorkerConfig(),
      workDir,
      repoConfig: { [REPO]: { skipQualityCheck: true } },
    };
    if (options.library) {
      const input = {
        repo: REPO,
        prNumber: PR_NUMBER,
        branchName: BRANCH,
        checkRunId: CI_CHECK_RUN_ID,
        checkName: "test",
        encodedAnnotations: btoa("[]"),
      };
      const processorDeps = {
        logger: deps.logger,
        deps,
        workDir: clone,
        workRoot: workDir,
        stateDir: `${workDir}/ci`,
        promptsDir: new URL("../../../prompts", import.meta.url).pathname,
        repoConfigs: config.repoConfig,
      };
      const result = processor === "ci"
        ? await processCiFailure(input, processorDeps)
        : processor === "spelling"
        ? await processSpellingFailure(input, processorDeps)
        : await processPrFeedback({
          ...input,
          commentId: "77",
          commentType: "review",
          commentBody: "please tidy this",
        }, processorDeps);
      assert(result.ok, result.ok ? "" : result.error.message);
      assertEquals(
        result.value.changesPushed,
        !options.rejectPush,
        JSON.stringify(result),
      );
    } else if (processor === "ci") {
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
    await git(["fetch", "origin"], clone);
    const remoteTree = await git(
      ["ls-tree", "--name-only", `origin/${BRANCH}`],
      clone,
    );
    assert(
      remoteTree.includes("repair.txt") === !options.rejectPush,
      `repair must reach remote: ${remoteTree}\n${lines.join("\n")}`,
    );
    if (options.rejectPush) {
      assertEquals(
        await git(["rev-parse", `origin/${BRANCH}`], clone),
        beforeSha,
      );
    }
    const ancestor = await gitResult([
      "merge-base",
      "--is-ancestor",
      baseSha,
      `origin/${BRANCH}`,
    ], clone);
    publishedBase = ancestor.code === 0;
    remoteHead = await git(["rev-parse", `origin/${BRANCH}`], clone);
    assertEquals(remoteTree.includes("base-only.txt"), publishedBase);
  } finally {
    console.warn = originalWarn;
    await Deno.remove(root, { recursive: true });
    if (sharedWorkDir === undefined) {
      await Deno.remove(workDir, { recursive: true });
    }
  }
  return { publishedBase, lines, beforeSha, remoteHead };
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
  lines.filter((line) =>
    line.startsWith("[base-refresh]") && !line.includes("publication")
  );

Deno.test("pr-ci-processor does not sync a MERGEABLE PR when its failing check is green only on the current base (Issue #4943)", async () => {
  const { publishedBase, lines } = await runWith(
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
  assertEquals(publishedBase, false);
});

Deno.test("pr-ci-processor merges the base when the same failure is red on the merge base and green on a newer base (Issue #4943)", async () => {
  const { publishedBase, lines } = await runWith(
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
    /^check test has the same failure on the PR merge base and passes on the newer base;/,
  );
  assertEquals(publishedBase, true);
});

for (
  const base of [
    "red",
    "no-run",
    "unavailable",
    "probe-throws",
    "stale-check-head",
    "different-historical-failure",
  ] as const
) {
  Deno.test(`pr-ci-processor does not sync the base for a MERGEABLE PR whose failing check reads ${base} on the base (Issue #4943)`, async () => {
    const { publishedBase, lines } = await runWith(
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
    assertEquals(publishedBase, false);
  });
}

Deno.test("pr-ci-processor names the unreadable identity in the skip reason when the base-fix probe throws (Issue #4943)", async () => {
  const { publishedBase, lines } = await runWith(
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
  assertEquals(publishedBase, false);
});

for (const processor of ["feedback", "spelling"] as const) {
  const label = processor === "feedback"
    ? "pr-feedback-processor"
    : "pr-spelling-processor";
  Deno.test(`${label} keeps its base-merge gate for a MERGEABLE PR (Issue #4943)`, async () => {
    const { publishedBase, lines } = await runWith(
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
    assertEquals(publishedBase, false);
  });
}

for (const processor of ["ci", "feedback", "spelling"] as const) {
  const label = processor === "ci"
    ? "pr-ci-processor"
    : processor === "feedback"
    ? "pr-feedback-processor"
    : "pr-spelling-processor";
  const baseRefreshLines = (lines: string[]) =>
    lines.filter((line) =>
      line.startsWith("[base-refresh]") && !line.includes("publication")
    );

  Deno.test(`${label} does not sync the base for a behind-only (MERGEABLE) PR (Issue #4943)`, async () => {
    const { publishedBase, lines } = await runWith(
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
    assertEquals(publishedBase, false);
  });

  Deno.test(`${label} publishes base ancestry for a CONFLICTING PR (Issue #4943)`, async () => {
    const { publishedBase, lines } = await runWith(
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
    assertEquals(publishedBase, true);
  });

  Deno.test(`${label} does not sync the base when the mergeable read throws (Issue #4943)`, async () => {
    const { publishedBase, lines } = await runWith(
      processor,
      () => Promise.reject(new Error("gh pr view: HTTP 503")),
    );
    assertEquals(publishedBase, false);
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
        const { publishedBase } = await runWith(
          processor,
          mergeableJson("UNKNOWN"),
          workDir,
        );
        assertEquals(
          publishedBase,
          false,
          "an UNKNOWN read never merges the base",
        );
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
        // The publication-time re-read of each run is tallied too.
        [`baseRefresh.base-merge-skipped.${label}-publication`]: 3,
        "baseRefresh.repeatedMergeabilityUnknown": 1,
      });
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  });
}

for (const processor of ["ci", "feedback", "spelling"] as const) {
  Deno.test(`${processor} direct library repair publishes substantive edits without an unrelated base advance`, async () => {
    const { publishedBase } = await runWith(
      processor,
      mergeableJson("MERGEABLE"),
      undefined,
      undefined,
      { library: true },
    );
    assertEquals(publishedBase, false);
  });
  Deno.test(`${processor} direct library conflict repair publishes the base ancestry`, async () => {
    const { publishedBase } = await runWith(
      processor,
      mergeableJson("CONFLICTING"),
      undefined,
      undefined,
      { library: true },
    );
    assertEquals(publishedBase, true);
  });
  Deno.test(`${processor} direct library reports a refused publication and leaves the remote unchanged`, async () => {
    const { publishedBase, beforeSha, remoteHead } = await runWith(
      processor,
      mergeableJson("MERGEABLE"),
      undefined,
      undefined,
      { library: true, rejectPush: true },
    );
    // runWith also asserts the repair never reached the remote tree and that
    // the library reported changesPushed=false for the refused push.
    assertEquals(
      remoteHead,
      beforeSha,
      "the refused push left the remote head",
    );
    assertEquals(publishedBase, false);
  });

  const label = processor === "ci"
    ? "pr-ci-processor"
    : processor === "feedback"
    ? "pr-feedback-processor"
    : "pr-spelling-processor";
  Deno.test(`${processor} direct library counts a publication-time base merge durably in the work directory (Issue #4943)`, async () => {
    const workDir = await Deno.makeTempDir();
    try {
      const { publishedBase } = await runWith(
        processor,
        mergeableJson("CONFLICTING"),
        workDir,
        undefined,
        { library: true },
      );
      assertEquals(publishedBase, true);
      const tally = JSON.parse(
        await Deno.readTextFile(`${workDir}/${BASE_REFRESH_COUNTERS_FILE}`),
      );
      assertEquals(tally.counters, {
        [`baseRefresh.base-merge-allowed.${label}-publication`]: 1,
      });
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  });
}
