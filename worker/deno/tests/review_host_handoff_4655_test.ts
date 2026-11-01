import { assertEquals } from "@std/assert";
import { prepareHostReviewHandoff } from "../../../.claude/skills/review-fleet-prs/scripts/review_host_handoff.ts";
import type { FableReview } from "../../../.claude/skills/review-fleet-prs/scripts/review_log.ts";

const head = "a".repeat(40);
const base = "b".repeat(40);
const review: FableReview = {
  summary: "A contract changes.",
  findings: [],
  testChanges: "meaningful",
  unrelatedIssues: [],
  checklist: [],
  testChangeNotes: [{
    file: "tests/guard_test.ts",
    line: 4,
    change: "changed expectation",
    kind: "expected-value",
    criterionQuote: "new contract",
    oldBehaviour: "old contract",
    requiredBehaviour: "new contract",
    coverage: "guard assertion",
    coverageTests: ["tests/guard_test.ts"],
    regressionCheck: {
      method: "mutation",
      command: "deno test",
      break: "remove guard",
      result: "failed",
    },
  }],
};
const input = {
  head,
  base,
  review,
  removedTests: [],
  issues: [{ title: "new contract", body: "" }],
  headTree: `100644 blob ${"d".repeat(40)}\ttests/guard_test.ts\0`,
};

Deno.test("host handoff requests fixed observations and defers when runner cannot prove them", async () => {
  let calls = 0;
  const result = await prepareHostReviewHandoff(input, (request) => {
    calls++;
    assertEquals(request.head, head);
    assertEquals(request.argv.at(-1), "./tests/guard_test.ts");
    return Promise.resolve({
      status: "unavailable",
      detail: "offline dependency missing",
    });
  });
  assertEquals(calls, 1);
  assertEquals(result.status, "pending");
});

Deno.test("host handoff does not accept a claimed test absent from the verified tree", async () => {
  let calls = 0;
  const result = await prepareHostReviewHandoff({
    ...input,
    headTree: "",
  }, () => {
    calls++;
    return Promise.resolve({ status: "unavailable", detail: "unexpected" });
  });
  assertEquals(calls, 0);
  assertEquals(result.status, "pending");
});
