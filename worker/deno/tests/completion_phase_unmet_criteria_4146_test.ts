/**
 * Unmet acceptance criteria block the PR, and the run keeps working until
 * they are met (Issue #4146).
 *
 * The owner's ruling: "If the criteria is not met then don't raise a PR, just
 * complete the job." A run whose PR summary closes a criterion out `partial`
 * or `missing` used to raise a PR that closed the issue on merge and file a
 * `Finish #N` follow-up for the rest (Issues #2562, #3506). These tests drive
 * the LIVE completion phase (`workOnIssueCompletion`) and assert on what
 * reaches `gh` and the agent: no PR while a criterion is unmet, the agent sent
 * back in the same run with the unmet criteria named, exactly one PR once
 * every criterion is met, and a run failure — never a follow-up issue, never
 * `needs-human` — when the bounded rounds run out.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { PhaseClaudeResult } from "../lib/phase_run_stats.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import { detectFailureCategory } from "../lib/failure_diagnosis.ts";
import { MAX_UNMET_CRITERIA_ROUNDS } from "../lib/unmet_criteria_gate.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const SHA = "4146aaaabbbbccccddddeeeeffff000011112222";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 4146;
const PR_URL = `https://github.com/${REPO}/pull/4150`;

const CRITERIA = [
  "The router sends planning to opus.",
  "The docs table lists opus for planning.",
  "The release notes name the routing change.",
  "The config reference names the new default.",
  "The changelog entry links the issue.",
];

function issueWith(criteria: readonly string[]): string {
  return `## Problem\n\nRoute planning to opus.\n\n## Acceptance criteria\n\n${
    criteria.map((c) => `- [ ] ${c}`).join("\n")
  }\n`;
}

/** A summary closing each criterion with the given status; every other gate passes. */
function summaryWith(
  criteria: readonly string[],
  statuses: readonly ("met" | "partial" | "missing")[],
): string {
  const entries = criteria.map((criterion, i) => {
    const status = statuses[i] ?? "met";
    const subject = criterion.replace(/\.$/, "").toLowerCase();
    return status === "met"
      ? `- **met** — ${subject} — evidence: \`lib/config_defaults.ts\` — reviewer: met`
      : status === "partial"
      ? `- **partial** — ${subject} — evidence: \`lib/config_defaults.ts\` — reviewer: partial — reason: ran out of turns`
      : `- **missing** — ${subject} — reviewer: missing — reason: ran out of turns`;
  });
  return `## Summary

Routed planning. Closes #${ISSUE}.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

${entries.join("\n")}

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English, TDD, fail-loud error handling

**Docs sweep** — grep: \`opus\`; section: \`docs/MODEL-AND-CACHING.md#planning\`; no hits; siblings: none — no existing set gained a member

**Branch outcomes:** none added
`;
}

function stubClient(
  comments: string[],
  labelsAdded: string[],
): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_repo: string, _issue: number, label: string) => {
      labelsAdded.push(label);
      return Promise.resolve();
    },
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
  criteria: readonly string[];
  /** The summary on the branch when completion starts. */
  summary: string;
  /** What each recovery round writes, in order; past the end, nothing. */
  roundsWrite?: readonly string[];
  claudeRunStats?: PhaseClaudeResult[];
  /** The agent raised its own PR from inside the execute phase. */
  prExistsForBranch?: boolean;
  /** That PR is a timed-out run's draft continuation. */
  prIsDraft?: boolean;
}

interface Outcome {
  status: string;
  reason?: string;
  category?: string;
  claudePrompts: string[];
  prCreateArgs: string[][];
  prCloseArgs: string[][];
  prReadyArgs: string[][];
  prEditArgs: string[][];
  issueCreates: string[][];
  ghLabelEdits: string[][];
  labelsAdded: string[];
  recoverCalls: number;
  finaliseCalls: number;
  comments: string[];
}

async function runCompletion(scenario: Scenario): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  const workDir = await Deno.makeTempDir();
  const summaryPath =
    `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(summaryPath, scenario.summary);

  const comments: string[] = [];
  const labelsAdded: string[] = [];
  const claudePrompts: string[] = [];
  const prCreateArgs: string[][] = [];
  const prCloseArgs: string[][] = [];
  const prReadyArgs: string[][] = [];
  const prEditArgs: string[][] = [];
  const issueCreates: string[][] = [];
  const ghLabelEdits: string[][] = [];
  let recoverCalls = 0;
  let finaliseCalls = 0;
  let round = 0;

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Route planning to opus",
    issueBody: issueWith(scenario.criteria),
    issueLabels: ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-route`,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    claudeRunStats: scenario.claudeRunStats ?? [],
  };

  const deps = createMockDeps({
    github: {
      createClient: () => stubClient(comments, labelsAdded),
      ensureLabelExists: () =>
        Promise.resolve({ ok: true as const, value: undefined }),
      runGhCommand: (args: string[]) => {
        if (args[0] === "issue" && args[1] === "create") {
          issueCreates.push(args);
          return Promise.resolve(`https://github.com/${REPO}/issues/9999\n`);
        }
        if (args[0] === "issue" && args[1] === "edit") {
          ghLabelEdits.push(args);
          return Promise.resolve("");
        }
        if (args[0] === "issue" && args[1] === "list") {
          return Promise.resolve("[]");
        }
        if (args[0] === "pr" && args[1] === "create") prCreateArgs.push(args);
        if (args[0] === "pr" && args[1] === "close") prCloseArgs.push(args);
        if (args[0] === "pr" && args[1] === "edit") prEditArgs.push(args);
        if (args[0] === "pr" && args[1] === "ready") prReadyArgs.push(args);
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(JSON.stringify({
            state: "OPEN",
            ...(scenario.prIsDraft ? { isDraft: true } : {}),
          }));
        }
        return Promise.resolve(PR_URL);
      },
    },
    git: {
      runGitCommand: (
        cmdArgs: string[],
      ): Promise<Result<{ code: number; stdout: string; stderr: string }>> => {
        const ok = (stdout: string) =>
          Promise.resolve({
            ok: true as const,
            value: { code: 0, stdout, stderr: "" },
          });
        if (cmdArgs[0] === "rev-parse") return ok(`${SHA}\n`);
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
          return ok("worker/deno/lib/config_defaults.ts");
        }
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: (options: { prompt: string }) => {
        claudePrompts.push(options.prompt);
        const next = scenario.roundsWrite?.[round];
        round++;
        if (next !== undefined) Deno.writeTextFileSync(summaryPath, next);
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
        Promise.resolve(
          scenario.prExistsForBranch
            ? { ok: true as const, value: PR_URL }
            : { ok: false as const, error: new Error("none") },
        ),
      recoverExistingPr: () => {
        recoverCalls++;
        return Promise.resolve({ ok: true, value: "recovered" });
      },
      finalisePr: () => {
        finaliseCalls++;
        return Promise.resolve({
          ok: true,
          value: { result: AutoMergeResult.Enabled, message: "armed" },
        });
      },
    },
  });

  let result;
  try {
    result = await workOnIssueCompletion(ctx, state, deps);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }

  const reason = result.status === "failure" || result.status === "early_exit"
    ? result.reason
    : undefined;
  return {
    status: result.status,
    reason,
    category: result.status === "failure" ? result.category : undefined,
    claudePrompts,
    prCreateArgs,
    prCloseArgs,
    prReadyArgs,
    prEditArgs,
    issueCreates,
    ghLabelEdits,
    labelsAdded,
    recoverCalls,
    finaliseCalls,
    comments,
  };
}

const TWO = CRITERIA.slice(0, 2);

Deno.test(
  "#4146 - a missing criterion raises no PR and sends the agent back with that criterion named",
  async () => {
    const out = await runCompletion({
      criteria: TWO,
      summary: summaryWith(TWO, ["met", "missing"]),
    });

    assertEquals(
      out.prCreateArgs.length,
      0,
      "no PR while a criterion is unmet",
    );
    assert(out.claudePrompts.length >= 1, "the agent is sent back in-run");
    const prompt = out.claudePrompts[0]!;
    assertStringIncludes(prompt, "The docs table lists opus for planning.");
    assertStringIncludes(prompt, "UNMET CRITERION");
    assertEquals(out.issueCreates, [], "no follow-up issue is filed");
  },
);

Deno.test(
  "#4146 - when the next round meets every criterion, exactly one PR is raised and it closes the issue",
  async () => {
    const out = await runCompletion({
      criteria: TWO,
      summary: summaryWith(TWO, ["met", "missing"]),
      roundsWrite: [summaryWith(TWO, ["met", "met"])],
    });

    assertEquals(out.status, "continue");
    assertEquals(out.claudePrompts.length, 1);
    assertEquals(out.prCreateArgs.length, 1);
    const body = out
      .prCreateArgs[0]![out.prCreateArgs[0]!.indexOf("--body") + 1]!;
    assertStringIncludes(body, `Closes #${ISSUE}`);
    assertFalse(body.includes("Partial delivery"));
    assertFalse(body.includes("Degraded run"));
    assertEquals(out.issueCreates, []);
  },
);

Deno.test(
  "#4146 - unmet criteria that no round can move fail the run: no PR, no follow-up, no needs-human",
  async () => {
    const stuck = summaryWith(TWO, ["met", "partial"]);
    const out = await runCompletion({
      criteria: TWO,
      summary: stuck,
      roundsWrite: [stuck, stuck, stuck, stuck],
    });

    assertEquals(out.status, "failure");
    assertEquals(out.category, "criteria_unmet");
    assertEquals(detectFailureCategory(out.reason ?? ""), "criteria_unmet");
    assertEquals(out.prCreateArgs.length, 0);
    assertEquals(out.issueCreates, []);
    assertFalse(out.labelsAdded.includes("needs-human"));
    assertFalse(
      out.ghLabelEdits.some((args) => args.join(" ").includes("needs-human")),
    );
    // A round that makes no progress ends the run: the first block plus one
    // recovery round, not the whole budget.
    assertEquals(out.claudePrompts.length, 1);
  },
);

Deno.test(
  "#4146 - rounds continue while each makes progress, up to the bound",
  async () => {
    const statuses = (metCount: number): ("met" | "missing")[] =>
      CRITERIA.map((_, i) => i < metCount ? "met" : "missing");
    const out = await runCompletion({
      criteria: CRITERIA,
      summary: summaryWith(CRITERIA, statuses(0)),
      // Each round meets one more criterion — progress every time, but five
      // criteria cannot all land inside the bound.
      roundsWrite: [1, 2, 3, 4, 5].map((n) =>
        summaryWith(CRITERIA, statuses(n))
      ),
    });

    assertEquals(out.claudePrompts.length, MAX_UNMET_CRITERIA_ROUNDS);
    assertEquals(out.status, "failure");
    assertEquals(out.category, "criteria_unmet");
    assertEquals(out.prCreateArgs.length, 0);
    assertEquals(out.issueCreates, []);
  },
);

Deno.test(
  "#4146 - a degraded run follows the same rules: no PR and no follow-up for a partial criterion",
  async () => {
    const out = await runCompletion({
      criteria: TWO,
      summary: summaryWith(TWO, ["partial", "met"]),
      claudeRunStats: [{ fallbackModel: "haiku" }],
    });

    assertEquals(out.prCreateArgs.length, 0);
    assertEquals(out.issueCreates, []);
    assertEquals(out.status, "failure");
    assertEquals(out.category, "criteria_unmet");
  },
);

Deno.test(
  "#4146 - a PR the agent raised itself becomes a draft, not finalised or closed, while a criterion is unmet",
  async () => {
    const stuck = summaryWith(TWO, ["met", "missing"]);
    const out = await runCompletion({
      criteria: TWO,
      summary: stuck,
      roundsWrite: [stuck],
      prExistsForBranch: true,
    });

    assertEquals(out.status, "failure");
    assertEquals(out.category, "criteria_unmet");
    assertEquals(out.finaliseCalls, 0, "auto-merge is never armed");
    assertEquals(out.recoverCalls, 0, "the PR body is not finalised");
    // Owner (Issue #4146): an incomplete PR is a draft, not closed, so CI
    // and review are not spent on it and the next run continues the branch.
    assertEquals(out.prCloseArgs, [], "the PR is never closed");
    assert(
      out.prReadyArgs.some((a) => a.includes("--undo")),
      "converted back to a draft",
    );
    const body =
      out.prEditArgs.at(-1)?.[out.prEditArgs.at(-1)!.indexOf("--body") + 1] ??
        "";
    assertStringIncludes(body, `Part of #${ISSUE}`);
    assertFalse(/\bcloses\s+#4146\b/i.test(body), "no closing keyword");
    assertEquals(out.issueCreates, []);
  },
);

Deno.test(
  "#4146 - criteria the summary never assesses are not met: no PR is finalised",
  async () => {
    const silent = `## Summary\n\nRouted planning. Closes #${ISSUE}.\n`;
    const out = await runCompletion({
      criteria: TWO,
      summary: silent,
      roundsWrite: [silent],
      prExistsForBranch: true,
    });

    assertEquals(out.status, "failure");
    assertEquals(out.category, "criteria_unmet");
    assertEquals(out.finaliseCalls, 0);
    assertEquals(out.prCloseArgs, []);
    assert(out.prReadyArgs.some((a) => a.includes("--undo")));
    assertEquals(out.issueCreates, []);
  },
);

Deno.test(
  "#4146 - a draft continuation PR is marked ready once every criterion is met",
  async () => {
    const out = await runCompletion({
      criteria: TWO,
      summary: summaryWith(TWO, ["met", "met"]),
      prExistsForBranch: true,
      prIsDraft: true,
    });

    assertEquals(out.status, "continue");
    assertEquals(out.prReadyArgs.length, 1, "gh pr ready");
    assertFalse(out.prReadyArgs[0]!.includes("--undo"));
    assertEquals(out.recoverCalls, 1, "the body is rewritten (Closes #N)");
    assertEquals(out.finaliseCalls, 1, "then the normal auto-merge path");
    assertEquals(out.prCreateArgs.length, 0, "no second PR");
  },
);

Deno.test(
  "#4146 - a ready PR is not re-marked ready",
  async () => {
    const out = await runCompletion({
      criteria: TWO,
      summary: summaryWith(TWO, ["met", "met"]),
      prExistsForBranch: true,
    });
    assertEquals(out.prReadyArgs.length, 0);
  },
);

Deno.test(
  "#4146 - no worker module files a degraded-follow-up issue any more",
  async () => {
    const offenders: string[] = [];
    const root = new URL("../lib/", import.meta.url);
    const walk = async (dir: URL) => {
      for await (const entry of Deno.readDir(dir)) {
        const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
        if (entry.isDirectory) await walk(url);
        else if (entry.name.endsWith(".ts")) {
          const text = await Deno.readTextFile(url);
          if (
            text.includes("degraded-follow-up-") ||
            text.includes("fileDegradedFollowUp")
          ) offenders.push(url.pathname);
        }
      }
    };
    await walk(root);
    assertEquals(offenders, []);
  },
);
