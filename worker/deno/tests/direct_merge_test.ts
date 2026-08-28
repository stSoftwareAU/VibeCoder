/**
 * Tests for direct merge module — merge-if-checks-passed command.
 *
 * Tests checkCiStatus() with mock API responses for passed, pending,
 * and failed scenarios, plus command argument parsing and output format.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 * Issue #926
 */

import { assertEquals } from "@std/assert";
import {
  checkCiStatus,
  type CheckRunsResponse,
  type CiStatusResult,
  type CombinedStatusResponse,
  directMergePr,
  enforcePreMergeRequirements,
  MIN_HEAD_AGE_SECONDS,
  type PreMergeGateFn,
  type PreMergeGateOutcome,
  prTargetsDefaultBranch,
} from "../lib/direct_merge.ts";
import type { Result } from "../types.ts";
import type { PRBranchStateBatchResult } from "../lib/pr_branch_state.ts";
import { mergeIfChecksPassedCommand } from "../commands/merge_if_checks_passed.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

function mockConfig(): WorkerConfig {
  return buildDefaultWorkerConfig();
}

const FAKE_SHA = "abc123def456";
const PR_VIEW_RESPONSE = JSON.stringify({ headRefOid: FAKE_SHA });

/**
 * Create a mock gh command function that returns appropriate responses
 * for the three API calls made by checkCiStatus:
 * 1. pr view → headRefOid
 * 2. check-runs API → check runs response
 * 3. status API → combined status response
 */
function createCiStatusMock(
  checkRuns: CheckRunsResponse,
  combinedStatus: CombinedStatusResponse,
): (args: string[]) => Promise<string> {
  return async (args: string[]) => {
    const joined = args.join(" ");
    if (joined.includes("pr view")) {
      return PR_VIEW_RESPONSE;
    }
    if (joined.includes("check-runs")) {
      return JSON.stringify(checkRuns);
    }
    if (joined.includes("/status")) {
      return JSON.stringify(combinedStatus);
    }
    throw new Error(`Unexpected gh command: ${joined}`);
  };
}

// =============================================================================
// checkCiStatus — all checks passed
// =============================================================================

Deno.test("direct_merge - checkCiStatus returns passed when all check runs succeed and no commit statuses", async () => {
  const mock = createCiStatusMock(
    {
      total_count: 2,
      check_runs: [
        { id: 1, name: "build", status: "completed", conclusion: "success" },
        { id: 2, name: "test", status: "completed", conclusion: "success" },
      ],
    },
    { state: "success", statuses: [] },
  );

  const result = await checkCiStatus("owner/repo", 42, mock);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "passed");
  }
});

Deno.test("direct_merge - checkCiStatus returns passed when check runs succeed and combined status is success", async () => {
  const mock = createCiStatusMock(
    {
      total_count: 1,
      check_runs: [
        { id: 1, name: "build", status: "completed", conclusion: "success" },
      ],
    },
    {
      state: "success",
      statuses: [
        { id: 1, state: "success", context: "deploy", description: "Deployed" },
      ],
    },
  );

  const result = await checkCiStatus("owner/repo", 42, mock);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "passed");
  }
});

// =============================================================================
// checkCiStatus — checks pending
// =============================================================================

Deno.test("direct_merge - checkCiStatus returns pending when a check run is still in progress", async () => {
  const mock = createCiStatusMock(
    {
      total_count: 2,
      check_runs: [
        { id: 1, name: "build", status: "completed", conclusion: "success" },
        { id: 2, name: "test", status: "in_progress", conclusion: null },
      ],
    },
    { state: "pending", statuses: [] },
  );

  const result = await checkCiStatus("owner/repo", 42, mock);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "pending");
  }
});

Deno.test("direct_merge - checkCiStatus returns pending when combined status is pending with statuses", async () => {
  const mock = createCiStatusMock(
    {
      total_count: 1,
      check_runs: [
        { id: 1, name: "build", status: "completed", conclusion: "success" },
      ],
    },
    {
      state: "pending",
      statuses: [
        { id: 1, state: "pending", context: "deploy", description: "Waiting" },
      ],
    },
  );

  const result = await checkCiStatus("owner/repo", 42, mock);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "pending");
  }
});

// =============================================================================
// checkCiStatus — checks failed
// =============================================================================

Deno.test("direct_merge - checkCiStatus returns failed when a check run has failure conclusion", async () => {
  const mock = createCiStatusMock(
    {
      total_count: 2,
      check_runs: [
        { id: 1, name: "build", status: "completed", conclusion: "success" },
        { id: 2, name: "test", status: "completed", conclusion: "failure" },
      ],
    },
    { state: "failure", statuses: [] },
  );

  const result = await checkCiStatus("owner/repo", 42, mock);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "failed");
  }
});

Deno.test("direct_merge - checkCiStatus returns failed when combined status is failure", async () => {
  const mock = createCiStatusMock(
    {
      total_count: 1,
      check_runs: [
        { id: 1, name: "build", status: "completed", conclusion: "success" },
      ],
    },
    {
      state: "failure",
      statuses: [
        { id: 1, state: "failure", context: "deploy", description: "Failed" },
      ],
    },
  );

  const result = await checkCiStatus("owner/repo", 42, mock);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "failed");
  }
});

Deno.test("direct_merge - checkCiStatus returns failed when check run is cancelled", async () => {
  const mock = createCiStatusMock(
    {
      total_count: 1,
      check_runs: [
        { id: 1, name: "build", status: "completed", conclusion: "cancelled" },
      ],
    },
    { state: "success", statuses: [] },
  );

  const result = await checkCiStatus("owner/repo", 42, mock);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "failed");
  }
});

// =============================================================================
// checkCiStatus — conclusion allowlist (Issue #3945)
//
// The verdict is an allowlist, not a denylist: only `success`, `skipped` and
// `neutral` pass. Every other completed conclusion — including one GitHub adds
// in future — fails closed rather than falling through to "passed".
// =============================================================================

const NON_PASSING_CONCLUSIONS = [
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
  "totally_new_value",
];

for (const conclusion of NON_PASSING_CONCLUSIONS) {
  Deno.test(`direct_merge - checkCiStatus returns failed for conclusion "${conclusion}"`, async () => {
    const mock = createCiStatusMock(
      {
        total_count: 2,
        check_runs: [
          { id: 1, name: "build", status: "completed", conclusion: "success" },
          { id: 2, name: "test", status: "completed", conclusion },
        ],
      },
      { state: "success", statuses: [] },
    );

    const result = await checkCiStatus("owner/repo", 42, mock);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.status, "failed");
    }
  });
}

const PASSING_CONCLUSIONS = ["success", "skipped", "neutral"];

for (const conclusion of PASSING_CONCLUSIONS) {
  Deno.test(`direct_merge - checkCiStatus returns passed for conclusion "${conclusion}"`, async () => {
    const mock = createCiStatusMock(
      {
        total_count: 1,
        check_runs: [
          { id: 1, name: "build", status: "completed", conclusion },
        ],
      },
      { state: "success", statuses: [] },
    );

    const result = await checkCiStatus("owner/repo", 42, mock);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.status, "passed");
    }
  });
}

Deno.test("direct_merge - checkCiStatus returns failed for an unrecognised combined status state", async () => {
  const mock = createCiStatusMock(
    {
      total_count: 1,
      check_runs: [
        { id: 1, name: "build", status: "completed", conclusion: "success" },
      ],
    },
    {
      state: "brand_new_state",
      statuses: [
        { id: 1, state: "brand_new_state", context: "deploy", description: "" },
      ],
    },
  );

  const result = await checkCiStatus("owner/repo", 42, mock);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "failed");
  }
});

// =============================================================================
// checkCiStatus — no checks at all
//
// Issue #3705: zero check runs and zero commit statuses is "no_checks"
// (unverified), not "passed". This test previously asserted "passed"; the
// business logic deliberately changed to fail closed.
// =============================================================================

Deno.test("direct_merge - checkCiStatus returns no_checks when no checks exist at all", async () => {
  const mock = createCiStatusMock(
    { total_count: 0, check_runs: [] },
    { state: "pending", statuses: [] },
  );

  const result = await checkCiStatus("owner/repo", 42, mock);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "no_checks");
  }
});

// =============================================================================
// checkCiStatus — GraphQL statusCheckRollup happy path (Issue #1806)
// =============================================================================

Deno.test("direct_merge - checkCiStatus uses single GraphQL call when statusCheckRollup succeeds", async () => {
  let graphqlCalls = 0;
  let restCalls = 0;
  const gh = (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1] === "graphql") {
      graphqlCalls++;
      return Promise.resolve(JSON.stringify({
        data: {
          repository: {
            n0: {
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        state: "SUCCESS",
                        contexts: {
                          nodes: [
                            {
                              __typename: "CheckRun",
                              databaseId: 11,
                              name: "build",
                              status: "COMPLETED",
                              conclusion: "SUCCESS",
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      }));
    }
    restCalls++;
    return Promise.reject(new Error(`Unexpected REST call: ${args.join(" ")}`));
  };

  const result = await checkCiStatus("owner/repo", 42, gh);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "passed");
  }
  // One GraphQL call replaces the REST pair
  assertEquals(graphqlCalls, 1);
  assertEquals(restCalls, 0);
});

// =============================================================================
// checkCiStatus — GraphQL rollup state is consumed (Issue #3945)
//
// `statusCheckRollup.state` is GitHub's own aggregate verdict. It is folded
// into the decision, so a non-green rollup blocks the merge even when every
// individual check run looks green.
// =============================================================================

/**
 * Build a gh mock whose GraphQL rollup reports `state` with a single
 * successful, completed check run.
 */
function createRollupStateMock(
  state: string,
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    if (args[0] === "api" && args[1] === "graphql") {
      return Promise.resolve(JSON.stringify({
        data: {
          repository: {
            n0: {
              commits: {
                nodes: [{
                  commit: {
                    statusCheckRollup: {
                      state,
                      contexts: {
                        nodes: [{
                          __typename: "CheckRun",
                          databaseId: 11,
                          name: "build",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                        }],
                      },
                    },
                  },
                }],
              },
            },
          },
        },
      }));
    }
    return Promise.reject(new Error(`Unexpected REST call: ${args.join(" ")}`));
  };
}

Deno.test("direct_merge - checkCiStatus returns failed when rollup state is FAILURE despite green check runs", async () => {
  const result = await checkCiStatus(
    "owner/repo",
    42,
    createRollupStateMock("FAILURE"),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "failed");
  }
});

Deno.test("direct_merge - checkCiStatus returns pending when rollup state is EXPECTED", async () => {
  const result = await checkCiStatus(
    "owner/repo",
    42,
    createRollupStateMock("EXPECTED"),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "pending");
  }
});

Deno.test("direct_merge - checkCiStatus returns failed for an unrecognised rollup state", async () => {
  const result = await checkCiStatus(
    "owner/repo",
    42,
    createRollupStateMock("BRAND_NEW_STATE"),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "failed");
  }
});

Deno.test("direct_merge - checkCiStatus falls back to REST pair when GraphQL fails", async () => {
  let graphqlCalls = 0;
  let restCalls = 0;
  const gh = (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (args[0] === "api" && args[1] === "graphql") {
      graphqlCalls++;
      return Promise.reject(new Error("GraphQL error"));
    }
    if (joined.includes("pr view")) {
      restCalls++;
      return Promise.resolve(JSON.stringify({ headRefOid: FAKE_SHA }));
    }
    if (joined.includes("check-runs")) {
      restCalls++;
      return Promise.resolve(JSON.stringify({
        total_count: 1,
        check_runs: [
          { id: 1, name: "build", status: "completed", conclusion: "success" },
        ],
      }));
    }
    if (joined.includes("/status")) {
      restCalls++;
      return Promise.resolve(
        JSON.stringify({ state: "success", statuses: [] }),
      );
    }
    return Promise.reject(new Error(`Unexpected: ${joined}`));
  };

  const result = await checkCiStatus("owner/repo", 42, gh);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "passed");
  }
  // GraphQL attempted once, then fall back to three REST calls
  assertEquals(graphqlCalls, 1);
  assertEquals(restCalls, 3);
});

// =============================================================================
// checkCiStatus — API error handling
// =============================================================================

Deno.test("direct_merge - checkCiStatus returns error when API call fails", async () => {
  const result = await checkCiStatus(
    "owner/repo",
    42,
    async (_args: string[]) => {
      throw new Error("gh command failed (exit 1): not found");
    },
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("Failed to fetch"), true);
  }
});

// =============================================================================
// prTargetsDefaultBranch — blast-radius guard (Issue #2416)
// =============================================================================

/**
 * Mock gh runner for the guard's two lookups:
 * 1. `pr view --json baseRefName --jq .baseRefName` → base branch
 * 2. `api repos/<repo> --jq .default_branch` → default branch
 * Any other call (e.g. the actual `pr merge`) returns `mergeResponse`, or
 * throws when `mergeResponse` is null.
 */
function createGuardMock(
  baseBranch: string,
  defaultBranch: string,
  mergeResponse: string | null = "Merged",
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const joined = args.join(" ");
    if (joined.includes("pr view") && joined.includes("baseRefName")) {
      return Promise.resolve(baseBranch);
    }
    if (joined.includes("default_branch")) {
      return Promise.resolve(defaultBranch);
    }
    if (joined.includes("pr merge")) {
      if (mergeResponse === null) {
        return Promise.reject(
          new Error("gh command failed (exit 1): merge conflict"),
        );
      }
      return Promise.resolve(mergeResponse);
    }
    return Promise.reject(new Error(`Unexpected gh command: ${joined}`));
  };
}

Deno.test("direct_merge - prTargetsDefaultBranch true when base equals default branch", async () => {
  const result = await prTargetsDefaultBranch(
    "owner/repo",
    42,
    createGuardMock("main", "main"),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, true);
  }
});

Deno.test("direct_merge - prTargetsDefaultBranch false for a milestone branch target", async () => {
  const result = await prTargetsDefaultBranch(
    "owner/repo",
    42,
    createGuardMock("milestone/optus-4-8", "main"),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, false);
  }
});

Deno.test("direct_merge - prTargetsDefaultBranch errors when base branch lookup fails", async () => {
  const result = await prTargetsDefaultBranch(
    "owner/repo",
    42,
    (_args: string[]) => Promise.reject(new Error("not found")),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.message.includes("Failed to fetch base branch"),
      true,
    );
  }
});

// =============================================================================
// directMergePr — success and failure
//
// Issue #2416: directMergePr now runs a default-branch guard before merging,
// so its mock gh runner must answer the base-branch and default-branch
// lookups (via createGuardMock) in addition to the merge call.
// =============================================================================

/**
 * A pre-merge gate that always allows the merge (CI green, branch current).
 *
 * Issue #3946 changed the gate contract: an allowed outcome must name the head
 * SHA its checks were read for, so the merge can be pinned to it. The stub
 * reports {@link FAKE_SHA} accordingly.
 */
const allowGate: PreMergeGateFn = () =>
  Promise.resolve({ ok: true, value: { allowed: true, headSha: FAKE_SHA } });

/** A pre-merge gate that blocks with the given reason. */
function blockGate(reason: PreMergeGateOutcome["reason"]): PreMergeGateFn {
  return () => Promise.resolve({ ok: true, value: { allowed: false, reason } });
}

Deno.test("direct_merge - directMergePr returns success when gh pr merge succeeds", async () => {
  const result = await directMergePr(
    "owner/repo",
    42,
    createGuardMock("milestone/optus-4-8", "main", "Merged PR #42"),
    allowGate,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.merged, true);
  }
});

Deno.test("direct_merge - directMergePr returns error when gh pr merge fails", async () => {
  const result = await directMergePr(
    "owner/repo",
    42,
    createGuardMock("milestone/optus-4-8", "main", null),
    allowGate,
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("Failed to merge"), true);
  }
});

// =============================================================================
// directMergePr — pre-merge backstop gate (Issue #2582)
// =============================================================================

Deno.test("direct_merge - directMergePr merges when CI passed and branch current", async () => {
  let mergeAttempted = false;
  const gh = createGuardMock("milestone/x", "main", "Merged");
  const result = await directMergePr(
    "owner/repo",
    42,
    (args) => {
      if (args.join(" ").includes("pr merge")) mergeAttempted = true;
      return gh(args);
    },
    allowGate,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.merged, true);
  }
  assertEquals(mergeAttempted, true);
});

Deno.test("direct_merge - directMergePr blocks (no merge) when CI pending", async () => {
  let mergeAttempted = false;
  const gh = (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (joined.includes("pr view") && joined.includes("baseRefName")) {
      return Promise.resolve("milestone/x");
    }
    if (joined.includes("default_branch")) return Promise.resolve("main");
    if (joined.includes("pr merge")) {
      mergeAttempted = true;
      return Promise.resolve("Merged");
    }
    return Promise.reject(new Error(`Unexpected: ${joined}`));
  };

  const result = await directMergePr(
    "owner/repo",
    42,
    gh,
    blockGate("checks_pending"),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.merged, false);
    assertEquals(result.value.blocked, "checks_pending");
  }
  assertEquals(mergeAttempted, false);
});

Deno.test("direct_merge - directMergePr blocks (no merge) when CI failed", async () => {
  let mergeAttempted = false;
  const gh = (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (joined.includes("pr view") && joined.includes("baseRefName")) {
      return Promise.resolve("milestone/x");
    }
    if (joined.includes("default_branch")) return Promise.resolve("main");
    if (joined.includes("pr merge")) {
      mergeAttempted = true;
      return Promise.resolve("Merged");
    }
    return Promise.reject(new Error(`Unexpected: ${joined}`));
  };

  const result = await directMergePr(
    "owner/repo",
    42,
    gh,
    blockGate("checks_failed"),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.merged, false);
    assertEquals(result.value.blocked, "checks_failed");
  }
  assertEquals(mergeAttempted, false);
});

Deno.test("direct_merge - directMergePr defers (no merge) when branch behind target", async () => {
  let mergeAttempted = false;
  const gh = (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (joined.includes("pr view") && joined.includes("baseRefName")) {
      return Promise.resolve("milestone/x");
    }
    if (joined.includes("default_branch")) return Promise.resolve("main");
    if (joined.includes("pr merge")) {
      mergeAttempted = true;
      return Promise.resolve("Merged");
    }
    return Promise.reject(new Error(`Unexpected: ${joined}`));
  };

  const result = await directMergePr(
    "owner/repo",
    42,
    gh,
    blockGate("behind_target"),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.merged, false);
    assertEquals(result.value.blocked, "behind_target");
  }
  // Behind branch → PR left open, no merge attempted.
  assertEquals(mergeAttempted, false);
});

Deno.test("direct_merge - directMergePr fails closed when the gate lookup fails", async () => {
  let mergeAttempted = false;
  const gh = (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (joined.includes("pr view") && joined.includes("baseRefName")) {
      return Promise.resolve("milestone/x");
    }
    if (joined.includes("default_branch")) return Promise.resolve("main");
    if (joined.includes("pr merge")) {
      mergeAttempted = true;
      return Promise.resolve("Merged");
    }
    return Promise.reject(new Error(`Unexpected: ${joined}`));
  };
  const failingGate: PreMergeGateFn = () =>
    Promise.resolve({ ok: false, error: new Error("CI lookup network error") });

  const result = await directMergePr("owner/repo", 42, gh, failingGate);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.message.includes("pre-merge gate could not confirm"),
      true,
    );
  }
  assertEquals(mergeAttempted, false);
});

// =============================================================================
// enforcePreMergeRequirements — gate unit tests (Issue #2582)
// =============================================================================

/** CI status fn stub returning a fixed status. */
function ciStub(status: CiStatusResult["status"]) {
  return (): Promise<Result<CiStatusResult>> =>
    Promise.resolve({ ok: true, value: { status } });
}

/** Branch-state batch stub returning a fixed behindBy for the PR. */
function branchStub(behindBy: number) {
  return (
    _repo: string,
    prs: { number: number }[],
  ): Promise<PRBranchStateBatchResult> => {
    const states = new Map(
      prs.map((
        p,
      ) => [p.number, { aheadBy: 0, behindBy, mergeable: "MERGEABLE" }]),
    );
    return Promise.resolve({ ok: true, states, callCount: 1 });
  };
}

const baseRefMock = (args: string[]): Promise<string> => {
  const key = args.join(" ");
  // Issue #4396: the milestone-base route gate reads the rollup PRs and the
  // milestone state; answer "route still open" so these scenarios stay about
  // CI/branch state. The gate has its own tests. (Checked before the
  // baseRefName branch: the rollup query's --json list names that field too.)
  if (key.includes("pr list") && key.includes("--head")) {
    return Promise.resolve("[]");
  }
  if (key.includes("/milestones?state=all")) {
    return Promise.resolve(
      JSON.stringify([{ number: 1, title: "x", state: "open" }]),
    );
  }
  // Issue #470: the gate now reads both refs in one `pr view --json
  // baseRefName,headRefName`, because the ahead/behind comparison has to be
  // oriented base-to-head. Answer with the JSON object it parses.
  if (key.includes("baseRefName")) {
    return Promise.resolve(
      JSON.stringify({
        baseRefName: "milestone/x",
        headRefName: "issue-1-feature",
      }),
    );
  }
  return Promise.reject(new Error(`Unexpected: ${key}`));
};

Deno.test("direct_merge - enforcePreMergeRequirements allows when CI passed and current", async () => {
  const result = await enforcePreMergeRequirements(
    "owner/repo",
    42,
    baseRefMock,
    {},
    ciStub("passed"),
    branchStub(0),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.allowed, true);
  }
});

Deno.test("direct_merge - enforcePreMergeRequirements blocks when CI pending", async () => {
  const result = await enforcePreMergeRequirements(
    "owner/repo",
    42,
    baseRefMock,
    {},
    ciStub("pending"),
    branchStub(0),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.allowed, false);
    assertEquals(result.value.reason, "checks_pending");
  }
});

Deno.test("direct_merge - enforcePreMergeRequirements blocks when CI failed", async () => {
  const result = await enforcePreMergeRequirements(
    "owner/repo",
    42,
    baseRefMock,
    {},
    ciStub("failed"),
    branchStub(0),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.allowed, false);
    assertEquals(result.value.reason, "checks_failed");
  }
});

Deno.test("direct_merge - enforcePreMergeRequirements blocks when branch behind target", async () => {
  const result = await enforcePreMergeRequirements(
    "owner/repo",
    42,
    baseRefMock,
    {},
    ciStub("passed"),
    branchStub(3),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.allowed, false);
    assertEquals(result.value.reason, "behind_target");
  }
});

Deno.test("direct_merge - enforcePreMergeRequirements does not check branch when CI not passed", async () => {
  let branchChecked = false;
  const branchSpy = (
    _repo: string,
    prs: { number: number }[],
  ): Promise<PRBranchStateBatchResult> => {
    branchChecked = true;
    return branchStub(0)(_repo, prs);
  };
  await enforcePreMergeRequirements(
    "owner/repo",
    42,
    baseRefMock,
    {},
    ciStub("failed"),
    branchSpy,
  );
  // CI short-circuits before any branch-state fetch.
  assertEquals(branchChecked, false);
});

Deno.test("direct_merge - enforcePreMergeRequirements fails closed when CI lookup errors", async () => {
  const result = await enforcePreMergeRequirements(
    "owner/repo",
    42,
    baseRefMock,
    {},
    () => Promise.resolve({ ok: false, error: new Error("CI fetch failed") }),
    branchStub(0),
  );
  assertEquals(result.ok, false);
});

Deno.test("direct_merge - directMergePr refuses to merge a PR targeting the default branch (Issue #2416)", async () => {
  let mergeAttempted = false;
  const gh = (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (joined.includes("pr view") && joined.includes("baseRefName")) {
      return Promise.resolve("main");
    }
    if (joined.includes("default_branch")) {
      return Promise.resolve("main");
    }
    if (joined.includes("pr merge")) {
      mergeAttempted = true;
      return Promise.resolve("Merged");
    }
    return Promise.reject(new Error(`Unexpected: ${joined}`));
  };

  const result = await directMergePr("owner/repo", 42, gh);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.message.includes("targets the default branch"),
      true,
    );
  }
  // The guard must short-circuit before any merge call reaches GitHub.
  assertEquals(mergeAttempted, false);
});

Deno.test("direct_merge - directMergePr fails closed when the target branch cannot be confirmed (Issue #2416)", async () => {
  let mergeAttempted = false;
  const gh = (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (joined.includes("pr merge")) {
      mergeAttempted = true;
      return Promise.resolve("Merged");
    }
    // Both lookups fail — guard cannot confirm the target is non-default.
    return Promise.reject(new Error("network error"));
  };

  const result = await directMergePr("owner/repo", 42, gh);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("could not confirm"), true);
  }
  assertEquals(mergeAttempted, false);
});

// =============================================================================
// Command — argument validation
// =============================================================================

Deno.test("direct_merge - command rejects missing --repo argument", async () => {
  const result = await mergeIfChecksPassedCommand.execute(
    { pr: 42 },
    mockConfig(),
  );

  assertEquals(result.success, false);
  assertEquals(result.message.includes("repo"), true);
});

Deno.test("direct_merge - command rejects missing --pr argument", async () => {
  const result = await mergeIfChecksPassedCommand.execute(
    { repo: "owner/repo" },
    mockConfig(),
  );

  assertEquals(result.success, false);
  assertEquals(result.message.includes("pr"), true);
});

Deno.test("direct_merge - command rejects non-numeric --pr argument", async () => {
  const result = await mergeIfChecksPassedCommand.execute(
    { repo: "owner/repo", pr: "abc" },
    mockConfig(),
  );

  assertEquals(result.success, false);
  assertEquals(result.message.includes("pr"), true);
});

Deno.test("direct_merge - command rejects invalid repo format", async () => {
  const result = await mergeIfChecksPassedCommand.execute(
    { repo: "invalid-repo", pr: 42 },
    mockConfig(),
  );

  assertEquals(result.success, false);
  assertEquals(result.message.includes("repo"), true);
});

Deno.test("direct_merge - command has correct name and description", () => {
  assertEquals(mergeIfChecksPassedCommand.name, "merge-if-checks-passed");
  assertEquals(typeof mergeIfChecksPassedCommand.description, "string");
  assertEquals(mergeIfChecksPassedCommand.description.length > 0, true);
});

// ---------------------------------------------------------------------------
// Issue #4375: a just-pushed head is not merged; a moved head is refused
// ---------------------------------------------------------------------------

Deno.test("direct_merge - enforcePreMergeRequirements refuses a head committed moments ago even when CI reads green (head_too_recent) (Issue #4375)", async () => {
  const now = 1_700_000_000_000;
  const result = await enforcePreMergeRequirements(
    "owner/repo",
    4363,
    baseRefMock,
    {
      nowMs: () => now,
      fetchHeadRecency: async () => ({
        headSha: "abc123",
        committedAtMs: now - 20_000, // pushed 20 s ago
      }),
    },
    () =>
      Promise.resolve({
        ok: true,
        value: { status: "passed", headSha: "abc123" },
      }),
    branchStub(0),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.allowed, false);
    assertEquals(result.value.reason, "head_too_recent");
  }
});

Deno.test("direct_merge - enforcePreMergeRequirements allows a settled head (older than MIN_HEAD_AGE_SECONDS) and pins its SHA (Issue #4375)", async () => {
  const now = 1_700_000_000_000;
  const result = await enforcePreMergeRequirements(
    "owner/repo",
    42,
    baseRefMock,
    {
      nowMs: () => now,
      fetchHeadRecency: async () => ({
        headSha: "abc123",
        committedAtMs: now - (MIN_HEAD_AGE_SECONDS + 60) * 1000,
      }),
    },
    () =>
      Promise.resolve({
        ok: true,
        value: { status: "passed", headSha: "abc123" },
      }),
    branchStub(0),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.allowed, true);
    assertEquals(result.value.headSha, "abc123");
  }
});

Deno.test("direct_merge - enforcePreMergeRequirements refuses when the head moved since the CI read (head_moved) (Issue #4375)", async () => {
  const result = await enforcePreMergeRequirements(
    "owner/repo",
    42,
    baseRefMock,
    {
      nowMs: () => 1_700_000_000_000,
      fetchHeadRecency: async () => ({
        headSha: "newhead",
        committedAtMs: 1_600_000_000_000,
      }),
    },
    () =>
      Promise.resolve({
        ok: true,
        value: { status: "passed", headSha: "oldhead" },
      }),
    branchStub(0),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.allowed, false);
    assertEquals(result.value.reason, "head_moved");
  }
});

Deno.test("direct_merge - a recency lookup failure does not block on its own (CI remains the fail-closed gate) (Issue #4375)", async () => {
  const result = await enforcePreMergeRequirements(
    "owner/repo",
    42,
    baseRefMock,
    { fetchHeadRecency: async () => null },
    ciStub("passed"),
    branchStub(0),
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.allowed, true);
});
