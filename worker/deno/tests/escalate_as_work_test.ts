/**
 * Tests for escalate_as_work.ts — carrying a stuck PR into the work queue
 * instead of parking it behind `needs-human` (Issue #569).
 *
 * The operator's framing: *"`PR comment + needs-human label` is mostly a
 * failure in our automated Vibe Coder workflow."* A PR that is behind,
 * conflicting, red or unmergeable is a task, not a decision.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildWorkEscalationBody,
  DEFAULT_WORK_LABEL,
  escalateAsWork,
  workEscalationMarker,
  workEscalationTitle,
} from "../lib/escalate_as_work.ts";

const STALL = {
  repo: "org/repo",
  prNumber: 549,
  summary: "CI is red and no fix has landed",
  reason: "semgrep has been failing for 2 hours with no new push.",
  nextStep: "Push a fix or close the PR.",
};

/** A `gh` stub recording every call, answering the listing with `answer`. */
function fakeGh(answer = "[]") {
  const calls: string[][] = [];
  return {
    calls,
    gh: (args: string[]) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(answer);
      }
      if (args[0] === "issue" && args[1] === "create") {
        return Promise.resolve("https://github.com/org/repo/issues/601\n");
      }
      return Promise.resolve("");
    },
  };
}

Deno.test("escalateAsWork - files the blockage into the fleet's own queue", async () => {
  const { gh, calls } = fakeGh();
  const result = await escalateAsWork(STALL, { gh });

  assert(result.ok);
  assertEquals(result.value.filed, true);
  assertEquals(result.value.issueNumber, 601);

  const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
  assert(create, "an issue must be filed");
  // Labelled so a slot will actually pick it up — the whole point.
  assertEquals(create.includes("--label"), true);
  assertEquals(create[create.indexOf("--label") + 1], DEFAULT_WORK_LABEL);
  // Filed beside the PR, where the work is.
  assertEquals(create[create.indexOf("--repo") + 1], "org/repo");
});

Deno.test("escalateAsWork - an ongoing blockage updates its issue, never re-files", async () => {
  const existing = JSON.stringify([
    { number: 601, title: workEscalationTitle(STALL) },
  ]);
  const { gh, calls } = fakeGh(existing);

  const result = await escalateAsWork(STALL, { gh });

  assert(result.ok);
  assertEquals(result.value.filed, false);
  assertEquals(result.value.issueNumber, 601);
  assertEquals(
    calls.some((c) => c[0] === "issue" && c[1] === "create"),
    false,
    "an ongoing blockage is one issue, commented on",
  );
  assert(calls.some((c) => c[0] === "issue" && c[1] === "comment"));
});

Deno.test("escalateAsWork - an unparseable listing files rather than losing the escalation", async () => {
  // A duplicate report is recoverable; a lost escalation is not.
  const { gh, calls } = fakeGh("not json at all");
  const result = await escalateAsWork(STALL, { gh });

  assert(result.ok);
  assertEquals(result.value.filed, true);
  assert(calls.some((c) => c[0] === "issue" && c[1] === "create"));
});

Deno.test("escalateAsWork - a gh failure is reported, never swallowed", async () => {
  const result = await escalateAsWork(STALL, {
    gh: () => Promise.reject(new Error("gh: rate limited")),
  });
  assert(!result.ok);
  assertStringIncludes(result.error.message, "rate limited");
});

Deno.test("buildWorkEscalationBody - carries the PR, the cause and what was tried", () => {
  const body = buildWorkEscalationBody({
    ...STALL,
    attempted: "The CI-fix lane spent 3 attempts on it.",
  });

  assertStringIncludes(body, workEscalationMarker("org/repo", 549));
  assertStringIncludes(body, "org/repo#549");
  assertStringIncludes(body, "semgrep has been failing");
  assertStringIncludes(body, "The CI-fix lane spent 3 attempts on it.");
  assertStringIncludes(body, "Push a fix or close the PR.");
  // States the policy, so the next reader knows why this is not needs-human.
  assertStringIncludes(body, "a task, not a decision");
});

Deno.test("workEscalationTitle - names the PR, so the dedup key is stable", () => {
  assertEquals(
    workEscalationTitle(STALL),
    "PR #549 cannot land: CI is red and no fix has landed",
  );
});
