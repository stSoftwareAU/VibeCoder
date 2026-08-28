/**
 * Tests for the SHA-pinned direct merge (Issue #3946).
 *
 * `checkCiStatus()` reads the checks for one specific head commit, but the
 * merge that followed named only the PR number — so a push landing in the
 * two-to-three `gh` round trips between them was squash-merged on checks that
 * never evaluated it. The merge now carries `--match-head-commit <sha>` with
 * the very SHA the checks were read for, and a head that moved inside that
 * window defers instead of failing.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkCiStatus,
  directMergePr,
  isHeadMovedError,
  type PreMergeGateFn,
} from "../lib/direct_merge.ts";
import { classifyMergeAttempt } from "../lib/merge_block_escalation.ts";
import { blockedReason } from "../commands/merge_if_checks_passed.ts";

/** The commit the mocked check query reports as the PR head. */
const CHECKED_SHA = "1111111111111111111111111111111111111111";

/** GitHub's refusal when the head advanced after the checks were read. */
const HEAD_MOVED_MESSAGE =
  "gh command failed (exit 1): failed to merge pull request: " +
  "Head branch was modified. Review and try the merge again. (HTTP 409)";

/** Recorded `gh` invocations, so a test can assert on the merge argv. */
interface GhRecorder {
  calls: string[][];
  /** Argv of the `pr merge` call, or undefined when no merge was attempted. */
  mergeArgs(): string[] | undefined;
}

/**
 * Build a `gh` runner covering every call the real direct-merge path makes:
 * the default-branch guard, the `statusCheckRollup` check query, the branch
 * state query, and the merge itself.
 *
 * @param headSha - Head commit SHA the check query reports (omit for none)
 * @param mergeOutcome - `null` merges cleanly; a string rejects with it
 */
function createDirectMergeMock(
  headSha: string | null,
  mergeOutcome: string | null = null,
): { gh: (args: string[]) => Promise<string>; recorder: GhRecorder } {
  const calls: string[][] = [];
  const recorder: GhRecorder = {
    calls,
    mergeArgs: () => calls.find((a) => a[0] === "pr" && a[1] === "merge"),
  };

  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");

    // Issue #4396: milestone-base route gate — route open.
    if (joined.includes("pr list") && joined.includes("--head")) {
      return Promise.resolve("[]");
    }
    if (joined.includes("/milestones?state=all")) {
      return Promise.resolve(
        JSON.stringify([{ number: 1, title: "x", state: "open" }]),
      );
    }
    // Issue #470: the gate reads both refs in one
    // `pr view --json baseRefName,headRefName`; the blast-radius guard still
    // reads the base alone with `--jq`.
    if (joined.includes("pr view") && joined.includes("baseRefName")) {
      return Promise.resolve(
        joined.includes("--jq") ? "milestone/x" : JSON.stringify({
          baseRefName: "milestone/x",
          headRefName: "issue-1-feature",
        }),
      );
    }
    if (joined.includes("default_branch")) {
      return Promise.resolve("main");
    }
    if (joined.includes("statusCheckRollup")) {
      return Promise.resolve(JSON.stringify({
        data: {
          repository: {
            n0: {
              commits: {
                nodes: [{
                  commit: {
                    ...(headSha === null ? {} : { oid: headSha }),
                    statusCheckRollup: {
                      state: "SUCCESS",
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
    if (joined.includes("headRef")) {
      return Promise.resolve(JSON.stringify({
        data: {
          repository: {
            p0: {
              number: 42,
              headRefName: "issue-1",
              baseRefName: "milestone/x",
              mergeable: "MERGEABLE",
              headRef: { compare: { aheadBy: 1, behindBy: 0 } },
            },
          },
        },
      }));
    }
    if (joined.includes("pr merge")) {
      return mergeOutcome === null
        ? Promise.resolve("Merged")
        : Promise.reject(new Error(mergeOutcome));
    }
    return Promise.reject(new Error(`Unexpected gh command: ${joined}`));
  };

  return { gh, recorder };
}

// ---------------------------------------------------------------------------
// checkCiStatus reports the SHA it read the checks for
// ---------------------------------------------------------------------------

Deno.test("direct_merge - checkCiStatus reports the head SHA the GraphQL rollup was read for", async () => {
  const { gh } = createDirectMergeMock(CHECKED_SHA);
  const result = await checkCiStatus("owner/repo", 42, gh);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "passed");
    assertEquals(result.value.headSha, CHECKED_SHA);
  }
});

Deno.test("direct_merge - checkCiStatus reports the head SHA on the REST fallback path", async () => {
  const gh = (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (joined.includes("graphql")) {
      return Promise.reject(new Error("GraphQL unavailable"));
    }
    if (joined.includes("pr view")) {
      return Promise.resolve(JSON.stringify({ headRefOid: CHECKED_SHA }));
    }
    if (joined.includes("check-runs")) {
      return Promise.resolve(JSON.stringify({
        total_count: 1,
        check_runs: [{
          id: 1,
          name: "build",
          status: "completed",
          conclusion: "success",
        }],
      }));
    }
    if (joined.includes("/status")) {
      return Promise.resolve(
        JSON.stringify({ state: "success", statuses: [] }),
      );
    }
    return Promise.reject(new Error(`Unexpected gh command: ${joined}`));
  };

  const result = await checkCiStatus("owner/repo", 42, gh);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.headSha, CHECKED_SHA);
  }
});

// ---------------------------------------------------------------------------
// The merge is pinned to the SHA the checks were read for
// ---------------------------------------------------------------------------

Deno.test("direct_merge - merge passes --match-head-commit with the SHA the checks were read for", async () => {
  const { gh, recorder } = createDirectMergeMock(CHECKED_SHA);

  const result = await directMergePr("owner/repo", 42, gh);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.merged, true);
  }

  const mergeArgs = recorder.mergeArgs();
  assertEquals(mergeArgs !== undefined, true);
  const argv = mergeArgs ?? [];
  const flagIndex = argv.indexOf("--match-head-commit");
  assertEquals(flagIndex >= 0, true);
  // The pinned SHA must be the one the check query itself reported.
  assertEquals(argv[flagIndex + 1], CHECKED_SHA);
});

Deno.test("direct_merge - refuses to merge when the gate reports no head SHA", async () => {
  const { gh, recorder } = createDirectMergeMock(CHECKED_SHA);
  // A gate that allows the merge without naming the SHA it evaluated cannot
  // have its verdict pinned to a commit — fail closed rather than merge blind.
  const shalessGate: PreMergeGateFn = () =>
    Promise.resolve({ ok: true, value: { allowed: true } });

  const result = await directMergePr("owner/repo", 42, gh, shalessGate);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "head SHA");
  }
  assertEquals(recorder.mergeArgs(), undefined);
});

// ---------------------------------------------------------------------------
// A head that moved defers rather than failing the run
// ---------------------------------------------------------------------------

Deno.test("direct_merge - a head-moved rejection defers instead of failing the run", async () => {
  const { gh } = createDirectMergeMock(CHECKED_SHA, HEAD_MOVED_MESSAGE);

  const result = await directMergePr("owner/repo", 42, gh);

  // Same shape as the gate's own deferrals: ok, not merged, PR left open.
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.merged, false);
    assertEquals(result.value.blocked, "head_moved");
  }
});

Deno.test("direct_merge - a genuine merge failure is still a loud error", async () => {
  const { gh } = createDirectMergeMock(
    CHECKED_SHA,
    "gh command failed (exit 1): merge conflict between base and head",
  );

  const result = await directMergePr("owner/repo", 42, gh);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "Failed to merge");
  }
});

Deno.test("isHeadMovedError - recognises GitHub's head-moved refusals", () => {
  assertEquals(isHeadMovedError(HEAD_MOVED_MESSAGE), true);
  assertEquals(
    isHeadMovedError("Expected head sha didn't match current head ref."),
    true,
  );
  assertEquals(isHeadMovedError("The head commit has changed"), true);
});

Deno.test("isHeadMovedError - does not swallow unrelated merge failures", () => {
  assertEquals(isHeadMovedError("merge conflict between base and head"), false);
  assertEquals(
    isHeadMovedError("Pull request is not mergeable: required review missing"),
    false,
  );
  assertEquals(isHeadMovedError("gh: authentication token expired"), false);
});

// ---------------------------------------------------------------------------
// The deferral is reported, not silently dropped
// ---------------------------------------------------------------------------

Deno.test("direct_merge - head_moved waits for the new head's checks", () => {
  assertEquals(classifyMergeAttempt({ kind: "head_moved" }), "await_checks");
});

Deno.test("blockedReason - maps head_moved to its stable string", () => {
  assertEquals(blockedReason("head_moved"), "head_moved");
});
