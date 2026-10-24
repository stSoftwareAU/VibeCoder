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
      branchName: "issue-42-fix-body",
      workerName: "worker",
      githubUser: "bot",
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
            headRefName: "foreign-branch",
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
    branchName: "issue-42-fix-body",
    workerName: "worker",
    githubUser: "bot",
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
            '{"baseRefName":"main","headRefName":"foreign-branch","title":"PR","body":"claims"}',
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

for (const owned of ["marker", "own-branch"] as const) {
  Deno.test(`feedback verifier - ${owned} summary repair replaces stale live claims before publication`, async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${dir}/docs/archive/pr-summaries`, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/docs/archive/pr-summaries/pr-summary-42.md`,
        "## Summary\n\nCorrected claims from the current branch.\n",
      );
      let received: PrePrVerifierInput | undefined;
      const input = {
        repo: "a/b",
        prNumber: 99,
        repoPath: dir,
        branchName: "issue-42-fix-body",
        workerName: "worker",
        githubUser: "bot",
        commentBody: "Fix the outdated description",
        timeoutSeconds: 12,
        logger: makeRecordingLogger().logger,
      };
      const result = await verifyFeedbackFix(input, {
        runGh: (args) => {
          assertEquals(
            args.slice(0, 2),
            ["pr", "view"],
            "verification must not edit GitHub",
          );
          return Promise.resolve(JSON.stringify({
            baseRefName: "main",
            headRefName: input.branchName,
            title: "Review fix",
            files: [],
            body: "Stale live claims" +
              (owned === "marker" ? "\n<!-- vibe-worker-issue-42 -->" : ""),
          }));
        },
        ask: () => {
          throw new Error("injected verifier should own the run");
        },
        verify: (actual) => {
          received = actual;
          return Promise.resolve({
            status: "checked",
            review: parseReviewReply(
              '{"summary":"clean","findings":[],"testChanges":"none"}',
            ),
          });
        },
      });
      assert(result.ok);
      assertStringIncludes(
        received!.summaryContent,
        "Corrected claims from the current branch.",
      );
      assertStringIncludes(
        received!.issueBody,
        "Corrected claims from the current branch.",
      );
      assertEquals(
        received!.summaryContent.includes("Stale live claims"),
        false,
      );
      assertEquals(received!.issueBody.includes("Stale live claims"), false);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("feedback verifier - candidate errors name the PR and branch and never run verification", async () => {
  for (const throws of [false, true]) {
    let verified = false;
    const result = await verifyFeedbackFix({
      repo: "a/b",
      prNumber: 99,
      repoPath: "/unused",
      branchName: "issue-42-fix-body",
      workerName: "worker",
      githubUser: "bot",
      commentBody: "fix",
      timeoutSeconds: 12,
      logger: makeRecordingLogger().logger,
    }, {
      runGh: () =>
        Promise.resolve(
          '{"baseRefName":"main","headRefName":"issue-42-fix-body","title":"PR","body":"stale"}',
        ),
      buildCandidate: () => {
        if (throws) throw new Error("summary unreadable");
        return Promise.resolve({
          ok: false,
          error: new Error("facts malformed"),
        });
      },
      ask: () => {
        throw new Error("must not ask");
      },
      verify: () => {
        verified = true;
        throw new Error("must not verify");
      },
    });
    assertEquals(verified, false);
    assert(!result.ok);
    assertStringIncludes(result.error.message, "PR #99 on issue-42-fix-body");
    assertStringIncludes(
      result.error.message,
      throws ? "summary unreadable" : "facts malformed",
    );
  }
});
