import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { verifyFeedbackFix } from "../lib/pr_feedback_verifier.ts";
import {
  parseReviewReply,
  type PrePrVerifierInput,
  type PrePrVerifierResult,
} from "../lib/pre_pr_verifier.ts";
import { makeRecordingLogger } from "./support/fake_claim_hub.ts";
import { prResponseMessagePath } from "../lib/pr_branch_preparation.ts";

Deno.test("feedback verifier - full review and rebuttal reach the disposable verifier without consuming the reply", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const replyPath = prResponseMessagePath(dir);
    await Deno.writeTextFile(replyPath, "Rebuttal: check both callers.");
    const commentBody = "**`a.ts:1`**: problem\n\n**Fix:** every caller";
    let received: PrePrVerifierInput | undefined;
    const result = await verifyFeedbackFix({
      repo: "a/b",
      prNumber: 42,
      repoPath: dir,
      commentBody,
      timeoutSeconds: 12,
      logger: makeRecordingLogger().logger,
    }, {
      runGh: () =>
        Promise.resolve(
          JSON.stringify({
            baseRefName: "milestone/fix",
            title: "Review fix",
            body: "PR claims",
          }),
        ),
      ask: () => {
        throw new Error("injected verifier should own the run");
      },
      verify: (input) => {
        received = input;
        return Promise.resolve({
          status: "checked",
          review: parseReviewReply(
            '{"summary":"clean","findings":[],"testChanges":"none"}',
          ),
        });
      },
    });
    assert(result.ok);
    assertEquals(received?.previousFindings, [commentBody]);
    assertEquals(received?.baseRef, "origin/milestone/fix");
    assertEquals(received?.summaryContent, "PR claims");
    assertStringIncludes(received!.issueBody, "check both callers");
    assertEquals(
      await Deno.readTextFile(replyPath),
      "Rebuttal: check both callers.",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("feedback verifier - unavailable, malformed and blocking results fail closed", async () => {
  const dir = await Deno.makeTempDir();
  const input = {
    repo: "a/b",
    prNumber: 42,
    repoPath: dir,
    commentBody: "fix both",
    timeoutSeconds: 12,
    logger: makeRecordingLogger().logger,
  };
  const clean = parseReviewReply(
    '{"summary":"clean","findings":[],"testChanges":"none"}',
  );
  try {
    for (
      const outcome of [
        { status: "not_checked", reason: "timeout" },
        {
          status: "checked",
          review: {
            ...clean,
            findings: [{
              file: "a.ts",
              line: 1,
              problem: "partial",
              fix: "both",
            }],
          },
        },
      ] satisfies PrePrVerifierResult[]
    ) {
      const result = await verifyFeedbackFix(input, {
        runGh: () =>
          Promise.resolve(
            '{"baseRefName":"main","title":"PR","body":"claims"}',
          ),
        ask: () => {
          throw new Error("unused");
        },
        verify: () => Promise.resolve(outcome),
      });
      assertEquals(result.ok, false);
      if (!result.ok) {
        assert(
          result.error.message.includes(
            outcome.status === "not_checked" ? "timeout" : "partial",
          ),
        );
      }
    }
    for (
      const metadata of ["not JSON", "{}", '{"baseRefName":"main","title":"x"}']
    ) {
      const result = await verifyFeedbackFix(input, {
        runGh: () => Promise.resolve(metadata),
        ask: () => {
          throw new Error("must not run");
        },
      });
      assertEquals(result.ok, false);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
