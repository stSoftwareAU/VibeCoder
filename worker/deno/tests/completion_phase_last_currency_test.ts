/**
 * The base can move while the PR-raise gates run. Right before `gh pr create`
 * the branch is checked against its base once more and, when it is behind,
 * the base is merged in and pushed then, while no PR exists and the push
 * starts no CI. The PR's first CI run is then also its last
 * (owner rule 2026-11-03). That catch-up merge is new, untested content, so
 * it is gated before it is pushed (Issue #5646).
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import {
  type gateUnpushedCommits,
  PrePushGateBlockedError,
} from "../lib/git_push.ts";
import { PRE_PUSH_GATE_MARKER } from "../lib/failure_diagnosis.ts";
import type { GitHubClient } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const BRANCH = "issue-2459-last-currency-test";
const BASE_BRANCH = "main";

type GateOutcome = Awaited<ReturnType<typeof gateUnpushedCommits>>;

const GATE_PASSED: GateOutcome = {
  ok: true,
  value: { kind: "passed", checksRun: [] },
};

function gateBlocked(): GateOutcome {
  return {
    ok: false,
    error: new PrePushGateBlockedError(
      "deno test failed in tests/example_test.ts",
    ),
  };
}

function stubClient(): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub: getIssue not implemented");
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

function context(): IssueContext {
  return {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 2459,
    issueTitle: "Last-moment base currency before the PR is raised",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
}

function state(repoPath: string): PhaseState {
  return {
    branchName: BRANCH,
    baseBranch: BASE_BRANCH,
    defaultBranch: BASE_BRANCH,
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

/**
 * `behindOnCall` answers each drift check: the first is the PR-raise sync,
 * the last is the check just before `gh pr create`. The gate verdict depends
 * on whether the base has been merged and any simulated repair has run.
 */
function deps(
  behindOnCall: (call: number) => number,
  events: string[],
  gateOnTree: (merged: boolean, repaired: boolean) => GateOutcome = () =>
    GATE_PASSED,
  issueState: () => "OPEN" | "CLOSED" = () => "OPEN",
) {
  let driftChecks = 0;
  let repaired = false;
  return createMockDeps({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as never,
    claude: {
      runClaudeWithRetry: () => {
        repaired = true;
        return Promise.resolve({
          ok: true as const,
          value: { exitCode: 0, output: "mock repair", timedOut: false },
        });
      },
    },
    github: {
      createClient: () => stubClient(),
      runGhCommand: (args: string[]) => {
        if (
          args[0] === "issue" && args[1] === "view" && args.at(-1) === "state"
        ) {
          return Promise.resolve(JSON.stringify({ state: issueState() }));
        }
        if (args[0] === "pr" && args[1] === "create") events.push("create");
        return Promise.resolve(
          "https://github.com/stSoftwareAU/VibeCoder/pull/2459",
        );
      },
    },
    git: {
      reconcileHeadToBranch: () =>
        Promise.resolve({
          ok: true as const,
          value: { action: "already-on-branch" as const, fromRef: BRANCH },
        }),
      gateUnpushedCommits: () =>
        Promise.resolve(gateOnTree(events.includes("merge"), repaired)),
      commitAndPushPending: async (
        _branchName,
        _message,
        _opts,
        _allowDefault,
        _preFlight,
        _runId,
        _formatBeforeGate,
        beforePush,
      ) => {
        if (beforePush) {
          const verdict = await beforePush();
          if (!verdict.ok) return { ok: false as const, error: verdict.error };
        }
        events.push("push");
        return {
          ok: true as const,
          value: {
            committedNewChanges: true,
            commitsPushed: 1,
            finalUnpushedCount: 0,
            finalUnpushedSource: "remote-head" as const,
          },
        };
      },
      pushUnpushedCommits: () => {
        events.push("push");
        return Promise.resolve({ ok: true as const, value: 1 });
      },
      runGitCommand: (args: string[]) => {
        const joined = args.join(" ");
        let stdout = "";
        if (args[0] === "rev-list" && joined.includes("--left-right")) {
          driftChecks++;
          stdout = `${behindOnCall(driftChecks)} 1\n`;
        } else if (args[0] === "merge" && args[1] === "--no-edit") {
          events.push("merge");
        } else if (
          args[0] === "rev-parse" && joined.includes("--verify") &&
          joined.includes("^{commit}")
        ) {
          stdout = "a".repeat(40) + "\n";
        }
        return Promise.resolve({
          ok: true as const,
          value: { code: 0, stdout, stderr: "" },
        });
      },
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
    },
  });
}

async function withSummary(run: (repoPath: string) => Promise<void>) {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-2459.md`,
    "## Summary\n\nLast-moment currency. Closes #2459.\n\n**Branch outcomes:** none added\n",
  );
  try {
    await run(repoPath);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
}

Deno.test("a base that moved during the gates is merged in and pushed before the PR is created", async () => {
  await withSummary(async (repoPath) => {
    const events: string[] = [];
    // Current at the PR-raise sync, one behind by the time the PR is raised.
    const result = await workOnIssueCompletion(
      context(),
      state(repoPath),
      deps((call) => (call === 1 ? 0 : 1), events),
    );
    assertEquals(result.status, "continue");
    const create = events.lastIndexOf("create");
    assert(create > 0, `the PR was raised: ${events.join(", ")}`);
    const before = events.slice(0, create);
    const merge = before.lastIndexOf("merge");
    assert(merge >= 0, `events: ${events.join(", ")}`);
    assert(before.lastIndexOf("push") > merge, events.join(", "));
  });
});

Deno.test("a branch still current when the PR is raised is not pushed again", async () => {
  await withSummary(async (repoPath) => {
    const events: string[] = [];
    const result = await workOnIssueCompletion(
      context(),
      state(repoPath),
      deps(() => 0, events),
    );
    assertEquals(result.status, "continue");
    assertEquals(events.includes("merge"), false);
    assertEquals(events.filter((e) => e === "push").length, 1);
  });
});

Deno.test("a catch-up merge the gate blocks is never pushed and the PR is not raised", async () => {
  await withSummary(async (repoPath) => {
    const events: string[] = [];
    // Current at the PR-raise sync, one behind at the last check. The gate
    // passes the branch before the merge and blocks the merged result.
    // A simulated repair could make it pass, but late repairs must not ship.
    const result = await workOnIssueCompletion(
      context(),
      state(repoPath),
      deps(
        (call) => (call === 1 ? 0 : 1),
        events,
        (merged, repaired) =>
          merged && !repaired ? gateBlocked() : GATE_PASSED,
      ),
    );
    assert(result.status === "failure", `status: ${result.status}`);
    assertEquals(result.category, "pre_push_gate");
    assert(
      result.reason.startsWith(PRE_PUSH_GATE_MARKER),
      `reason: ${result.reason}`,
    );
    assertEquals(events.includes("create"), false, events.join(", "));
    // Positive control: the catch-up merge really ran before the block.
    assert(events.includes("merge"), `events: ${events.join(", ")}`);
    const lastMerge = events.lastIndexOf("merge");
    assertEquals(
      events.slice(lastMerge + 1).includes("push"),
      false,
      `events: ${events.join(", ")}`,
    );
  });
});

Deno.test("an issue closed during the catch-up gate never gets a PR", async () => {
  await withSummary(async (repoPath) => {
    const events: string[] = [];
    let closed = false;
    const result = await workOnIssueCompletion(
      context(),
      state(repoPath),
      deps(
        (call) => (call === 1 ? 0 : 1),
        events,
        (merged) => {
          if (merged) closed = true;
          return GATE_PASSED;
        },
        () => closed ? "CLOSED" : "OPEN",
      ),
    );
    assert(closed, "the catch-up gate observed the merged tree");
    assert(result.status === "early_exit", `status: ${result.status}`);
    assert(result.reason.startsWith("claim_stale:issue_closed"));
    assertEquals(events.includes("create"), false, events.join(", "));
  });
});
