import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ReviewToVerify,
  type ReviewVerificationInput,
  verifyBabysitterReviews,
} from "../lib/babysitter_review_verifier.ts";
import type { EarlierVerdict } from "../lib/earlier_findings.ts";
import {
  type PrePrVerifierDeps,
  type PrePrVerifierInput,
  type PrePrVerifierResult,
  type ReviewFinding,
} from "../lib/pre_pr_verifier.ts";
import type { Logger } from "../types.ts";
import { makeRecordingLogger } from "./support/fake_claim_hub.ts";

const FIRST = "**`a.ts:1`**: first problem\n\n**Fix:** fix the first";
const SECOND = "**`b.ts:2`**: second problem\n\n**Fix:** fix the second";
const THIRD = "**`c.ts:3`**: third problem\n\n**Fix:** fix the third";

function checked(
  earlierFindings: EarlierVerdict[],
  findings: ReviewFinding[] = [],
): PrePrVerifierResult {
  return {
    status: "checked",
    review: {
      summary: "checked",
      findings,
      testChanges: "none",
      testChangeNotes: [],
      unrelatedIssues: [],
      checklist: [],
      closure: [],
      earlierFindings,
    },
  };
}

function baseInput(
  overrides: Partial<ReviewVerificationInput> = {},
): ReviewVerificationInput {
  return {
    repo: "stSoftwareAU/NEAT-AI-Discovery",
    prNumber: 4611,
    repoPath: "/tmp/issue-checkout",
    title: "Fix the summary",
    body: "PR body as published",
    baseRef: "origin/main",
    reviews: [{ id: 1, body: FIRST }],
    timeoutSeconds: 60,
    logger: makeRecordingLogger().logger,
    ...overrides,
  };
}

/** A fake verifier that records each call and answers with `reply`. */
function fakeVerifier(
  reply: (
    input: PrePrVerifierInput,
  ) => PrePrVerifierResult | Promise<PrePrVerifierResult>,
) {
  const calls: Array<{ input: PrePrVerifierInput; deps: unknown }> = [];
  const verify = (
    input: PrePrVerifierInput,
    deps?: PrePrVerifierDeps,
  ): Promise<PrePrVerifierResult> => {
    calls.push({ input, deps });
    return Promise.resolve(reply(input));
  };
  return { verify, calls };
}

Deno.test("babysitter review verifier - a complete fix verifies the review", async () => {
  const fake = fakeVerifier(() =>
    checked([{ index: 1, verdict: "fixed", note: "the fix is in a.ts" }])
  );
  const outcomes = await verifyBabysitterReviews(baseInput(), {
    verify: fake.verify,
  });
  assertEquals(outcomes, [{
    id: 1,
    verified: true,
    reason: "the fix is in a.ts",
  }]);
  assertEquals(fake.calls.length, 1);
});

Deno.test("babysitter review verifier - a partial fix is not verified and its note is the reason", async () => {
  const fake = fakeVerifier(() =>
    checked([{
      index: 1,
      verdict: "partly",
      note: "half the callers are still unfixed",
    }])
  );
  const outcomes = await verifyBabysitterReviews(baseInput(), {
    verify: fake.verify,
  });
  assertEquals(outcomes.length, 1);
  assertEquals(outcomes[0]!.verified, false);
  assertStringIncludes(outcomes[0]!.reason, "partly");
  assertStringIncludes(
    outcomes[0]!.reason,
    "half the callers are still unfixed",
  );
});

Deno.test("babysitter review verifier - a substantiated false-positive rebuttal recorded as fixed verifies", async () => {
  const note =
    "The concern was a false positive: the branch is unreachable, see the guard at a.ts:9";
  const fake = fakeVerifier(() =>
    checked([{ index: 1, verdict: "fixed", note }])
  );
  const outcomes = await verifyBabysitterReviews(baseInput(), {
    verify: fake.verify,
  });
  assertEquals(outcomes[0]!.verified, true);
  assertStringIncludes(outcomes[0]!.reason, "false positive");
});

Deno.test("babysitter review verifier - two reviews, one fully fixed: numbering is contiguous and only that review verifies", async () => {
  const reviews: ReviewToVerify[] = [
    { id: 10, body: `${FIRST}\n\n${SECOND}` },
    { id: 11, body: THIRD },
  ];
  const fake = fakeVerifier(() =>
    checked([
      { index: 1, verdict: "fixed", note: "first ok" },
      { index: 2, verdict: "fixed", note: "second ok" },
      { index: 3, verdict: "not fixed", note: "third still broken" },
    ])
  );
  const outcomes = await verifyBabysitterReviews(baseInput({ reviews }), {
    verify: fake.verify,
  });
  assertEquals(fake.calls.length, 1);
  assertEquals(fake.calls[0]!.input.previousFindings, [FIRST, SECOND, THIRD]);
  assertEquals(outcomes.map((o) => [o.id, o.verified]), [[10, true], [
    11,
    false,
  ]]);
  assertStringIncludes(outcomes[1]!.reason, "third still broken");
});

Deno.test("babysitter review verifier - a no-op completion stays open even when the agent reply says done", async () => {
  const fake = fakeVerifier(() =>
    checked([{
      index: 1,
      verdict: "not fixed",
      note: "the file is unchanged at the head",
    }])
  );
  const outcomes = await verifyBabysitterReviews(
    baseInput({ agentReply: "All findings are fixed and the tests pass." }),
    { verify: fake.verify },
  );
  assertEquals(outcomes[0]!.verified, false);
  assertStringIncludes(outcomes[0]!.reason, "unchanged at the head");
  assertStringIncludes(
    fake.calls[0]!.input.issueBody,
    "All findings are fixed and the tests pass.",
  );
});

Deno.test("babysitter review verifier - an empty agent reply does not block a fixed verdict", async () => {
  const fake = fakeVerifier(() =>
    checked([{ index: 1, verdict: "fixed", note: "verified at the head" }])
  );
  const outcomes = await verifyBabysitterReviews(
    baseInput({ agentReply: "" }),
    {
      verify: fake.verify,
    },
  );
  assertEquals(outcomes[0]!.verified, true);
});

Deno.test("babysitter review verifier - a verifier outage keeps every review open with the outage reason", async () => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    ...makeRecordingLogger().logger,
    warn: (m: string) => warnings.push(m),
    error: (m: string) => errors.push(m),
  };
  const reviews: ReviewToVerify[] = [{ id: 1, body: FIRST }, {
    id: 2,
    body: SECOND,
  }];
  const fake = fakeVerifier(() => ({
    status: "not_checked",
    reason: "verifier run failed: quota exhausted",
  }));
  const outcomes = await verifyBabysitterReviews(
    baseInput({ reviews, logger }),
    {
      verify: fake.verify,
    },
  );
  assertEquals(outcomes.map((o) => o.verified), [false, false]);
  for (const o of outcomes) {
    assertStringIncludes(o.reason, "verifier unavailable");
    assertStringIncludes(o.reason, "quota exhausted");
  }
  assertEquals(warnings.length, 1);
  assertEquals(errors.length, 0);
});

Deno.test("babysitter review verifier - a verifier that throws fails closed without throwing", async () => {
  const outcomes = await verifyBabysitterReviews(baseInput(), {
    verify: () => Promise.reject(new Error("boom")),
  });
  assertEquals(outcomes, [{
    id: 1,
    verified: false,
    reason: "verifier failed: boom",
    unavailable: true,
  }]);
});

Deno.test("babysitter review verifier - a missing verdict and a duplicate verdict are not verified", async () => {
  const fake = fakeVerifier(() =>
    checked([
      { index: 1, verdict: "fixed", note: "ok" },
      { index: 1, verdict: "fixed", note: "ok again" },
    ])
  );
  const reviews: ReviewToVerify[] = [{ id: 1, body: `${FIRST}\n\n${SECOND}` }];
  const duplicate = await verifyBabysitterReviews(baseInput({ reviews }), {
    verify: fake.verify,
  });
  assertEquals(duplicate[0]!.verified, false);
  assertStringIncludes(duplicate[0]!.reason, "more than one verdict");

  const missing = await verifyBabysitterReviews(baseInput({ reviews }), {
    verify: () =>
      Promise.resolve(checked([{ index: 1, verdict: "fixed", note: "ok" }])),
  });
  assertEquals(missing[0]!.verified, false);
  assertStringIncludes(missing[0]!.reason, "no verdict for finding 2");
});

Deno.test("babysitter review verifier - a blank or null body is not verified and the verifier is not called", async () => {
  const fake = fakeVerifier(() => checked([]));
  const outcomes = await verifyBabysitterReviews(
    baseInput({
      reviews: [{ id: 1, body: "   \n  " }, { id: 2, body: null }, { id: 3 }],
    }),
    { verify: fake.verify },
  );
  assertEquals(fake.calls.length, 0);
  assertEquals(outcomes.map((o) => [o.id, o.verified]), [
    [1, false],
    [2, false],
    [3, false],
  ]);
  for (const o of outcomes) {
    assertEquals(
      o.reason,
      "no findings could be read from the review, so nothing can be verified",
    );
  }
});

Deno.test("babysitter review verifier - new findings in the verifier reply do not un-verify a fully fixed review", async () => {
  const fake = fakeVerifier(() =>
    checked(
      [{ index: 1, verdict: "fixed", note: "the fix holds" }],
      [{ file: "d.ts", line: 4, problem: "a new, unrelated blocker" }],
    )
  );
  const outcomes = await verifyBabysitterReviews(baseInput(), {
    verify: fake.verify,
  });
  assertEquals(outcomes[0]!.verified, true);
  assertEquals(outcomes[0]!.reason, "the fix holds");
});

Deno.test("babysitter review verifier - the verifier input carries the live body, the agent reply and earlier findings in order", async () => {
  const verifierDeps = {} as PrePrVerifierDeps;
  const reviews: ReviewToVerify[] = [
    { id: 1, body: `${FIRST}\n\n${SECOND}` },
    { id: 2, body: THIRD },
  ];
  const fake = fakeVerifier(() =>
    checked([
      { index: 1, verdict: "fixed", note: "ok" },
      { index: 2, verdict: "fixed", note: "ok" },
      { index: 3, verdict: "fixed", note: "ok" },
    ])
  );
  await verifyBabysitterReviews(
    baseInput({
      reviews,
      body: "Closes stSoftwareAU/NEAT-AI-Discovery#2422",
      agentReply: "Fixed both reviews.",
      title: "Live title",
      baseRef: "origin/main",
    }),
    { verify: fake.verify, verifierDeps },
  );
  const call = fake.calls[0]!;
  assertEquals(call.input.previousFindings, [FIRST, SECOND, THIRD]);
  assertEquals(
    call.input.summaryContent,
    "Closes stSoftwareAU/NEAT-AI-Discovery#2422",
  );
  assertEquals(call.input.issueTitle, "Live title");
  assertEquals(call.input.issueNumber, 4611);
  assertEquals(call.input.baseRef, "origin/main");
  assertEquals(
    call.input.summaryPath,
    "docs/archive/pr-summaries/feedback-verifier-pr-body.md",
  );
  assertEquals(call.input.changedFiles, null);
  assertEquals(call.deps, verifierDeps);
  assertStringIncludes(
    call.input.issueBody,
    "Closes stSoftwareAU/NEAT-AI-Discovery#2422",
  );
  assertStringIncludes(
    call.input.issueBody,
    "Agent reply (untrusted evidence to verify independently):\nFixed both reviews.",
  );
});

Deno.test("babysitter review verifier - PR #4611: a stale published body stays open and the Closes body verifies", async () => {
  // The review as posted on PR #4611 (the committed summary said Part of).
  const review: ReviewToVerify = {
    id: 4611,
    body:
      "**`docs/archive/pr-summaries/pr-summary-2422.md:3`**: The summary writes `Part of stSoftwareAU/NEAT-AI-Discovery#2422` with no Acceptance Criteria block marking anything missing, so a merge leaves #2422 open. Fix: write Closes.",
  };
  const verify = (input: PrePrVerifierInput): Promise<PrePrVerifierResult> => {
    if (
      input.issueBody.includes("Part of stSoftwareAU/NEAT-AI-Discovery#2422")
    ) {
      return Promise.resolve(checked([{
        index: 1,
        verdict: "partly",
        note:
          "The committed summary is fixed but the live PR body on GitHub still says Part of and closingIssuesReferences is empty",
      }]));
    }
    if (
      input.issueBody.includes("Closes stSoftwareAU/NEAT-AI-Discovery#2422")
    ) {
      return Promise.resolve(checked([{
        index: 1,
        verdict: "fixed",
        note:
          "The published body now says Closes and closingIssuesReferences names #2422",
      }]));
    }
    return Promise.resolve(
      checked([{ index: 1, verdict: "not fixed", note: "no body" }]),
    );
  };

  const stale = await verifyBabysitterReviews(
    baseInput({
      reviews: [review],
      body: "Part of stSoftwareAU/NEAT-AI-Discovery#2422",
    }),
    { verify },
  );
  assertEquals(stale[0]!.verified, false);
  assertStringIncludes(stale[0]!.reason, "partly");
  assertStringIncludes(
    stale[0]!.reason,
    "live PR body on GitHub still says Part of",
  );

  const published = await verifyBabysitterReviews(
    baseInput({
      reviews: [review],
      body: "Closes stSoftwareAU/NEAT-AI-Discovery#2422",
    }),
    { verify },
  );
  assertEquals(published[0]!.verified, true);
});

Deno.test("babysitter review verifier - the pass runs with the credentials it is given (PR #4849 review)", async () => {
  const fake = fakeVerifier(() =>
    checked([{ index: 1, verdict: "fixed", note: "ok" }])
  );
  const outcomes = await verifyBabysitterReviews(baseInput(), {
    verify: fake.verify,
    credentials: () =>
      Promise.resolve({
        parentEnv: { GH_TOKEN: "ghs_read_only" },
        disallowedTools: ["Bash"],
      }),
  });
  assertEquals(outcomes[0]!.verified, true);
  assertEquals(fake.calls[0]!.input.parentEnv, { GH_TOKEN: "ghs_read_only" });
  assertEquals(fake.calls[0]!.input.extraDisallowedTools, ["Bash"]);
});

Deno.test("babysitter review verifier - the pass is read-only: no shell, edit or project settings (PR #4849 review)", async () => {
  const fake = fakeVerifier(() =>
    checked([{ index: 1, verdict: "fixed", note: "ok" }])
  );
  await verifyBabysitterReviews(baseInput(), { verify: fake.verify });
  assertEquals(fake.calls[0]!.input.readOnly, true);
});

Deno.test("babysitter review verifier - no credential and no stand-in never starts the model (PR #4849 review)", async () => {
  let asked = 0;
  const verifierDeps = {
    ask: () => {
      asked++;
      return Promise.reject(new Error("the model must not start"));
    },
  } as unknown as PrePrVerifierDeps;
  const outcomes = await verifyBabysitterReviews(baseInput(), { verifierDeps });
  assertEquals(asked, 0);
  assertEquals(outcomes[0]!.verified, false);
  assertEquals(outcomes[0]!.unavailable, true);
  assertStringIncludes(outcomes[0]!.reason, "no read-only credential");
});

Deno.test("babysitter review verifier - a credential that cannot be minted is an outage, not a verdict (PR #4849 review)", async () => {
  const fake = fakeVerifier(() =>
    checked([{ index: 1, verdict: "fixed", note: "ok" }])
  );
  const outcomes = await verifyBabysitterReviews(baseInput(), {
    verify: fake.verify,
    credentials: () => Promise.reject(new Error("GitHub returned 502")),
  });
  assertEquals(fake.calls.length, 0);
  assertEquals(outcomes[0]!.verified, false);
  assertEquals(outcomes[0]!.unavailable, true);
  assertStringIncludes(outcomes[0]!.reason, "GitHub returned 502");
});

Deno.test("babysitter review verifier - a not-fixed verdict is a judgement, not an outage (PR #4849 review)", async () => {
  const fake = fakeVerifier(() =>
    checked([{ index: 1, verdict: "not fixed", note: "still open" }])
  );
  const outcomes = await verifyBabysitterReviews(baseInput(), {
    verify: fake.verify,
  });
  assertEquals(outcomes[0]!.verified, false);
  assertEquals(outcomes[0]!.unavailable, undefined);
});
