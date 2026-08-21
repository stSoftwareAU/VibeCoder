/**
 * The completion phase only treats a PR as "already exists" when it is OPEN
 * and its head is the branch this run pushed (Issue #174).
 *
 * VibeCoder#42: a human's partial PR (#173) for the same issue merged while
 * the worker's execute was still running. The by-issue-number lookup matched
 * it, the worker "recovered" into it, closed #42 on the strength of that
 * merge, and left its own three commits on a branch with no PR at all.
 *
 * Every test drives `workOnIssueCompletion` with injected doubles and asserts
 * on observable behaviour — the gh commands issued and the phase result.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { GitHubClient } from "../types.ts";

const REPO = "stSoftwareAU/VibeCoder";
const BRANCH = "issue-42-primary-graphql-quota-exhaustion";
/** The human's partial PR for the same issue — merged, on another branch. */
const FOREIGN_PR = `https://github.com/${REPO}/pull/173`;
const OWN_PR = `https://github.com/${REPO}/pull/175`;

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

interface RunOptions {
  /** PR URL returned by the by-issue-number search (the dangerous lookup). */
  prForIssue?: string;
  /**
   * Per-call answers for the by-issue-number search, so a PR that only
   * becomes visible after a failed `gh pr create` can be modelled.
   */
  prForIssueSequence?: Array<string | undefined>;
  /** PR URL returned by the by-branch search. */
  prForBranch?: string;
  /** PR number → the state and head branch `gh pr view` reports. */
  prView?: Record<string, { state: string; headRefName: string }>;
  /** Make `gh pr create` fail with this message. */
  createFails?: string;
}

async function runCompletion(opts: RunOptions): Promise<{
  status: string;
  reason?: string;
  ghCalls: string[][];
  warnings: string[];
  recoveredUrls: string[];
}> {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-42.md`,
    "## Summary\n\nRe-run the pre-flight quota gate. Closes #42.\n",
  );

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: 42,
    issueTitle: "Primary GraphQL quota exhaustion is swallowed",
    issueBody: "",
    issueLabels: ["top-priority"],
    issueComments: "",
    githubUser: "vibe-worker",
    config: buildDefaultWorkerConfig(),
  };
  const state: PhaseState = {
    branchName: BRANCH,
    baseBranch: "Develop",
    defaultBranch: "Develop",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };

  const ghCalls: string[][] = [];
  const warnings: string[] = [];
  const recoveredUrls: string[] = [];
  let issueLookups = 0;

  const deps = createMockDeps({
    logger: {
      info: () => undefined,
      warn: (m: string) => warnings.push(m),
      error: (m: string) => warnings.push(m),
      debug: () => undefined,
    } as never,
    github: {
      createClient: () => stubClient(),
      runGhCommand: (args: string[]) => {
        ghCalls.push([...args]);
        if (args[0] === "pr" && args[1] === "view") {
          const view = opts.prView?.[args[2]!];
          return Promise.resolve(JSON.stringify(view ?? { state: "OPEN" }));
        }
        if (args[0] === "pr" && args[1] === "create") {
          if (opts.createFails) {
            return Promise.reject(new Error(opts.createFails));
          }
          return Promise.resolve(`${OWN_PR}\n`);
        }
        return Promise.resolve("");
      },
    },
    git: {
      reconcileHeadToBranch: () =>
        Promise.resolve({
          ok: true as const,
          value: { action: "already-on-branch" as const, fromRef: BRANCH },
        }),
      pushUnpushedCommits: () => Promise.resolve({ ok: true as const, value: 3 }),
      runGitCommand: (args: string[]) =>
        Promise.resolve({
          ok: true as const,
          value: {
            code: 0,
            stdout: args[0] === "rev-list" ? "3\n" : "",
            stderr: "",
          },
        }),
    },
    pr: {
      findExistingPrForIssue: () => {
        const url = opts.prForIssueSequence
          ? opts.prForIssueSequence[issueLookups++]
          : opts.prForIssue;
        return Promise.resolve(
          url
            ? { ok: true as const, value: url }
            : { ok: false as const, error: new Error("No PR found") },
        );
      },
      findExistingPrForBranch: () =>
        Promise.resolve(
          opts.prForBranch
            ? { ok: true as const, value: opts.prForBranch }
            : { ok: false as const, error: new Error("No PR found") },
        ),
      recoverExistingPr: (
        _repo: string,
        _issueNumber: number,
        prUrl: string,
      ) => {
        recoveredUrls.push(prUrl);
        return Promise.resolve({ ok: true as const, value: "recovered" });
      },
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);
  await Deno.remove(repoPath, { recursive: true });
  return {
    status: result.status,
    ...(result.status === "failure" ? { reason: result.reason } : {}),
    ghCalls,
    warnings,
    recoveredUrls,
  };
}

// ---------------------------------------------------------------------------
// The defect: a merged PR for the issue, on somebody else's branch.
// ---------------------------------------------------------------------------

Deno.test("completion #174 - a merged sibling PR for the issue does not stand in for this run's PR", async () => {
  const run = await runCompletion({
    prForIssue: FOREIGN_PR,
    prView: { "173": { state: "MERGED", headRefName: "issue-42-per-pass-rest-pr" } },
  });

  assertEquals(run.status, "continue");

  // The run's branch got its own PR.
  const create = run.ghCalls.find((a) => a[0] === "pr" && a[1] === "create");
  assert(create, "a PR must be raised for this run's branch");
  assertEquals(create[create.indexOf("--head") + 1], BRANCH);

  // The sibling PR was never recovered into.
  assertEquals(run.recoveredUrls, []);

  // And the issue was NOT closed on the strength of that merge.
  assertEquals(
    run.ghCalls.some((a) => a[0] === "issue" && a[1] === "close"),
    false,
    "the worker must not close the issue for a PR it did not open",
  );

  // The skip is audible — nothing above INFO was logged on #42.
  assert(
    run.warnings.some((w) => w.includes("174")),
    `expected a warning naming the ignored PR: ${run.warnings}`,
  );
});

Deno.test("completion #174 - an OPEN PR for the issue on another branch does not stand in either", async () => {
  const run = await runCompletion({
    prForIssue: FOREIGN_PR,
    prView: { "173": { state: "OPEN", headRefName: "somebody-elses-branch" } },
  });

  assertEquals(run.status, "continue");
  assertEquals(run.recoveredUrls, []);
  const create = run.ghCalls.find((a) => a[0] === "pr" && a[1] === "create");
  assert(create, "a PR must be raised for this run's branch");
  assertEquals(create[create.indexOf("--head") + 1], BRANCH);
});

// ---------------------------------------------------------------------------
// The behaviour that must be preserved: genuine idempotency.
// ---------------------------------------------------------------------------

Deno.test("completion #174 - an open PR on this run's branch is still reused, not duplicated", async () => {
  const run = await runCompletion({
    prForBranch: OWN_PR,
    prView: { "175": { state: "OPEN", headRefName: BRANCH } },
  });

  assertEquals(run.status, "continue");
  assertEquals(run.recoveredUrls, [OWN_PR]);
  assertEquals(
    run.ghCalls.some((a) => a[0] === "pr" && a[1] === "create"),
    false,
    "an open PR for this branch must never be duplicated",
  );
});

Deno.test("completion #174 - the by-issue lookup is still honoured when the PR is open on this run's branch", async () => {
  // Defence in depth (Issue #872): the by-branch listing can miss a PR the
  // by-issue search finds. That candidate is trusted once it is verified.
  const run = await runCompletion({
    prForIssue: OWN_PR,
    prView: { "175": { state: "OPEN", headRefName: BRANCH } },
  });

  assertEquals(run.status, "continue");
  assertEquals(run.recoveredUrls, [OWN_PR]);
  assertEquals(
    run.ghCalls.some((a) => a[0] === "pr" && a[1] === "create"),
    false,
  );
});

// ---------------------------------------------------------------------------
// PR-creation failure recovery must apply the same ownership rule.
// ---------------------------------------------------------------------------

Deno.test("completion #174 - a failed pr create does not recover into a foreign PR; it fails loudly", async () => {
  const run = await runCompletion({
    createFails: "GraphQL: something went wrong",
    prForIssue: FOREIGN_PR,
    prView: { "173": { state: "MERGED", headRefName: "issue-42-per-pass-rest-pr" } },
  });

  assertEquals(run.status, "failure");
  assertStringIncludes(run.reason ?? "", "PR creation failed");
  assertEquals(run.recoveredUrls, []);
  assertEquals(
    run.ghCalls.some((a) => a[0] === "issue" && a[1] === "close"),
    false,
  );
});

Deno.test("completion #174 - a failed pr create still recovers into this run's own open PR", async () => {
  const run = await runCompletion({
    createFails: "a pull request for branch already exists",
    // Invisible to the pre-check, visible to the post-failure self-heal.
    prForIssueSequence: [undefined, OWN_PR],
    prView: { "175": { state: "OPEN", headRefName: BRANCH } },
  });

  assertEquals(run.status, "continue");
  assertEquals(run.recoveredUrls, [OWN_PR]);
});
