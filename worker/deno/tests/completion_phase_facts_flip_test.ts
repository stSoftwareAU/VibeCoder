/**
 * Completion-phase facts flip gate (Issue #4188).
 *
 * Drives `workOnIssueCompletion` with a stub `verifyFactsFlips`. A refused
 * entry must not raise a PR, and the refusal text is the #4186 message. A
 * thrown verifier is a loud not-checked, never a pass.
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
import type { SummaryFacts } from "../lib/summary_facts.ts";
import type {
  FactsFlipSeams,
  FactsFlipVerdict,
} from "../lib/facts_flip_verifier.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f901122334455";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 4188;
const PR_URL = `https://github.com/${REPO}/pull/4188`;
const SOURCE = "lib/m.ts";
const TEST_PATH = "tests/m_test.ts";
const TEST_NAME = "pins the flag";
const FLIP = "the named test failed";
const REFUSAL =
  `\`${SOURCE}:2\`: no flip of this line turns \`${TEST_NAME}\` red; name a test that fails, or add one`;

const ISSUE_BODY = "## Problem\n\nA self-reported flip is not evidence.\n";
const DOCS_SWEEP_LINE =
  "**Docs sweep** — grep: `BrokerBalance`; section: `docs/reporting-api.md#decisions-report`; no hits; siblings: none — no existing set gained a member";

function summary(): string {
  return `## Summary

Changed the flag. Closes #${ISSUE}.

${DOCS_SWEEP_LINE}

${BRANCH_OUTCOMES_MARKER}

## Test Plan

- \`${TEST_PATH}\`
`;
}

function facts(): SummaryFacts {
  return {
    version: 1,
    branchOutcomes: {
      noneAdded: false,
      entries: [{
        path: SOURCE,
        line: 2,
        outcome: "returns early when the flag is set",
        test: TEST_PATH,
        testName: TEST_NAME,
        flipWentRed: FLIP,
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
  verify?: (
    facts: SummaryFacts,
    seams: FactsFlipSeams,
  ) => Promise<FactsFlipVerdict[]>;
  /** Omit the dependency entirely. */
  unwired?: boolean;
}

interface Outcome {
  status: string;
  reason?: string;
  prCreateCalls: number;
  prBodies: string[];
  comments: string[];
  logs: { level: string; message: string }[];
}

async function runCompletion(scenario: Scenario): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  const workDir = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE}.md`,
    summary(),
  );
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE}.facts.json`,
    JSON.stringify(facts()),
  );

  const comments: string[] = [];
  const prBodies: string[] = [];
  const logs: Outcome["logs"] = [];
  let prCreateCalls = 0;

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;
  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Check the facts flip gate",
    issueBody: ISSUE_BODY,
    issueLabels: ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-facts-flip`,
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
      info: (message: string) => logs.push({ level: "info", message }),
      warn: (message: string) => logs.push({ level: "warn", message }),
      error: (message: string) => logs.push({ level: "error", message }),
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
          if (cmdArgs.includes("--diff-filter=ACMR")) return ok("");
          return ok(SOURCE);
        }
        if (cmdArgs[0] === "--literal-pathspecs" && cmdArgs[1] === "ls-tree") {
          return ok(cmdArgs.includes(TEST_PATH) ? TEST_PATH : "");
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
      ...(scenario.unwired ? {} : {
        verifyFactsFlips: scenario.verify ??
          (() => Promise.resolve([])),
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
    prCreateCalls,
    prBodies,
    comments,
    logs,
  };
}

function blockedText(outcome: Outcome): string {
  return `${outcome.reason ?? ""}\n${outcome.comments.join("\n")}`;
}

Deno.test("completion facts flip - a refused entry blocks the raise with the #4186 message", async () => {
  const outcome = await runCompletion({
    verify: () =>
      Promise.resolve([{
        index: 0,
        verdict: { kind: "refused", message: REFUSAL },
      }]),
  });
  assertEquals(outcome.prCreateCalls, 0);
  assertEquals(outcome.status, "failure");
  assertStringIncludes(blockedText(outcome), REFUSAL);
});

Deno.test("completion facts flip - a verified entry is shown beside flipWentRed", async () => {
  const outcome = await runCompletion({
    verify: () =>
      Promise.resolve([{
        index: 0,
        verdict: { kind: "verified" },
      }]),
  });
  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertStringIncludes(
    outcome.prBodies[0]!,
    `flip: \`${FLIP}\` — verified`,
  );
});

Deno.test("completion facts flip - not_checked shows its reason and is not verified", async () => {
  const outcome = await runCompletion({
    verify: () =>
      Promise.resolve([{
        index: 0,
        verdict: { kind: "not_checked", reason: "baseline_failure" },
      }]),
  });
  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  const body = outcome.prBodies[0]!;
  assertStringIncludes(body, "not checked: baseline_failure");
  assertEquals(body.includes("— verified"), false);
});

Deno.test("completion facts flip - an unwired verifier is a loud not_checked, not a pass", async () => {
  const outcome = await runCompletion({ unwired: true });
  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  const body = outcome.prBodies[0]!;
  assertStringIncludes(body, "not checked: the flip verifier is not wired");
  assertEquals(body.includes("— verified"), false);
  assert(
    outcome.logs.some((log) =>
      log.level === "warn" &&
      log.message === "Facts flip verifier is not wired"
    ),
  );
});

Deno.test("completion facts flip - a thrown verifier is a loud not_checked, never a pass", async () => {
  const outcome = await runCompletion({
    verify: () => Promise.reject(new Error("deno exploded")),
  });
  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  const body = outcome.prBodies[0]!;
  assertStringIncludes(
    body,
    "not checked: the flip verifier failed: deno exploded",
  );
  assertEquals(body.includes("— verified"), false);
  assert(
    outcome.logs.some((log) =>
      log.level === "error" && log.message === "Facts flip verifier failed"
    ),
  );
  assertEquals(
    outcome.logs.some((log) =>
      log.message.startsWith("WARNING:") || log.message.startsWith("ERROR:")
    ),
    false,
  );
});
