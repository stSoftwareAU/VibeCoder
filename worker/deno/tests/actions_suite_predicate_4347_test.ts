/**
 * The worker and the review gate each keep a copy of the check-suite rule
 * (Issue #4347). This test fails when those copies disagree, case-folded,
 * over every GraphQL check conclusion, status and app slug.
 */
import { assertEquals } from "@std/assert";
import { isFailedActionsSuite } from "../lib/direct_merge.ts";
import { failedActionsSuiteConclusions } from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";

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
