/**
 * Facts flip stage of `deno task pr-summary-check` (Issue #4190).
 *
 * A vacuous tested entry is refused with the #4186 message. An unrunnable
 * entry is not checked. The same fixture yields the same verdict from this
 * stage and from the completion-phase gate.
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
  formatReport,
  type GateReport,
  runPrSummaryCheck,
} from "../lib/pr_summary_check.ts";
import type { GitRunner } from "../lib/git_base_ref.ts";
import { verifyFactsFlips } from "../lib/facts_flip_verifier.ts";

const ISSUE = 4190;
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f901122334455";
const REPO = "stSoftwareAU/VibeCoder";
const PR_URL = `https://github.com/${REPO}/pull/4190`;
const SOURCE_REL = "lib/m.ts";
const TEST_REL = "tests/m_test.ts";
const TEST_NAME = "pins the flag";
const REFUSAL =
  `\`${SOURCE_REL}:2\`: no flip of this line turns \`${TEST_NAME}\` red; name a test that fails, or add one`;

const SOURCE = [
  "export function f(a: boolean): boolean {",
  "  if (a) {",
  "    return true;",
  "  }",
  "  return false;",
  "}",
  "",
].join("\n");

const DOCS_SWEEP_LINE =
  "**Docs sweep** — grep: `BrokerBalance`; section: `docs/reporting-api.md#decisions-report`; no hits; siblings: none — no existing set gained a member";

function summary(): string {
  return [
    "## Summary",
    "",
    `Changed the flag. Closes #${ISSUE}.`,
    "",
    DOCS_SWEEP_LINE,
    "",
    BRANCH_OUTCOMES_MARKER,
    "",
    "## Test Plan",
    "",
    `- \`${TEST_REL}\``,
    "",
  ].join("\n");
}

function facts(test: string): string {
  return JSON.stringify({
    version: 1,
    branchOutcomes: {
      noneAdded: false,
      entries: [{
        path: SOURCE_REL,
        line: 2,
        outcome: "returns early when the flag is set",
        test,
        testName: TEST_NAME,
        flipWentRed: "the named test failed",
      }],
    },
  });
}

async function writeFixture(test: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "facts-flip-4190-" });
  await Deno.mkdir(`${dir}/lib`, { recursive: true });
  await Deno.mkdir(`${dir}/tests`, { recursive: true });
  await Deno.mkdir(`${dir}/docs/archive/pr-summaries`, { recursive: true });
  await Deno.writeTextFile(`${dir}/deno.json`, "{}\n");
  await Deno.writeTextFile(`${dir}/${SOURCE_REL}`, SOURCE);
  await Deno.writeTextFile(
    `${dir}/${TEST_REL}`,
    `Deno.test(${JSON.stringify(TEST_NAME)}, () => {});\n`,
  );
  await Deno.writeTextFile(
    `${dir}/docs/archive/pr-summaries/pr-summary-${ISSUE}.facts.json`,
    facts(test),
  );
  return dir;
}

function gitFor(testPath: string): GitRunner {
  return (args) => {
    const ok = (stdout = "", code = 0) =>
      Promise.resolve({
        ok: true as const,
        value: { code, stdout, stderr: "" },
      });
    if (args[0] === "rev-parse") return ok();
    if (args[0] === "diff") return ok(`${SOURCE_REL}\n`);
    if (args.includes("ls-tree")) return ok(`${testPath}\n`);
    return ok();
  };
}

function flipReport(reports: readonly GateReport[]): GateReport | undefined {
  return reports.find((report) => report.gate === "Facts flip verifier");
}

Deno.test("pr-summary-check facts flip - a vacuous tested entry is refused", async () => {
  const dir = await writeFixture(TEST_REL);
  try {
    const checked = await runPrSummaryCheck({
      summaryContent: summary(),
      issueNumber: ISSUE,
      baseBranch: "main",
      issueBody: null,
      issueLabels: null,
      runGit: gitFor(TEST_REL),
      repoRoot: dir,
    });
    assert(checked.ok);
    const report = flipReport(checked.value);
    assert(report, "facts flip stage missing");
    assertEquals(report.status, "blocked");
    assertStringIncludes(report.problems.join("\n"), REFUSAL);
    assertStringIncludes(formatReport(checked.value), REFUSAL);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pr-summary-check facts flip - an unrunnable entry is not checked", async () => {
  const dir = await writeFixture("tests/m_check.py");
  try {
    const checked = await runPrSummaryCheck({
      summaryContent: summary(),
      issueNumber: ISSUE,
      baseBranch: "main",
      issueBody: null,
      issueLabels: null,
      runGit: gitFor("tests/m_check.py"),
      repoRoot: dir,
    });
    assert(checked.ok);
    const report = flipReport(checked.value);
    assert(report, "facts flip stage missing");
    assertEquals(report.status, "not_checked");
    assertStringIncludes(report.note ?? "", "unsupported_test");
    assertEquals(report.status === "passed", false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

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

async function runCompletion(
  dir: string,
  testPath: string,
): Promise<
  { status: string; reason?: string; prCreateCalls: number; body: string }
> {
  const workDir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/docs/archive/pr-summaries/pr-summary-${ISSUE}.md`,
    summary(),
  );
  const comments: string[] = [];
  const prBodies: string[] = [];
  let prCreateCalls = 0;
  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;
  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Twin the facts flip gate",
    issueBody: "## Problem\n\nA self-reported flip is not evidence.\n",
    issueLabels: ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-facts-flip`,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: dir,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const deps = createMockDeps({
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
          if (cmdArgs.includes("--diff-filter=ACMR")) return ok("");
          return ok(SOURCE_REL);
        }
        if (cmdArgs[0] === "--literal-pathspecs" && cmdArgs[1] === "ls-tree") {
          return ok(cmdArgs.includes(testPath) ? testPath : "");
        }
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: () =>
        Promise.resolve({
          ok: true as const,
          value: { exitCode: 0, output: "done", timedOut: false },
        }),
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
      verifyFactsFlips,
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
  try {
    const result = await workOnIssueCompletion(ctx, state, deps);
    return {
      status: result.status,
      reason: result.status === "failure" || result.status === "early_exit"
        ? result.reason
        : undefined,
      prCreateCalls,
      body: `${prBodies[0] ?? ""}\n${comments.join("\n")}`,
    };
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

Deno.test("pr-summary-check facts flip - agrees with the completion-phase gate", async () => {
  const refusedDir = await writeFixture(TEST_REL);
  const uncheckedDir = await writeFixture("tests/m_check.py");
  try {
    const refusedCheck = await runPrSummaryCheck({
      summaryContent: summary(),
      issueNumber: ISSUE,
      baseBranch: "main",
      issueBody: null,
      issueLabels: null,
      runGit: gitFor(TEST_REL),
      repoRoot: refusedDir,
    });
    const refusedPhase = await runCompletion(refusedDir, TEST_REL);
    assert(refusedCheck.ok);
    const refused = flipReport(refusedCheck.value);
    assert(refused);
    assertEquals(refused.status, "blocked");
    assertEquals(refusedPhase.prCreateCalls, 0);
    assertEquals(refusedPhase.status, "failure");
    for (const message of refused.problems) {
      assertStringIncludes(refusedPhase.reason ?? "", message);
      assertStringIncludes(refusedPhase.body, message);
    }

    const uncheckedCheck = await runPrSummaryCheck({
      summaryContent: summary(),
      issueNumber: ISSUE,
      baseBranch: "main",
      issueBody: null,
      issueLabels: null,
      runGit: gitFor("tests/m_check.py"),
      repoRoot: uncheckedDir,
    });
    const uncheckedPhase = await runCompletion(
      uncheckedDir,
      "tests/m_check.py",
    );
    assert(uncheckedCheck.ok);
    const unchecked = flipReport(uncheckedCheck.value);
    assert(unchecked);
    assertEquals(unchecked.status, "not_checked");
    assertEquals(uncheckedPhase.status, "continue");
    assertEquals(uncheckedPhase.prCreateCalls, 1);
    assertStringIncludes(
      uncheckedPhase.body,
      unchecked.note ?? "missing-reason",
    );
    assertEquals(uncheckedPhase.body.includes("— verified"), false);
  } finally {
    await Deno.remove(refusedDir, { recursive: true });
    await Deno.remove(uncheckedDir, { recursive: true });
  }
});
