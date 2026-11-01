import { assertEquals } from "@std/assert";
import { collectRegressionEvidence } from "../../../.claude/skills/review-fleet-prs/scripts/review_regression_collection.ts";
import type { PairedCheckRequest } from "../../../.claude/skills/review-fleet-prs/scripts/review_regression_collection.ts";

const head = "a".repeat(40);
const base = "b".repeat(40);
const blob = "d".repeat(40);
const resultFor = (request: PairedCheckRequest) => {
  const check = (commit: string) => ({
    status: "passed" as const,
    head: commit,
    tree: "e".repeat(40),
    cwd: request.cwd,
    argv: request.argv,
    imageDigest: `sha256:${"f".repeat(64)}`,
    runtime: "apple-container",
    code: 0,
    output: "passed",
    overlayBlob: blob,
  });
  return {
    status: "observed" as const,
    blob,
    head: check(request.head),
    base: check(request.base),
  };
};
const input = {
  head,
  base,
  tests: ["tests/guard_test.ts"],
  headFiles: new Set(["tests/guard_test.ts"]),
};

Deno.test("host collector never turns unavailable observations into proof", async () => {
  const seen: unknown[] = [];
  const result = await collectRegressionEvidence(input, (request) => {
    seen.push(request);
    return Promise.resolve({
      status: "unavailable",
      detail: "offline dependency missing",
    });
  });
  assertEquals(result.status, "pending");
  assertEquals(seen.length, 1);
});

Deno.test("host collector binds actual observations to both commits and the planned test", async () => {
  const result = await collectRegressionEvidence(
    input,
    (request) =>
      Promise.resolve({
        ...resultFor(request),
        head: { ...resultFor(request).head, head: "c".repeat(40) },
      }),
  );
  assertEquals(result.status, "pending");
});

Deno.test("matched observations require a further review, never approval", async () => {
  const result = await collectRegressionEvidence(
    input,
    (request) => Promise.resolve(resultFor(request)),
  );
  assertEquals(result.status, "review");
});
