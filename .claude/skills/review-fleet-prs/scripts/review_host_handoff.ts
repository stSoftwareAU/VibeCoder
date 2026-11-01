import { independentTestReview } from "./independent_test_review.ts";
import {
  collectRegressionEvidence,
  type PairedCheckRequest,
  type PairedObservation,
} from "./review_regression_collection.ts";
import type { LinkedIssue } from "./auto_release.ts";
import type { FableReview } from "./review_log.ts";
import { parseHeadTree } from "./review_regression_plan.ts";

/** Host caller supplies issue contents and head-tree paths it fetched itself.
 * Reviewer suggestions remain data; the runner and command are host-owned.
 * Even matching observations require a second independent review. */
export async function prepareHostReviewHandoff(
  input: {
    head: string;
    base: string;
    review: FableReview;
    removedTests: readonly string[];
    issues: readonly LinkedIssue[];
    headTree: string;
  },
  runPair: (request: PairedCheckRequest) => Promise<PairedObservation>,
) {
  if (
    input.review.findings.length > 0 ||
    input.review.checklist.some((item) => item.verdict === "missing")
  ) {
    return {
      status: "pending" as const,
      reason: "review has blocking findings",
    };
  }
  const notes = input.review.testChangeNotes;
  let reasons: string[];
  try {
    reasons = independentTestReview(
      notes as unknown as Record<string, unknown>[],
      input.removedTests,
      input.issues,
    );
  } catch (e) {
    return {
      status: "pending" as const,
      reason: `invalid reviewer evidence: ${(e as Error).message}`,
    };
  }
  if (reasons.length) {
    return { status: "pending" as const, reason: reasons.join("; ") };
  }
  const tests: string[] = [];
  for (const note of notes) {
    if (
      !Array.isArray(note.coverageTests) || !note.coverageTests.length ||
      !note.coverageTests.every((test) => typeof test === "string")
    ) {
      return {
        status: "pending" as const,
        reason: "coverage test selection is missing or unsupported",
      };
    }
    tests.push(...note.coverageTests);
  }
  let headFiles: Set<string>;
  try {
    headFiles = parseHeadTree(input.headTree);
  } catch (e) {
    return { status: "pending" as const, reason: (e as Error).message };
  }
  return await collectRegressionEvidence({
    head: input.head,
    base: input.base,
    tests,
    headFiles,
  }, runPair);
}
