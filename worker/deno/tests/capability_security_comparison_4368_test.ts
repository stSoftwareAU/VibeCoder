/** Matched comparison, unknown results and honest adoption (Issue #4368). */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  compareCapabilityGuidance,
  type ComparisonDependencies,
  scoreReviewReply,
} from "../lib/capability_security_comparison.ts";

const root = new URL("../../../", import.meta.url).pathname;
const output = [
  "functional: authorised update persists ... ok (1ms)",
  "security: cross-tenant rejected ... ok (1ms)",
  "security: privileged field rejected ... ok (1ms)",
  "ok | 3 passed | 0 failed (3ms)",
].join("\n");

function dependencies(
  overrides: Partial<ComparisonDependencies> = {},
): ComparisonDependencies {
  return {
    invoke: () =>
      Promise.resolve({
        ok: true,
        text: JSON.stringify({ source: "export const implementation = true;" }),
        attempts: [{
          ok: true,
          servedModels: ["served-model"],
          costUsd: 0.1,
          elapsedMs: 10,
        }],
      }),
    execute: () =>
      Promise.resolve({
        code: 0,
        stdout: output,
        stderr: "",
        elapsedMs: 3,
        isolation: {
          status: "enforced",
          runtime: "test",
          image: "sha256:test",
          detail: "isolated",
        },
      }),
    ...overrides,
  };
}

Deno.test("comparison runs every matched arm/task/sample with the same model and budget", async () => {
  const seen: {
    model: string;
    effort: string;
    timeoutMs: number;
    prompt: string;
  }[] = [];
  const deps = dependencies();
  const invoke = deps.invoke;
  deps.invoke = (request) => {
    seen.push(request);
    if (request.prompt.includes("REVIEW_FIXTURES")) {
      return Promise.resolve({
        ok: true,
        text: JSON.stringify({
          blocking: ["insecure", "deny-all", "newly-exposed"],
          preExisting: ["pre-existing"],
        }),
        attempts: [{
          ok: true,
          servedModels: ["served-model"],
          costUsd: 0.1,
          elapsedMs: 10,
        }],
      });
    }
    return invoke(request);
  };
  const result = await compareCapabilityGuidance({
    root,
    model: "pinned-model",
    effort: "low",
    samples: 2,
    timeoutMs: 30000,
  }, deps);
  assertEquals(result.generations.length, 12);
  assertEquals(result.reviews.length, 6);
  assertEquals(seen.length, 18);
  assert(
    seen.every((call) =>
      call.model === "pinned-model" && call.effort === "low" &&
      call.timeoutMs === 30000
    ),
  );
  assertEquals(result.liveComparison, "completed");
  assertEquals(result.winner, null);
  assertEquals(result.adoption.action, "simplify");
  for (const arm of result.arms) {
    assertEquals(arm.jointPassed, 4);
    assertEquals(arm.attempted, 4);
    assert(arm.jointInterval99 !== null);
    assertEquals(arm.reviewFalsePositives, 0);
    assertEquals(arm.reviewFalseNegatives, 0);
  }
});

Deno.test("unavailable isolation prevents a generated result being scored as a pass", async () => {
  const result = await compareCapabilityGuidance(
    { root, model: "pinned", samples: 2 },
    dependencies({
      execute: () =>
        Promise.resolve({
          code: null,
          stdout: output,
          stderr: "no sandbox",
          elapsedMs: 1,
          isolation: {
            status: "unavailable",
            runtime: "none",
            image: "none",
            detail: "no sandbox",
          },
        }),
    }),
  );
  assertEquals(result.liveComparison, "partial");
  assert(
    result.generations.every((entry) =>
      !entry.joint && !entry.functional.executed
    ),
  );
  assert(result.blockers.some((entry) => entry.includes("sandbox")));
});

Deno.test("failed process, missing model and missing cost remain incomplete evidence", async () => {
  const result = await compareCapabilityGuidance(
    { root, model: "pinned", samples: 2 },
    dependencies({
      invoke: () =>
        Promise.resolve({
          ok: true,
          text: JSON.stringify({ source: "code" }),
          attempts: [{
            ok: true,
            servedModels: [],
            costUsd: null,
            elapsedMs: 10,
          }],
        }),
      execute: () =>
        Promise.resolve({
          code: 1,
          stdout: output,
          stderr: "runtime error",
          elapsedMs: 1,
          isolation: {
            status: "enforced",
            runtime: "test",
            image: "digest",
            detail: "isolated",
          },
        }),
    }),
  );
  assertEquals(result.liveComparison, "partial");
  assert(result.generations.every((entry) => !entry.joint));
  assert(
    result.arms.every((entry) => entry.estimatedApiEquivalentUsd === null),
  );
  assert(result.blockers.some((entry) => entry.includes("served model")));
});

Deno.test("review confusion counts secure and irrelevant false positives and missed defects", () => {
  const score = scoreReviewReply(
    JSON.stringify({
      blocking: ["secure", "docs", "insecure"],
      preExisting: [],
    }),
  );
  assertEquals(score.status, "completed");
  assertEquals(score.falsePositives, 2);
  assertEquals(score.falseNegatives, 2);
  assertEquals(score.preExistingCorrect, false);
  assertEquals(scoreReviewReply('{"blocking":[]}').status, "unknown");
  assertEquals(
    scoreReviewReply('{"blocking":["invented"],"preExisting":[]}').status,
    "unknown",
  );
});

Deno.test("comparison rejects an unbounded sample count before invoking anything", async () => {
  let called = false;
  await assertRejects(
    () =>
      compareCapabilityGuidance(
        { root, model: "pinned", samples: 100 },
        dependencies({
          invoke: () => {
            called = true;
            throw new Error("must not call");
          },
        }),
      ),
    Error,
    "samples",
  );
  assertEquals(called, false);
});

Deno.test("comparison retries an unavailable lease once, preserving recovery evidence", async () => {
  const deps = dependencies();
  const execute = deps.execute;
  let calls = 0;
  deps.execute = (request) => {
    if (++calls % 2 === 1) {
      return Promise.resolve({
        code: null,
        stdout: "",
        stderr: "runtime starting",
        elapsedMs: 8,
        isolation: {
          status: "unavailable",
          runtime: "test",
          image: "digest",
          detail: "runtime starting",
        },
      });
    }
    return execute(request);
  };
  const result = await compareCapabilityGuidance({
    root,
    model: "pinned",
    samples: 2,
  }, deps);
  assertEquals(calls, 24);
  assert(
    result.generations.every((g) =>
      g.joint && g.executionAttempts.length === 2
    ),
  );
  assert(result.arms.every((a) => a.executionRetries === 4));
  assertEquals(result.blockers.some((b) => b.includes("sandbox")), false);
});

Deno.test("live joint acceptance requires a completed, non-contradictory parent verdict", async () => {
  for (
    const stdout of [
      output.split("\n").slice(0, -1).join("\n"),
      output + "\nfunctional: authorised update persists ... FAILED",
    ]
  ) {
    const deps = dependencies();
    deps.execute = () =>
      Promise.resolve({
        code: 0,
        stdout,
        stderr: "",
        elapsedMs: 1,
        isolation: {
          status: "enforced",
          runtime: "test",
          image: "digest",
          detail: "isolated",
        },
      });
    const result = await compareCapabilityGuidance({
      root,
      model: "pinned",
      samples: 2,
    }, deps);
    assert(result.generations.every((g) => !g.joint));
  }
});

Deno.test("review false positives include erroneous pre-existing reports", () => {
  const result = scoreReviewReply(
    JSON.stringify({
      blocking: ["insecure", "deny-all", "newly-exposed"],
      preExisting: ["secure", "docs", "pre-existing"],
    }),
  );
  assertEquals(result.falsePositives, 2);
  assertEquals(result.falseNegatives, 0);
});
