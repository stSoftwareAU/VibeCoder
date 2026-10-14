/**
 * Integration tests for the structured Branch outcomes facts file running in
 * the LIVE completion phase (Issue #3535, part of #3396).
 *
 * Drives `workOnIssueCompletion` and asserts on whether `gh pr create` ran and
 * on the body it was given.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { BRANCH_OUTCOMES_MARKER } from "../lib/pr_summary_facts.ts";
import {
  renderBranchOutcomes,
  type SummaryFacts,
} from "../lib/summary_facts.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f901122334455";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 3396;
const PR_URL = `https://github.com/${REPO}/pull/4311`;
const EXISTING_TEST =
  "worker/deno/tests/completion_phase_branch_outcomes_facts_3396_test.ts";
const MISSING_TEST = "worker/deno/tests/does_not_exist_test.ts";
const OTHER_TEST = "worker/deno/tests/pr_summary_facts_test.ts";
const FACTS_FILE = `pr-summary-${ISSUE}.facts.json`;
const CHANGED = "crates/report/src/decisions.rs";

const ISSUE_BODY = `## Problem

Branch outcomes are hand-written.
`;

const DOCS_SWEEP_LINE =
  "**Docs sweep** — grep: `BrokerBalance`; section: `docs/reporting-api.md#decisions-report`; no hits; siblings: none — no existing set gained a member";

function summaryWith(block: string): string {
  return `## Summary

Changed the broker balance card. Closes #${ISSUE}.

${DOCS_SWEEP_LINE}

${block}

## Test Plan

- \`${EXISTING_TEST}\`
`;
}

function factsFor(test: string): SummaryFacts {
  return {
    version: 1,
    branchOutcomes: {
      noneAdded: false,
      entries: [{
        path: CHANGED,
        line: 42,
        outcome: "error",
        test,
        testName: "rejects bad input",
        flipWentRed: "went red when the guard was removed",
      }],
    },
  };
}

function stubClient(comments: string[]): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_repo: string, _issue: number, body: string) => {
      comments.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

interface Scenario {
  /** Summary on the branch when the completion phase starts. */
  summary: string;
  /** The branch's changed files, as `git diff --name-only` reports them. */
  changedFiles: string;
  /** Test paths `ls-tree` reports as existing at HEAD. */
  existingTestsAtHead?: string[];
  /** Facts file text; omitted, no facts file is written. */
  facts?: string;
  /** Create a directory at the facts path so it cannot be read. */
  factsIsDirectory?: boolean;
  lsTreeFails?: boolean;
  /**
   * Make the plain `diff --name-only <base>...HEAD` call fail (non-zero
   * exit) while the changed-workflow gate's own
   * `--diff-filter=ACMR` diff still succeeds — the one scenario where
   * `changedFilesKnown` is false, so `completion_phase.ts` passes
   * `changedFiles: null` into `validateBranchOutcomes` (PR #3160 review).
   */
  changedFilesDiffFails?: boolean;
  /** Issue labels. Defaults to a non-bug enhancement. */
  issueLabels?: string[];
}

interface Outcome {
  status: string;
  reason?: string;
  claudeCalls: number;
  prCreateCalls: number;
  prBodies: string[];
  lsTreeArgs: string[][];
  comments: string[];
  logs: { level: string; message: string; context: unknown }[];
}

/** Drive the live completion phase over a (possibly) blocked branch-outcomes gate. */
async function runCompletion(scenario: Scenario): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  const workDir = await Deno.makeTempDir();
  const summaryPath =
    `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(summaryPath, scenario.summary);
  const factsPath = `${repoPath}/docs/archive/pr-summaries/${FACTS_FILE}`;
  if (scenario.factsIsDirectory) await Deno.mkdir(factsPath);
  else if (scenario.facts !== undefined) {
    await Deno.writeTextFile(factsPath, scenario.facts);
  }

  const comments: string[] = [];
  let prCreateCalls = 0;
  let claudeCalls = 0;
  const prBodies: string[] = [];
  const lsTreeArgs: string[][] = [];
  const logs: Outcome["logs"] = [];

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Check the branch-outcomes gate",
    issueBody: ISSUE_BODY,
    issueLabels: scenario.issueLabels ?? ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-branch-outcomes`,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };

  const deps = createMockDeps({
    logger: {
      info: (message: string, context?: unknown) => {
        logs.push({ level: "info", message, context });
      },
      warn: (message: string, context?: unknown) => {
        logs.push({ level: "warn", message, context });
      },
    },
    github: {
      createClient: () => stubClient(comments),
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "create") {
          prCreateCalls++;
          prBodies.push(args[args.indexOf("--body") + 1] ?? "");
        }
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(JSON.stringify({ state: "OPEN" }));
        }
        return Promise.resolve(PR_URL);
      },
    },
    git: {
      runGitCommand: (
        cmdArgs: string[],
      ): Promise<Result<{ code: number; stdout: string; stderr: string }>> => {
        const ok = (stdout: string, code = 0) =>
          Promise.resolve({
            ok: true as const,
            value: { code, stdout, stderr: "" },
          });
        if (cmdArgs[0] === "rev-parse") return ok(`${SHA}\n`);
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
          // The changed-workflow gate (Issue #1859) runs its own
          // `--diff-filter=ACMR` diff, independent of the plain diff that
          // feeds `changedFiles`/`changedFilesKnown` — keep it healthy even
          // when `changedFilesDiffFails` breaks the other one.
          if (cmdArgs.includes("--diff-filter=ACMR")) return ok("");
          if (scenario.changedFilesDiffFails) return ok("", 1);
          return ok(scenario.changedFiles);
        }
        if (cmdArgs[0] === "--literal-pathspecs" && cmdArgs[1] === "ls-tree") {
          if (scenario.lsTreeFails) return ok("", 1);
          lsTreeArgs.push(cmdArgs);
          // Like git, report only the requested paths that exist.
          const existing = (scenario.existingTestsAtHead ?? []).filter((p) =>
            cmdArgs.includes(p)
          );
          return ok(existing.join("\n"));
        }
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: (_options: { prompt: string }) => {
        claudeCalls++;
        return Promise.resolve({
          ok: true as const,
          value: { exitCode: 0, output: "done", timedOut: false },
        });
      },
    },
    quality: {
      runQualityGate: () =>
        Promise.resolve({
          ok: true as const,
          value: {
            checks: [],
            summary: { text: "All checks passed", passed: true },
            passed: true,
            output: "",
          },
        }),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false as const, error: new Error("none") }),
      recoverExistingPr: () =>
        Promise.resolve({ ok: true, value: "recovered" }),
      finalisePr: () =>
        Promise.resolve({
          ok: true,
          value: { result: AutoMergeResult.Enabled, message: "armed" },
        }),
    },
  });

  let result;
  try {
    result = await workOnIssueCompletion(ctx, state, deps);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }

  return {
    status: result.status,
    reason: result.status === "failure" || result.status === "early_exit"
      ? result.reason
      : undefined,
    claudeCalls,
    prCreateCalls,
    prBodies,
    lsTreeArgs,
    comments,
    logs,
  };
}

function blockedText(outcome: Outcome): string {
  return `${outcome.reason ?? ""}\n${outcome.comments.join("\n")}`;
}

Deno.test(
  "completion facts - valid facts render in place of the marker (Issue #3535)",
  async () => {
    const facts = factsFor(EXISTING_TEST);
    const outcome = await runCompletion({
      summary: summaryWith(BRANCH_OUTCOMES_MARKER),
      facts: JSON.stringify(facts),
      changedFiles: CHANGED,
      existingTestsAtHead: [EXISTING_TEST],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertStringIncludes(outcome.prBodies[0]!, renderBranchOutcomes(facts));
    assertEquals(outcome.prBodies[0]!.includes(BRANCH_OUTCOMES_MARKER), false);
    assert(
      outcome.logs.some((log) =>
        log.level === "info" &&
        log.message === "Loaded PR summary facts file" &&
        JSON.stringify(log.context) ===
          JSON.stringify({ source: `docs/archive/pr-summaries/${FACTS_FILE}` })
      ),
    );
    assertEquals(
      outcome.logs.some((log) =>
        log.message === "PR summary facts file is unusable"
      ),
      false,
    );
  },
);

Deno.test(
  "completion facts - valid facts without a marker are appended (Issue #3535)",
  async () => {
    const facts = factsFor(EXISTING_TEST);
    const outcome = await runCompletion({
      summary: summaryWith(""),
      facts: JSON.stringify(facts),
      changedFiles: CHANGED,
      existingTestsAtHead: [EXISTING_TEST],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertStringIncludes(outcome.prBodies[0]!, renderBranchOutcomes(facts));
  },
);

Deno.test(
  "completion facts - a cited test absent at HEAD blocks, naming it (Issue #3535)",
  async () => {
    const outcome = await runCompletion({
      summary: summaryWith(BRANCH_OUTCOMES_MARKER),
      facts: JSON.stringify(factsFor(MISSING_TEST)),
      changedFiles: CHANGED,
      existingTestsAtHead: [EXISTING_TEST],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(blockedText(outcome), MISSING_TEST);
  },
);

Deno.test(
  "completion facts - malformed JSON blocks, naming the facts file (Issue #3535)",
  async () => {
    const outcome = await runCompletion({
      summary: summaryWith(BRANCH_OUTCOMES_MARKER),
      facts: "{ not json",
      changedFiles: CHANGED,
      existingTestsAtHead: [EXISTING_TEST],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(blockedText(outcome), FACTS_FILE);
    assertStringIncludes(blockedText(outcome), "invalid JSON");
    // The gate comment itself names the facts problem, not only the reason.
    assert(outcome.comments.some((c) => c.includes(FACTS_FILE)));
    const warning = outcome.logs.find((log) =>
      log.level === "warn" &&
      log.message === "PR summary facts file is unusable"
    );
    assert(warning, "expected the unusable-facts warning");
    assertStringIncludes(
      (warning.context as { error: string }).error,
      FACTS_FILE,
    );
  },
);

Deno.test(
  "completion facts - schema-invalid facts block, naming the facts file (Issue #3535)",
  async () => {
    const outcome = await runCompletion({
      summary: summaryWith(BRANCH_OUTCOMES_MARKER),
      facts: JSON.stringify({
        version: 2,
        branchOutcomes: { noneAdded: true, entries: [] },
      }),
      changedFiles: CHANGED,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(blockedText(outcome), FACTS_FILE);
  },
);

Deno.test(
  "completion facts - an unreadable facts file blocks rather than reading as absent (Issue #3535)",
  async () => {
    const outcome = await runCompletion({
      summary: summaryWith(BRANCH_OUTCOMES_MARKER),
      factsIsDirectory: true,
      changedFiles: CHANGED,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(blockedText(outcome), FACTS_FILE);
    assertStringIncludes(blockedText(outcome), "could not be read");
  },
);

Deno.test(
  "completion facts - a facts file beside a hand-written Branch outcomes list blocks (Issue #3535)",
  async () => {
    const outcome = await runCompletion({
      summary: summaryWith(
        `**Branch outcomes:**\n- \`${CHANGED}:42\` — error — \`${EXISTING_TEST}::rejects bad input\``,
      ),
      facts: JSON.stringify(factsFor(EXISTING_TEST)),
      changedFiles: CHANGED,
      existingTestsAtHead: [EXISTING_TEST],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(blockedText(outcome), FACTS_FILE);
    assertStringIncludes(blockedText(outcome), "hand-written");
  },
);

Deno.test(
  "completion facts - every test path the validator checks is looked up at HEAD (Issue #3535)",
  async () => {
    const facts = factsFor(EXISTING_TEST);
    // A test-shaped `path` is checked by the validator too, so it must be
    // asked of git; it exists here, so the PR is raised.
    facts.branchOutcomes.entries[0]!.path = OTHER_TEST;
    const outcome = await runCompletion({
      summary: summaryWith(BRANCH_OUTCOMES_MARKER),
      facts: JSON.stringify(facts),
      changedFiles: CHANGED,
      existingTestsAtHead: [EXISTING_TEST, OTHER_TEST],
    });

    const looked = outcome.lsTreeArgs.flat();
    assert(looked.includes(EXISTING_TEST));
    assert(looked.includes(OTHER_TEST));
    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
  },
);
