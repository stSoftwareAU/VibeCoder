import { assertEquals, assertRejects } from "@std/assert";
import {
  decideIndependentOutcome,
  fetchGoverningIssues,
  independentTestReview,
} from "../../../.claude/skills/review-fleet-prs/scripts/independent_test_review.ts";
import { postReviewArgs } from "../../../.claude/skills/review-fleet-prs/scripts/post.ts";
import {
  hasIndependentReviewHold,
  reviewerOwnedLabelFromHistory,
} from "../../../.claude/skills/review-fleet-prs/scripts/needs_human.ts";
import type {
  FableReview,
  TestChangeNote,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_log.ts";

const evidence = {
  file: "old_test.ts",
  line: 1,
  change: "obsolete test removed",
  kind: "removed-file",
  criterionQuote: "The new contract",
  oldBehaviour: "The old endpoint returned the legacy shape.",
  requiredBehaviour: "The new endpoint returns a stable value.",
  coverage: "new_test.ts checks the returned value and failure case.",
  regressionCheck: {
    method: "mutation",
    command: "deno test new_test.ts",
    break: "removed guard",
    result: "failed; guard restored",
  },
};

Deno.test("independent review accepts an evidenced obsolete file removal", () => {
  assertEquals(
    independentTestReview([evidence], ["old_test.ts"], [
      { title: "The new contract", body: "" },
    ]),
    [],
  );
});

Deno.test("independent review rejects missing evidence and untrusted requirements", () => {
  const issues = [{ title: "The new contract", body: "" }];
  assertEquals(
    independentTestReview([{ ...evidence, coverage: "" }], [], issues).length >
      0,
    true,
  );
  assertEquals(
    independentTestReview(
      [{ ...evidence, criterionQuote: "invented" }],
      [],
      issues,
    ).length > 0,
    true,
  );
  assertEquals(
    independentTestReview([{ ...evidence, regressionCheck: true }], [], issues)
      .length > 0,
    true,
  );
  assertEquals(
    independentTestReview([], ["old_test.ts"], issues).length > 0,
    true,
  );
  assertEquals(
    independentTestReview([{ ...evidence, kind: "added-skip" }], [], issues)
      .length > 0,
    true,
  );
});

Deno.test("Part of and worker branch identity fetch issue contents", async () => {
  const calls: string[][] = [];
  const runGh = (args: string[]) => {
    calls.push(args);
    if (args[0] === "pr") {
      return Promise.resolve(JSON.stringify({
        closingIssuesReferences: [],
        body: "Part of #42.",
        headRefName: "issue-42-example",
      }));
    }
    return Promise.resolve(
      JSON.stringify({ title: "Trusted requirement", body: "Issue body" }),
    );
  };
  assertEquals(await fetchGoverningIssues("acme/widgets", 99, runGh, true), [
    { title: "Trusted requirement", body: "Issue body" },
  ]);
  assertEquals(calls.filter((c) => c[0] === "issue").length, 1);
});

Deno.test("incomplete independent evidence retries instead of approving", async () => {
  const review: FableReview = {
    summary: "",
    findings: [],
    testChanges: "meaningful",
    testChangeNotes: [{ ...evidence, coverage: "" } as TestChangeNote],
    unrelatedIssues: [],
    checklist: [],
  };
  const gh = (args: string[]) =>
    Promise.resolve(
      JSON.stringify(
        args[0] === "pr"
          ? {
            closingIssuesReferences: [],
            body: "Part of #42",
            headRefName: "issue-42-example",
          }
          : { title: "The new contract", body: "" },
      ),
    );
  await assertRejects(
    () =>
      decideIndependentOutcome(
        { repo: "acme/widgets", number: 99, kind: "fleet" },
        review,
        [],
        gh,
      ),
    Error,
    "missing coverage",
  );
});

Deno.test("posting binds an approval to the reviewed commit", () => {
  assertEquals(
    postReviewArgs(
      { repo: "acme/widgets", number: 99, headSha: "reviewed" },
      "approved",
      "/tmp/body",
    ),
    [
      "api",
      "repos/acme/widgets/pulls/99/reviews",
      "--method",
      "POST",
      "-f",
      "commit_id=reviewed",
      "-f",
      "event=APPROVE",
      "-F",
      "body=@/tmp/body",
    ],
  );
});

Deno.test("label history recovers the reviewer's hold but preserves a human re-add", async () => {
  const pr = { repo: "acme/widgets", number: 99, headSha: "reviewed" };
  const hold = {
    state: "COMMENTED",
    user: { login: "reviewer[bot]" },
    commit_id: "reviewed",
    body:
      "Held for owner review: this PR changes existing tests.\nAutomated review by /review-fleet-prs",
    submitted_at: "2026-11-01T01:00:00Z",
  };
  const label = (actor: string, event: string) => ({
    event,
    actor: { login: actor },
    label: { name: "needs-human" },
    created_at: "2026-11-01T01:01:00Z",
  });
  const gh = (events: unknown[]) => (args: string[]) =>
    Promise.resolve(
      JSON.stringify([args[1]!.includes("/issues/") ? events : [hold]]),
    );
  assertEquals(
    await reviewerOwnedLabelFromHistory(
      pr,
      "reviewer",
      gh([label("reviewer[bot]", "labeled")]),
    ),
    true,
  );
  assertEquals(
    await reviewerOwnedLabelFromHistory(
      pr,
      "reviewer",
      gh([
        label("reviewer[bot]", "labeled"),
        label("human", "unlabeled"),
        label("human", "labeled"),
      ]),
    ),
    false,
  );
  assertEquals(
    await reviewerOwnedLabelFromHistory(
      { ...pr, headSha: "other" },
      "reviewer",
      gh([label("reviewer[bot]", "labeled")]),
    ),
    false,
  );
});

Deno.test("a human change request survives a later comment until dismissed", async () => {
  const pr = { repo: "acme/widgets", number: 99 };
  const review = (state: string) => ({ user: { login: "human" }, state });
  const gh = (entries: unknown[]) => () =>
    Promise.resolve(JSON.stringify([entries]));
  assertEquals(
    await hasIndependentReviewHold(
      pr,
      "reviewer",
      gh([review("CHANGES_REQUESTED"), review("COMMENTED")]),
    ),
    true,
  );
  assertEquals(
    await hasIndependentReviewHold(
      pr,
      "reviewer",
      gh([review("CHANGES_REQUESTED"), review("DISMISSED")]),
    ),
    false,
  );
});
