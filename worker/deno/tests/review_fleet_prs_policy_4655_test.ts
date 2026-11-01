import { assertEquals, assertThrows } from "@std/assert";
import {
  CURRENT_REVIEW_POLICY,
  policyForRepo,
  policyMarker,
  reviewerPolicy,
} from "../../../.claude/skills/review-fleet-prs/scripts/reviewer_policy.ts";

Deno.test("old opt-in migrates to fleet-wide policy while explicit overrides win", () => {
  const policy = reviewerPolicy({
    pr_reviewer_auto_release: ["o/old"],
    pr_reviewer_test_policy: { "O/Keep": "legacy" },
  });
  assertEquals(policyForRepo(policy, "o/old"), CURRENT_REVIEW_POLICY);
  assertEquals(policyForRepo(policy, "o/new"), CURRENT_REVIEW_POLICY);
  assertEquals(policyForRepo(policy, "o/keep"), "legacy");
  assertThrows(() => reviewerPolicy({ pr_reviewer_auto_release: "o/r" }));
  assertThrows(() =>
    reviewerPolicy({ pr_reviewer_test_policy: { "o/r": "unknown" } })
  );
  assertThrows(() =>
    reviewerPolicy({
      pr_reviewer_test_policy: { "o/r": "legacy", "O/R": "legacy" },
    })
  );
  assertEquals(
    policyMarker(CURRENT_REVIEW_POLICY),
    "Test review policy: 2026-11-02",
  );
});
