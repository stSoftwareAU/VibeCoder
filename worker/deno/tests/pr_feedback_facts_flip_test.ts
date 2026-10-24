/**
 * Review-fix facts flip check (Issue #4189).
 *
 * Stubs the verifier and the facts resolver. A refused verdict must reach
 * the reply with the #4186 message. A thrown verifier must be reported, not
 * swallowed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { SummaryFacts } from "../lib/summary_facts.ts";
import type { BranchOutcomesFactsOutcome } from "../lib/pr_summary_facts.ts";
import type {
  FactsFlipSeams,
  FactsFlipVerdict,
} from "../lib/facts_flip_verifier.ts";
import { runReviewFixFactsFlip } from "../lib/pr_feedback_processor.ts";

const SOURCE = "lib/m.ts";
const TEST_NAME = "pins the flag";
const REFUSAL =
  `\`${SOURCE}:2\`: no flip of this line turns \`${TEST_NAME}\` red; name a test that fails, or add one`;

function facts(): SummaryFacts {
  return {
    version: 1,
    branchOutcomes: {
      noneAdded: false,
      entries: [{
        path: SOURCE,
        line: 2,
        outcome: "returns early when the flag is set",
        test: "tests/m_test.ts",
        testName: TEST_NAME,
        flipWentRed: "the named test failed",
      }],
    },
  };
}

function validFacts(): BranchOutcomesFactsOutcome {
  return {
    kind: "valid",
    relativePath: "docs/archive/pr-summaries/pr-summary-4189.facts.json",
    facts: facts(),
    rendered: "",
    content: "{}",
  };
}

interface Log {
  level: string;
  message: string;
  context?: Record<string, unknown>;
}

function logger(logs: Log[]) {
  return {
    info: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "info", message, context }),
    warn: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "warn", message, context }),
    error: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "error", message, context }),
  };
}

Deno.test("review-fix facts flip - a refused entry is carried in the reply", async () => {
  const logs: Log[] = [];
  const reply = await runReviewFixFactsFlip({
    repoPath: "/repo",
    issueNumber: 4189,
    logger: logger(logs),
    resolveFacts: () => Promise.resolve(validFacts()),
    verifyFactsFlips: () =>
      Promise.resolve([{
        index: 0,
        verdict: { kind: "refused", message: REFUSAL },
      }]),
  });
  assert(reply !== null);
  assertStringIncludes(reply, REFUSAL);
});

Deno.test("review-fix facts flip - an absent facts file skips with a logged reason", async () => {
  const logs: Log[] = [];
  let verified = false;
  const reply = await runReviewFixFactsFlip({
    repoPath: "/repo",
    issueNumber: 4189,
    logger: logger(logs),
    resolveFacts: () => Promise.resolve({ kind: "absent" }),
    verifyFactsFlips: () => {
      verified = true;
      return Promise.resolve([]);
    },
  });
  assertEquals(reply, null);
  assertEquals(verified, false);
  const skipped = logs.find((log) =>
    log.message === "Facts flip check skipped"
  );
  assert(skipped, "expected a skip log");
  assertEquals(skipped.level, "info");
  assertStringIncludes(String(skipped.context?.reason ?? ""), "absent");
});

Deno.test("review-fix facts flip - a facts file that fails to parse is not_checked", async () => {
  const logs: Log[] = [];
  const reason =
    "Branch outcomes facts file docs/archive/pr-summaries/pr-summary-4189.facts.json is invalid: invalid JSON";
  const reply = await runReviewFixFactsFlip({
    repoPath: "/repo",
    issueNumber: 4189,
    logger: logger(logs),
    resolveFacts: () =>
      Promise.resolve({
        kind: "error",
        relativePath: "docs/archive/pr-summaries/pr-summary-4189.facts.json",
        content: "{",
        reason,
      }),
    verifyFactsFlips: () => Promise.resolve([]),
  });
  assert(reply !== null);
  assertStringIncludes(reply, "not checked:");
  assertStringIncludes(reply, reason);
  assertEquals(reply.includes("verified"), false);
});

Deno.test("review-fix facts flip - a thrown verifier is reported, never swallowed", async () => {
  const logs: Log[] = [];
  const reply = await runReviewFixFactsFlip({
    repoPath: "/repo",
    issueNumber: 4189,
    logger: logger(logs),
    resolveFacts: () => Promise.resolve(validFacts()),
    verifyFactsFlips: (
      _facts: SummaryFacts,
      _seams: FactsFlipSeams,
    ): Promise<FactsFlipVerdict[]> => {
      throw new Error("deno exploded");
    },
  });
  assert(reply !== null);
  assertStringIncludes(reply, "not checked:");
  assertStringIncludes(reply, "deno exploded");
  assert(
    logs.some((log) =>
      log.level === "error" && log.message === "Facts flip verifier failed"
    ),
  );
  assertEquals(
    logs.some((log) =>
      log.message.startsWith("WARNING:") || log.message.startsWith("ERROR:")
    ),
    false,
  );
});

Deno.test("review-fix facts flip - the processor calls the check on the push path", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/pr_feedback_processor.ts", import.meta.url),
  );
  const start = src.indexOf("async function _processFeedbackWithHeartbeat");
  assert(start >= 0);
  const body = src.slice(start);
  const mutation = body.indexOf("runReviewFixMutationCheck(");
  const flip = body.indexOf("runReviewFixFactsFlip(");
  const push = body.indexOf("deps.git.commitAndPushPending");
  assert(mutation > 0);
  assert(flip > mutation);
  assert(push > flip);
});
