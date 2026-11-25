/**
 * The worker and the review gate each keep a copy of the check-suite rule
 * (Issue #4347). This test fails when those copies disagree, case-folded,
 * over every GraphQL check conclusion, status and app slug.
 */
import { assertEquals } from "@std/assert";
import {
  determineCiStatus,
  isFailedActionsSuite,
} from "../lib/direct_merge.ts";
import {
  failedActionsSuiteConclusions,
  type SearchPr,
  skipReason,
} from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";

const CONCLUSIONS = [
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "NEUTRAL",
  "SKIPPED",
  "STALE",
  "STARTUP_FAILURE",
  "SUCCESS",
  "TIMED_OUT",
  "Failure",
  null,
];

const STATUSES = [
  "COMPLETED",
  "IN_PROGRESS",
  "QUEUED",
  "PENDING",
  "REQUESTED",
  "WAITING",
  "Completed",
];

const SLUGS = ["github-actions", "dependabot", "review-bot"];
const COUNTS = [0, 1, 4];

Deno.test("the worker and review-gate suite predicates agree, case-folded (Issue #4347)", () => {
  for (const slug of SLUGS) {
    for (const status of STATUSES) {
      for (const conclusion of CONCLUSIONS) {
        for (const count of COUNTS) {
          const worker = isFailedActionsSuite({
            app_slug: slug,
            status,
            conclusion,
            check_run_count: count,
          });
          const gate = failedActionsSuiteConclusions([{
            app: { slug },
            status,
            conclusion,
            checkRuns: { totalCount: count },
          }]);
          assertEquals(
            gate.length > 0,
            worker,
            `${slug} ${status} ${conclusion} runs=${count}`,
          );
          if (worker && conclusion !== null) {
            assertEquals(gate, [conclusion.toUpperCase()]);
          }
        }
      }
    }
  }

  // An unknown app is never an Actions suite, on either copy.
  assertEquals(
    isFailedActionsSuite({
      app_slug: null,
      status: "COMPLETED",
      conclusion: "FAILURE",
      check_run_count: 0,
    }),
    false,
  );
  assertEquals(
    failedActionsSuiteConclusions([{
      app: null,
      status: "COMPLETED",
      conclusion: "FAILURE",
      checkRuns: { totalCount: 0 },
    }]),
    [],
  );
});

Deno.test("the worker and review gate agree on unfinished suites beside green checks", async () => {
  for (const slug of [...SLUGS, null]) {
    for (
      const [status, actionsVerdict] of [
        ["COMPLETED", "passed"],
        ["Completed", "passed"],
        ["IN_PROGRESS", "pending"],
        ["QUEUED", "pending"],
        ["PENDING", "pending"],
        ["REQUESTED", "pending"],
        ["WAITING", "pending"],
      ] as const
    ) {
      for (const count of COUNTS) {
        const expected = slug === "github-actions" ? actionsVerdict : "passed";
        const worker = determineCiStatus(
          {
            total_count: 1,
            check_runs: [{
              id: 1,
              name: "build",
              status: "completed",
              conclusion: "success",
            }],
            check_suites: [{
              app_slug: slug,
              status,
              conclusion: null,
              check_run_count: count,
            }],
          },
          { state: "pending", statuses: [] },
          "SUCCESS",
        );
        const pr: SearchPr = {
          number: 1,
          title: "t",
          url: "https://github.com/o/r/pull/1",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "head",
          baseRefName: "main",
          repository: {
            nameWithOwner: "o/r",
            defaultBranchRef: { name: "main" },
          },
          author: { login: "stservice" },
          reviews: { nodes: [] },
          commits: {
            nodes: [{
              commit: {
                statusCheckRollup: { state: "SUCCESS" },
                checkSuites: {
                  nodes: [{
                    app: slug === null ? null : { slug },
                    status,
                    conclusion: null,
                    checkRuns: { totalCount: count },
                  }],
                },
              },
            }],
          },
        };
        assertEquals(worker, expected, `${slug} ${status} runs=${count}`);
        assertEquals(
          await skipReason(pr, "nleck"),
          expected === "pending" ? "waiting-ci" : null,
        );
      }
    }
  }
});
